// 入站：NapCat 把一条 OneBot 事件 POST 过来之后的所有判断。
//
// 顺序是有讲究的，改之前先看一遍：
//   群消息 → 交给 group（不建会话）
//   白名单 → 不是主人就静默丢弃
//   收图模式 → 只存不答
//   语音/聊天记录 → 先转成文字
//   图片 → 变成 content part 跟着走
//   审批/提问 → 回填，不进会话
//   控制词（/状态 /任务 /日程 /待办 /插队 /排队 /多条开始 /多条结束 /模型 /群模型 /导入表情 挂了 我在电脑前了）→ 桥自己答
//   其余 → 投给绑定的会话
import http from 'node:http'

/**
 * @param {object} deps 见 src/bridge.js 的调用处
 */
export function createInbound(deps) {
  const {
    cfg,
    allowed,
    log,
    state,
    sendText,
    saveState,
    parseAnswer,
    messageText,
    recordError,
    DEFAULTS,
    handleGroupEvent,
    importStickers,
    groupReplyCommandReply,
    groupModelCommandReply,
    groupCfg,
    promptSession,
    hangupToSwitchboard,
    imagePart,
    saveImageToInbox,
    transcribeVoice,
    expandForward,
    activitySnapshot,
    modelCommandReply,
    prompts,
    expectReply,
    statusPayload,
    statusText,
    sessionRows,
    emitCommand,
  } = deps

  // 入站自己的可变状态：HTTP 监听句柄，以及「批量收图」模式。
  let server
  let stickerBatch = null
  // 多条模式：/多条开始 之后只攒不投，/结束 时合成一条交给会话。
  // 只有私聊会走到这里——群消息在 handleEvent 开头就分流去 handleGroupEvent 了。
  let messageBatch = null

  /** 多条模式的进度（`/多条` 用），也是一句话的用法提示。 */
  function batchStatus() {
    if (!messageBatch) return '现在没在收多条。发 /多条开始 开始。'
    const mins = Math.max(0, Math.round((Date.now() - messageBatch.startedAt) / 60_000))
    const imgs = messageBatch.parts.length ? ` + ${messageBatch.parts.length} 张图` : ''
    const when = mins > 0 ? `${mins} 分钟前` : '刚刚'
    return (
      `正在收多条：${messageBatch.items.length} 条字${imgs}（起于${when}）。\n` +
      '发 /多条结束 一起发出去；/多条取消 丢掉。'
    )
  }

  /**
   * 把攒着的几条合成一发交给会话。
   * 投递失败时把内容留着，让他再发一次 /结束——那可能是他打了五分钟的东西，
   * 不能默默丢。
   */
  async function flushBatch(uin, note = '') {
    const batch = messageBatch
    if (!batch) return
    const body = batch.items.join('\n')
    const count = batch.items.length + batch.parts.length
    messageBatch = null
    if (!body.trim() && batch.parts.length === 0) {
      await sendText(uin, '攒的是空的，没东西可发。')
      return
    }
    try {
      // 只有从 QQ 发起的回合才把回答镜像回 QQ（见 src/replies.js）。
      if (typeof expectReply === 'function') expectReply()
      await promptSession(body || '（这条只发了图）', { parts: batch.parts })
      const imgs = batch.parts.length ? `、${batch.parts.length} 张图` : ''
      await sendText(
        uin,
        `收到 ${count} 条${imgs}，一起发过去了${note ? `（${note}）` : ''}。`,
      )
    } catch (error) {
      messageBatch = batch
      await recordError('batch.flush', error)
      await sendText(uin, '一起发失败了，攒的还在——再发一次 /结束。')
    }
  }

  async function handleEvent(event) {
    if (!event || typeof event !== 'object') return
    if (event.post_type !== 'message') return
    // Group traffic never touches the private-call path: it is answered (or
    // ignored) by the local model, with no session, no binding, no tools.
    if (event.message_type === 'group') return handleGroupEvent(event)
    const uin = String(event.user_id || '')
    if (!uin) return
    if (!allowed.has(uin)) {
      log.warn(`bridge: dropped message from ${uin} (not in allowUins)`)
      return
    }
    let text = messageText(event)
    // messageText falls back to raw_message, so a voice-only message looks like
    // "[CQ:record,file=...]" and used to skip the transcription path entirely.
    const segs = Array.isArray(event.message) ? event.message : []
    const hasRecord = segs.some((seg) => seg && seg.type === 'record')
    const hasTypedText = segs.some(
      (seg) => seg && seg.type === 'text' && String(seg.data?.text || '').trim(),
    )
    if (hasRecord && !hasTypedText) text = ''

    // ── 批量收图：/收图 开始，之后每张图只进 inbox、不回复；/收完了 结束并入表情库。
    const trimmed = text.trim()
    if (/^(收图|收表情|批量收图)$/.test(trimmed)) {
      stickerBatch = { startedAt: Date.now(), saved: 0 }
      await sendText(uin, '开始收图：直接往里发，我一张张存着，不回复你。发完喊「收完了」，我再一起入库。')
      return
    }
    if (/^(收完了|收完|收完表情|结束收图)$/.test(trimmed)) {
      const had = stickerBatch?.saved ?? 0
      stickerBatch = null
      try {
        const r = await importStickers()
        const bits = [`收到 ${had} 张，入库 ${r.added.length} 张`]
        if (r.dup) bits.push(`重复 ${r.dup}`)
        if (r.tooBig) bits.push(`太大 ${r.tooBig}`)
        if (r.bad) bits.push(`不是图片 ${r.bad}`)
        await sendText(uin, bits.join('；'))
      } catch (error) {
        await recordError('stickers.batch', error)
        sendText(uin, `入库失败：${error instanceof Error ? error.message : String(error)}`).catch(
          () => {},
        )
      }
      return
    }
    if (stickerBatch) {
      const imgs = segs.filter((seg) => seg && seg.type === 'image')
      if (imgs.length) {
        for (const seg of imgs) {
          try {
            const part = await imagePart(seg)
            if (part && (await saveImageToInbox(part))) stickerBatch.saved += 1
          } catch (error) {
            log.warn?.(`bridge: 收图失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (stickerBatch.saved >= 300) {
          stickerBatch = null
          await sendText(uin, '收了 300 张，先停了。喊「/导入表情」入库。').catch(() => {})
        }
        return
      }
      if (trimmed) {
        await sendText(
          uin,
          `收图中（已存 ${stickerBatch.saved} 张）。图片继续发，发完喊「收完了」。`,
        ).catch(() => {})
        return
      }
    }
    if (!text) {
      // A voice message can be transcribed locally; anything else is not text.
      const voices = (Array.isArray(event.message) ? event.message : []).filter(
        (seg) => seg && seg.type === 'record',
      )
      if (voices.length > 0) {
        for (const seg of voices) {
          const heard = await transcribeVoice(seg)
          if (heard) {
            text = text ? `${text}\n${heard}` : heard
            break
          }
        }
        if (text) log.info?.(`bridge: transcribed voice -> ${text.slice(0, 40)}`)
      }
    }
    // 聊天记录（合并转发）：展开成「昵称: 内容」的纯文本再交给会话。
    if (!text) {
      const fwd = segs.find((seg) => seg && (seg.type === 'forward' || seg.type === 'node'))
      if (fwd) {
        const inner = await expandForward(fwd)
        if (inner) {
          text = `【聊天记录】\n${inner}`
          log.info?.(`bridge: 展开聊天记录 ${inner.length} 字`)
        }
      }
    }

    // Images travel as real image parts, so a photo from the phone can be seen
    // by the session instead of being answered with "读不了".
    const imageParts = []
    const imageSegs = (Array.isArray(event.message) ? event.message : []).filter(
      (seg) => seg && seg.type === 'image',
    )
    if (imageSegs.length > 0 && cfg.intakeImages === false) {
      // 收图默认关闭：向 NapCat 取原图曾让它失去发送能力并掉线。
      log.info?.('bridge: 收到图片，但 intakeImages 关闭，跳过取图')
      sendText(uin, '图片这边先不收了（防止把桥弄掉线），有事打字或者发语音。').catch(() => {})
      if (!text) return
    } else {
      for (const seg of imageSegs) {
        try {
          const part = await imagePart(seg)
          if (part) imageParts.push(part)
        } catch (error) {
          log.warn(`bridge: image intake failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (imageParts.length > 0) {
        log.info?.(`bridge: attached ${imageParts.length} image(s) to the prompt`)
      }
    }

    if (!text && imageParts.length === 0) {
      // Video, files and stickers carry no usable content: say so instead of
      // dropping the message and leaving the owner wondering.
      const kinds = (Array.isArray(event.message) ? event.message : [])
        .map((seg) => seg && seg.type)
        .filter((t) => typeof t === 'string' && t !== 'text')
      if (kinds.length > 0) {
        const label = {
          image: '图片',
          record: '语音',
          video: '视频',
          file: '文件',
          face: '表情',
          mface: '表情',
          forward: '聊天记录',
          node: '聊天记录',
        }
        const names = [...new Set(kinds)].map((k) => label[k] || k)
        sendText(uin, `这条我只收到${names.join('、')}，读不了内容。要说事还是打字吧。`).catch(() => {})
      }
      return
    }
    if (state.ownerUin !== uin) {
      state.ownerUin = uin
      await saveState({ ownerUin: state.ownerUin })
    }
    if (prompts.hasApproval()) {
      const answer = parseAnswer(text)
      if (answer) {
        prompts.settleApproval(answer)
        // 批复期间收到的话不丢：按顺序补投。
        const queued = deferred.shift()
        if (queued) {
          setImmediate(() => {
            enqueueInbound(() => promptSession(queued, {})).catch(() => {})
          })
          if (deferred.length) {
            sendText(uin, `还有 ${deferred.length} 条排在后面，批复完依次投递。`).catch(() => {})
          }
        }
      } else {
        deferred.push(text)
        sendText(
          uin,
          '还在等审批答复：回「允许」或「拒绝」。这条我先存着，批复完就投。',
        ).catch(() => {})
      }
      return
    }
    if (prompts.hasQuestion()) {
      // The answer is consumed here; it never becomes a normal prompt.
      prompts.settleQuestion(text)
      return
    }
    // /会话：列可接的会话（已归档的不算，编号和 qq_list_sessions / 「接 N」一致）。
    const sessionsCommand = /^[/／]?(会话|会话列表|sessions?)$/i.exec(text.trim())
    if (sessionsCommand) {
      try {
        const { rows, hiddenNoise } = await sessionRows(false)
        const lines = rows.map((s, i) => {
          const marks = []
          if (s.bound) marks.push('← 当前绑定')
          if (s.running) marks.push('[运行中]')
          const tail = marks.length ? '  ' + marks.join(' ') : ''
          return `${i + 1}. ${s.title || s.short}${tail}\n   ${s.cwd || ''} · ${s.short}`
        })
        const foot = hiddenNoise > 0 ? `\n\n（另有 ${hiddenNoise} 条内部会话已折叠）` : ''
        await sendText(uin, lines.length ? lines.join('\n') + foot : '没有可用的会话。')
      } catch (error) {
        await recordError('sessions.command', error)
        sendText(uin, '会话列表没读出来，等下再试。').catch(() => {})
      }
      return
    }
    // /状态：桥自己的体检，和 qq_status 工具同一份数据（含在不在电脑前、
    // 忙时插队还是排队）。放最前面，别的命令没拦住时才轮到它。
    const statusCommand = /^[/／]?(状态|status|桥状态)$/i.exec(text.trim())
    if (statusCommand) {
      try {
        await sendText(uin, statusText(await statusPayload()))
      } catch (error) {
        await recordError('status.command', error)
        sendText(uin, '状态没读出来，等下再试。').catch(() => {})
      }
      return
    }
    // "在看什么" is answered by the bridge itself: asking what every session is
    // doing must not queue behind whichever turn is currently running.
    const activityCommand =
      /^[/／]?(任务|任务进度|进度|在看什么|忙什么|干什么|会话任务|jobs?|activity|tasks?)(?:\s+([\s\S]{1,40}))?$/i.exec(
        text.trim(),
      )
    if (activityCommand) {
      try {
        await sendText(uin, await activitySnapshot(activityCommand[2] || ''))
      } catch (error) {
        await recordError('activity', error)
        sendText(uin, '没拿到任务快照，等会儿再试。').catch(() => {})
      }
      return
    }
    // /日程 和 /待办 已拆成独立插件 @nyxfold/dsh-qq-schedule：桥只把没认出来的
    // /命令 广播给扩展（见下方扩展点），装没装那个包都不影响这里。
    // ── busy 时的默认投递方式：/插队 让新消息直接打断当前回合塞给模型，
    // /排队 让它等这轮结束。挂在 state.json 里，重启也记得。
    const busyModeHead = /^[/／]?(插队|排队)$/u.exec(text.trim())
    if (busyModeHead) {
      const mode = busyModeHead[1] === '插队' ? 'steer' : 'queue'
      state.busyMode = mode
      saveState?.({ busyMode: mode }).catch(() => {})
      await sendText(
        uin,
        mode === 'steer'
          ? '好：会话在跑的时候，新消息直接插给模型（打断当前这轮）。发 /排队 改回来。'
          : '好：会话在跑的时候，新消息排队，等这轮跑完再投。发 /插队 改成直接插。',
      )
      return
    }
    // ── 多条模式（只私聊）：/多条开始 之后一路攒着，/多条结束 时合成一发。
    // 攒的时候一句都不回，要的就是安静；桥自己的控制词（/任务 /日程…）照旧能用，
    // 它们在上面已经拦掉了。攒太多会自己先发出去，免得忘了 /多条结束 一直憋着。
    const batchHead = /^[/／]?(?:多条|连发|批量消息)([\s\S]*)$/i.exec(text.trim())
    if (batchHead) {
      const sub = batchHead[1].trim()
      if (/^(开始|开|start|on)$/i.test(sub)) {
        if (messageBatch) {
          await sendText(uin, `已经在收了（${messageBatch.items.length} 条）。发 /多条结束 一起发出去。`)
        } else {
          messageBatch = { uin, items: [], parts: [], startedAt: Date.now() }
          await sendText(
            uin,
            '开始收多条：随便发，我一条都不回；发完发 /多条结束，我合成一发投过去。',
          )
        }
        return
      }
      if (/^(结束|收尾|done|end|flush)$/i.test(sub)) {
        if (!messageBatch) {
          await sendText(uin, '现在没在收多条。发 /多条开始 开始。')
          return
        }
        await flushBatch(uin)
        return
      }
      if (/^(取消|清空|cancel|off|停|停止)$/i.test(sub)) {
        const had = messageBatch ? messageBatch.items.length + messageBatch.parts.length : 0
        messageBatch = null
        await sendText(
          uin,
          had ? `多条取消，攒的 ${had} 条丢了。` : '现在没在收多条，没什么可取消的。',
        )
        return
      }
      await sendText(uin, batchStatus())
      return
    }
    // /结束 兼容保留：带斜杠当「结束多条」，裸的「结束」在没收多条时仍是挂断词。
    // 新写法是 /多条结束（上面的 batchHead 分支）。
    const endBatch = /^([/／]?)结束$/.exec(text.trim())
    if (endBatch && (messageBatch || endBatch[1])) {
      if (!messageBatch) {
        await sendText(uin, '现在没在收多条。发 /多条开始 开始。')
        return
      }
      await flushBatch(uin)
      return
    }
    // Reply-mode switch: /群回复 toggles "must be @'d", accepts 开 / 关 too.
    const groupReplyHead = /^(群回复|群模式|群聊回复|groupreply)([\s\S]*)$/i.exec(
      text.trim().replace(/^[/／]/, ''),
    )
    if (groupReplyHead) {
      const bare = groupReplyHead[2].trim()
      const known = /^(开|关|on|off|全部|只@|@|mention|always|all|要@|不用@|不用|)$/i.test(bare)
      if (known) {
        try {
          await sendText(uin, await groupReplyCommandReply(bare))
        } catch (error) {
          await recordError('group.reply.command', error)
          sendText(uin, '改不了群回复模式，等下再试。').catch(() => {})
        }
        return
      }
    }
    // 表情入库：/导入表情 → 把 stickers-inbox 里的图收进表情库（文件名＝表情名）。
    const stickerImport = /^(导入表情|表情入库|importstickers|import-stickers)$/i.exec(
      text.trim().replace(/^[/／]/, ''),
    )
    if (stickerImport) {
      try {
        const r = await importStickers()
        const bits = []
        if (r.added.length) {
          const head = r.added.slice(0, 8).join('、')
          bits.push(`入库 ${r.added.length} 张：${head}${r.added.length > 8 ? '…' : ''}`)
        }
        if (r.dup) bits.push(`重复 ${r.dup}`)
        if (r.tooBig) bits.push(`太大 ${r.tooBig}`)
        if (r.bad) bits.push(`不是图片 ${r.bad}`)
        await sendText(
          uin,
          bits.length
            ? bits.join('；')
            : `inbox 是空的。把图丢进 ${String(groupCfg.stickersInbox || DEFAULTS.group.stickersInbox)} 再发一次。`,
        )
      } catch (error) {
        await recordError('stickers.import', error)
        sendText(uin, `入库失败：${error instanceof Error ? error.message : String(error)}`).catch(
          () => {},
        )
      }
      return
    }
    // Group-local model switch: /群模型 [n|恢复]. Separate from /模型 because
    // group chat bypasses sessions entirely and talks to LM Studio directly.
    const groupModelHead = /^(群模型|组模型|groupmodel)([\s\S]*)$/i.exec(
      text.trim().replace(/^[/／]/, ''),
    )
    let groupModelArgument
    if (groupModelHead) {
      const rest = groupModelHead[2]
      const bare = rest.trim()
      const looksLikeCommand =
        bare === '' ||
        /^\d{1,2}$/.test(bare) ||
        /^(恢复|默认|reset|default)$/i.test(bare) ||
        /^\s/.test(rest)
      if (looksLikeCommand) groupModelArgument = bare
    }
    if (groupModelArgument !== undefined) {
      try {
        await sendText(uin, await groupModelCommandReply(groupModelArgument))
      } catch (error) {
        await recordError('group.model.command', error)
        sendText(uin, `换不动群模型：${error instanceof Error ? error.message : String(error)}`).catch(
          () => {},
        )
      }
      return
    }
    // Model switching is a bridge-level control: it must work even when the
    // session is currently running a model too small to call tools.
    // Accept "/模型3" as well as "/模型 3": people do not type spaces.
    const modelHead = /^(切换模型|模型|model)([\s\S]*)$/i.exec(text.trim().replace(/^[/／]/, ''))
    let modelArgument
    if (modelHead) {
      const rest = modelHead[2]
      const bare = rest.trim()
      const looksLikeCommand =
        bare === '' ||
        /^\d{1,2}$/.test(bare) ||
        /^(恢复|默认|reset|default)$/i.test(bare) ||
        /^\s/.test(rest)
      if (looksLikeCommand) modelArgument = bare
    }
    if (modelArgument !== undefined) {
      try {
        await sendText(uin, await modelCommandReply(modelArgument))
      } catch (error) {
        await recordError('model.command', error)
        sendText(uin, `换不动：${error instanceof Error ? error.message : String(error)}`).catch(
          () => {},
        )
      }
      return
    }
    // Coming back to the desk mid-chat: correct the "can't operate the PC"
    // assumption before it makes the session keep asking. It also flips the
    // persistent atDesk flag, so the next QQ message does not re-apply the
    // "sender is on a phone" hint — that flag is what makes 挂了 harmless:
    // the switchboard still knows he is sitting at the machine.
    const AT_DESK_RE =
      /^(我在电脑前了?|我到电脑前了|回到电脑前了|我在桌前了?|我在电脑边了?|我回来了?|我回来啦|我到电脑了?|我在了|人在电脑前|在电脑前了?|能用电脑了?)[。.!！\s]*$/u
    if (AT_DESK_RE.test(text.trim())) {
      try {
        state.atDesk = true
        saveState?.({ atDesk: true }).catch(() => {})
        await promptSession('（更正）我现在就在电脑前，可以直接让我点确认、看屏幕、审批。', {
          remoteHint: false,
        })
        sendText(uin, '好，当你已经在电脑前了。').catch(() => {})
      } catch (error) {
        await recordError('presence.at-desk', error)
      }
      return
    }
    // The other direction: he is away from the machine again, so stop
    // assuming someone can click on this screen.
    const AWAY_RE =
      /^(我不在电脑前了?|我在手机上了?|我现在在手机上|我出门了|我出去了|我在外面|回宿舍了|用手机就行)[。.!！\s]*$/u
    if (AWAY_RE.test(text.trim())) {
      state.atDesk = false
      saveState?.({ atDesk: false }).catch(() => {})
      sendText(uin, '好，那按你在手机上算。').catch(() => {})
      return
    }
    // "挂了" is a control instruction, not conversation. Handle it in the
    // bridge so it works from whichever session holds the call, without
    // waiting on that session's model or its rebind permission.
    const HANGUP_RE = /^(挂断|挂了|拜拜|再见|没事了|先这样|就这样|收工|下了|结束|退下|不聊了)[。.!！?？\s]*$/
    if (HANGUP_RE.test(text.trim())) {
      try {
        const fresh = await hangupToSwitchboard('qq-message:hangup')
        sendText(uin, '挂了，回到总机。').catch(() => {})
        log.info?.(`bridge: hung up from chat, switchboard now ${fresh.slice(-8)}`)
      } catch (error) {
        sendText(uin, '挂断没成功，再试一次？').catch(() => {})
        await recordError('hangup.keyword', error)
      }
      return
    }
    // 多条模式：到这里既不投也不回，只往袋子里加。到上限就先一起发出去。
    if (messageBatch) {
      if (text.trim()) messageBatch.items.push(text.trim())
      if (imageParts.length > 0) messageBatch.parts.push(...imageParts)
      const chars = messageBatch.items.reduce((sum, item) => sum + item.length, 0)
      const total = messageBatch.items.length + messageBatch.parts.length
      if (total >= 40 || chars >= 20_000) await flushBatch(uin, '攒到上限了')
      return
    }
    // 扩展命令：内置命令都没认出来的 /xxx，广播给装了扩展插件的桥（例如
    // @nyxfold/dsh-qq-schedule 接管 /日程 /待办）。没人接管就按普通消息投给会话，
    // 和以前一样——扩展是纯增量，拆掉它也坏不了主路径。
    const slash = text.trim()
    if (/^[/／]/.test(slash)) {
      const payload = {
        text: slash,
        uin,
        reply: (chunk) => sendText(uin, chunk),
        handled: false,
      }
      try {
        emitCommand?.(payload)
      } catch (error) {
        await recordError('command.extension', error)
      }
      if (payload.handled) return
    }
    try {
      const steer = /^(挂断|挂了|拜拜|再见|没事了|先这样|就这样|收工|下了|结束|退下|不聊了)/.test(
        text.trim(),
      )
      // 只有从 QQ 发起的回合才把回答镜像回 QQ（见 src/replies.js）。
      if (typeof expectReply === 'function') expectReply()
      await promptSession(text, { steer, parts: imageParts })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordError('session.prompt', error)
      // Tell the owner on QQ why nothing happened, instead of failing silently.
      if (message.includes('绑定')) await sendText(uin, message).catch(() => {})
      throw error
    }
  }

  // Inbound messages are handled one at a time: two near-simultaneous
  // messages would otherwise race on ensureSession and could bind twice.
  // 审批挂起期间收到的普通消息，按顺序补投。
  const deferred = []

  let inboundChain = Promise.resolve()
  function enqueueInbound(task) {
    const run = inboundChain.then(task, task)
    inboundChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  function startInbound() {
    const port = Number(cfg.listenPort) || DEFAULTS.listenPort
    server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { connection: 'close' })
        res.end()
        return
      }
      // 挡住浏览器：任何带上 Origin 的请求都不是 NapCat 发的（网页 fetch 到
      // 127.0.0.1 是"简单请求"，浏览器会真发出去、只是读不到响应，所以必须拒）。
      if (req.headers.origin) {
        log.warn('bridge: 拒绝了带 Origin 的入站请求（浏览器发来的，不是 NapCat）')
        res.writeHead(403, { connection: 'close' })
        res.end()
        return
      }
      // 只收 JSON。浏览器发的简单请求一定是 text/plain，挡在这一步。
      const ct = String(req.headers['content-type'] || '').toLowerCase()
      if (ct && !ct.includes('application/json')) {
        res.writeHead(415, { connection: 'close' })
        res.end()
        return
      }
      // 可选共享令牌：配置了 ingressToken 就必须落在 /<token> 上。
      const token = String(cfg.ingressToken || '').trim()
      if (token && String(req.url || '').replace(/^\//, '').split('?')[0] !== token) {
        res.writeHead(404, { connection: 'close' })
        res.end()
        return
      }
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= 4 * 1024 * 1024) chunks.push(chunk)
      })
      req.on('end', () => {
        res.writeHead(204, { connection: 'close' })
        res.end()
        let event
        try {
          event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return
        }
        enqueueInbound(() => handleEvent(event)).catch((error) => {
          // 带上栈，否则只看到一句 message，下一次还得靠猜。
          const detail = error instanceof Error ? (error.stack || error.message) : String(error)
          log.warn(`bridge: handle failed: ${detail}`)
        })      })
    })
    server.on('error', (error) => {
      log.warn(`bridge: inbound listener failed on ${port}: ${error.message}`)
    })
    server.listen(port, '127.0.0.1', () => {
      log.info?.(`bridge: listening for NapCat on http://127.0.0.1:${port}/`)
    })
  }

  function stopInbound() {
    if (!server) return
    try {
      server.close()
    } catch {
      /* already closed */
    }
    server = undefined
  }
  /** 入站口是否在监听（qq_status 用）。 */
  function isListening() {
    return Boolean(server?.listening)
  }

  return { handleEvent, startInbound, stopInbound, isListening }
}
