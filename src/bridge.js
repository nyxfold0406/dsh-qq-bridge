// QQ bridge for DeepSeek Harness — drive this session from a QQ private chat.
//
// Transport is plain HTTP in both directions, so the plugin needs no WebSocket
// client and no npm dependency outside Node's standard library:
//
//   outbound  POST {napcatUrl}/send_private_msg | upload_private_file | ...
//   inbound   this plugin listens on 127.0.0.1:{listenPort}; NapCat's HTTP 上报
//             (post_url) must point at http://127.0.0.1:{listenPort}/
//
// A QQ message becomes a prompt on one bound session; the session's assistant
// text for that turn is sent back to the chat that asked. Only `allowUins` may
// talk to it — anyone else is dropped silently.
//
// Agent tools registered here:
//   qq_send_message  push a short note to the chat (progress reports)
//   qq_send_file     send one local file (the file stays on this computer)
//   qq_status        report bridge health for debugging
//   qq_activity      what every session is doing right now (same as /任务 on QQ)
//
// Chat-side control words, answered by the bridge without waking a session:
// /任务 (or /进度, /jobs) — per-session snapshot: running turns, background
// jobs, todo progress; /日程 — the coming week from the desktop todo app;
// /待办 — the todo list; /多条开始 … /结束 — collect several messages and
// deliver them once; 挂了 — reconnect the switchboard.
//
// Approval requests raised by the bound session are forwarded to the chat; a
// reply of 允许/拒绝 (or yes/no) settles them.
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, resolveConfig } from './config.js'
import { getJson, postJson } from './http.js'
import { createNapcat } from './napcat.js'
import { createMedia } from './media.js'
import { createGroup } from './group.js'
import { createActivity } from './activity.js'
import { createSchedule } from './schedule.js'
import { createPrompts } from './prompts.js'
import { createTools } from './tools.js'
import { createReplies } from './replies.js'
import { createCommand } from './command.js'
import { createModelPicker } from './model.js'
import { createStateStore } from './state.js'
import { createSession } from './session.js'
import { createInbound } from './inbound.js'
import { createLogger } from './log.js'
import { messageText, parseAnswer, plainText, splitText } from './text.js'
import { sleep } from './util.js'

export const name = 'dshQq'
export const inject = ['tools', 'sessionController', 'workingDirectory', 'commands']

// 默认值 / 纯函数 / HTTP 已抽到 src/config.js、src/text.js、src/http.js。

export function apply(ctx, config) {
  const { cfg, allowed, maxChars, stateFile } = resolveConfig(config)
  const log = createLogger(ctx, cfg)

  // 出站客户端（src/napcat.js）：发文字/文件/图、截屏都走它。
  // ownerUin 和 lastSend 留在本文件，因为好几个分区都要读写它们。
  const napcat = createNapcat({
    url: cfg.napcatUrl,
    accessToken: cfg.accessToken,
    dataDir: cfg.dataDir,
    maxChars,
    log,
    getOwnerUin: () => ownerUin,
    onSent: (info) => { lastSend = info },
  })
  const { callApi, sendText, sendFile } = napcat

  let sessionId
  let lilySessionId
  let ownerUin = ''
  // 最近一次成功发送：掉线时写进错误里，方便判断是不是长消息把它弄死的。
  let lastSend = null
  // 批量收图模式：开着的时候图片只进 inbox，不进会话、不逐张回复。
  // "He is on his phone" note: at most once per hour per bound session.
  let remoteHintSession = ''
  let remoteHintAt = 0
  let started = false

  // --------------------------------------------- 状态与绑定（src/state.js）---
  // 三个可变状态留在桥里，state.js 通过访问器读写，避免两边各存一份。
  const qqState = {
    get sessionId() {
      return sessionId
    },
    set sessionId(value) {
      sessionId = value
    },
    get lilySessionId() {
      return lilySessionId
    },
    set lilySessionId(value) {
      lilySessionId = value
    },
    get ownerUin() {
      return ownerUin
    },
    set ownerUin(value) {
      ownerUin = value
    },
  }

  const {
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
  } = createStateStore({
    ctx,
    cfg,
    log,
    sendText,
    stateFile,
    DEFAULTS,
    state: qqState,
    recordError,
    // 这三个属于 src/session.js，而会话层又依赖这里的 loadState/setBinding，
    // 所以用惰性包装穿过去，避免构造期撞上 TDZ。
    archivedSessionIds: (...args) => archivedSessionIds(...args),
    sessionRows: (...args) => sessionRows(...args),
    ensureWorkspaceId: (...args) => ensureWorkspaceId(...args),
  })


  // ------------------------------------------------------------- session ---

  /** Persist the last failure so it is readable without attaching a debugger. */
  async function recordError(stage, error) {
    try {
      await mkdir(cfg.dataDir, { recursive: true })
      await writeFile(
        path.join(cfg.dataDir, 'last-error.txt'),
        `${new Date().toISOString()} [${stage}]\n${error?.stack || String(error)}\n`,
        'utf8',
      )
    } catch {
      /* diagnostics only */
    }
  }

  // ------------------------------------------- 会话/接线（src/session.js）---
  const {
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
  } = createSession({
    ctx,
    cfg,
    log,
    sendText,
    state: qqState,
    recordError,
    loadState,
    saveState,
    appendAudit,
    setBinding,
    lilyTitle,
    nextLilyGeneration,
  })


  // --------------------------------------------------------------- groups ---

  const groupCfg = { ...DEFAULTS.group, ...(cfg.group || {}) }

  const media = createMedia({ callApi, log, cfg, groupCfg, recordError })
  const {
    pieceLabel,
    sniffImageExt,
    harvestSticker,
    expandForward,
    transcribeVoice,
    saveImageToInbox,
    imagePart,
  } = media
  // ------------------------------------- 群聊（src/group.js）---
  const group = createGroup({
    cfg,
    groupCfg,
    log,
    callApi,
    postJson,
    getJson,
    sleep,
    recordError,
    media,
    plainText,
    splitText,
    messageText,
  })
  const { handleGroupEvent, groupModelCommandReply, groupReplyCommandReply, importStickers } = group



  // ------------------------------------------- 模型切换（src/model.js）---
  const { modelCommandReply, watchLocalContext } = createModelPicker({
    ctx,
    log,
    groupCfg,
    DEFAULTS,
    getJson,
    sendText,
    getOwnerUin: () => ownerUin,
    ensureSession,
  })



  // -------------------------------------------------------------- inbound ---


  // ------------------------------- activity（src/activity.js）---
  const { activitySnapshot } = createActivity({ ctx, sessionRows })

  // -------------------------- 日程/待办（src/schedule.js）---
  // 读桌面待办小窗的纯文本；没配 todoAppDir 就只回一句"读不到"，不报错。
  const { scheduleSnapshot, todoSnapshot } = createSchedule({ cfg, log })

  // ---------------------------------- 审批/提问（src/prompts.js）---
  const prompts = createPrompts({
    ctx,
    log,
    sendText,
    getSessionId: () => sessionId,
    getOwnerUin: () => ownerUin,
    parseAnswer,
    cfg,
  })

  // -------------------------------------------- 入站分发（src/inbound.js）---
  const inbound = createInbound({
    cfg,
    allowed,
    log,
    state: qqState,
    sendText,
    parseAnswer,
    messageText,
    recordError,
    DEFAULTS,
    // 下面这些在别处创建（或由别的模块导出），用惰性包装避开构造期的 TDZ。
    handleGroupEvent: (...args) => handleGroupEvent(...args),
    importStickers: (...args) => importStickers(...args),
    groupReplyCommandReply: (...args) => groupReplyCommandReply(...args),
    groupModelCommandReply: (...args) => groupModelCommandReply(...args),
    groupCfg,
    promptSession: (...args) => promptSession(...args),
    hangupToSwitchboard: (...args) => hangupToSwitchboard(...args),
    imagePart: (...args) => imagePart(...args),
    saveImageToInbox: (...args) => saveImageToInbox(...args),
    transcribeVoice: (...args) => transcribeVoice(...args),
    expandForward: (...args) => expandForward(...args),
    activitySnapshot,
    scheduleSnapshot,
    todoSnapshot,
    modelCommandReply: (...args) => modelCommandReply(...args),
    prompts,
    expectReply: () => replies.expectReply(),
  })
  const { handleEvent, startInbound, stopInbound, isListening } = inbound


  // ------------------------------------------------------------- replies ---
  // ------------------------------------------- 回复回传（src/replies.js）---
  const replies = createReplies({
    ctx,
    log,
    sendText,
    getSessionId: () => sessionId,
    getOwnerUin: () => ownerUin,
    watchLocalContext,
  })

  // ------------------------------------------------ /qq 命令（src/command.js）---
  createCommand({
    ctx,
    cfg,
    allowed,
    getSessionId: () => sessionId,
    getOwnerUin: () => ownerUin,
    setBinding,
    activitySnapshot,
  })


  // ---------------------------------------------------------------- tools ---

  // ---------------------------------------------------------------- tools ---

  const text = (value) => [{ type: 'text', text: value }]

  createTools({
    ctx,
    cfg,
    allowed,
    sendText,
    sendFile,
    callApi,
    activitySnapshot,
    sessionRows,
    getOwnerUin: () => ownerUin,
    getSessionId: () => sessionId,
    setLilySessionId: (id) => {
      lilySessionId = id
    },
    isListening,
    mayEmit,
    EMIT_DENIED,
    mayRebind,
    REBIND_DENIED,
    listWorkspaces,
    ensureWorkspaceId,
    setBinding,
    sessionExists,
    hangupToSwitchboard,
    nextLilyGeneration,
    lilyTitle,
    saveState,
    recordError,
    DEFAULTS,
  })


  // -------------------------------------------------------------- startup ---

  // NapCat can drop the QQ session on its own (risk control, network). Nobody
  // notices until a message goes unanswered, so poll and record the outage.
  let healthFails = 0
  let lastHealthyAt = Date.now()
  ctx.effect(() => {
    const timer = setInterval(async () => {
      try {
        await callApi('get_login_info', {}, 8000)
        if (healthFails > 0) {
          log.info?.(`bridge: napcat back online after ${healthFails} failed checks`)
        }
        healthFails = 0
        lastHealthyAt = Date.now()
      } catch (error) {
        healthFails += 1
        // First failure and then every 15 minutes, so the log stays readable.
        if (healthFails === 1 || healthFails % 15 === 0) {
          log.warn(
            `bridge: napcat unreachable (${healthFails} consecutive): ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        if (healthFails === 1) {
          const ctxLine = lastSend
            ? `（最后一次成功发送：${new Date(lastSend.at).toLocaleTimeString('zh-CN')}，${lastSend.chars} 字 / ${lastSend.chunks} 段）`
            : '（本次启动以来没有成功发送过）'
          recordError('napcat.offline', new Error(`${error instanceof Error ? error.message : String(error)} ${ctxLine}`)).catch(() => {})
        }
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, 'qq.health')

  ctx.effect(() => {
    startInbound()
    ensureSession()
      .then(() => ensureLilyTitle())
      .then(() => sweepOldSwitchboards())
      .catch((error) => {
        log.warn(`bridge: 启动清理失败：${error instanceof Error ? error.message : String(error)}`)
      })
    // 之后每 6 小时扫一次（只归档，不删除）
    const sweepTimer = setInterval(() => {
      sweepOldSwitchboards().catch(() => {})
    }, 6 * 60 * 60 * 1000)
    return () => {
      clearInterval(sweepTimer)
      stopInbound()
      prompts.cancelAll()
      replies.clear()
    }
  }, 'qq.bridge')
}

