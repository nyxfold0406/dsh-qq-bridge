// 会话回复回传：把绑定会话的 assistant 文本实时发回 QQ。
//
// 2026-11-25 改成「一段一炮」：模型每输出一段（assistant/message），只要这一轮
// 是 QQ 发起的，就立刻发一条到 QQ——和 GUI 一样能看到中间汇报，不用等这一轮
// 结束。代价是话多的时候 QQ 会连着弹几条；这是用户选的模式。
//
// 中断/出错的回合补一句后缀；整轮一个字都没说、又是 error 的，去看上下文窗口。
export function createReplies({ ctx, log, sendText, getSessionId, getOwnerUin, watchLocalContext, selfSent }) {
  // 哪些 turn 已经发过内容（补后缀、判断空回复用）。
  const sentByTurn = new Map()
  // 只有「这条回合是从 QQ 发起的」才把结果发回 QQ。电脑前直接跟这个说话
  // 产生的回合不该出现在手机上（隐私 + 噪音）。
  let expectedAt = 0
  function expectReply() {
    expectedAt = Date.now()
  }

  /** 这一轮是不是 QQ 发起的（答完会回传 QQ）。 */
  function expecting() {
    return expectedAt > 0 && Date.now() - expectedAt < 30 * 60 * 1000
  }

  function markSent(turn) {
    if (turn === undefined) return
    // Cap the map: a turn that never ends must not grow it forever.
    if (sentByTurn.size > 64) {
      const oldest = sentByTurn.keys().next().value
      if (oldest !== undefined) sentByTurn.delete(oldest)
    }
    sentByTurn.set(turn, true)
  }

  // Registered through ctx.effect so a plugin reload releases the old
  // listener; a leaked one would keep replying from a stale session.
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        if (!getSessionId() || !session || String(session.id) !== String(getSessionId())) return
        if (event.type === 'assistant/message') {
          const blocks = event.data?.message?.content ?? []
          const text = blocks
            .filter((block) => block && block.type === 'text')
            .map((block) => block.text ?? '')
            .join('')
          if (!text.trim()) return
          // Not a QQ turn: this text stays inside the machine.
          if (!expecting()) return
          markSent(event.data.turn)
          sendText(getOwnerUin(), text).catch((error) => {
            log.warn(`bridge: reply failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          return
        }
        if (event.type === 'turn/end') {
          const turn = event.data?.turn
          const wasExpected = expecting()
          expectedAt = 0
          const hadText = turn !== undefined && sentByTurn.has(turn)
          if (turn !== undefined) sentByTurn.delete(turn)
          if (!wasExpected) return
          const reason = event.data?.reason?.kind
          if (!hadText) {
            // An empty failed turn is usually a model-side 400 (context size,
            // overload). Watch the window instead of staying silent.
            if (reason === 'error') void watchLocalContext(getSessionId()).catch(() => {})
            return
          }
          if (reason === 'aborted') {
            sendText(getOwnerUin(), '（这轮被打断了）').catch(() => {})
          } else if (reason === 'error') {
            sendText(getOwnerUin(), '（这轮出错了）').catch(() => {})
          }
          void watchLocalContext(getSessionId()).catch(() => {})
        }
      }),
    'qq.session-events',
  )

  /** 卸载时清空积压的回合记录（bridge 的 dispose 会调用）。 */
  function clear() {
    sentByTurn.clear()
  }

  return { clear, expectReply, expecting }
}
