// 会话：接线、投递、列会话、开总机、挂断。
//
// 这一层不做 QQ 协议的事，只跟 DSH 的 sessionController 打交道。所有函数都
// 以 sessionId 为参数或以 state 里的当前绑定为准，不自己缓存第二份。
//
// 「接线」的含义：state.sessionId 指向哪个会话，QQ 来的消息就投给哪个。
// 空 = 没接线；投递前会先确认那个会话还活着（未被归档/删除），否则回落到总机。
import { mkdir, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULTS } from './config.js'

/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.cfg
 * @param {object} deps.log
 * @param {Function} deps.sendText
 * @param {object} deps.state      { sessionId, lilySessionId, ownerUin } 的 get/set
 * @param {Function} deps.recordError
 * @param {Function} deps.loadState
 * @param {Function} deps.saveState
 * @param {Function} deps.appendAudit
 * @param {Function} deps.setBinding
 * @param {Function} deps.lilyTitle
 * @param {Function} deps.nextLilyGeneration
 */
export function createSession({
  ctx,
  cfg,
  log,
  sendText,
  state,
  recordError,
  loadState,
  saveState,
  appendAudit,
  setBinding,
  lilyTitle,
  nextLilyGeneration,
}) {
  // 「他在手机上」这句提示：每个绑定最多每小时说一次，别每条消息都烧 token。
  let remoteHintSession = ''
  let remoteHintAt = 0

  async function ensureSession() {
    if (state.sessionId) return state.sessionId
    const saved = await loadState()
    if (saved.ownerUin) state.ownerUin = String(saved.ownerUin)
    if (saved.lilySessionId) state.lilySessionId = String(saved.lilySessionId)

    // Try the stored binding first, then the switchboard. A session id from a
    // previous DSH process no longer exists, so falling back keeps the bridge
    // answering instead of erroring on every message.
    const ordered = [saved.sessionId, saved.lilySessionId]
      .map((v) => (v ? String(v) : ''))
      .filter((v, i, arr) => v && arr.indexOf(v) === i)
    for (const candidate of ordered) {
      try {
        if (await sessionExists(candidate)) {
          state.sessionId = candidate
          if (candidate !== String(saved.sessionId || '')) {
            log.warn(`bridge: stored binding ${String(saved.sessionId || '').slice(-8)} is gone; using ${candidate.slice(-8)}`)
            await saveState({ sessionId: candidate })
            await appendAudit({
              at: new Date().toISOString(),
              from: String(saved.sessionId || '').slice(-8) || '(none)',
              to: candidate.slice(-8),
              source: 'auto:binding-missing',
              actor: 'plugin',
            })
          }
          return state.sessionId
        }
      } catch {
        /* try the next candidate */
      }
    }
    throw new Error('还没有接线：在会话里 /qq bind，或者新建一个总机')
  }

  /** Whether the target session currently has a turn in flight. */
  async function isSessionBusy(sid) {
    try {
      const controller = new AbortController()
      const listed = await ctx.sessionController.list({}, controller.signal)
      const row = (Array.isArray(listed?.items) ? listed.items : []).find(
        (s) => String(s.sessionId) === String(sid),
      )
      return Boolean(row?.running)
    } catch {
      return false
    }
  }

  async function promptSession(text, options = {}) {
    // 桥可能被实例化多份：收消息那份内存里的绑定可能已经过时（内存里还认旧会话，
    // 却看不到 qq_bind_session 改过的 state.json）。投递前一律以记事本为准。
    const persisted = await loadState()
    const onDisk = persisted && persisted.sessionId ? String(persisted.sessionId) : ''
    if (onDisk && onDisk !== String(state.sessionId || '')) {
      state.sessionId = onDisk
      log.info?.(`bridge: adopted persisted binding ${state.sessionId}`)
    }
    let sid = await ensureSession()
    // The bound session may have been archived or deleted since the last
    // message. Delivering there would end the turn as `blocked` with no reply,
    // so hand the chat back to the switchboard instead.
    if (!(await sessionUsable(sid))) {
      const fellBack = await rebindToSwitchboard(sid, 'auto:binding-unusable')
      if (fellBack) {
        sid = fellBack
        if (options.quiet !== true) {
          sendText(
            state.ownerUin,
            '原来接的那个会话不在了（被删或归档），已经转回总控。',
          ).catch(() => {})
        }
      }
    }
    const busy = await isSessionBusy(sid)
    // A busy session would swallow the message until its turn ends. Say so
    // immediately instead of leaving the owner staring at a silent chat.
    if (busy && options.quiet !== true) {
      sendText(state.ownerUin, '收到，这边手头那轮还没跑完，消息排着了，跑完就回你。').catch(() => {})
    }
    // Hangup-style instructions jump the queue: waiting behind a long turn
    // would make them useless.
    const mode = busy && options.steer === true ? 'steer' : 'queue'
    const controller = new AbortController()
    // Text and images ride in one prompt: DSH accepts image parts with base64
    // data, so a photo from the phone reaches the session as a real image.
    const content = []
    // The model must know the sender is on a phone, not at this machine, or it
    // will plan steps that require someone to click/confirm on screen.
    // Say it once per binding (and at most hourly): repeating it every message
    // burns tokens for something the session keeps in history anyway.
    const hintNow = Date.now()
    const hintEvery = Number(cfg.remoteHintEveryMs) || DEFAULTS.remoteHintEveryMs
    const hintDue =
      cfg.remoteHint !== false &&
      options.remoteHint !== false &&
      (String(sid) !== remoteHintSession || hintNow - remoteHintAt > hintEvery)
    if (hintDue) {
      content.push({
        type: 'text',
        text: String(cfg.remoteHintText || DEFAULTS.remoteHintText),
      })
      remoteHintSession = String(sid)
      remoteHintAt = hintNow
    }
    if (String(text || '').trim()) content.push({ type: 'text', text })
    for (const part of Array.isArray(options.parts) ? options.parts : []) content.push(part)
    if (content.length === 0) content.push({ type: 'text', text: '（空消息）' })
    try {
      await ctx.sessionController.prompt(
        {
          requestId: `qq-${Date.now()}-${randomUUID().slice(0, 8)}`,
          sessionId: sid,
          mode,
          content,
        },
        controller.signal,
      )
    } catch (error) {
      await recordError('session.prompt', error)
      throw error
    }
  }

  /** One canonical, phone-friendly session list shared by the QQ tools. */
  async function sessionRows(includeNoise = false) {
    const controller = new AbortController()
    const [listed, archived] = await Promise.all([
      ctx.sessionController.list({}, controller.signal),
      archivedSessionIds(),
    ])
    const all = Array.isArray(listed?.items) ? listed.items : []
    const titleOf = (s) => String(s?.projections?.values?.title || '')
    const kept = includeNoise
      ? all
      : all.filter((s) => {
          const id = String(s.sessionId)
          // The bound switchboard must never be hidden, even while its title
          // is still settling right after creation.
          if (state.sessionId && id === String(state.sessionId)) return true
          if (archived.has(id)) return false
          if (s?.blank) return false
          const t = titleOf(s)
          // 历代总机（controlV0.69/70/71…）不该跟正常会话挤在同一个列表里，
          // 只留当前绑定的那一个。要全看用 /任务 all。
          if (/^controlV0\.[0-9]+$/i.test(t)) return false
          if (/^\[dsh-mnemon/i.test(t)) return false
          if (/^[0-9a-f]{6,12}$/i.test(t)) return false
          if (!t && !s?.running) return false
          return true
        })
    const rows = kept.map((s) => {
      const values = s?.projections?.values || {}
      return {
        sessionId: String(s.sessionId),
        short: String(s.sessionId).slice(-8),
        title: String(values.title || ''),
        cwd: s.cwd ? String(s.cwd) : '',
        running: Boolean(s.running),
        updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : '',
        bound: state.sessionId ? String(s.sessionId) === String(state.sessionId) : false,
        // Raw projections: goal / plan / agentTeam / subagent survive a Host
        // restart, so the activity snapshot still has something to say about a
        // session that has emitted no event since this plugin mounted.
        values,
      }
    })
    return { rows, hiddenNoise: all.length - kept.length }
  }

  /** Session ids the user archived; those must not show up in the QQ list. */
  async function archivedSessionIds() {
    try {
      const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      const ids = parsed?.global?.archivedSessionIds
      return new Set(Array.isArray(ids) ? ids.map(String) : [])
    } catch {
      return new Set()
    }
  }

  /**
   * Whether a session can still take a turn: it exists and the user has not
   * archived it. An archived session is not "gone" — the core still answers for
   * it — but DSH's archived-session gate ends every turn as `blocked` before a
   * model request, so a message delivered there is silently swallowed.
   */
  async function sessionUsable(sid) {
    const id = String(sid || '')
    if (!id) return false
    const archived = await archivedSessionIds()
    if (archived.has(id)) return false
    return sessionExists(id)
  }

  /**
   * Whether a session exists, across core versions.
   *
   * 0.2.1 answers through `sessionController.inspect(id)` → `{ meta: { id } }`.
   * 0.2.2 removed `inspect`; the passive read there is
   * `state({ state.sessionId }, signal)`, which rejects for an unknown id. The session
   * list answers in every version and doubles as the second opinion when the
   * first call fails transiently, so a hiccup never silently moves the chat.
   */
  async function sessionExists(sid) {
    const id = String(sid || '')
    if (!id) return false
    const controller = ctx.sessionController
    // A QQ message must never hang on a stuck lookup.
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 5000)
    try {
      if (typeof controller?.state === 'function') {
        await controller.state({ sessionId: id }, abort.signal)
        return true
      }
      if (typeof controller?.inspect === 'function') {
        const inspection = await controller.inspect(id, abort.signal)
        if (inspection?.meta?.id) return true
      }
    } catch {
      /* unknown id, or a core version that answers neither way */
    } finally {
      clearTimeout(timer)
    }
    try {
      const listed = await controller.list({}, abort.signal)
      const rows = Array.isArray(listed?.items) ? listed.items : []
      return rows.some((s) => String(s.sessionId) === id)
    } catch {
      return false
    }
  }

  /** Open the next switchboard generation when the current one is gone. */

  /**
   * 总机的目录不一定存在（新装的人没有 Switchboard 这个文件夹）。
   * 不存在就建出来——否则 DSH 会拿着一个不存在的 cwd 去开会话，
   * 工作区解析失败，最后开出来的是一个没有 AGENTS.md 的裸会话。
   */
  async function ensureSwitchboardDir(dir) {
    try {
      await mkdir(dir, { recursive: true })
      return dir
    } catch (error) {
      log.warn(`bridge: 建总机目录失败（${dir}）：${error instanceof Error ? error.message : String(error)}`)
      return dir
    }
  }

  async function openFreshSwitchboard() {
    const gen = await nextLilyGeneration()
    const lilyCwd = `${cfg.workspacesRoot || DEFAULTS.workspacesRoot}\\${cfg.switchboardDir || DEFAULTS.switchboardDir}`
    await ensureSwitchboardDir(lilyCwd)
    const workspaceId = await ensureWorkspaceId(lilyCwd)
    log.info?.(`bridge: switchboard cwd=${lilyCwd} workspaceId=${workspaceId || "（未解析，将用 cwd）"}`)
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
    log.warn?.(`bridge: opened ${lilyTitle(gen)} as the new switchboard`)
    return fresh
  }

  /**
   * Move the binding back to the switchboard when the bound session can no
   * longer answer (deleted or archived), instead of posting into a black hole.
   * @returns the session id now bound, or '' when no switchboard could be found.
   */
  async function rebindToSwitchboard(fromId, source) {
    try {
      const saved = await loadState()
      let lily = String(state.lilySessionId || saved.lilySessionId || '')
      if (lily && !(await sessionUsable(lily))) lily = ''
      if (!lily) lily = await openFreshSwitchboard()
      if (!lily) return ''
      state.sessionId = lily
      await saveState({ sessionId: lily })
      await appendAudit({
        at: new Date().toISOString(),
        from: String(fromId || '').slice(-8) || '(none)',
        to: lily.slice(-8),
        source,
        actor: 'plugin',
      })
      log.warn?.(
        `bridge: bound session ${String(fromId || '').slice(-8)} cannot take turns; rebound to switchboard ${lily.slice(-8)}`,
      )
      return lily
    } catch (error) {
      log.warn?.(
        `bridge: switchboard fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return ''
    }
  }

  /** Agent workspaces on this machine, ordered so a number stays stable per call. */
  async function listWorkspaces() {
    const root = cfg.workspacesRoot || DEFAULTS.workspacesRoot
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      log.warn(`bridge: cannot read ${root}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en'))
  }

  /** Register (or find) a DSH workspace for one directory, so sessions are grouped. */
  async function ensureWorkspaceId(cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return undefined
    try {
      const existing = await registry.resolveByPath(cwd)
      if (existing?.id) return String(existing.id)
      const created = await registry.create(cwd)
      return created?.id ? String(created.id) : undefined
    } catch (error) {
      log.warn(
        `bridge: workspace resolve failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }


  /**
   * 清理历代总机：除了当前绑定/当前总机，其余 controlV0.N 一律归档。
   * 只归档不删除，DSH 里还能翻出来。启动时跑一次，之后每 6 小时一次。
   */
  async function sweepOldSwitchboards({ keepExtra = 0 } = {}) {
    const registry = ctx.get('workspaceRegistry')
    if (!registry?.archiveSession) return { archived: 0, reason: 'no-registry' }
    let listed
    try {
      listed = await ctx.sessionController.list({}, new AbortController().signal)
    } catch {
      return { archived: 0, reason: 'list-failed' }
    }
    const all = Array.isArray(listed?.items) ? listed.items : []
    const keep = new Set(
      [String(state.lilySessionId || ''), String(state.sessionId || '')].filter(Boolean),
    )
    const old = all
      .filter((s) => /^controlV0\.[0-9]+$/i.test(String(s?.projections?.values?.title || '')))
      .filter((s) => !keep.has(String(s.sessionId)))
      .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
      .slice(Math.max(0, Number(keepExtra) || 0))
    let archived = 0
    for (const s of old) {
      try {
        await registry.archiveSession(String(s.sessionId))
        archived += 1
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    if (archived > 0) log.info?.(`bridge: 归档了 ${archived} 个旧总机`)
    return { archived }
  }

  /**
   * Hang up and open a fresh switchboard. Shared by the qq_hangup tool and the
   * keyword path in handleEvent, so "挂了" works no matter who is on the line.
   */
  async function hangupToSwitchboard(source) {
    const saved = await loadState()
    const oldLily = state.lilySessionId || String(saved.lilySessionId || '')
    const lilyCwd = `${cfg.workspacesRoot || DEFAULTS.workspacesRoot}\\${cfg.switchboardDir || DEFAULTS.switchboardDir}`
    await ensureSwitchboardDir(lilyCwd)
    try {
      const workspaceId = await ensureWorkspaceId(lilyCwd)
    log.info?.(`bridge: switchboard cwd=${lilyCwd} workspaceId=${workspaceId || "（未解析，将用 cwd）"}`)
      const created = await ctx.sessionController.create(
        workspaceId ? { workspaceId } : { cwd: lilyCwd },
      )
      const fresh = String(created.sessionId)
      const gen = await nextLilyGeneration()
      try {
        await ctx.sessionController.rename({ sessionId: fresh, title: lilyTitle(gen) })
      } catch {
        /* cosmetic */
      }
      await saveState({ lilyGeneration: gen })
      state.lilySessionId = fresh
      await saveState({ lilySessionId: fresh })
      await setBinding(fresh, source, 'plugin')
      if (oldLily && oldLily !== fresh) {
        const registry = ctx.get('workspaceRegistry')
        try {
          await registry?.archiveSession(oldLily)
        } catch {
          /* archiving the old switchboard is best-effort */
        }
      }
      return fresh
    } catch (error) {
      await recordError('hangup.create', error)
      // Fall back to the existing switchboard rather than leaving QQ unbound.
      if (oldLily) {
        await setBinding(oldLily, `${source}(fallback)`, 'plugin')
        return oldLily
      }
      throw error
    }
  }
  return {
    ensureSession,
    isSessionBusy,
    promptSession,
    sessionRows,
    archivedSessionIds,
    sessionUsable,
    sessionExists,
    openFreshSwitchboard,
    rebindToSwitchboard,
    listWorkspaces,
    ensureWorkspaceId,
    hangupToSwitchboard,
    sweepOldSwitchboards,
  }
}
