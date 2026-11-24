// NapCat（OneBot v11）出站客户端：发文字 / 发文件 / 发图 / 截屏。
//
// 只负责「把东西送出去」，不关心是回复谁、为什么发。入站（NapCat 的
// HTTP 上报）不在这里，见 src/bridge.js 的 startInbound。
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { postJson } from './http.js'
import { plainText, splitText } from './text.js'
import { execFileP, sleep } from './util.js'

/**
 * @param {object} opts
 * @param {string} opts.url            NapCat 的 HTTP 根地址
 * @param {string} [opts.accessToken]  可选 token，走 Authorization 头
 * @param {string} opts.dataDir        截图落盘目录
 * @param {number} [opts.maxChars]     单条消息上限（超了自动分段）
 * @param {object} opts.log            ctx.logger（或空实现）
 * @param {() => string} opts.getOwnerUin  当前绑定主人的 QQ 号（可能是空串）
 * @param {(info: {at:number,chars:number,chunks:number}) => void} [opts.onSent]
 *        每次成功发完一条消息后回调（旧版的 lastSend，用于排障）
 */
export function createNapcat({ url, accessToken, dataDir, maxChars = 600, log, getOwnerUin, onSent }) {
  const say = log || { warn: () => {}, info: () => {}, debug: () => {} }

  function apiUrl(action) {
    const base = url.endsWith('/') ? url : `${url}/`
    return new URL(action, base).toString()
  }

  async function callApi(action, params, timeoutMs = 15_000) {
    const headers = {}
    if (accessToken) headers.authorization = `Bearer ${accessToken}`
    const { statusCode, body } = await postJson(apiUrl(action), params || {}, headers, timeoutMs)
    if (statusCode && statusCode >= 400) {
      throw new Error(`NapCat ${action}: HTTP ${statusCode} ${typeof body === 'string' ? body : ''}`.trim())
    }
    if (body && typeof body === 'object' && body.retcode !== 0 && body.retcode !== undefined) {
      const detail = body.message || body.wording || body.msg || ''
      throw new Error(`NapCat ${action}: retcode ${body.retcode} ${detail}`.trim())
    }
    return body && typeof body === 'object' ? body.data : undefined
  }

  async function sendText(uin, text) {
    const target = String(uin || getOwnerUin()).trim()
    if (!target) throw new Error('bridge: no target QQ number yet — send a message from the allowed account first')
    const chunks = splitText(plainText(text), maxChars)
    for (let i = 0; i < chunks.length; i += 1) {
      // Small gap between chunks: rapid-fire sends are what rate limits catch.
      if (i > 0) await sleep(500)
      try {
        await callApi('send_private_msg', { user_id: Number(target), message: chunks[i] })
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        say.warn?.(`bridge: 发送失败（第 ${i + 1}/${chunks.length} 段），1.2 秒后重试一次：${why}`)
        await sleep(1200)
        await callApi('send_private_msg', { user_id: Number(target), message: chunks[i] })
      }
    }
    const info = { at: Date.now(), chars: String(text || '').length, chunks: chunks.length }
    if (onSent) onSent(info)
    return chunks.length
  }

  async function sendFile(uin, file, displayName) {
    const target = String(uin || getOwnerUin()).trim()
    if (!target) throw new Error('bridge: no target QQ number yet')
    const absolute = path.resolve(file)
    // The file leaves the machine, so keep credentials and session stores out
    // of reach even if some session is talked into sending them.
    const blocked =
      /(^|[\\/])(\.credentials\.yaml|id_rsa|id_ed25519|id_ecdsa|\.env(\.[^\\/]*)?|credentials\.json|cookies\.txt|passkey\.json|cloud-key\.txt|deepseek\.key|[^\\/]*\.key)$/i.test(absolute) ||
      /[\\/]\.dsh[\\/]qq[\\/]/i.test(absolute) ||
      /[\\/]\.ssh[\\/]/i.test(absolute) ||
      /[\\/]\.dsh([\\/]sessions|[\\/]storages|[\\/]profiles)[\\/]/i.test(absolute)
    if (blocked) throw new Error('bridge: 这个路径是凭据/会话数据，不给发。')
    // NB: never name this `stat` — it shadows the imported helper and the
    // initializer then hits the temporal dead zone ("Cannot access 'stat'
    // before initialization").
    const fileStat = await stat(absolute).catch(() => undefined)
    if (!fileStat || !fileStat.isFile()) throw new Error(`bridge: 找不到文件：${absolute}`)
    const name = displayName || path.basename(absolute)
    const posix = absolute.replace(/\\/g, '/')
    // NapCat's Go-CQHTTP `upload_private_file` action returns
    // "rich media transfer failed" from the QQ 9.9.30 kernel no matter what
    // path form is used. The regular `send_private_msg` file segment goes
    // through a different code path inside NapCat and works on the same build,
    // so send the file as a message segment instead.
    try {
      await callApi('send_private_msg', {
        user_id: Number(target),
        message: [{ type: 'file', data: { file: posix, name } }],
      })
    } catch (error) {
      await callApi('send_private_msg', {
        user_id: Number(target),
        message: [{ type: 'file', data: { file: `file:///${posix}`, name } }],
      })
    }
    return absolute
  }

  async function sendImage(uin, file) {
    const target = String(uin || getOwnerUin()).trim()
    if (!target) throw new Error('bridge: no target QQ number yet')
    const absolute = path.resolve(file)
    const asUri = `file:///${absolute.replace(/\\/g, '/')}`
    await callApi('send_private_msg', {
      user_id: Number(target),
      message: [{ type: 'image', data: { file: asUri } }],
    })
    return absolute
  }

  /** Capture the primary screen into a PNG under the bridge data dir. */
  async function captureScreen() {
    await mkdir(dataDir, { recursive: true })
    const out = path.join(dataDir, `shot-${Date.now()}.png`)
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)',
      `$bmp.Save('${out.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose()',
      '$bmp.Dispose()',
    ].join('; ')
    await execFileP(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 25_000, windowsHide: true },
    )
    return out
  }

  return { apiUrl, callApi, sendText, sendFile, sendImage, captureScreen }
}
