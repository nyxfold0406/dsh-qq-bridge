// 会话回复回传：把绑定会话这一轮的 assistant 文本发回 QQ。
//
// 一轮可能分好几条 assistant/message，所以先按 turn 攒着（replyByTurn），
// turn/end 时一次性发出去；被中断/出错的回合加一句后缀，空回复则只去看上下文窗口。
/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.log
 * @param {(uin: string, text: string) => Promise<number>} deps.sendText
 * @param {() => string} deps.getSessionId
 * @param {() => string} deps.getOwnerUin
 * @param {(sid: string) => Promise<void>} deps.watchLocalContext
 */
export function createReplies({ ctx, log, sendText, getSessionId, getOwnerUin, watchLocalContext }) {
  const replyByTurn = new Map()
  // 只有「这条回合是从 QQ 发起的」才把结果发回 QQ。电脑前直接跟这个说话
  // 产生的回合不该出现在手机上（隐私 + 噪音）。
  let expectedAt = 0
  function expectReply() {
    expectedAt = Date.now()
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
          if (text.trim()) {
            // Cap the buffer: a turn that never ends must not grow it forever.
            if (replyByTurn.size > 64) {
              const oldest = replyByTurn.keys().next().value
              if (oldest !== undefined) replyByTurn.delete(oldest)
            }
            replyByTurn.set(event.data.turn, text)
          }
          return
        }
        if (event.type === 'turn/end') {
          const expected = expectedAt > 0 && Date.now() - expectedAt < 30 * 60 * 1000
          expectedAt = 0
          if (!expected) {
            // 不是 QQ 发起的回合：缓冲清掉，不发。
            replyByTurn.delete(event.data?.turn)
            return
          }
          const turn = event.data?.turn
          const text = replyByTurn.get(turn)
          replyByTurn.delete(turn)
          const reason = event.data?.reason?.kind
          if (!text || !text.trim()) {
            // An empty failed turn is usually a model-side 400 (context size,
            // overload). Watch the window instead of staying silent.
            if (reason === 'error') void watchLocalContext(getSessionId()).catch(() => {})
            return
          }
          const suffix =
            reason === 'aborted' ? '\n\n（这轮被打断了）' : reason === 'error' ? '\n\n（这轮出错了）' : ''
          sendText(getOwnerUin(), text + suffix).catch((error) => {
            log.warn(`bridge: reply failed: ${error instanceof Error ? error.message : String(error)}`)
          })
          void watchLocalContext(getSessionId()).catch(() => {})
        }
      }),
    'qq.session-events',
  )

  /** 卸载时清空积压的回合缓冲（bridge 的 dispose 会调用）。 */
  function clear() {
    replyByTurn.clear()
  }

  return { clear, expectReply }
}
