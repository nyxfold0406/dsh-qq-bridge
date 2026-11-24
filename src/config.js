// 插件的全部默认值 + 配置归一化。
//
// 合并语义：**深合并**（deepMerge）。普通对象逐键递归，数组和标量直接替换。
//
// 历史是浅合并，但 group 与 group.cloud 在各自使用的地方（现在分别是
// src/group.js 和它对 cloud 的处理）都还会再合一次默认值，所以线上行为
// 一直是对的。2026-11-11 复核过：早先「群聊 requireMention 会变 undefined」
// 和「group.cloud 会丢默认值」两个判断都是错的，已从文档里删掉。
// 把合并做进配置层，只是让这件事不再依赖调用方记得补那一层。
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULTS = {
  napcatUrl: 'http://127.0.0.1:3000',
  listenPort: 6721,
  // 入站令牌：非空时 NapCat 的 post_url 必须写成 http://127.0.0.1:<port>/<token>。
  // 留空 = 不带令牌（仍然拒绝非 JSON、拒绝带 Origin 的请求）。
  ingressToken: '',
  allowUins: [],
  accessToken: '',
  dataDir: path.join(os.homedir(), '.dsh', 'qq'),
  // 单条太长时 QQ 那一侧容易发不出去（2026-11-10 20:32 一条两千字的消息
  // 触发了「没有可用的网络适配器」，随后进程退出）。切小一点更稳。
  maxChars: 600,
  workspacesRoot: path.join(os.homedir(), 'AGENTS'),
  switchboardDir: 'Switchboard',
  // 桌面待办小窗的数据目录（todos.txt / classes.txt / events.txt / cfg.txt）。
  // 空 = /日程、/待办 不启用。桥只读它，不写：改数据走小窗或 py todo.py。
  todoAppDir: '',
  // /日程 默认看几天（从今天算，含今天）。
  scheduleDays: 7,
  pythonPath: 'python',
  sttScript: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'stt.py'),
  sttModel: 'small',
  // 日志级别：debug / info / warn / error；同时落 dataDir/bridge.log
  logLevel: 'info',
  // 审批是否可以在 QQ 上答（true 会挡住电脑前的审批卡片）
  approvalViaQq: true,
  // 收图：11-08 的日志证明图片能读到（回复引用了截图里的细节），所以默认开着。
  // 11-10 20:23 收图后 NapCat 掉线，原因没法归到收图上；取图加超时兜底，
  // 真出问题可以改成 false 停掉。
  intakeImages: true,
  imageTimeoutMs: 10_000,
  // 这条消息走的是 QQ：他在不在电脑前不确定，但「不能自己操作电脑」是事实。
  // 只陈述这一点，审批/确认照旧交给他，并让他先问一句在不在。
  remoteHint: true,
  remoteHintEveryMs: 3_600_000,
  remoteHintText:
    '【这条走 QQ：他没法直接操作这台电脑。需要他本人点确认、看屏幕、审批的，先问他在不在电脑前，别替他按。】',
  group: {
    enabled: false,
    allowGroups: [],
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'qwen/qwen3-4b-2507',
    wakeWords: [],
    temperature: 0.6,
    maxTokens: 220,
    timeoutMs: 20000,
    history: 8,
    maxPerMinute: 3,
    maxChars: 220,
    cooldownMs: 1500,
    // false = answer every message in an allowed group; true = only @ / wake word.
    requireMention: true,
    systemPrompt: '',
    persona: '',
    facts: [],
    summaryEvery: 6,
    // 表情：图片表情包放 stickersDir，用文件名当「表情名」；也支持 QQ 自带表情 face:N。
    stickersEnabled: true,
    stickersDir: path.join(os.homedir(), '.dsh', 'qq', 'stickers'),
    // 入库：把图丢进这个目录，然后在 QQ 里发「/导入表情」，文件名就是表情名。
    stickersInbox: path.join(os.homedir(), '.dsh', 'qq', 'stickers-inbox'),
    memoryFile: '',
    cloud: {
      enabled: true,
      baseUrl: 'https://api.deepseek.com/v1',
      keyFile: '',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      maxTokens: 600,
      timeoutMs: 60000,
      // deepseek-flash is a reasoning model: unless told otherwise it spends
      // the whole budget thinking and returns an empty answer.
      disableThinking: true,
    },
  },
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 深合并：普通对象逐键递归，数组与标量直接替换。
 * 历史版本是浅合并，但 group / group.cloud 在用到的地方还会各自再合一次
 * 默认值，所以线上行为一直是对的；这里把合并做进配置层，只是让「只写了几个
 * 子键」这件事不再依赖调用方记得补一层。
 */
export function deepMerge(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value
  }
  return out
}

/**
 * 归一化一份原始配置，返回运行时要用到的派生值。
 * 合并语义：深合并（见 deepMerge）+ allowUins 规整 + maxChars 下限。
 */
export function resolveConfig(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {})
  const allowed = new Set(
    (cfg.allowUins || []).map((v) => String(v).trim()).filter(Boolean),
  )
  const maxChars = Number(cfg.maxChars) > 200 ? Number(cfg.maxChars) : DEFAULTS.maxChars
  const stateFile = path.join(cfg.dataDir, 'state.json')
  return { cfg, allowed, maxChars, stateFile }
}

/**
 * 配置体检：列出这份配置显式写了哪些键（其余都来自默认值）。
 * 只读，不改任何东西；给 README 和 scripts/smoke.mjs 用。
 */
export function describeConfig(raw) {
  const explicitTop = Object.keys(raw || {}).filter((k) => k in DEFAULTS)
  const group = (raw && raw.group) || {}
  const explicitGroup = Object.keys(group)
  const explicitCloud = Object.keys(group.cloud || {})
  return { explicitTop, explicitGroup, explicitCloud }
}
