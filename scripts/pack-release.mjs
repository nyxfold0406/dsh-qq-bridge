#!/usr/bin/env node
// 打 npm 发布包：dist/stage/ 准备好，再 pack 出 tgz。包名就叫 QQ 桥：@nyxfold/dsh-qq-bridge。
//
//   node scripts/pack-release.mjs                # 只打包
//   node scripts/pack-release.mjs --publish      # 打完直接发（要先 npm 登录）
//
// 本机没有独立 npm，用 DSH 自带的 pnpm：
//   DSH_PNPM_PATH="C:/Users/QSL/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
//     node scripts/pack-release.mjs
//
// 为什么不直接在本目录里 pack：
//   本机 profile 是用短名 `dsh-qq` link 的，而 npm 上的名字是
//   `@nyxfold/dsh-qq-bridge`（1.0.7 就发在这个 scope 下）。直接改本目录的
//   package.json 会让 profile 的 link 名字对不上，得重新 pnpm install 才不影响
//   重启加载。所以发布用的名字只在**暂存目录**里改，本机怎么跑还是怎么跑。
//
// 同时把 cordis.patch.yml 换成 cordis.patch.release.yml（中性默认值 + 发布名）：
// 本机那份含自己的 QQ 号、群号、人设和本机路径，绝对不能进包。
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const STAGE = path.join(DIST, 'stage')
const RELEASE_NAME = '@nyxfold/dsh-qq-bridge'

// 只带这些进包（不跟 package.json 的 files 走，这里才是唯一口径）。
const FILES = [
  'index.js',
  'src',
  'tools',
  'scripts/smoke.mjs',
  'scripts/verify-hardening.mjs',
  'scripts/audit-release.mjs',
  'docs/ARCHITECTURE.md',
  'docs/REGRESSION.md',
  'docs/PUBLISH.md',
  'todo-app',
  'LICENSE',
  'README.md',
  'cordis.patch.example.yml',
]

const pnpmPath = String(process.env.DSH_PNPM_PATH || '').trim()
if (!pnpmPath) {
  console.error('缺 DSH_PNPM_PATH：指向 DSH 自带的 pnpm.mjs（见文件头的例子）')
  process.exit(1)
}

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

await rm(STAGE, { recursive: true, force: true })
await mkdir(STAGE, { recursive: true })
for (const rel of FILES) {
  if (!(await exists(path.join(ROOT, rel)))) {
    console.warn(`· 跳过不存在的 ${rel}`)
    continue
  }
  await cp(path.join(ROOT, rel), path.join(STAGE, rel), { recursive: true })
}

// 插件描述文件换成发布版（中性默认值、发布名）
await cp(path.join(ROOT, 'cordis.patch.release.yml'), path.join(STAGE, 'cordis.patch.yml'))

// package.json：换成发布名；文件已经暂存好了，去掉 files 过滤和 private。
const out = {
  name: RELEASE_NAME,
  version,
  type: pkg.type,
  description: pkg.description,
  license: 'MIT',
  author: 'Vesperviod',
  keywords: pkg.keywords,
  exports: pkg.exports,
  scripts: { smoke: 'node scripts/smoke.mjs' },
  dsh: pkg.dsh,
}
await writeFile(path.join(STAGE, 'package.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')

console.log(`暂存完成：${STAGE}（${out.name}@${out.version}）`)

const run = (argv) => {
  const res = spawnSync(process.execPath, argv, { cwd: STAGE, stdio: 'inherit' })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run([pnpmPath, 'pack', '--pack-destination', DIST])
const tgz = path.join(DIST, `${RELEASE_NAME.replace(/^@/, '').replace('/', '-')}-${version}.tgz`)
console.log(`打好了：${tgz}`)

if (process.argv.includes('--publish')) {
  // 从暂存目录发，别从本目录发（名字不一样）
  run([pnpmPath, 'publish', '--access', 'public', '--no-git-checks', '--tag', 'latest'])
}
