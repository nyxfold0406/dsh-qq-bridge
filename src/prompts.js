// 审批与提问的转发：把会话里需要用户点头的东西搬到 QQ 上，再把答复填回去。
//
// 两条路（approval/request、user-questions/request）只处理**当前绑定会话**
// 发出的请求；别的会话保持原样（next() 放行，留给界面）。
//
// 只有一件待办会挂着：approval 或 question 之一。新的请求进来不会踢掉旧的，
// 因为宿主那边同一时刻也只会有一个在等。
/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.log
 * @param {(uin: string, text: string) => Promise<number>} deps.sendText
 * @param {() => string} deps.getSessionId
 * @param {() => string} deps.getOwnerUin
 * @param {(text: string) => 'allowed-once' | 'rejected' | undefined} deps.parseAnswer
 */
export function createPrompts({ ctx, log, sendText, getSessionId, getOwnerUin, parseAnswer, cfg }) {
  // true = 审批在 QQ 上答（会挡住 GUI 的卡片）；false = 只让 GUI 处理。
  // 人坐在电脑前时把它关掉更顺手。
  const viaQq = !cfg || cfg.approvalViaQq !== false
  const pending = { approval: undefined, question: undefined }

  function hasApproval() {
    return Boolean(pending.approval)
  }

  function hasQuestion() {
    return Boolean(pending.question)
  }

  function settleApproval(answer) {
    pending.approval?.settle(answer)
  }

  function settleQuestion(text) {
    pending.question?.settle(text)
  }

  function cancelAll() {
    pending.approval?.settle('cancelled')
    pending.question?.settle('')
  }

  // ------------------------------------------------------------ approvals ---

  function forwardApproval(req, uin) {
    const reason = req?.reason ?? ''
    const toolName = req?.toolName ?? '工具'
    const prompt =
      reason.length > 0
        ? `[审批] ${toolName}（${reason}）要执行。回「允许」或「拒绝」。`
        : `[审批] ${toolName} 要执行。回「允许」或「拒绝」。`
    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        pending.approval = undefined
        req?.signal?.removeEventListener?.('abort', onAbort)
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled')
      // settle() now receives an already-decided outcome ('allowed-once' |
      // 'rejected'); a text fallback keeps older call sites working.
      pending.approval = {
        settle: (outcome) => finish(typeof outcome === 'string' ? outcome : parseAnswer(outcome) || 'rejected'),
      }
      req?.signal?.addEventListener?.('abort', onAbort, { once: true })
      sendText(uin, prompt).catch(() => finish('unavailable'))
    })
  }

  ctx.effect(
    () =>
      ctx.on(
        'approval/request',
        (req, next) => {
          if (!viaQq) return next()
          if (!getSessionId() || !getOwnerUin()) return next()
          if (String(req?.agent?.id) !== String(getSessionId())) return next()
          return forwardApproval(req, getOwnerUin())
        },
        { prepend: true },
      ),
    'qq.approval-events',
  )

  // ------------------------------------------------------------- questions ---

  /** Render one ask_user_question question as compact QQ text. */
  function formatQuestion(questions) {
    const q = questions[0]
    if (!q) return '（没有要问的）'
    const lines = []
    lines.push(q.header ? `【${q.header}】` : '【问你】')
    lines.push(String(q.question || ''))
    if (q.detail) lines.push(String(q.detail))
    const options = Array.isArray(q.options) ? q.options : []
    if (options.length > 0) {
      lines.push('')
      options.forEach((opt, i) => {
        const desc = opt.description ? ` — ${opt.description}` : ''
        lines.push(`${i + 1}. ${opt.label}${desc}`)
      })
      lines.push('')
      lines.push(
        q.multiSelect
          ? '回复编号（多个用逗号，如 1,3），或直接打字当自定义回答。'
          : '回复编号，或直接打字当自定义回答。',
      )
    } else {
      lines.push('')
      lines.push('直接打字回复。')
    }
    return lines.join('\n')
  }

  /** Translate the owner's QQ reply into the structured answer batch. */
  function parseQuestionReply(questions, text) {
    const t = String(text || '').trim()
    if (!t) return undefined
    // Only the first question is asked on QQ; extra ones get the same answer
    // shape with an empty selection so the batch still validates.
    const q = questions[0]
    if (!q) return { answers: [] }
    const options = Array.isArray(q.options) ? q.options : []
    const byLabel = (s) => options.find((o) => String(o.label) === s)

    // "1" or "1,3"
    if (/^\d+(\s*[,，]\s*\d+)*$/.test(t)) {
      const picked = t
        .split(/[,，]/)
        .map((n) => Number(n.trim()) - 1)
        .filter((i) => i >= 0 && i < options.length)
        .map((i) => options[i].label)
      if (picked.length > 0) {
        return {
          answers: questions.map((item, index) => ({
            id: item.id,
            selected: index === 0 ? picked : [],
          })),
        }
      }
    }

    // Exact option text
    const hit = byLabel(t)
    if (hit) {
      return {
        answers: questions.map((item, index) => ({
          id: item.id,
          selected: index === 0 ? [hit.label] : [],
        })),
      }
    }

    // Free text becomes the custom answer for the first question.
    return {
      answers: questions.map((item, index) => ({
        id: item.id,
        selected: [],
        ...(index === 0 ? { custom: t } : {}),
      })),
    }
  }

  function forwardQuestion(request, uin) {
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return Promise.resolve({ answers: [] })
    return new Promise((resolve) => {
      let settled = false
      const finish = (answer) => {
        if (settled) return
        settled = true
        pending.question = undefined
        request?.signal?.removeEventListener?.('abort', onAbort)
        resolve(answer ?? { answers: [] })
      }
      const onAbort = () => finish(null)
      pending.question = {
        settle: (text) => {
          const answer = parseQuestionReply(questions, text)
          finish(answer ?? null)
        },
      }
      request?.signal?.addEventListener?.('abort', onAbort, { once: true })
      sendText(uin, formatQuestion(questions)).catch(() => finish(null))
    })
  }

  ctx.effect(
    () =>
      ctx.on(
        'user-questions/request',
        (request, next) => {
          if (!viaQq) return next()
          if (!getSessionId() || !getOwnerUin()) return next()
          if (String(request?.agent?.id) !== String(getSessionId())) return next()
          return forwardQuestion(request, getOwnerUin())
        },
        { prepend: true },
      ),
    'qq.question-events',
  )

  return {
    hasApproval,
    hasQuestion,
    settleApproval,
    settleQuestion,
    cancelAll,
    forwardApproval,
    forwardQuestion,
  }
}
