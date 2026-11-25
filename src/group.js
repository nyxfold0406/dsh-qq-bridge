// 群聊子系统：不建 DSH 会话，直接拿消息拼提示词、调一次模型、回一条话。
//
// 状态全部封闭在这里（每个群的历史、限流时间戳、记忆、设置）：
//   groupHistory  最近 history 轮对话
//   groupStamps   每人每分钟的发言时间戳（限流）
//   groupMemory   摘要与事实（落 group-memory.json）
//   groupSettings 群里运行期改过的模型 / 是否要 @（落 group-settings.json）
//
// 依赖由 src/bridge.js 注入：NapCat 客户端、发消息、配置、媒体处理、日志。
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULTS } from './config.js'

// 群聊里自称的名字。发布版留占位，用户在自己的配置里改 systemPrompt 覆盖。
const ASSISTANT_NAME = '你的角色名'

/**
 * @param {object} deps
 * @param {object} deps.cfg         归一化后的顶层配置
 * @param {object} deps.groupCfg    DEFAULTS.group 与 cfg.group 的合并结果
 * @param {object} deps.log         ctx.logger（或带分级日志的包装）
 * @param {Function} deps.callApi   NapCat API
 * @param {Function} deps.postJson  JSON POST（云端模型用）
 * @param {Function} deps.getJson   JSON GET（列 LM Studio 模型用）
 * @param {Function} deps.sleep
 * @param {(stage: string, error: unknown) => Promise<void>} deps.recordError
 * @param {object} deps.media       src/media.js 的返回值
 * @param {Function} deps.plainText
 * @param {Function} deps.splitText
 * @param {Function} deps.messageText
 */
export function createGroup(deps) {
  const {
    cfg,
    groupCfg,
    log,
    callApi,
    postJson,
    getJson,
    sleep,
    recordError,
    media,
    plainText,
    splitText,
    messageText,
  } = deps
  const {
    pieceLabel,
    sniffImageExt,
    harvestSticker,
    expandForward,
    transcribeVoice,
    saveImageToInbox,
    imagePart,
  } = media || {}

  const groupCloud = { ...DEFAULTS.group.cloud, ...(groupCfg.cloud || {}) }
  const groupCloudKeyFile = String(
    groupCloud.keyFile || path.join(cfg.dataDir || DEFAULTS.dataDir, 'cloud-key.txt'),
  )
  let groupCloudKey = ''
  let groupCloudKeyLoaded = false

  /** Cloud models ride on an API key file, not on DSH's account login. */
  async function cloudApiKey() {
    if (groupCloudKeyLoaded) return groupCloudKey
    groupCloudKeyLoaded = true
    try {
      groupCloudKey = (await readFile(groupCloudKeyFile, 'utf8')).trim()
    } catch {
      groupCloudKey = ''
    }
    return groupCloudKey
  }

  function isCloudModel(value) {
    return String(value || '').startsWith('cloud:')
  }
  const groupAllowed = new Set(
    (groupCfg.allowGroups || []).map((v) => String(v).trim()).filter(Boolean),
  )
  const groupHistory = new Map()
  const groupStamps = new Map()
  const groupLastReply = new Map()
  const groupMemory = new Map()
  const groupExchange = new Map()
  let groupMemoryLoaded = false
  let groupMemoryTimer

  const groupMemoryFile = String(
    groupCfg.memoryFile || path.join(cfg.dataDir || DEFAULTS.dataDir, 'group-memory.json'),
  )
  const groupSettingsFile = path.join(
    cfg.dataDir || DEFAULTS.dataDir,
    'group-settings.json',
  )
  let groupSettingsLoaded = false
  let groupModelOverride = ''
  // undefined = follow the config; true/false = owner's runtime choice.
  let groupRequireMention

  /** The group picks its own local model; it is not the private session's. */
  function effectiveGroupModel() {
    return groupModelOverride || groupCfg.model
  }

  /** Does the bot need an @ (or wake word) before it answers in a group? */
  function needsMention() {
    if (typeof groupRequireMention === 'boolean') return groupRequireMention
    return groupCfg.requireMention !== false
  }

  async function loadGroupSettings() {
    if (groupSettingsLoaded) return
    groupSettingsLoaded = true
    try {
      const parsed = JSON.parse(await readFile(groupSettingsFile, 'utf8'))
      if (typeof parsed?.model === 'string') groupModelOverride = parsed.model.trim()
      if (typeof parsed?.requireMention === 'boolean') groupRequireMention = parsed.requireMention
    } catch {
      /* no override yet */
    }
  }

  async function saveGroupSettings() {
    try {
      await mkdir(path.dirname(groupSettingsFile), { recursive: true })
      const payload = { model: groupModelOverride }
      if (typeof groupRequireMention === 'boolean') payload.requireMention = groupRequireMention
      await writeFile(groupSettingsFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (error) {
      log.warn?.(`bridge: [群] 设置写盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Ask LM Studio which models it currently serves (chat ones only). */
  async function groupModelOptions() {
    const base = String(groupCfg.baseUrl || DEFAULTS.group.baseUrl).replace(/\/+$/, '')
    const res = await getJson(`${base}/models`, 8000)
    const list = Array.isArray(res?.body?.data) ? res.body.data : []
    const local = list
      .map((entry) => String(entry?.id ?? ''))
      .filter((id) => id && !/embed/i.test(id))
      .map((id) => ({ value: id, label: id }))
    const cloud = []
    if (groupCloud.enabled && (await cloudApiKey())) {
      for (const id of groupCloud.models || []) {
        const model = String(id || '').trim()
        if (model) cloud.push({ value: `cloud:${model}`, label: `${model}（云）` })
      }
    }
    return [...local, ...cloud]
  }

  function modelLabel(value) {
    return isCloudModel(value) ? `${String(value).slice(6)}（云）` : String(value)
  }

  async function groupModelCommandReply(argument) {
    const arg = String(argument || '').trim()
    const options = await groupModelOptions().catch(() => [])
    const current = effectiveGroupModel()
    if (!arg) {
      const lines = options.map(
        (item, index) =>
          `${index + 1}. ${item.label}${item.value === current ? '  ← 当前' : ''}`,
      )
      const head = options.length ? lines.join('\n') : '（没拿到模型列表）'
      return [
        '群聊可用的模型：',
        head,
        '',
        `现在：${modelLabel(current)}`,
        '发「/群模型 2」切换，「/群模型 恢复」回配置默认（本地 qwen4b）。',
        '注：只影响群聊；私聊会话用 /模型。云端按 token 计费。',
      ].join('\n')
    }
    if (/^(恢复|默认|reset|default)$/i.test(arg)) {
      groupModelOverride = ''
      await saveGroupSettings()
      return `群聊模型已回到配置默认：${groupCfg.model}`
    }
    let target
    const index = Number(arg)
    if (Number.isInteger(index) && index >= 1 && index <= options.length) target = options[index - 1]
    if (!target) {
      const needle = arg.toLowerCase()
      target = options.find(
        (item) =>
          item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle),
      )
    }
    if (!target) return `没找到「${arg}」。发「/群模型」看列表。`
    groupModelOverride = target.value
    await saveGroupSettings()
    return `群聊已切到 ${target.label}。${isCloudModel(target.value) ? '（云端，按 token 计费）' : ''}`
  }

  /**
   * Runtime switch for "must I be @'d in a group". Persisted next to the model
   * override, so it survives restarts without editing the profile config.
   */
  async function groupReplyCommandReply(argument) {
    const arg = String(argument || '').trim().toLowerCase()
    const open = ['开', 'on', '全部', 'always', 'all', '不用@', '不用']
    const close = ['关', 'off', '只@', '@', 'mention', '要@']
    if (open.includes(arg)) groupRequireMention = false
    else if (close.includes(arg)) groupRequireMention = true
    else groupRequireMention = !needsMention()
    await saveGroupSettings()
    return needsMention()
      ? '群聊恢复成只回 @ 和唤醒词。'
      : '群聊现在每条都回，不用 @。嫌吵发「/群回复 关」。'
  }

  /** Small model, small memory: a compact per-group summary is persisted. */
  async function loadGroupMemory() {
    if (groupMemoryLoaded) return
    groupMemoryLoaded = true
    try {
      const parsed = JSON.parse(await readFile(groupMemoryFile, 'utf8'))
      for (const [key, value] of Object.entries(parsed || {})) {
        if (value && typeof value.summary === 'string' && value.summary.trim()) {
          groupMemory.set(key, { summary: value.summary, updatedAt: Number(value.updatedAt) || 0 })
        }
      }
    } catch {
      /* first run: start empty */
    }
  }

  function saveGroupMemorySoon() {
    clearTimeout(groupMemoryTimer)
    groupMemoryTimer = setTimeout(async () => {
      try {
        const out = {}
        for (const [key, value] of groupMemory) out[key] = value
        await mkdir(path.dirname(groupMemoryFile), { recursive: true })
        await writeFile(groupMemoryFile, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
      } catch (error) {
        log.warn?.(`bridge: [群] 记忆写盘失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, 1500)
    groupMemoryTimer.unref?.()
  }

  /**
   * One chat completion. Local models go to LM Studio; "cloud:<model>" entries
   * go to the OpenAI-compatible cloud endpoint with the stored API key.
   */
  async function askGroupModel(messages, options = {}) {
    const picked = effectiveGroupModel()
    const cloudModel = isCloudModel(picked) ? String(picked).slice(6) : ''
    const base = cloudModel
      ? String(groupCloud.baseUrl || DEFAULTS.group.cloud.baseUrl).replace(/\/+$/, '')
      : String(groupCfg.baseUrl || DEFAULTS.group.baseUrl).replace(/\/+$/, '')
    const headers = {}
    if (cloudModel) {
      const key = await cloudApiKey()
      if (!key) throw new Error('云端模型没有 API key（cloud-key.txt 是空的）')
      headers.authorization = `Bearer ${key}`
    }
    const localBudget =
      Number(options.maxTokens) || Number(groupCfg.maxTokens) || DEFAULTS.group.maxTokens
    // Reasoning models spend the budget thinking first; give cloud calls room
    // and retry once with a much larger cap if the answer got cut off.
    const budgets = cloudModel
      ? [Math.max(localBudget, Number(groupCloud.maxTokens) || DEFAULTS.group.cloud.maxTokens)]
      : [localBudget]
    if (cloudModel) budgets.push(budgets[0] * 4)
    const timeoutMs = cloudModel
      ? Number(groupCloud.timeoutMs) || DEFAULTS.group.cloud.timeoutMs
      : Number(groupCfg.timeoutMs) || DEFAULTS.group.timeoutMs

    let lastPayload
    let lastStatus
    for (const maxTokens of budgets) {
      const body = {
        model: cloudModel || picked,
        messages,
        temperature:
          Number(options.temperature) || Number(groupCfg.temperature) || DEFAULTS.group.temperature,
        max_tokens: maxTokens,
        stream: false,
        ...(cloudModel && groupCloud.disableThinking !== false
          ? { thinking: { type: 'disabled' } }
          : {}),
      }
      const res = await postJson(`${base}/chat/completions`, body, headers, timeoutMs)
      // postJson resolves { statusCode, body } — the completion lives in .body.
      const payload = res?.body
      lastPayload = payload
      lastStatus = res?.statusCode
      if (res?.statusCode && res.statusCode >= 400) {
        throw new Error(`HTTP ${res.statusCode} ${JSON.stringify(payload).slice(0, 120)}`)
      }
      const text = payload?.choices?.[0]?.message?.content
      if (typeof text === 'string' && text.trim()) return text.trim()
      log.warn?.(
        `bridge: [群] 空回复（max_tokens=${maxTokens}，finish=${payload?.choices?.[0]?.finish_reason ?? '?'}）`,
      )
    }
    const sample =
      typeof lastPayload === 'string'
        ? lastPayload.slice(0, 120)
        : JSON.stringify(lastPayload ?? null).slice(0, 120)
    throw new Error(`empty completion (status=${lastStatus ?? '?'}, body=${sample})`)
  }

  /**
   * A condensed character sheet for group chat: short, flat, no cheerleading. Keep this under ~200
   * characters — a 4B model spends its attention fast.
   */
  function groupPersona() {
    const custom = String(groupCfg.persona || '').trim()
    if (custom) return custom
    return [
      `你是${ASSISTANT_NAME}。这是你自己的群，安静点没关系，不用当主持。`,
      '中文，一次一到三句，不加名字前缀、不写括号动作、不用表情符号。',
      '平静，有立场。问你就答，不知道就说不知道；不同意就说不同意，给一句理由就够。',
      '别编现实经历（学校、专业、住址、家人），被问到就说「这个不讲」，然后接着聊别的。',
      '这份默认人设是占位用的：自己的设定请在配置里写 group.persona。',
    ].join('\n')
  }

  /** 表情库索引：{items:[{name,file,hash,size,addedAt}]}，没有就返回空。 */
  async function loadStickerIndex() {
    const dir = String(groupCfg.stickersDir || DEFAULTS.group.stickersDir)
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'))
      if (Array.isArray(parsed?.items)) return parsed
    } catch {
      /* 旧库没有索引，回退到扫目录 */
    }
    return { items: [] }
  }

  async function saveStickerIndex(index) {
    const dir = String(groupCfg.stickersDir || DEFAULTS.group.stickersDir)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }

  /** 库里的表情条目：优先用索引，没索引就扫目录。 */
  async function stickerEntries() {
    const dir = String(groupCfg.stickersDir || DEFAULTS.group.stickersDir)
    const index = await loadStickerIndex()
    if (index.items.length) {
      return index.items.map((it) => ({ name: String(it.name), file: String(it.file) }))
    }
    try {
      const files = await readdir(dir)
      return files
        .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
        .map((f) => ({ name: path.parse(f).name, file: f }))
    } catch {
      return []
    }
  }

  /** 表情包文件名（不含扩展名）当表情名用。每次随机挑 20 个给模型看，省 token。 */
  async function stickerNames() {
    if (groupCfg.stickersEnabled === false) return []
    const entries = await stickerEntries()
    const names = entries.map((e) => e.name)
    // 随机抽一批，避免每轮都只看到同样几个
    for (let i = names.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[names[i], names[j]] = [names[j], names[i]]
    }
    return names.slice(0, 20)
  }

  /**
   * 入库：把 stickersInbox 里的图搬进表情库，文件名＝表情名，同名自动加后缀。
   * 去重按 sha256；超过 8MB 或不是图片的跳过。
   */
  async function importStickers() {
    const dir = String(groupCfg.stickersDir || DEFAULTS.group.stickersDir)
    const inbox = String(groupCfg.stickersInbox || DEFAULTS.group.stickersInbox)
    await mkdir(dir, { recursive: true })
    await mkdir(inbox, { recursive: true })
    const index = await loadStickerIndex()
    const knownHashes = new Set(index.items.map((it) => String(it.hash || '')))
    const usedNames = new Set(index.items.map((it) => String(it.name).toLowerCase()))
    const result = { added: [], dup: 0, tooBig: 0, bad: 0 }

    // 先把库里已存在、但索引里没有的图补登记（手动丢进目录的那些），
    // 否则有索引之后它们就永远不出现在表情清单里。
    let reconciled = 0
    try {
      for (const file of await readdir(dir)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) continue
        const name = path.parse(file).name
        if (usedNames.has(name.toLowerCase())) continue
        let buffer
        try {
          buffer = await readFile(path.join(dir, file))
        } catch {
          continue
        }
        const hash = createHash('sha256').update(buffer).digest('hex')
        if (knownHashes.has(hash)) continue
        knownHashes.add(hash)
        usedNames.add(name.toLowerCase())
        index.items.push({
          name,
          file,
          hash,
          size: buffer.length,
          addedAt: new Date().toISOString(),
        })
        reconciled += 1
      }
    } catch {
      /* 目录还不存在也无所谓 */
    }
    result.reconciled = reconciled

    let files = []
    try {
      files = await readdir(inbox)
    } catch {
      return result
    }
    for (const file of files) {
      const src = path.join(inbox, file)
      let info
      try {
        info = await stat(src)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) {
        result.bad += 1
        continue
      }
      if (info.size > 8 * 1024 * 1024) {
        result.tooBig += 1
        continue
      }
      let buffer
      try {
        buffer = await readFile(src)
      } catch {
        result.bad += 1
        continue
      }
      const hash = createHash('sha256').update(buffer).digest('hex')
      if (knownHashes.has(hash)) {
        result.dup += 1
        await rm(src, { force: true })
        continue
      }
      const ext = path.extname(file).toLowerCase()
      let base = path.parse(file).name
        .replace(/[\r\n\t]/g, ' ')
        .replace(/[\[\]【】()（）]/g, '')
        .trim()
      // 哈希名（聊天记录里收的表情）也算没法当名字的，统一改成「表情N」
      if (
        !base ||
        /^\d+$/.test(base) ||
        /^[0-9a-f]{8,}$/i.test(base) ||
        /^(img|image|微信图片|screenshot)[-_ ]?\d*$/i.test(base)
      ) {
        base = `表情${index.items.length + result.added.length + 1}`
      }
      let name = base
      let n = 2
      while (usedNames.has(name.toLowerCase())) {
        name = `${base}-${n}`
        n += 1
      }
      usedNames.add(name.toLowerCase())
      knownHashes.add(hash)
      const destName = `${name}${ext}`
      await writeFile(path.join(dir, destName), buffer)
      index.items.push({
        name,
        file: destName,
        hash,
        size: buffer.length,
        addedAt: new Date().toISOString(),
      })
      result.added.push(name)
      await rm(src, { force: true })
    }
    if (result.added.length || reconciled) await saveStickerIndex(index)
    return result
  }

  /** 把模型写的 [表情:名字] 变成一条真实消息段；找不到就返回 undefined。 */
  async function buildSticker(name) {
    const raw = String(name || '').trim()
    if (!raw) return undefined
    const face = /^face[:：](\d{1,2})$/i.exec(raw)
    if (face) return { type: 'face', data: { id: face[1] } }
    const dir = String(groupCfg.stickersDir || DEFAULTS.group.stickersDir)
    try {
      const files = await readdir(dir)
      const file = files.find(
        (f) => /\.(png|jpe?g|gif|webp)$/i.test(f) && path.parse(f).name.toLowerCase() === raw.toLowerCase(),
      )
      if (!file) return undefined
      const buffer = await readFile(path.join(dir, file))
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) return undefined
      // 本地路径在 enableLocalFile2Url=false 时不可用，base64 最稳。
      // sub_type + summary 让 QQ 按「表情」渲染，而不是普通图片。
      return {
        type: 'image',
        data: {
          file: `base64://${buffer.toString('base64')}`,
          sub_type: 1,
          summary: '[动画表情]',
        },
      }
    } catch {
      return undefined
    }
  }

  async function groupSystemPrompt(groupId) {
    const custom = String(groupCfg.systemPrompt || '').trim()
    if (custom) return custom
    const parts = [groupPersona()]
    const facts = (groupCfg.facts || []).map((v) => String(v || '').trim()).filter(Boolean)
    if (facts.length) parts.push(`\n已知：${facts.join('；')}。`)
    const memory = groupMemory.get(String(groupId))
    if (memory?.summary) parts.push(`\n之前聊到的：${memory.summary}`)
    if (groupCfg.stickersEnabled !== false) {
      const names = await stickerNames()
      const pick = names.length ? `可用的表情包名字：${names.join('、')}；` : ''
      parts.push(
        `\n表情用法：只在接梗、被逗、情绪明显时才加一个，别当句号用；连续两条回复不要都带；文字能说清就不加。` +
          `\n想加就在句末写 [表情:名字]，${pick}` +
          `也可以用 QQ 小黄脸：[表情:face:14]微笑、[表情:face:13]呲牙、[表情:face:12]调皮、[表情:face:20]偷笑、` +
          `[表情:face:5]流泪、[表情:face:9]大哭、[表情:face:22]白眼、[表情:face:28]憨笑、[表情:face:38]笑哭、[表情:face:18]抓狂。`,
      )
    }
    parts.push('\n只输出你要说的话：不加名字前缀，不解释，不写括号动作，不换行。')
    return parts.join('')
  }

  /** Fold the recent tail into one short line so context survives truncation. */
  async function summarizeGroup(groupId) {
    const list = groupHistory.get(String(groupId)) || []
    if (list.length < 4) return
    const previous = groupMemory.get(String(groupId))?.summary || ''
    const transcript = list
      .map((m) => `${m.role === 'assistant' ? '你' : '对方'}: ${m.content}`)
      .join('\n')
    const messages = [
      {
        role: 'system',
        content:
          '把下面这段群聊压缩成一句中文备忘，30 字以内。只写还在继续的话题、或者刚定下的事。不要评价，不要写谁在骂人、谁什么态度，不要引号，不要换行。',
      },
      {
        role: 'user',
        content: `${previous ? `旧的备忘：${previous}\n` : ''}${transcript}`,
      },
    ]
    try {
      const raw = await askGroupModel(messages, { maxTokens: 80, temperature: 0.3 })
      const summary = raw.replace(/\s+/g, ' ').replace(/^["「『]|["」』]$/g, '').trim().slice(0, 80)
      if (!summary) return
      groupMemory.set(String(groupId), { summary, updatedAt: Date.now() })
      saveGroupMemorySoon()
      log.info?.(`bridge: [群 ${groupId}] 备忘：${summary}`)
    } catch (error) {
      log.warn?.(
        `bridge: [群 ${groupId}] 压缩上下文失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  function pushGroupHistory(groupId, role, content) {
    if (!groupHistory.has(groupId)) groupHistory.set(groupId, [])
    const list = groupHistory.get(groupId)
    list.push({ role, content })
    const keep = Math.max(2, Number(groupCfg.history) || DEFAULTS.group.history) * 2
    while (list.length > keep) list.shift()
  }

  const groupLogFile = path.join(cfg.dataDir || DEFAULTS.dataDir, 'group.log')

  /** Group traffic gets its own plain-text trace: the host log is invisible. */
  async function groupTrace(line) {
    try {
      await appendFile(groupLogFile, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* trace must never break the bridge */
    }
  }

  /** Send one short line into a group (used for asides, not model replies). */
  async function groupSay(groupId, body) {
    try {
      await callApi('send_group_msg', {
        group_id: /^\d+$/.test(groupId) ? Number(groupId) : groupId,
        message: body,
      })
      return true
    } catch (error) {
      log.warn?.(
        `bridge: [群 ${groupId}] 发不出去：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  async function handleGroupEvent(event) {
    if (!groupCfg.enabled) {
      await groupTrace(`skip: disabled (group ${event.group_id})`)
      return
    }
    const groupId = String(event.group_id ?? '').trim()
    if (!groupId) return
    if (groupAllowed.size === 0 || !groupAllowed.has(groupId)) {
      await groupTrace(`skip: group ${groupId} not in allowGroups`)
      return
    }
    await loadGroupMemory()
    await loadGroupSettings()

    const segments = Array.isArray(event.message) ? event.message : []
    const sender = event.sender || {}
    const name = String(sender.card || sender.nickname || '群友').slice(0, 24)
    const selfId = String(event.self_id ?? '')
    // NapCat's at-segment shape varies between versions (qq / user_id, string
    // vs number). A miss here silently swallows the message, so accept any real
    // at-segment in a fan group, and also check the raw CQ form.
    const atTargets = segments
      .filter((seg) => seg && (seg.type === 'at' || seg.type === 'mention'))
      .map((seg) => String(seg.data?.qq ?? seg.data?.user_id ?? seg.data?.uid ?? '').trim())
    const rawText = String(event.raw_message || '')
    const mentioned =
      atTargets.some((qq) => qq === selfId || qq === 'all' || qq === 'everyone') ||
      (selfId ? rawText.includes(`[CQ:at,qq=${selfId}]`) : false)

    let text = messageText(event).replace(/^@[^\s]+\s*/u, '').trim()
    // A voice segment arrives as "[CQ:record,file=...]" — messageText falls back
    // to raw_message, which is truthy and used to swallow the voice path. Only
    // real text segments count as text here.
    const hasRecord = segments.some((seg) => seg && seg.type === 'record')
    const hasTypedText = segments.some(
      (seg) => seg && seg.type === 'text' && String(seg.data?.text || '').trim(),
    )
    if (hasRecord && !hasTypedText) text = ''
    // Voice in a group: transcribe locally and treat it like typed text. This
    // runs even without an @ so the words land in history for the next message.
    if (!text && hasRecord) {
      for (const seg of segments) {
        if (!seg || seg.type !== 'record') continue
        const heard = await transcribeVoice(seg)
        if (heard) {
          text = heard
          break
        }
      }
      if (text) {
        await groupTrace(`voice -> ${text.slice(0, 60)}`)
      } else if (mentioned) {
        await groupSay(groupId, '没听清，再说一遍？')
      }
    }
    // 聊天记录（合并转发）在群里也展开
    if (!text) {
      const fwd = segments.find((seg) => seg && (seg.type === 'forward' || seg.type === 'node'))
      if (fwd) {
        const inner = await expandForward(fwd)
        if (inner) {
          text = `【聊天记录】\n${inner}`
          await groupTrace(`forward -> ${inner.length} 字`)
        }
      }
    }
    await groupTrace(
      `recv group=${groupId} from=${name} self=${selfId} at=${mentioned} ats=${JSON.stringify(atTargets)} text=${text.slice(0, 40)}`,
    )
    // 纯图片/纯聊天记录没有文字，但后面还要交给模型，不能在这里丢掉。
    const hasImageSeg = segments.some((seg) => seg && seg.type === 'image')
    if (!text && !hasImageSeg) {
      await groupTrace('skip: empty text')
      return
    }

    const wakeWords = (groupCfg.wakeWords || []).map((w) => String(w || '').trim()).filter(Boolean)
    const woken = wakeWords.some((w) => text.startsWith(w))
    if (needsMention() && !mentioned && !woken) {
      // Keep the tail of the conversation for context, but do not answer.
      pushGroupHistory(groupId, 'user', `${name}: ${text}`)
      await groupTrace(
        `skip: not mentioned / no wake word | segments=${JSON.stringify(segments).slice(0, 240)}`,
      )
      return
    }
    if (woken) {
      const hit = wakeWords.find((w) => text.startsWith(w)) || ''
      text = text.slice(hit.length).trim()
      if (!text) return
    }

    const now = Date.now()
    const stamps = (groupStamps.get(groupId) || []).filter((t) => now - t < 60_000)
    if (stamps.length >= (Number(groupCfg.maxPerMinute) || DEFAULTS.group.maxPerMinute)) {
      log.info?.(`bridge: [群 ${groupId}] 一分钟内说太多，跳过`)
      await groupTrace('skip: rate limited')
      return
    }
    if (now - (groupLastReply.get(groupId) || 0) < (Number(groupCfg.cooldownMs) || DEFAULTS.group.cooldownMs)) {
      await groupTrace('skip: cooldown')
      return
    }
    stamps.push(now)
    groupStamps.set(groupId, stamps)

    // 群里发的表情（mface / 标成表情的图）也收进 inbox，攒着以后入库。
    let harvestedHere = 0
    for (const seg of segments) {
      const subType = Number(seg?.data?.sub_type ?? seg?.data?.subType)
      const isStickerPiece =
        seg?.type === 'mface' ||
        (seg?.type === 'image' &&
          (subType === 1 ||
            subType === 7 ||
            /动画表情|表情/.test(String(seg.data?.summary || ''))))
      if (!isStickerPiece || harvestedHere >= 5) continue
      const mark = await harvestSticker(seg)
      harvestedHere += 1
      await groupTrace(`sticker harvest: ${mark}`)
    }

    // 图片：只有云端模型认 image_url；本地小模型是纯文本，求它看图只会浪费一次调用。
    const groupImages = []
    if (segments.some((seg) => seg && seg.type === 'image')) {
      if (isCloudModel(effectiveGroupModel())) {
        for (const seg of segments) {
          if (!seg || seg.type !== 'image') continue
          try {
            const part = await imagePart(seg)
            if (part?.data) {
              groupImages.push({
                type: 'image_url',
                image_url: { url: `data:${part.mediaType};base64,${part.data}` },
              })
            }
          } catch (error) {
            await groupTrace(`image error: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } else {
        await groupSay(groupId, '本地模型看不了图，切云端再看，或者打字说。')
      }
    }

    const userContent = groupImages.length
      ? [{ type: 'text', text: `${name}: ${text || '（发了张图）'}` }, ...groupImages]
      : `${name}: ${text || '（发了张图）'}`

    const messages = [
      { role: 'system', content: await groupSystemPrompt(groupId) },
      ...(groupHistory.get(groupId) || []),
      { role: 'user', content: userContent },
    ]

    let reply
    await groupTrace(`ask model=${effectiveGroupModel()} msgs=${messages.length}`)
    try {
      reply = await askGroupModel(messages)
    } catch (error) {
      log.warn?.(
        `bridge: [群 ${groupId}] 本地模型没回：${error instanceof Error ? error.message : String(error)}`,
      )
      await groupTrace(`model error: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const limit = Number(groupCfg.maxChars) || DEFAULTS.group.maxChars
    // 模型可以在句末带一个 [表情:名字]，这里把它拆出来单独发；正文照旧。
    let sticker
    let bodyText = plainText(reply)
    const stickerHit = /[\[【](?:表情|sticker|face)[:：]\s*([^\]】]{1,40})[\]】]/i.exec(bodyText)
    if (stickerHit) {
      bodyText = bodyText.replace(stickerHit[0], '')
      sticker = await buildSticker(stickerHit[1])
      if (!sticker) await groupTrace(`sticker miss: ${stickerHit[1]}`)
    }
    // 表情该发就发，不设冷却；只有真的解析不出来才不发。
    // One line, always: a chat message with line breaks reads like a wall.
    const oneLine = bodyText.replace(/\s*\n+\s*/g, ' ')
    const clean = splitText(oneLine, limit)[0].trim()
    if (!clean && !sticker) {
      await groupTrace('skip: empty reply after cleanup')
      return
    }

    const targetGroup = /^\d+$/.test(groupId) ? Number(groupId) : groupId
    // 像真人一样分条：最多 3 条，第一条引用对方那条消息。
    const parts = splitText(oneLine, limit)
      .slice(0, 3)
      .map((s) => s.trim())
      .filter(Boolean)
    // 引用别每条都挂：对方本身在回复别人、或者这条信息容易对不上号时才引用，
    // 其余情况直接说话更像真人。
    const incomingIsReply = segments.some((seg) => seg && seg.type === 'reply')
    const speakers = new Set(
      (groupHistory.get(groupId) || []).slice(-4).map((m) => String(m.content || '').split(':')[0]),
    )
    const ambiguous = speakers.size > 1
    const quoteId =
      event.message_id && (incomingIsReply || (ambiguous && Math.random() < 0.35))
        ? String(event.message_id)
        : ''
    try {
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) await sleep(450)
        const segments = []
        if (i === 0 && quoteId) segments.push({ type: 'reply', data: { id: quoteId } })
        segments.push({ type: 'text', data: { text: parts[i] } })
        await callApi('send_group_msg', { group_id: targetGroup, message: segments })
      }
      if (!parts.length && quoteId) {
        // 只有表情也要挂上引用，否则看不出在回谁。
        await callApi('send_group_msg', {
          group_id: targetGroup,
          message: [{ type: 'reply', data: { id: quoteId } }, { type: 'text', data: { text: ' ' } }],
        })
      }
      if (sticker) {
        await callApi('send_group_msg', { group_id: targetGroup, message: [sticker] })
      }
      await groupTrace(`sent: ${parts.join(' / ').slice(0, 70)}${sticker ? ` [+表情 ${sticker.type}]` : ''}`)
    } catch (error) {
      log.warn?.(
        `bridge: [群 ${groupId}] 发不出去：${error instanceof Error ? error.message : String(error)}`,
      )
      await groupTrace(`send error: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    groupLastReply.set(groupId, Date.now())
    pushGroupHistory(groupId, 'user', `${name}: ${text}`)
    pushGroupHistory(groupId, 'assistant', clean)
    log.info?.(`bridge: [群 ${groupId}] ${name}: ${text.slice(0, 30)} -> ${clean.slice(0, 30)}`)

    // Every few exchanges, fold the tail into one short line. A 4B model's
    // patience for raw history is short; the summary is what survives.
    const exchanges = (groupExchange.get(groupId) || 0) + 1
    const every = Math.max(2, Number(groupCfg.summaryEvery) || DEFAULTS.group.summaryEvery)
    if (exchanges >= every) {
      groupExchange.set(groupId, 0)
      await summarizeGroup(groupId)
    } else {
      groupExchange.set(groupId, exchanges)
    }
  }

  return {
    handleGroupEvent,
    groupModelCommandReply,
    groupReplyCommandReply,
    importStickers,
  }
}
