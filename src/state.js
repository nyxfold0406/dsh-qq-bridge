// 状态与绑定：state.json 读写、审计流水，以及「谁有权改绑定 / 谁有权往外发」。
//
// 绑定是整套东西的根：QQ 的消息进哪个会话、哪个会话能发消息出去，都看它。
// 所以写入口只有 setBinding 一个，每次写都落 state.json + bind.log。
//
// 可变状态不归这里：sessionId / lilySessionId / ownerUin 由桥持有，通过
// accessors（get/set）进出，避免同一份状态被两个模块各记一份。
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.cfg
 * @param {object} deps.log
 * @param {Function} deps.sendText
 * @param {string} deps.stateFile
 * @param {object} deps.DEFAULTS
 * @param {object} deps.state      { sessionId, lilySessionId, ownerUin } 的 get/set 访问器
 * @param {Function} deps.recordError
 * @param {Function} deps.archivedSessionIds
 * @param {Function} deps.sessionRows
 * @param {Function} deps.ensureWorkspaceId
 */
export function createStateStore({
  ctx,
  cfg,
  log,
  sendText,
  stateFile,
  DEFAULTS,
  state,
  recordError,
  archivedSessionIds,
  sessionRows,
  ensureWorkspaceId,
}) {
  // ---------------------------------------------------------------- state ---

  async function loadState() {
    try {
      const raw = await readFile(stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  // 串行化写：loadState → 合并 → 写 这三步并发会丢键，用一条 Promise 链排队。
  let writeChain = Promise.resolve()

  async function saveState(patch) {
    const run = writeChain.then(() => persistState(patch), () => persistState(patch))
    writeChain = run.catch(() => {})
    return run
  }

  async function persistState(patch) {
    try {
      const current = await loadState()
      const next = { ...current, ...patch }
      await mkdir(cfg.dataDir, { recursive: true })
      await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      log.warn(`bridge: state write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Append one line to the binding audit trail: who changed what, when. */
  async function appendAudit(entry) {
    try {
      await mkdir(cfg.dataDir, { recursive: true })
      await appendFile(path.join(cfg.dataDir, 'bind.log'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* audit must never break the bridge */
    }
  }

  /**
   * The single writer for the current binding. Every entry point goes through
   * here so it is audited and the owner gets a confirmation on QQ.
   */
  async function setBinding(nextId, source, actorId) {
    const previous = state.sessionId ? String(state.sessionId) : ''
    state.sessionId = nextId ? String(nextId) : undefined
    await saveState({ sessionId: state.sessionId || '' })
    await appendAudit({
      at: new Date().toISOString(),
      from: previous.slice(-8) || '(none)',
      to: state.sessionId ? state.sessionId.slice(-8) : '(none)',
      source,
      actor: actorId ? String(actorId) : '(unknown)',
    })
    const label = state.sessionId ? `…${state.sessionId.slice(-8)}` : '（未接通）'
    sendText(state.ownerUin, `已切换到 ${label}（来源：${source}）`).catch(() => {})
    return state.sessionId
  }

  /** Only the switchboard (Lily) may move the binding from an agent tool. */
  function mayRebind(exec) {
    const actor = String(exec?.agent?.id || '')
    if (!actor) return false
    // The switchboard always may.
    if (actor === String(state.lilySessionId || '')) return true
    // Whoever currently holds the call may hang itself up; without this a
    // forwarded session could never hand the phone back.
    return Boolean(state.sessionId) && actor === String(state.sessionId)
  }

  /**
   * Outbound pushes (text / files) are only open to the session currently on
   * the line. The binding is read from state.json on every call: an in-memory
   * copy goes stale as soon as a hangup or rebind happens, and a stale bridge
   * instance would otherwise keep forwarding files for a call that ended.
   */
  async function mayEmit(exec) {
    const actor = String(exec?.agent?.id || '')
    if (!actor) return false
    let bound = ''
    try {
      const saved = await loadState()
      bound = String(saved.sessionId || '')
    } catch {
      bound = ''
    }
    if (!bound) return false
    if (actor === bound) return true
    await recordError(
      'emit.denied',
      new Error(`actor=${actor.slice(-8)} bound=${bound.slice(-8)}`),
    )
    return false
  }

  const EMIT_DENIED =
    '这个会话没有接通 QQ，不能往外发东西。要发消息或文件，先把它接到 QQ 上（Lily 那边说「接 N」）。'

  /** Lily is replaced on every hangup, so she gets generational numbering. */
  function lilyTitle(generation) {
    return `controlV0.${generation}`
  }

  /** Keep the live switchboard's display name in sync with its generation. */
  async function ensureLilyTitle() {
    const saved = await loadState()
    const lily = state.lilySessionId || String(saved.lilySessionId || '')
    if (!lily) return

    // Someone archived the switchboard (sidebar cleanup, another agent). The
    // binding would then point at a dead session, so open the next one here.
    const archived = await archivedSessionIds()
    if (archived.has(String(lily))) {
      try {
        const gen = await nextLilyGeneration()
        const lilyCwd = `${cfg.workspacesRoot || DEFAULTS.workspacesRoot}\\${cfg.switchboardDir || DEFAULTS.switchboardDir}`
        const workspaceId = await ensureWorkspaceId(lilyCwd)
        const created = await ctx.sessionController.create(
          workspaceId ? { workspaceId } : { cwd: lilyCwd },
        )
        const fresh = String(created.sessionId)
        try {
          await ctx.sessionController.rename({ sessionId: fresh, title: lilyTitle(gen) })
        } catch {
          /* cosmetic */
        }
        state.lilySessionId = fresh
        state.sessionId = fresh
        await saveState({ lilyGeneration: gen, lilySessionId: fresh, sessionId: fresh })
        await appendAudit({
          at: new Date().toISOString(),
          from: String(lily).slice(-8),
          to: fresh.slice(-8),
          source: 'auto:switchboard-archived',
          actor: 'plugin',
        })
        log.warn?.(`bridge: switchboard was archived; opened ${lilyTitle(gen)}`)
      } catch (error) {
        log.warn?.(
          `bridge: failed to reopen switchboard: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return
    }

    const want = lilyTitle(Number(saved.lilyGeneration) || 1)
    try {
      const { rows } = await sessionRows(false)
      const row = rows.find((r) => r.sessionId === String(lily))
      if (row && row.title !== want) {
        await ctx.sessionController.rename({ sessionId: lily, title: want })
        log.info?.(`bridge: switchboard renamed to ${want}`)
      }
    } catch {
      /* renaming is cosmetic */
    }
  }

  async function nextLilyGeneration() {
    const saved = await loadState()
    return (Number(saved.lilyGeneration) || 0) + 1
  }

  const REBIND_DENIED =
    '这个会话无权改 QQ 绑定。只有 Lily 总机可以——在 QQ 上对 Lily 说「接 N」或「新 N」，或者在这里敲 /qq bind。'

  // ------------------------------- media（src/media.js，在 groupCfg 之后创建）---
  return {
    loadState,
    saveState,
    appendAudit,
    setBinding,
    mayRebind,
    mayEmit,
    EMIT_DENIED,
    REBIND_DENIED,
    lilyTitle,
    ensureLilyTitle,
    nextLilyGeneration,
  }
}
