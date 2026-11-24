// 模型切换与上下文窗口看护。
//
// DSH 有运行期接口（modelCatalog / selectModel），所以换模型不用重启 DSH。
// 这里顺带干一件事：本地模型的窗口小，每次回合结束后比对一下这次实际发了多少
// token，快到窗口上限就提前在 QQ 上警告，而不是等下一次请求报 "exceeds context size"。
/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.log
 * @param {object} deps.groupCfg      （用 baseUrl 去问 LM Studio 的已加载窗口）
 * @param {object} deps.DEFAULTS
 * @param {Function} deps.getJson
 * @param {Function} deps.sendText
 * @param {() => string} deps.getOwnerUin
 * @param {() => Promise<string>} deps.ensureSession
 */
export function createModelPicker({ ctx, log, groupCfg, DEFAULTS, getJson, sendText, getOwnerUin, ensureSession }) {
  /**
   * Session-local model switching over QQ. DSH exposes a runtime API
   * (modelCatalog + selectModel), so switching never needs a restart — only
   * this plugin code does, once.
   */
  async function loadModelCatalog() {
    if (typeof ctx.sessionController?.modelCatalog !== 'function') {
      throw new Error('这个 DSH 版本没有模型目录接口')
    }
    const catalog = await ctx.sessionController.modelCatalog()
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
    const flat = []
    for (const group of groups) {
      const provider = String(group?.id ?? group?.provider ?? '')
      const models = Array.isArray(group?.models) ? group.models : []
      for (const entry of models) {
        const model = String(entry?.id ?? entry?.model ?? '')
        if (!provider || !model) continue
        flat.push({
          provider,
          model,
          label: `${provider} / ${String(entry?.label ?? entry?.name ?? model)}`,
        })
      }
    }
    return { catalog, flat }
  }

  async function currentModelSelection(sid) {
    try {
      if (typeof ctx.sessionController?.projections !== 'function') return undefined
      const res = await ctx.sessionController.projections({ sessionId: sid })
      const values = res?.kind === 'sequenced' ? res.values : undefined
      const selection = values?.modelSelection?.next || values?.modelSelection?.lastUsed
      if (selection?.provider && selection?.model) return selection
    } catch {
      /* best effort */
    }
    return undefined
  }

  const contextWatch = new Map()
  let localModelsCache = { at: 0, contexts: {} }

  /** LM Studio reports the window it actually loaded; cache for a minute. */
  async function loadedContextFor(modelId) {
    if (Date.now() - localModelsCache.at > 60_000) {
      try {
        const origin = new URL(groupCfg.baseUrl || DEFAULTS.group.baseUrl).origin
        const res = await getJson(`${origin}/api/v0/models`, 5000)
        const contexts = {}
        for (const entry of res?.body?.data || []) {
          if (entry?.id) contexts[String(entry.id)] = Number(entry.loaded_context_length) || 0
        }
        localModelsCache = { at: Date.now(), contexts }
      } catch {
        localModelsCache = { at: Date.now(), contexts: localModelsCache.contexts || {} }
      }
    }
    return localModelsCache.contexts[String(modelId)] || 0
  }

  /** Cumulative prompt tokens the session has sent, across the known fields. */
  function tokenTotals(values) {
    const totals = values?.tokenUsage?.totals
    if (!totals) return 0
    const pick = (key) => Number(totals[key]) || 0
    return (
      pick('uncachedInputTokens') +
      pick('cacheReadTokens') +
      pick('cacheWriteTokens') +
      pick('cachedInputTokens')
    )
  }

  /**
   * Local models have a hard window. After every turn, compare the prompt the
   * session actually sent against the loaded context and warn the owner before
   * the next request dies with "exceeds context size".
   */
  async function watchLocalContext(sid) {
    if (!getOwnerUin() || !sid) return
    let values
    try {
      const res = await ctx.sessionController.projections({ sessionId: sid })
      values = res?.kind === 'sequenced' ? res.values : undefined
    } catch {
      return
    }
    const selection = values?.modelSelection?.next || values?.modelSelection?.lastUsed
    if (!selection?.model || /deepseek/i.test(String(selection.provider || ''))) return
    const total = tokenTotals(values)
    const previous = contextWatch.get(sid)
    const delta = total - (previous?.total || 0)
    contextWatch.set(sid, { total, warnedAt: previous?.warnedAt || 0 })
    if (delta <= 0) return
    const window = await loadedContextFor(selection.model)
    if (!window) return
    const ratio = delta / window
    if (ratio < 0.75) return
    const now = Date.now()
    if (now - (previous?.warnedAt || 0) < 600_000) return
    contextWatch.set(sid, { total, warnedAt: now })
    const used = Math.round(ratio * 100)
    const message =
      ratio >= 1
        ? `上下文超了（上次请求 ${delta} / 窗口 ${window}）。发「挂了」开个新总机，再 /模型 切回本地模型。`
        : `上下文用到 ${used}%（${delta} / ${window}），再说几句就满了。快满时发「挂了」开个新总机。`
    sendText(getOwnerUin(), message).catch(() => {})
    log.info?.(`bridge: context watch ${used}% (${delta}/${window}) on ${String(sid).slice(-8)}`)
  }

  /** Tolerate both request shapes across DSH versions: nested vs flattened. */
  async function applyModelSelection(sid, selection) {
    const attempts = [
      () => ctx.sessionController.selectModel({ sessionId: sid, selection }),
      () => ctx.sessionController.selectModel({ sessionId: sid, ...selection }),
    ]
    let lastError
    for (const attempt of attempts) {
      try {
        return await attempt()
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async function modelCommandReply(argument) {
    const { catalog, flat } = await loadModelCatalog()
    if (flat.length === 0) return '模型目录是空的，provider 可能都没起来。'
    const sid = await ensureSession()
    const current = await currentModelSelection(sid)
    const currentKey = current ? `${current.provider}/${current.model}` : ''
    const arg = String(argument || '').trim()

    if (!arg) {
      const lines = flat.map((item, index) => {
        const mark = currentKey === `${item.provider}/${item.model}` ? '  ← 当前' : ''
        return `${index + 1}. ${item.label}${mark}`
      })
      return `${lines.join('\n')}\n\n现在：${currentKey || '未知'}\n发「/模型 2」切换，「/模型 恢复」回默认。`
    }

    if (/^(恢复|默认|reset|default)$/i.test(arg)) {
      const fallback = catalog?.default ?? catalog?.defaultSelection ?? catalog?.deploymentDefault
      if (!fallback?.provider || !fallback?.model) return '没拿到默认模型，在 GUI 的设置里选一次吧。'
      await applyModelSelection(sid, { provider: fallback.provider, model: fallback.model })
      return `已切回默认：${fallback.provider} / ${fallback.model}`
    }

    let target
    const index = Number(arg)
    if (Number.isInteger(index) && index >= 1 && index <= flat.length) target = flat[index - 1]
    if (!target) {
      const needle = arg.toLowerCase()
      target = flat.find(
        (item) =>
          item.model.toLowerCase().includes(needle) || item.label.toLowerCase().includes(needle),
      )
    }
    if (!target) return `没找到「${arg}」。发「/模型」看列表。`

    await applyModelSelection(sid, { provider: target.provider, model: target.model })
    // Local models cannot hold a long agent session: say so before the owner
    // hits "exceeds context size" on the next message.
    const isLocal = !/deepseek/i.test(target.provider) && !/deepseek/i.test(target.model)
    if (isLocal) {
      return `已切到 ${target.label}。\n注意：本地模型窗口小，这个会话历史一长就会报超出上下文。先发「挂了」开一个新总机，再切本地模型，能聊得久一些。`
    }
    return `已切到 ${target.label}。`
  }
  return { modelCommandReply, watchLocalContext, currentModelSelection, applyModelSelection, loadModelCatalog }
}
