// 入站媒体的处理：表情入库、聊天记录展开、语音转写、图片转 content part。
//
// 这些函数都只依赖 NapCat 客户端和配置，不碰会话状态，所以可以单独成型；
// 由 src/bridge.js 在 groupCfg 就绪后创建一次。
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULTS } from './config.js'

/** 拉一个 URL，但只接受公网 http(s)、只读前 limit 字节，防 SSRF 与 OOM。 */
async function fetchCapped(url, limit) {
  let target
  try {
    target = new URL(url)
  } catch {
    return Buffer.alloc(0)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return Buffer.alloc(0)
  const host = target.hostname
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return Buffer.alloc(0)
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok || !res.body) return Buffer.alloc(0)
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > limit) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > limit) return Buffer.alloc(0)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

import { execFileP } from './util.js'

/**
 * @param {object} deps
 * @param {(action: string, params?: object, timeoutMs?: number) => Promise<any>} deps.callApi
 * @param {object} deps.log            ctx.logger
 * @param {object} deps.cfg            归一化后的配置
 * @param {object} deps.groupCfg       DEFAULTS.group 与 cfg.group 的合并结果
 * @param {(stage: string, error: unknown) => Promise<void>} deps.recordError
 */
export function createMedia({ callApi, log, cfg, groupCfg, recordError }) {
  // ---------------------------------------------------------- media ---

  /** 合并转发里每个消息段压成一行文字用的标记。 */
  function pieceLabel(piece) {
    if (!piece || typeof piece !== 'object') return ''
    if (piece.type === 'text') return String(piece.data?.text || '')
    if (piece.type === 'image') return '[图片]'
    if (piece.type === 'record') return '[语音]'
    if (piece.type === 'face' || piece.type === 'mface') return '[表情]'
    if (piece.type === 'video') return '[视频]'
    if (piece.type === 'file') return '[文件]'
    return ''
  }

  /** 按文件头判断图片类型，决定存成什么扩展名。 */
  function sniffImageExt(buffer) {
    if (!buffer || buffer.length < 12) return ''
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
    if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return 'gif'
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      return 'webp'
    }
    return ''
  }

  /**
   * 把聊天记录里的表情/表情图片真正收下来，存进 inbox 等入库。
   * 只收「表情段（mface）」和「带表情标记的图片」，普通图片/照片不动。
   * 返回占位文字：收到就写 [表情:已收 xxxx]，收不到就退回 [表情]。
   */
  async function harvestSticker(piece) {
    const isMface = piece?.type === 'mface'
    const data = piece?.data || {}
    // QQ 的表情图 sub_type 见过 1（动画表情）和 7（大表情/带文字的表情），
    // summary 也可能是表情自带的文字（例如「对的」），不全是「[动画表情]」。
    const subType = Number(data.sub_type ?? data.subType)
    const isStickerImage =
      piece?.type === 'image' &&
      (subType === 1 ||
        subType === 7 ||
        /动画表情|表情/.test(String(data.summary || '')))
    if (!isMface && !isStickerImage) return pieceLabel(piece)
    let buffer = Buffer.alloc(0)
    try {
      if (isMface && data.url) {
        buffer = await fetchCapped(String(data.url), 8 * 1024 * 1024)
      }
      if (!buffer.length && piece.type === 'image') {
        const part = await imagePart(piece)
        if (part?.data) buffer = Buffer.from(part.data, 'base64')
      }
    } catch (error) {
      log.warn(`bridge: 收表情失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const ext = sniffImageExt(buffer)
    if (!ext || buffer.length < 200 || buffer.length > 8 * 1024 * 1024) return '[表情]'
    try {
      const inbox = String(groupCfg.stickersInbox || DEFAULTS.group.stickersInbox)
      await mkdir(inbox, { recursive: true })
      const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 10)
      await writeFile(path.join(inbox, `${hash}.${ext}`), buffer)
      return `[表情:已收 ${hash}]`
    } catch {
      return '[表情]'
    }
  }

  /**
   * 展开「聊天记录」（合并转发）：拿 id 向 NapCat 要里面每条消息。
   * 只取前 40 条、总长 3000 字，够模型看懂上下文，不会撑爆。
   * 里面的表情会被真正收进 inbox（最多 12 张），不再只是占位。
   */
  async function expandForward(seg) {
    const id = String(seg?.data?.id || seg?.data?.message_id || '')
    if (!id) return ''
    try {
      const data = await callApi('get_forward_msg', { id }, 20_000)
      const list = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data?.message)
          ? data.message
          : []
      const lines = []
      let harvested = 0
      for (const m of list.slice(0, 40)) {
        const nick = String(m?.sender?.card || m?.sender?.nickname || m?.sender?.user_id || '?')
        let body = ''
        if (typeof m?.message === 'string') {
          body = m.message
        } else if (Array.isArray(m?.message)) {
          const pieces = []
          for (const piece of m.message) {
            const isStickerPiece =
              piece?.type === 'mface' ||
              (piece?.type === 'image' &&
                (Number(piece.data?.sub_type ?? piece.data?.subType) === 1 ||
                  /动画表情|表情/.test(String(piece.data?.summary || ''))))
            if (isStickerPiece && harvested < 12) {
              pieces.push(await harvestSticker(piece))
              harvested += 1
            } else {
              pieces.push(pieceLabel(piece))
            }
          }
          body = pieces.join('')
        }
        const line = `${nick}: ${String(body).trim()}`
        if (line.trim().length > 2) lines.push(line)
      }
      if (harvested) log.info?.(`bridge: 聊天记录里收了 ${harvested} 张表情到 inbox`)
      return lines.join('\n').slice(0, 3000)
    } catch (error) {
      log.warn(`bridge: 展开聊天记录失败：${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** Transcribe one QQ voice segment through the local whisper helper. */
  async function transcribeVoice(seg) {
    const fileRef = String(seg?.data?.file || '')
    const rawPath = String(seg?.data?.path || '')
    if (!fileRef && !rawPath) return ''
    // NapCat stores voice as silk/amr under its own cache. get_record decodes it,
    // but it only accepts the bare file name — a full path answers
    // "file not found" and the raw .amr then fails to decode as audio.
    let abs = ''
    if (fileRef) {
      try {
        const info = await callApi('get_record', { file: fileRef, out_format: 'wav' })
        const resolved = String(info?.file || info?.path || '')
        if (resolved) abs = resolved.startsWith('file://') ? resolved.slice(7) : resolved
      } catch (error) {
        log.warn(`bridge: get_record failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!abs) abs = rawPath || (path.isAbsolute(fileRef) ? fileRef : path.join(cfg.dataDir, fileRef))
    try {
      const { stdout } = await execFileP(
        cfg.pythonPath || 'python',
        [cfg.sttScript, abs, 'auto', cfg.sttModel || 'small'],
        {
          timeout: 180_000,
          windowsHide: true,
          env: {
            ...process.env,
            HF_ENDPOINT: 'https://hf-mirror.com',
            HF_HUB_DISABLE_XET: '1',
          },
        },
      )
      const line = String(stdout || '')
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('{'))
        .pop()
      if (!line) return ''
      const parsed = JSON.parse(line)
      if (parsed.error) {
        log.warn(`bridge: stt failed: ${parsed.error}`)
        await recordError('stt', parsed.error)
        return ''
      }
      return String(parsed.text || '').trim()
    } catch (error) {
      log.warn(`bridge: stt error: ${error instanceof Error ? error.message : String(error)}`)
      await recordError('stt', error)
      return ''
    }
  }

  /** 把一张图直接落进 inbox（批量收图用），返回是否写入成功。 */
  async function saveImageToInbox(part) {
    if (!part?.data) return false
    const ext =
      part.mediaType === 'image/png'
        ? 'png'
        : part.mediaType === 'image/gif'
          ? 'gif'
          : part.mediaType === 'image/webp'
            ? 'webp'
            : 'jpg'
    const buffer = Buffer.from(part.data, 'base64')
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return false
    const inbox = String(groupCfg.stickersInbox || DEFAULTS.group.stickersInbox)
    await mkdir(inbox, { recursive: true })
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 10)
    await writeFile(path.join(inbox, `${hash}.${ext}`), buffer)
    return true
  }

  /**
   * Turn one OneBot image segment into a DSH image content part.
   * NapCat keeps the file locally; get_image resolves the segment to a path.
   */
  async function imagePart(seg) {
    const raw = String(seg?.data?.file || seg?.data?.url || seg?.data?.path || '')
    if (!raw) return undefined
    let filePath = ''
    try {
      const info = await callApi(
        'get_image',
        { file: raw },
        Number(cfg.imageTimeoutMs) || DEFAULTS.imageTimeoutMs,
      )
      filePath = String(info?.file || info?.path || '')
    } catch (error) {
      log.warn(`bridge: get_image failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!filePath) return undefined
    if (filePath.startsWith('file://')) filePath = filePath.slice(7)
    filePath = path.normalize(filePath)
    const buffer = await readFile(filePath)
    if (!buffer.length) return undefined
    // 按文件头判断真实类型：iPhone 发来的图常是 .png 扩展名但内容是 JPEG，
    // 按扩展名声明会让宿主报 "Declared image type does not match its bytes"。
    let mediaType = 'image/jpeg'
    if (buffer.length >= 12 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      mediaType = 'image/png'
    } else if (buffer.length >= 6 &&
        buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      mediaType = 'image/gif'
    } else if (buffer.length >= 12 &&
        buffer.toString('ascii', 8, 12) === 'WEBP') {
      mediaType = 'image/webp'
    } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      mediaType = 'image/jpeg'
    }
    // Keep the cache small: phone photos are a few MB each.
    if (buffer.length > 12 * 1024 * 1024) {
      log.warn(`bridge: image too large (${buffer.length} bytes), skipped`)
      return undefined
    }
    return {
      type: 'image',
      mediaType,
      data: buffer.toString('base64'),
      name: path.basename(filePath),
    }
  }

  // ------------------------------------------------------------- session ---


  return {
    pieceLabel,
    sniffImageExt,
    harvestSticker,
    expandForward,
    transcribeVoice,
    saveImageToInbox,
    imagePart,
  }
}
