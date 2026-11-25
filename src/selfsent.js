// 「这一轮 agent 自己已经把话发到 QQ 了」的标记。
//
// 背景：绑定的 QQ 会话在 turn/end 时会把这一轮的 assistant 文本整段回传
// （见 src/replies.js）。如果 agent 已经用 qq_send_message / qq_send_file
// 把正文发过去了，这次回传就是重复，用户会收到两遍。
//
// 做法：工具成功发送时 mark()，turn/end 时 consume()——这一轮就不再回传。
// consume() 在每个 turn/end 都调用，所以过期的标记不会留到下一轮。
export function createSelfSent() {
  let marked = false
  return {
    mark() {
      marked = true
    },
    consume() {
      const value = marked
      marked = false
      return value
    },
  }
}
