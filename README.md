# QQ 桥 · dsh-qq-bridge

**用手机 QQ 管理 DeepSeek Harness 的会话。**

人不在电脑前，也能知道哪个会话在跑、把新任务丢进指定工作区、把某一轮掐掉、
让需要审批的动作落到你的手机上。回答分段发回聊天，长任务跑完自己回来报。

它不是"把模型接进 QQ"的聊天机器人。**它把 QQ 变成 DSH 的遥控器。**

---

## 一、它解决的问题

DSH 是桌面上的一台机器：会话、工作区、后台任务、待审批。人一离开键鼠，
这台机器就失联了——你看不见它在干什么，也没法给它派活。

现有做法有三条路，各缺一块：

| 做法 | 缺什么 |
|---|---|
| 每个 QQ 聊天各开一个持久 agent（多数同类） | 能记住上下文，但会话数量跟着聊天数涨，上下文越滚越大，群里说话也会长出会话 |
| 让 agent 自己刷消息、自己发 | 你在不在场都一样，出问题找不到人；风险面大 |
| 远程桌面 / SSH | 手机上调不了会话，只能看屏幕 |

这个插件走第四条：**在 QQ 里做会话管理**——列、接、开、挂、盯。

---

## 二、设计上我们做了什么

下面每条都是「问题 → 做法 → 你得到什么」。**不吹首创**，同类里有重叠；差别在组合和取舍。

### 1. 总机（Lily）+ 代际编号

**问题**：如果 QQ 永远绑在同一个会话上，那个会话的历史会无限膨胀，越聊越贵、越聊越迟钝。

**做法**：挂断不是"断开连接"，而是**开一个新的总机**。每个总机叫 `controlV0.N`，
N 递增；旧的那个归档。总机是个干活的普通会话，不是特殊角色——它只是被绑定的那个。

**你得到什么**：随时能"换一张白纸"，不用手动删会话；上下文成本可控。

### 2. 接线是持久化的，而且是**有主**的

**问题**：桥重启后不知道电话该接给谁；更麻烦的是，任意一个会话都能抢走这条线。

**做法**：
- 绑定写进 `state.json`，重启后照旧生效；绑定变更写 `bind.log`（谁、什么时候、从哪到哪）
- 只有**总机**、或**当前拿着电话的那个会话**有权改绑定或挂断（`mayRebind`）
- 每轮投递前从磁盘读一次绑定——多实例时不会各认一个会话

**你得到什么**：不会被某个会话"劫持"；出了问题有流水可查。

### 3. 会话没了，电话自动回总机

**问题**：在 GUI 里把会话删了或归档了，QQ 这边的消息就投进黑洞——不报错、不回复，你以为它死了。

**做法**：投递前确认会话还能接活（存在、未归档）；不能就回落到总机，并在 QQ 上说一句
「原来接的那个会话不在了，已经转回总控」。

**你得到什么**：不会静默失联。

### 4. 忙的时候说实话，而不是装死

**问题**：会话正在跑一轮，你的新消息会排队，但你不知道。

**做法**：检测到忙碌就在 QQ 上回一句「手头那轮还没跑完，消息排着了」；
挂断类指令（`挂了`）插队执行（`steer`），不用等当前轮跑完。

**你得到什么**：知道它在忙，不是坏了；急事能立刻打断。

### 5. 群聊不建会话

**问题**：群里一句话就开一个会话，成本高、污染列表、还容易被群友带上歪路。

**做法**：群消息走另一条路——拼提示词、调一次模型、发回，**不建会话、不给工具**，
带限流（每人每分钟）和最小间隔。

**你得到什么**：群里能互动，但不会长出一堆垃圾会话。

### 6. 审批落到手机

**问题**：需要你点头的动作，人不在电脑前就卡在那里，而你以为它还在跑。

**做法**：审批和提问会转发成 QQ 消息；回「允许」/「拒绝」/编号即可。
超时、取消都走同一个出口，不留挂死的回调。

**你得到什么**：手机就能放行。

### 7. 形态：薄、零依赖、自带离线回归

- 约 4900 行、19 个模块，`src/bridge.js` 只剩不到 400 行装配
- 只用 Node 标准库，**零 npm 依赖**，不用装第三方运行时
- `node scripts/smoke.mjs` 在本地伪造一个 OneBot 服务端，把
  「收消息 → 路由 → 投递 → 回话」整条链跑一遍，不需要真号
- 自带**桌面待办小窗**（`todo-app/`）：一个独立 exe + 纯文本数据，
  `/日程` `/待办` 就是读它；不装 DSH 也能单独用

**你得到什么**：改得动、看得懂、坏了能自己查。这一点对"长期自己用"比功能多更重要。

---

## 三、和同类比

先说实话：**这个方向上别人做得比我们多。** 我读过两个：

**[dsh-onebot-qq](https://github.com/mario841859784/dsh-onebot)**（OneBot 11 + NapCat，跟我们同一条路）
——每个 QQ 聊天一个持久 Agent，重启自动 resume；有 `/new`、`/session`（切回历史会话）、
`/workspace`（切工作区）、`/preset`、`/model`、`/status`、`/steer`、`/doctor`，
还有中间消息实时发送、t2i 文字图卡片、群成员权限分档、群聊旁观。
**功能面比本插件宽得多**，如果这些你都用得上，直接用它。

**[@zaofan/dsh-qqbot](https://github.com/zaofan-make/dsh-qqbot)** 走的是腾讯官方 Bot API
（AppID / AppSecret，不碰个人号），带表情库、定时任务、群友小传、好感度、群管理面板。
**完全另一条路**——不需要 NapCat，但受官方接口范围限制。

那我们的位置在哪：

| | 本插件 | dsh-onebot-qq | SurfCore |
|---|---|---|---|
| 连接方式 | HTTP 上报（NapCat post_url） | WebSocket（正/反） | 第三方运行时 |
| 会话模型 | **一条线 + 一个总机**，代际轮换 | 每个聊天一个持久 Agent | 会话映射 + 控制台 |
| 切会话 | 总机在聊天里 `接 N` / `新 N` | `/session` 切回历史会话 | 控制台 |
| 谁能改绑定 | 只有总机或当前会话 | 管理员白名单 | 视实现 |
| 群聊 | **不建会话**，直接调一次模型 | 每个群一个 agent | 仿真群友 |
| 依赖 | **零 npm 依赖** | 有依赖、要编译 | 第三方运行时 + npm 依赖 |
| 离线回归 | 自带冒烟（伪造服务端） | 有 vitest 用例 | 有测试 |

**差别不是"谁功能多"，是"上下文怎么花"**：
它给每个聊天一个长期 agent，记得住但会越滚越大；
我们只维持一条线，挂断就换新总机，贵的地方只有当前那一段。

### 为什么有人会选 NapCat 这条路

比起腾讯**官方 Bot API**（注册开放平台、拿 AppID/AppSecret、申请群聊权限、等审核），
这条路省掉的是：注册、资质、审核、以及"默认只推 @ 消息"的限制。

代价也写在这里：**用的是个人号协议端，违反平台协议，有账号受限风险**；
官方路线完全不碰个人号，这是它唯一的、但很硬的优点。

**要功能全用 dsh-onebot-qq，要完整角色用 SurfCore，要一条便宜、能读能改、不用过审核的线，用这个。**

---

## 四、安装

前置：Windows、DSH、[NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot v11 运行时）。

```powershell
# 1) 装进 DSH profile（`~/.dsh/profiles/<name>/`）
pnpm add @nyxfold/dsh-qq-bridge
#    profile 的 package.json 里：
#      dependencies:   "@nyxfold/dsh-qq-bridge": "^1.1.1"
#      dsh.profile.bundles: 加入 "@nyxfold/dsh-qq-bridge"
#    （自己改代码就给可以 link 一份：pnpm add link:D:/AGENTS/plugins/qq-bridge）
#    包里自带的 cordis.patch.yml 是中性默认值：allowUins 为空、群聊关闭。

# 2) 配自己的值
copy node_modules/@nyxfold/dsh-qq-bridge/cordis.patch.example.yml → 同名文件，至少改 allowUins
#    安装目录里的 cordis.patch.yml 也可以直接改；改的是插件自己那一份，不是 profile 那份
#    （profile 里再写 `- id: qq` 会整块替换，不是深合并）

# 3) 重启 DSH
```

装完先改 `allowUins`，否则桥谁也不理。桌面待办小窗在包的 `todo-app/` 里，
双击 `桌面待办.exe` 就能用；想让 `/日程` `/待办` 读它，把 `todoAppDir` 指过去。

NapCat 那边只有一处要配：HTTP 上报（post_url）指向 `http://127.0.0.1:6721/`。

### 关于 UAC

NapCat 要注入客户端进程（通常在 `Program Files` 下），**这一步必须管理员权限**。
常见做法是在 `.bat` 里自我提权，代价是每次登录弹一次 UAC。

本插件本身不需要提权。要免掉那次弹窗的是**启动方式**：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-run-at-logon.ps1 `
  -TaskName NapCatQQ -Target "D:\path\to\start-napcat.bat" `
  -RemoveStartupLink "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\NapCatQQ.lnk"
```

设置一次（会弹一次 UAC），之后开机自动跑、不再弹。卸载加 `-Remove`。

---

## 五、在 QQ 上怎么用

**在会话里**：`/qq bind` 把当前会话接到 QQ。

**在 QQ 里**：

| 你说 | 它做什么 |
|---|---|
| `/任务` 或 `/进度` | 所有会话的快照：谁在跑、跑了多久、几个后台任务、待办到哪 |
| `/日程` | 最近一周的安排：课表 + 一次性事务 + 当天截止（`/日程 明天`、`/日程 3`、`/日程 本周`） |
| `/待办` | 未完成的待办清单，按截止时间和紧要程度排（`/待办 全部` 连已完成的一起列） |
| `/多条开始` … `/结束` | 接下来的几条先攒着，一次性合成一条发过去；`/多条` 看攒了几条，`/多条取消` 丢掉（攒的时候一句都不回） |
| `接 N` / `qq_bind_session` | 把第 N 个会话接到手机上 |
| `新 N` / `qq_call_workspace` | 在第 N 个工作区开一个新会话并接通 |
| `挂了` | 挂断，开一个新总机 |
| `/模型 N` | 换模型（`/模型 恢复` 回默认） |
| `允许` / `拒绝` | 审批 |
| `/收图 开始` … `/收完了` | 批量收表情进库 |

`/日程`、`/待办` 和 `/任务` 一样由桥自己回，**不进会话**：手机上问一句就有答案，
不用等某个正在跑的回合，也不花上下文。数据源是**桌面待办小窗**的纯文本
（`todoAppDir`，见[第六节](#六配置)），桥只读不写。

九个工具：`qq_send_message`、`qq_send_file`、`qq_status`、`qq_activity`、
`qq_list_sessions`、`qq_bind_session`、`qq_call_workspace`、`qq_workspaces`、`qq_hangup`。

---

## 六、配置

默认值在 `src/config.js` 的 `DEFAULTS`，**深合并**：只写要改的键。完整示例见
[`cordis.patch.example.yml`](./cordis.patch.example.yml)。

| 键 | 默认 | 说明 |
|---|---|---|
| `napcatUrl` | `http://127.0.0.1:3000` | NapCat 的 HTTP 地址 |
| `listenPort` | `6721` | 入站端口，必须等于 post_url |
| `allowUins` | `[]` | 白名单；**空 = 谁都不理** |
| `ingressToken` | `''` | 入站令牌；设了以后 post_url 要写成 `/<token>` |
| `dataDir` | `~/.dsh/qq` | state / bind.log / bridge.log |
| `switchboardDir` | `Switchboard` | 总机的工作目录名 |
| `todoAppDir` | `''` | 桌面待办小窗的数据目录；**空 = `/日程` `/待办` 不启用** |
| `scheduleDays` | `7` | `/日程` 默认看几天（含今天） |
| `maxChars` | `600` | 单条上限，超了分段 |
| `logLevel` | `info` | 同时写 `dataDir/bridge.log`（2MB 滚动） |
| `group.*` | 关闭 | 群聊白名单、模型、人设、限流 |

---

## 七、排查

| 症状 | 先看什么 |
|---|---|
| 发不出消息 | `qq_status`；NapCat 是否登录 |
| 收不到消息 | post_url 是否指向 `127.0.0.1:6721`；`allowUins` 是否为空 |
| 回了但很慢 | 会话是否在忙：`qq_activity` |
| 语音没转文字 | `pythonPath` 指向的解释器有没有 faster-whisper |
| 群里不回 | `group.allowGroups`、`requireMention`、`maxPerMinute` |

排障文件：`state.json`、`bind.log`、`bridge.log`、`last-error.txt`。

---

## 八、开发与测试

```
index.js            入口（只做装配）
src/bridge.js       约 390 行装配 + 启动/健康检查
src/inbound.js      入站分发：群/白名单/收图/语音/控制词/投递
src/session.js      接线、投递、列会话、开总机、挂断
src/state.js        state.json、审计、绑定权限
src/group.js        群聊
src/media.js        表情/聊天记录/语音/图片
src/model.js        /模型 切换 + 本地窗口预警
src/napcat.js       出站客户端
src/prompts.js      审批/提问转发
src/activity.js     会话活动快照
src/schedule.js     /日程 /待办 快照（读桌面待办的纯文本）
src/replies.js      回合文本回传
src/command.js      /qq 命令
src/tools.js        九个工具
src/config.js       默认值 + 深合并
src/log.js          分级日志
src/text.js         纯函数
src/http.js / util.js
```

```powershell
node --check index.js && node --check src/*.js
node scripts/smoke.mjs
```

冒烟测试用临时目录和 6799 端口，不碰线上状态、不连真号。
架构见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)，真机回归清单见 [`docs/REGRESSION.md`](./docs/REGRESSION.md)。

---

## 九、安全设计

- **入站只认 JSON**：带 `Origin` 头的请求直接拒（网页 `fetch` 到 127.0.0.1 会被挡），
  `content-type` 不是 JSON 的也拒。NapCat 不受影响。
- **可选共享令牌**：配了 `ingressToken`，入站路径必须带它；否则本机任何进程都能冒充你说话。
- **白名单之外静默丢弃**：连"你不在名单里"都不回，不给探测信号。
- **审批词只认**允许 / 同意 / 可以 / 确认 / 允许执行，和拒绝 / 不同意 / 禁止 / 取消。
  不再接受 `1`、`ok`、`y` 这类随手词。
- **只有 QQ 发起的回合才镜像回聊天**：你在电脑前直接跟这个会话说的话，不会出现在手机上。
- **出站黑名单**：`.credentials.yaml`、`.ssh`、`.env`、`*.key`、`.dsh/qq/` 一律拒发。
- **表情收割不抓内网**：只接受公网 http(s)，读之前先看大小，超 8MB 直接丢。

## 十、边界与许可

- 个人自用工具，与腾讯、DeepSeek 官方**没有任何关系**，不提供绕过风控的能力
- 只转发 NapCat 已经产生的消息，不修改客户端、不伪造协议
- 只认白名单里的号，其他人静默丢弃；凭据类文件拒绝发送
- 使用前请自行确认平台服务条款；账号风险自负
- MIT，见 [LICENSE](./LICENSE)
