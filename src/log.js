// 分级日志：把 ctx.logger 的输出同时落一份文件，供事后排查。
//
// 为什么需要它：DSH 的日志只活在宿主进程里，重启就没了。桥出问题的时候
// 往往已经重启过一次，能看的东西只剩 %USERPROFILE%\.dsh\qq\last-error.txt
// 那一条。这里补一份带时间戳、带级别的流水（默认 2MB 滚一个）。
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_BYTES = 2 * 1024 * 1024

function fmtValue(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * @param {object} ctx  插件上下文（用 ctx.logger 做一级转发）
 * @param {object} cfg  归一化后的配置（用 dataDir / logLevel）
 */
export function createLogger(ctx, cfg = {}) {
  const base = ctx?.logger
  const min = LEVELS[String(cfg.logLevel || 'info').toLowerCase()] ?? LEVELS.info
  const file = path.join(cfg.dataDir || '.', 'bridge.log')
  let ready = false
  let chain = Promise.resolve()

  function write(line) {
    chain = chain.then(async () => {
      try {
        if (!ready) {
          await mkdir(path.dirname(file), { recursive: true })
          ready = true
        }
        const st = await stat(file).catch(() => null)
        if (st && st.size > MAX_BYTES) await rename(file, `${file}.1`).catch(() => {})
        await appendFile(file, line, 'utf8')
      } catch {
        /* 写日志不许把桥搞挂 */
      }
    })
    return chain
  }

  function emit(level) {
    return (...args) => {
      if (LEVELS[level] < min) return
      try {
        const fn = base?.[level]
        if (typeof fn === 'function') fn.call(base, ...args)
      } catch {
        /* 宿主的 logger 出问题也不该影响到桥 */
      }
      const msg = args.map(fmtValue).join(' ')
      write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`)
    }
  }

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    /** 日志文件路径，给 qq_status / 排障用 */
    file,
  }
}
