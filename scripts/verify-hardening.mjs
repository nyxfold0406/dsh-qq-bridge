#!/usr/bin/env node
// 硬性验证：把「评审里那几条安全修复」逐条打一遍，不靠嘴说。
//
//   node scripts/verify-hardening.mjs
//
// 它起一个真的桥实例（临时目录 + 假 NapCat），然后按攻击者的方式发请求，
// 断言每一条都被挡住，或者被挡得刚刚好。
import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { parseAnswer } from '../src/text.js'

const PORT = Number(process.env.QQ_VERIFY_PORT || 6791)
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qq-verify-'))
const results = []
const log = { debug() {}, info() {}, warn() {}, error() {} }

const napcat = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }))
  })
})
await new Promise((r) => napcat.listen(0, '127.0.0.1', r))

const disposers = []
const ctx = {
  logger: log,
  effect(fn) {
    const d = fn()
    disposers.push(() => {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* ignore */
      }
    })
    return () => {}
  },
  get: () => undefined,
  on: () => {},
  tools: { register: () => {} },
  commands: { register: () => {} },
  sessionController: {
    list: async () => ({ items: [] }),
    create: async () => ({ sessionId: 'verify-session' }),
    inspect: async () => ({ meta: { id: 'verify-session' } }),
    prompt: async () => ({}),
    rename: async () => ({}),
    modelCatalog: async () => ({ groups: [] }),
    projections: async () => ({}),
    selectModel: async () => ({}),
  },
  workingDirectory: {},
}

const baseCfg = {
  napcatUrl: `http://127.0.0.1:${napcat.address().port}`,
  listenPort: PORT,
  allowUins: ['10001'],
  dataDir,
  ingressToken: 'sekret',
  group: { enabled: false, allowGroups: [] },
}
await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ sessionId: '', ownerUin: '' }), 'utf8')
apply(ctx, baseCfg)
await new Promise((r) => setTimeout(r, 300))

const event = JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  raw_message: '在吗',
  message: [{ type: 'text', data: { text: '在吗' } }],
  sender: { user_id: 10001 },
})

async function probe(name, { urlPath = '/', headers = {}, body = event, method = 'POST' }) {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(3000),
  }).catch((e) => ({ status: 'ERR ' + e.message }))
  results.push({ name, status: res.status })
  return res.status
}

function check(name, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? '✓' : '✗'} ${name}  → ${actual}${ok ? '' : `（期望 ${expected}）`}`)
  if (!ok) process.exitCode = 1
}

// 1. 浏览器伪造：带 Origin
check('带 Origin 的请求被拒', await probe('origin', { headers: { origin: 'https://evil.example' } }), 403)
// 2. 浏览器简单请求：text/plain（伪造时浏览器只能发这个）
check(
  '非 JSON content-type 被拒',
  await probe('plain', { headers: { 'content-type': 'text/plain' } }),
  415,
)
// 3. 令牌：不带 / 走错路径
check('未带令牌的路径被拒', await probe('no-token', { urlPath: '/', body: event }), 404)
check('错误令牌被拒', await probe('bad-token', { urlPath: '/nope', body: event }), 404)
// 4. 正确令牌放行
check('正确令牌放行', await probe('good-token', { urlPath: '/sekret', body: event }), 204)
// 5. 非 POST
check('GET 被拒', await probe('get', { method: 'GET' }), 405)

// 6. 审批词收紧
check('parseAnswer(允许) = allowed-once', parseAnswer('允许'), 'allowed-once')
check('parseAnswer(1) 不再放行', parseAnswer('1'), undefined)
check('parseAnswer(ok) 不再放行', parseAnswer('ok'), undefined)
check('parseAnswer(是) 不再放行', parseAnswer('是'), undefined)
check('parseAnswer(拒绝) = rejected', parseAnswer('拒绝'), 'rejected')

// 收尾
for (const d of disposers.reverse()) d()
await new Promise((r) => setTimeout(r, 100))
napcat.close()
await rm(dataDir, { recursive: true, force: true }).catch(() => {})

console.log(process.exitCode ? '\n硬性验证失败' : '\n硬性验证通过：6 类请求 + 5 条审批词')
process.exit(process.exitCode || 0)
