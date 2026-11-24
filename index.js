// QQ bridge for DeepSeek Harness — 让 QQ 私聊驱动这里的会话。
//
// 这是一个 DSH 插件（bundle），通过 profile 里 `dsh-qq-bridge: link:.../plugins/qq-bridge`
// 挂载；配置来自本包的 cordis.patch.yml（见 README 的「配置」一节）。
//
// 传输是双向纯 HTTP，不依赖 WebSocket，也不引任何第三方 npm 包：
//   出站  POST {napcatUrl}/send_private_msg | get_image | get_record | ...
//   入站  本插件监听 127.0.0.1:{listenPort}，NapCat 的 HTTP 上报（post_url）
//         指向它；只有 allowUins 里的人能说话，其他人静默丢弃。
//
// 入口文件只做装配，实现在 src/ 下：
//   src/config.js   默认值 + 配置归一化（浅合并语义与旧版一致）
//   src/http.js     零依赖 JSON POST/GET（带超时）
//   src/text.js     审批词、分段、取字、Markdown 去噪（纯函数）
//   src/napcat.js   NapCat 出站客户端（发字/发文件/发图/截屏）
//   src/util.js     sleep / execFileP
//   src/bridge.js   桥主体：会话绑定、群聊、入站分发、审批/提问转发、工具注册
import { apply as applyBridge, inject, name } from './src/bridge.js'

export { name, inject }

export function apply(ctx, config) {
  return applyBridge(ctx, config)
}

// 老调用方（以及宿主的手动检查脚本）还用这三个纯函数。
export { messageText, parseAnswer, splitText } from './src/text.js'
