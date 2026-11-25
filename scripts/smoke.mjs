#!/usr/bin/env node
// 冒烟测试：不启动 DSH，用假的宿主上下文把插件的 apply() 真跑一遍。
//
//   node scripts/smoke.mjs
//
// 检查四件事：
//   1. 每个模块都能被 import（语法 / 路径 / 循环依赖）
//   2. apply() 能跑完，不抛异常（能抓出 TDZ、未定义变量这类只有运行时才炸的错）
//   3. 八个 qq_* 工具、一个 /qq 命令都注册上了
//   4. 入站监听真的能起来（POST 任何东西都该回 204）
//
// 它用临时目录和 6799 端口，不碰线上 state，也不连 NapCat。
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createGroup } from '../src/group.js'
import { createMedia } from '../src/media.js'
import { DEFAULTS, describeConfig, resolveConfig } from '../src/config.js'
import { messageText, parseAnswer, plainText, splitText } from '../src/text.js'

const PORT = Number(process.env.QQ_SMOKE_PORT || 6799)

// 假 NapCat：真起一个 HTTP 服务，出站调用都落在这里，测试可以断言发了什么。
const napcatCalls = []
const napcatServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    const action = String(req.url || '').replace(/^\//, '').split('?')[0]
    let parsed = null
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      parsed = { raw: body }
    }
    napcatCalls.push({ action, body: parsed })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
  })
})
await new Promise((resolve) => napcatServer.listen(0, '127.0.0.1', resolve))
const napcatPort = napcatServer.address().port
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qq-smoke-'))
const disposers = []
const tools = new Map()
const commands = []
const listeners = new Map()
const logs = []

const log = {
  debug: (...a) => logs.push(['debug', ...a]),
  info: (...a) => logs.push(['info', ...a]),
  warn: (...a) => logs.push(['warn', ...a]),
  error: (...a) => logs.push(['error', ...a]),
}

const ctx = {
  logger: log,
  effect(fn, label) {
    let dispose
    try {
      dispose = fn()
    } catch (error) {
      console.error(`✗ effect(${label}) 抛错：`, error)
      process.exitCode = 1
      return () => {}
    }
    const d = () => {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
    disposers.push(d)
    return d
  },
  get: () => undefined,
  on: (event, handler) => {
    const list = listeners.get(event) || []
    list.push(handler)
    listeners.set(event, list)
  },
  tools: {
    register: (def) => tools.set(def.name, def),
  },
  commands: {
    register: (def) => commands.push(def),
  },
  sessionController: {
    list: async () => ({
      items: [
        {
          sessionId: 'smoke-session',
          cwd: dataDir,
          running: false,
          updatedAt: Date.now(),
          projections: { values: { title: 'smoke session' } },
        },
      ],
    }),
    create: async () => ({ sessionId: 'smoke-session' }),
    inspect: async () => ({ sessionId: 'smoke-session' }),
    prompt: async () => ({}),
    rename: async () => ({}),
    modelCatalog: async () => ({ models: [] }),
    projections: async () => ({}),
    selectModel: async () => ({}),
  },
  workingDirectory: {},
}

const cfg = {
  napcatUrl: `http://127.0.0.1:${napcatPort}`,
  listenPort: PORT,
  allowUins: ['10001'],
  dataDir,
  group: { enabled: false, allowGroups: [] },
}

// 先写一份「已经接过线」的状态，这样启动时就会绑上 smoke-session。
await writeFile(
  path.join(dataDir, 'state.json'),
  `${JSON.stringify({ sessionId: 'smoke-session', ownerUin: '10001' }, null, 2)}\n`,
  'utf8',
)

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}

function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// 0. 纯函数（不依赖宿主，坏了最容易一路带到线上）
eq(parseAnswer('允许'), 'allowed-once', 'parseAnswer(允许)')
eq(parseAnswer('拒绝'), 'rejected', 'parseAnswer(拒绝)')
eq(parseAnswer('好啊'), undefined, 'parseAnswer(好啊)')
eq(splitText('abcdef', 3).join('|'), 'abc|def', 'splitText 基本分段')
const emojiChunks = splitText('😀😀😀', 3)
eq(emojiChunks.length, 3, 'splitText 三段 emoji')
eq(emojiChunks.every((c) => c.length === 2), true, 'splitText 不切代理对')
eq(plainText('## 标题\n**粗** `码`'), '标题\n粗 码', 'plainText 去 Markdown')
eq(messageText({ message: [{ type: 'text', data: { text: ' 嗨 ' } }] }), '嗨', 'messageText 取字')
const conf = resolveConfig({ allowUins: [' 42 ', ''], maxChars: 900 })
eq(conf.maxChars, 900, 'resolveConfig 保留 maxChars')
eq([...conf.allowed].join(','), '42', 'resolveConfig 规整 allowUins')
eq(describeConfig({ group: { enabled: true } }).explicitGroup.join(','), 'enabled', 'describeConfig 报显式键')
eq(resolveConfig({ group: { requireMention: false } }).cfg.group.maxPerMinute, DEFAULTS.group.maxPerMinute, '深合并保留 group 默认值')
eq(resolveConfig({ group: { cloud: { enabled: false } } }).cfg.group.cloud.timeoutMs, DEFAULTS.group.cloud.timeoutMs, '深合并保留 group.cloud 默认值')
if (!process.exitCode) console.log('✓ 纯函数断言通过')

// 1. 两个子系统的装配（不跑业务，只确认工厂返回了该有的东西）
const stubLog = { debug() {}, info() {}, warn() {}, error() {} }
const groupCfg = { ...DEFAULTS.group }
const media = createMedia({
  callApi: async () => undefined,
  log: stubLog,
  cfg: { ...DEFAULTS, dataDir },
  groupCfg,
  recordError: async () => {},
})
const mediaKeys = ['pieceLabel', 'sniffImageExt', 'harvestSticker', 'expandForward', 'transcribeVoice', 'saveImageToInbox', 'imagePart']
for (const k of mediaKeys) if (typeof media[k] !== 'function') fail(`media.${k} 没返回`)
const group = createGroup({
  cfg: { ...DEFAULTS, dataDir },
  groupCfg,
  log: stubLog,
  callApi: async () => undefined,
  postJson: async () => ({}),
  getJson: async () => ({}),
  sleep: async () => {},
  recordError: async () => {},
  media,
  plainText,
  splitText,
  messageText,
})
for (const k of ['handleGroupEvent', 'groupModelCommandReply', 'groupReplyCommandReply', 'importStickers']) {
  if (typeof group[k] !== 'function') fail(`group.${k} 没返回`)
}
if (!process.exitCode) console.log('✓ media / group 装配正常')

// activity：它订阅事件、再拼一张小票
const { createActivity } = await import('../src/activity.js')
const activity = createActivity({ ctx, sessionRows: async () => ({ rows: [], hiddenNoise: 0 }) })
if (typeof activity.activitySnapshot !== 'function') fail('activity.activitySnapshot 没返回')
else {
  const text = await activity.activitySnapshot('')
  if (!String(text).includes('会话任务')) fail('activitySnapshot 没出标题')
}

// prompts：审批/提问只挂一件待办，空的时候不能乱 settle
const { createPrompts } = await import('../src/prompts.js')
const prompts = createPrompts({
  ctx,
  log: stubLog,
  sendText: async () => 1,
  getSessionId: () => 'smoke-session',
  getOwnerUin: () => '10001',
  parseAnswer,
})
if (prompts.hasApproval() || prompts.hasQuestion()) fail('prompts 初始状态不该有待办')
prompts.settleApproval('allowed-once')
prompts.cancelAll()
for (const k of ['hasApproval', 'hasQuestion', 'settleApproval', 'settleQuestion', 'cancelAll', 'forwardApproval', 'forwardQuestion']) {
  if (typeof prompts[k] !== 'function') fail(`prompts.${k} 没返回`)
}
if (!process.exitCode) console.log('✓ activity / prompts 装配正常')

// model：换模型和窗口看护
const { createModelPicker } = await import('../src/model.js')
const picker = createModelPicker({
  ctx,
  log: stubLog,
  groupCfg: DEFAULTS.group,
  DEFAULTS,
  getJson: async () => ({}),
  sendText: async () => 1,
  getOwnerUin: () => '10001',
  ensureSession: async () => 'smoke-session',
})
for (const k of ['modelCommandReply', 'watchLocalContext', 'currentModelSelection', 'applyModelSelection', 'loadModelCatalog']) {
  if (typeof picker[k] !== 'function') fail(`model.${k} 没返回`)
}
if (!process.exitCode) console.log('✓ model 装配正常')

try {
  apply(ctx, cfg)
} catch (error) {
  fail(`apply() 抛异常：${error?.stack || error}`)
}

// 1. 工具
const expected = [
  'qq_activity',
  'qq_bind_session',
  'qq_call_workspace',
  'qq_hangup',
  'qq_list_sessions',
  'qq_send_file',
  'qq_status',
  'qq_workspaces',
]
const missing = expected.filter((n) => !tools.has(n))
for (const n of missing) fail(`工具没注册：${n}`)
if (!missing.length) console.log(`✓ 工具 ${tools.size} 个全部注册`)

// 1b. 参数校验：宿主不校验 schema，工具层必须自己挡
const sendFile = tools.get('qq_send_file')
if (!sendFile) fail('拿不到 qq_send_file')
else {
  const bad = await sendFile.execute({ file: 123 }, { agent: { id: 'smoke-session' } })
  if (bad?.ok !== false) fail('坏参数没有被挡住（应为 ok:false）')
  else console.log('✓ 坏参数被挡（ok:false，不抛异常）')
}

// 1c. 合法参数不能被校验误伤（曾经因为校验递归爆栈，所有工具都返回"参数不合法"）
{
  const t = tools.get('qq_status')
  const res = await t.execute({}, { agent: { id: 'smoke-session' } })
  const txt = JSON.stringify(res)
  if (txt.includes('参数不合法')) fail('合法参数被校验误伤：' + txt)
  else console.log('✓ 合法参数通过校验（qq_status 正常返回）')
}

// 2. 命令
const commandNames = commands.map((c) => String(c.name || c.command || ''))
if (commandNames.includes('qq')) console.log('✓ /qq 命令已注册')
else fail(`/qq 命令没注册（注册到的是：${commandNames.join(', ') || '空'}）`)

// 3. 入站监听
await new Promise((r) => setTimeout(r, 400))
let inbound = false
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }),
    signal: AbortSignal.timeout(3000),
  })
  inbound = res.status === 204
  if (!inbound) fail(`入站端口回了 ${res.status}，期望 204`)
  else console.log(`✓ 入站监听 127.0.0.1:${PORT} 正常（204）`)
} catch (error) {
  fail(`入站端口连不上：${error.message}`)
}

// 4. 会话事件订阅
if (listeners.has('session/event')) console.log('✓ 已订阅 session/event')
else console.warn('· 没订阅 session/event（会话回复可能收不到）')

// 5. 入站端到端：真的递一条私聊消息进去，看它有没有走到 prompt。
//    NapCat 指向一个死端口，所以发送必然失败——这不影响判断：我们要看的是
//    路由（白名单 → 接线 → 投递）有没有断。
const promptCalls = []
ctx.sessionController.prompt = async (args) => {
  promptCalls.push(args)
  return {}
}
try {
  await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: 999,
      user_id: 10001,
      raw_message: '在吗',
      message: [{ type: 'text', data: { text: '在吗' } }],
      sender: { user_id: 10001, nickname: 'smoke' },
    }),
    signal: AbortSignal.timeout(3000),
  })
} catch (error) {
  fail(`入站投递失败：${error.message}`)
}
await new Promise((r) => setTimeout(r, 1500))
if (promptCalls.length > 0) {
  const call = promptCalls[0]
  if (!String(call.sessionId || '').trim()) fail('prompt 调用没有 sessionId')
  else console.log(`✓ 入站消息走到了 prompt（session ${String(call.sessionId).slice(-8)}）`)
} else {
  const tail = logs
    .filter(([level]) => level === 'warn' || level === 'error')
    .slice(-6)
    .map(([level, ...rest]) => `   ${level}: ${rest.map((v) => (v instanceof Error ? v.message : String(v))).join(' ')}`)
  fail(`入站消息没有走到 prompt：路由断了\n${tail.join('\n')}`)
}

// 6. 白名单之外的人说话：必须一行代码都不进会话。
const before = promptCalls.length
try {
  await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      self_id: 999,
      user_id: 20002,
      raw_message: '陌生人',
      message: [{ type: 'text', data: { text: '陌生人' } }],
      sender: { user_id: 20002, nickname: 'stranger' },
    }),
    signal: AbortSignal.timeout(3000),
  })
} catch (error) {
  fail(`陌生人消息投递失败：${error.message}`)
}
await new Promise((r) => setTimeout(r, 800))
if (promptCalls.length === before) console.log('✓ 白名单外的消息被丢弃（没进会话）')
else fail('白名单外的消息居然进了会话')



// 7. 回复回路：模拟 DSH 抛出 session/event，看文本能不能一路回到 QQ。
napcatCalls.length = 0
const sessionHandlers = listeners.get('session/event') || []
const smokeSession = { id: 'smoke-session' }
for (const handler of sessionHandlers) {
  handler(smokeSession, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '收到，我在' }] } },
  })
}
for (const handler of sessionHandlers) {
  handler(smokeSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'done' } } })
}
await new Promise((r) => setTimeout(r, 600))
const replied = napcatCalls.filter(
  (call) => call.action === 'send_private_msg' && JSON.stringify(call.body).includes('收到，我在'),
)
if (replied.length > 0) console.log('✓ 回复回路通（assistant 文本经 NapCat 发回聊天）')
else fail('回复没有回到 QQ：session/event → sendText 这段断了')

// 收拾
for (const d of disposers.reverse()) d()
try {
  napcatServer.close()
} catch {
  /* ignore */ }
try {
  await rm(dataDir, { recursive: true, force: true })
} catch {
  /* ignore */
}

if (process.exitCode) {
  console.error('\n冒烟测试失败')
} else {
  console.log('\n冒烟测试通过')
}
process.exit(process.exitCode || 0)
