# 发布页文案（可直接粘贴）

## 标题

**dsh-qq-bridge — 把 私聊接到 DeepSeek Harness 会话上（约 4 千行，零 npm 依赖）**

## 一句话

在一个会话里敲 `/qq bind`，之后手机 聊天里说一句，那台电脑上的会话就替你把活干了；
回答分段发回聊天，需要你点头的动作也能在 聊天里回「允许」。

## 正文

这个东西只做一件事：**当一根管子**。

- **薄**：18 个模块、约 4 千行，`src/bridge.js` 只剩 374 行装配代码。没有旁挂服务、没有进程间协议。
- **零依赖**：不装 npm 包、不要第三方运行时，`git clone` + 改一个 yml + 重启就能跑。
- **不碰账号内容**：不替你看视频、评论、发动态，风险面小。
- **群聊不污染会话**：群里说话不建会话、不给工具，直接调一次模型答，便宜。
- **自带回归**：`node scripts/smoke.mjs` 会本地伪造一个 NapCat，把「收消息 → 投递 → 回话」
  整条链跑一遍，不需要真号就能验证改动没把桥弄断。
- **免 UAC**：附 `scripts/windows-run-at-logon.ps1`，把需要管理员的启动命令挂成
  「最高权限 + 登录触发」的计划任务，开机自动跑且不再弹窗。

## 取向：一根管子，不是一个角色

同类方案里有人把桌面分身、长期记忆、B站联动、语音都做进去了，那是另一条路，
功能面远超本项目。本项目的取舍是窄而薄：

- **定位**：只做 QQ ↔ DSH 会话的通道，不接管角色、记忆、内容运营。
- **群聊**：不建会话，直接调一次模型答，省上下文。
- **依赖**：零 npm 依赖，代码量约 4 千行，一个人一晚上能读完。
- **自带离线回归**：不用真号就能验证改动没把桥弄断。

要养一个长期存在的她，用那类整套方案；要一根干净、能读能改的管子，用这个。

## 安装（三步）

```powershell
git clone https://github.com/<you>/dsh-qq-bridge.git C:\Users\you\plugins\dsh-qq-bridge
# profile package.json：dsh-qq-bridge → link:...；bundles 里加 dsh-qq-bridge
copy cordis.patch.example.yml cordis.patch.yml   # 填 allowUins
# 重启 DSH；NapCat 的 post_url 指向 http://127.0.0.1:6721/
```

## 合规与边界

- 只认白名单里的号，其他人静默丢弃
- 不代登录、不绕过风控、不转发凭据类文件
- 与腾讯 / QQ / DeepSeek 官方无关；使用前请自行确认 QQ 服务条款，风险自负
- MIT 许可

---

# 发布前检查清单

- [x] 代码里没有本机绝对路径（`DEFAULTS` 全部改成 `os.homedir()` 派生或 `python`）
- [x] 没有 号码 / 群号 / 群友名单 / 歌单 / 电台名
- [x] `cordis.patch.yml` 是中性默认值（`allowUins: []`、群聊关闭）
- [x] `cordis.patch.example.yml` 带注释、含全部可配置项
- [x] README 面向外部用户（不是写给自家人看的）
- [x] LICENSE（MIT）
- [x] `.gitignore` 排除 `state/`、`*.key`、`*.log`
- [x] `node scripts/smoke.mjs` 在没有真号的情况下全绿
- [ ] 在干净机器上按 README 走一遍（未做）
- [ ] 决定仓库名与所有者（未定）

# 发布后要盯的事

1. **DSH 升级会漂**：本插件吃 `sessionController` / `tools` / `commands` / `workspaceRegistry`
   这些宿主接口。升级后先跑 `node scripts/smoke.mjs`，它会立刻报哪块对不上。
2. **NapCat 的 post_url 是最常见的装不起来原因**：README 里要放在最显眼的位置。
3. **别把 `cordis.patch.yml` 当地址簿**：用户会把自己的 号码写进去，然后想发出来问问题。
   `.gitignore` 里已经排了 `cordis.patch.local.yml`，但主文件还是别提交个人版本。
