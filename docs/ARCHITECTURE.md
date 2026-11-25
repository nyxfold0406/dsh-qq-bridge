# 架构

插件只有两种运行形态：**在 DSH 宿主进程里**（入站监听、会话桥接、工具注册、群聊），
和**什么都没有**——它不拉起独立进程，也不常驻后台。NapCat 和 QQ 是外部的东西，
桥只是它们与 DSH 之间的一层 HTTP 翻译。

```
QQ 手机  ⇄  NapCat(Win)  :3000
                 │ HTTP 上报（POST 一条 OneBot v11 事件）
                 ▼
         dsh-qq-bridge 入站  127.0.0.1:6721        ┐
                 │                          │
    ┌────────────┴────────────┐             │  都跑在 DSH 宿主进程里
    ▼                         ▼             │
  私聊                       群聊            │
    │                         │             │
    ▼                         ▼             │
 handleEvent             handleGroupEvent   │
    │                         │             │
    │                    askGroupModel ─────┼─▶ POST http://127.0.0.1:1234/v1（LM Studio）
    │                                  或  ─┼─▶ POST https://api.deepseek.com/v1（group.cloud）
    ▼                                       │
 DSH sessionController.prompt(sid)          │
    │                                       │
    一轮的 assistant 文本                   │
    ▼                                       │
 sendText ──▶ POST /send_private_msg ──▶ NapCat ──▶ QQ
```

## 模块

| 文件 | 职责 | 拥有什么状态 |
|---|---|---|
| `index.js` | 入口装配，`name` / `inject` / `apply` | 无 |
| `src/bridge.js` | 装配 + 启动/健康检查（只剩 约 390 行接线代码） | `sessionId`、`lilySessionId`、`ownerUin`、`lastSend` |
| `src/inbound.js` | 入站分发：群/白名单/收图/语音/控制词/投递 | `server`、`stickerBatch`、`inboundChain` |
| `src/state.js` | state.json 读写、审计、绑定变更与发送权限判定 | 无（通过访问器读写桥里的三个绑定变量） |
| `src/session.js` | 接线、投递、列会话、开/回退总机、挂断 | `remoteHintSession`、`remoteHintAt`（「他在手机上」提示的节流） |
| `src/group.js` | 群聊：限流、摘要、记忆、表情库、群里改模型 | `groupHistory`、`groupStamps`、`groupMemory`、`groupExchange`、`groupSettings`、`groupModelOverride` |
| `src/activity.js` | 会话活动快照（谁在跑、后台任务、待办） | `report`（每会话一条，事件里写，被问时才读） |
| `src/prompts.js` | 审批 / 提问的转发与回填 | `pending.approval`、`pending.question` |
| `src/replies.js` | 一轮文本攒好再发回 QQ | `replyByTurn` |
| `src/model.js` | `/模型` 切换、本地模型窗口预警 | `contextWatch`、`localModelsCache` |
| `src/command.js` | `/qq` 命令 | 无 |
| `src/tools.js` | 九个 `qq_*` 工具的注册、参数、渲染 | 无（读桥的状态用 getter） |
| `src/media.js` | 表情入库、聊天记录展开、语音转写、图片 → content part | 无（纯函数 + I/O） |
| `src/napcat.js` | 出站 API：发字 / 发文件 / 发图 / 截屏 | 无 |
| `src/log.js` | 分级日志：转发 `ctx.logger` + 落 `bridge.log` | 无（写盘队列） |
| `src/config.js` | `DEFAULTS` + 深合并 + 派生值 | 无 |
| `src/text.js` | 审批词、分段、取字、Markdown 去噪 | 无 |
| `src/http.js` | JSON POST/GET（带超时） | 无 |
| `src/util.js` | `sleep` / `execFileP` | 无 |

**为什么桥主体还留在 `bridge.js`**：那 2000 行共享上面那十来个可变状态，
而且彼此会互相写（绑定改了要落盘、审批要回填到当前回合）。按行数切文件只会把
「一个变量被三个模块写」藏起来；按依赖切才有意义。群聊能独立出去，是因为它
除了发消息和调模型以外不碰桥的状态。

## 一次私聊消息的完整路径

1. NapCat 把事件 POST 到 `127.0.0.1:6721`；插件**立刻回 204**，不阻塞 NapCat。
2. `enqueueInbound()` 把处理串成一条队列，避免同一时刻两条消息抢同一个回合。
3. `handleEvent()` 判类型：
   - `meta_event`（心跳）→ 丢弃
   - 发送者不在 `allowUins` → 静默丢弃（不回话，不给对方任何信号）
   - 控制词（`/任务`、`挂了`）→ 桥自己答，不唤醒会话
   - 待审批 ≠ 空且文本能解析成允许/拒绝 → 回填 `pendingApproval`
   - 群消息且群在白名单 → 走 `handleGroupEvent`
   - 其余 → `promptSession()`：`ensureSession()` → `sessionController.prompt()`
4. 回复：监听 `session/event`，用 `replyByTurn` 把「哪个回合的文本」对上「发去哪」，
   `sendText()` 分段发回。

## 审批与提问

会话里需要用户点头的动作，会在 `session/event` 里冒出来；桥把它转成一条 QQ 消息
（带编号和上下文），把 resolve 函数存进 `pendingApproval` / `pendingQuestion`。
用户回「允许」/「拒绝」/「1,3」时，桥解析后调用那个函数，会话继续。
**超时和取消都走同一个出口**，不会留下挂死的回调。

## 群聊

群消息不建会话：拼提示词 → `askGroupModel()` 调一次模型 → `groupSay()` 发回。
好处是便宜、不占会话；代价是没有工具、没有长期记忆（只有 `history` 轮 + `facts` + 摘要）。
群里可以用 `/模型`、`/回复` 之类改运行期参数，落在 `group-settings.json`。

## 状态文件（都在 `dataDir`，默认 `~/.dsh/qq`）

| 文件 | 内容 |
|---|---|
| `state.json` | 当前绑定会话、Lily 总机、主人 QQ 号 |
| `bind.log` | 绑定变更流水 |
| `last-error.txt` | 最近一次失败（不用挂调试器） |
| `bridge.log` | 分级流水，2MB 滚一次 |
| `group-memory.json` | 群摘要与事实 |
| `group-settings.json` | 群运行期设置（模型、是否要 @） |
| `group.log` | 群聊流水 |
| `shot-*.png` | 截屏（`qq_send_file` 截图时） |

## 改什么要重启

**所有改动都要重启 DSH**：这是宿主插件（不是客户端 bundle），没有热更新。
重启后靠两件事确认活着：

```powershell
node scripts/smoke.mjs          # 静态：装配、工具、纯函数
Test-NetConnection 127.0.0.1 -Port 6721   # 运行期：入站口开着 = 插件装配成功
```

`qq\_restart-and-verify.ps1` 把这两步和「失败自动回滚」串在一起。
真机回归清单见 `REGRESSION.md`。
