# 发布步骤（npm）

包名：`@nyxfold/dsh-qq-bridge`（作用域包，不跟别人抢名字）
版本：2.0.0
许可：MIT

> 2.0.0 起拆成两个包：
> - `@nyxfold/dsh-qq-bridge` —— 主桥
> - `@nyxfold/dsh-qq-schedule` —— 可选扩展（`/日程` `/待办`），0.1.0
>
> 先发 schedule（主包 README 提到它），或两个一起发，顺序不影响安装。

> 为什么用作用域包：`dsh-qq-bridge` 这个裸名字在 npm 上已经被占了
> （`xmengxin` 在 2026-08 发布过，Apache-2.0，走的是 QQ 官方 bot 路线）。
> 作用域包 `@nyxfold/...` 永远不会撞名，而且一眼能看出是谁发的。

---

## 0. 前置

| 需要 | 说明 |
|---|---|
| npm 账号 | 用户名 `nyxfold`（2026-11-11 查过：npm 上还没有这个用户） |
| 邮箱 | 注册要验证；之后找回账号也靠它 |
| 2FA | npm 现在要求；手机上装一个 authenticator（Google Authenticator / 1Password 都行） |
| 装了 npm 或 pnpm 的机器 | **这台电脑发不了**：DSH 自带的 Node 没有 npm CLI |

---

## 1. 注册

1. 打开 <https://www.npmjs.com/signup>
2. 用户名填 `nyxfold`，邮箱填你自己的，设密码
3. 去邮箱点验证链接
4. 登录后进 **Account → Two-Factor Authentication**，开启 2FA（扫码）

---

## 2. 登录（在有 npm 的机器上）

```bash
npm login
# 或：npm adduser
```

会依次要用户名、密码、邮箱 OTP、2FA 验证码。成功后会写 `~/.npmrc`。

---

## 3. 发布

把 `publish/dsh-qq-bridge` 整个目录拷到那台机器上，然后：

```bash
cd dsh-qq-bridge
npm publish --access public
```

作用域包必须加 `--access public`，否则默认是私有的（要付费）。

**没有 npm 只有 pnpm 时**（比如这台机器）：

```bash
node "<pnpm 路径>/bin/pnpm.cjs" publish --access public
```

pnpm 会读 `~/.npmrc` 里的 token，登录还是得用 `npm login` 或手动写 token。

---

## 4. 发完检查

```bash
npm view @nyxfold/dsh-qq-bridge          # 能看到 version / license / keywords
```

DSH 插件市场是**爬 npm** 的（找带 `dsh` 字段的包），下次刷新会自动收录，不需要投稿。
也可以手动让用户装：

```bash
dsh plugin add @nyxfold/dsh-qq-bridge
```

---

## 5. 发之前最后确认

- [x] `node scripts/smoke.mjs` 全绿
- [x] `node scripts/verify-hardening.mjs` 全绿
- [x] 隐私扫描零命中（没有 QQ 号 / 群号 / 本机绝对路径）
- [x] `package.json` 无 `private`、有 `publishConfig.access=public`
- [x] `cordis.patch.yml` 是中性默认（`allowUins: []`、群聊关闭）
- [x] `@nyxfold/dsh-qq-schedule` 路由自测通过（/待办、/日程 接管，/随便 不接管）
- [ ] 在第二台机器上按 README 装过（**未做**）

> 「群聊 @」「审批回填」已在作者机器上真机跑过（2.0.0 之前）。第二台机器安装
> 仍未验证，发布说明里不用强调，但自己心里有数。

## 6. 回滚 / 撤包

```bash
npm unpublish @nyxfold/dsh-qq-bridge@2.0.0 --force   # 24 小时内有效
npm deprecate @nyxfold/dsh-qq-bridge@2.0.0 "有严重问题，请用 2.0.1"
```

超过 24 小时基本只能 `deprecate`（发新版、把旧的标成废弃），名字收不回来。
