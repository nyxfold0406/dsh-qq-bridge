// 发布包脱敏体检：把 tgz 里每个文件当 UTF-8 和 UTF-16LE 各扫一遍
// （exe/png 这类二进制里，.NET 字符串是 UTF-16，普通 grep 看不到）。
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const PATTERNS = [
  ['真名', /邱舜朗|邱晓拂/],
  ['手机号', /15920195179/],
  ['个人 QQ / 群号', /1371548293|660158129/],
  ['邮箱', /qiusl2008/],
  // 已经复核过的允许项：小窗的单实例互斥体名（DeskTodoXiWei_v3），只是锁的名字。
  ['本机路径', /XiWei|D:\\\\?AGENTS|Becky/],
  ['个人待办样例', /配音大赛|航天医学|肝功|DESeq2|四级口语|团课|准考证|体测|图书馆复习|新媒体中心|四级半套/],
  ['课表/窗口状态', /topmost=1|semesterstart=2026/],
]

// 复核过的允许串：扫之前先抹掉，命中与否都不算问题。
const ALLOWED = ['DeskTodoXiWei_v3']

const buf = gunzipSync(readFileSync(process.argv[2]))
const files = []
let off = 0
while (off + 512 <= buf.length) {
  const header = buf.subarray(off, off + 512)
  if (header.every((b) => b === 0)) break
  const nameEnd = header.indexOf(0)
  const name = header.subarray(0, nameEnd > 0 ? nameEnd : 100).toString('utf8')
  const sizeRaw = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
  const size = sizeRaw ? Number.parseInt(sizeRaw, 8) : 0
  if (!name.startsWith('PaxHeader')) {
    files.push({ name, body: buf.subarray(off + 512, off + 512 + size) })
  }
  off += 512 + Math.ceil(size / 512) * 512
}

let bad = 0
for (const [label, re] of PATTERNS) {
  const hits = []
  for (const f of files) {
    const scrub = (s) => ALLOWED.reduce((acc, lit) => acc.split(lit).join(''), s)
    const asUtf8 = scrub(f.body.toString('utf8'))
    const asUtf16 = scrub(f.body.toString('utf16le'))
    if (re.test(asUtf8) || re.test(asUtf16) || re.test(f.name)) hits.push(f.name)
  }
  if (hits.length) {
    bad += 1
    console.log(`✗ ${label}：${hits.join(', ')}`)
  } else {
    console.log(`✓ ${label}`)
  }
}
console.log(`\n${files.length} 个文件，${bad ? `${bad} 项命中，先别发` : '全干净'}`)
process.exit(bad ? 1 : 0)
