// 文本处理：审批词判定、分段、OneBot 消息取字、Markdown 去噪。
// 全是纯函数，不碰 I/O，单测最容易写。

export const ALLOW_WORDS = new Set(['允许', '允许执行', '同意', '可以', '确认'])
export const REJECT_WORDS = new Set(['拒绝', '不同意', '禁止', '取消'])

/** Parse an inbound reply into an approval decision (whole word, or first token). */
export function parseAnswer(text) {
  const normalized = String(text || '').trim().toLowerCase()
  if (!normalized) return undefined
  if (ALLOW_WORDS.has(normalized)) return 'allowed-once'
  if (REJECT_WORDS.has(normalized)) return 'rejected'
  const first = normalized.split(/[\s,，。.!！?？、:：;；/]+/u)[0] || ''
  if (ALLOW_WORDS.has(first)) return 'allowed-once'
  if (REJECT_WORDS.has(first)) return 'rejected'
  return undefined
}

/** Split text into chat-sized chunks without breaking surrogate pairs. */
export function splitText(text, max) {
  const out = []
  let rest = String(text ?? '')
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    // 不要把 emoji 的代理对切成两半（否则发出半条乱码）
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length) out.push(rest)
  return out
}

/** Pull the human text out of an OneBot message segment array. */
export function messageText(event) {
  const message = event?.message
  if (typeof message === 'string') return message.trim()
  if (Array.isArray(message)) {
    const joined = message
      .filter((seg) => seg && seg.type === 'text')
      .map((seg) => seg.data?.text ?? '')
      .join('')
    if (joined.trim()) return joined.trim()
  }
  return typeof event?.raw_message === 'string' ? event.raw_message.trim() : ''
}

/**
 * QQ shows raw text, so Markdown syntax just adds noise on the phone.
 * Strip the common markers while keeping the words and code content.
 */
export function plainText(md) {
  let s = String(md ?? '')
  // fenced code blocks: drop the fence, keep the body
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
  s = s.replace(/```/g, '')
  // inline code
  s = s.replace(/`([^`]+)`/g, '$1')
  // bold / italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,，。])/g, '$1$2')
  // headings
  s = s.replace(/^#{1,6}\s+/gm, '')
  // links -> label (url) only when the label differs
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  // bullets
  s = s.replace(/^\s*[-*+]\s+/gm, '· ')
  // horizontal rules
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}
