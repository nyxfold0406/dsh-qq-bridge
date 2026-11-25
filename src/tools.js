// 九个 qq_* 工具：注册 + 描述 + 输出渲染。
//
// 这里是 agent 能看到的那一面。每个工具都是 `reg({...})` 包在
// `ctx.effect()` 里，卸载时自动摘掉。工具本身不含业务逻辑：它读状态、调
// src/bridge.js 里的函数，再把结果渲染成一段手机能读的字。
//
// 共享状态不在这里：当前绑定、主人号、最近发送都由桥持有，通过
// getSessionId / getOwnerUin / setLilySessionId 这几个函数进出。

/**
 * @param {object} deps 见文件末尾的调用处（src/bridge.js）
 */

/** 极简 JSON Schema 校验：只查 type / required / 数组元素。 */
function checkValue(spec, value, path) {
  if (!spec || typeof spec !== 'object') return
  const t = spec.type
  const fail = (what) => {
    throw new Error(`参数 ${path} 应为 ${what}`)
  }
  if (value === undefined || value === null) return
  if (t === 'string' && typeof value !== 'string') fail('字符串')
  else if (t === 'boolean' && typeof value !== 'boolean') fail('布尔值')
  else if (t === 'integer' && !Number.isInteger(value)) fail('整数')
  else if (t === 'number' && typeof value !== 'number') fail('数字')
  else if (t === 'array') {
    if (!Array.isArray(value)) fail('数组')
    else if (spec.items) value.forEach((v, i) => checkValue(spec.items, v, `${path}[${i}]`))
  } else if (t === 'object' && spec.properties) {
    // 只在这里判类型；对象内部的 required/properties 由下面那段统一处理，
    // 不要在这里递归回自己（会无限递归爆栈）。
    if (typeof value !== 'object' || Array.isArray(value)) fail('对象')
  }
  if (t === 'object' && spec.properties) {
    for (const key of spec.required || []) {
      if (value[key] === undefined) throw new Error(`缺少参数 ${path}.${key}`)
    }
    for (const [key, sub] of Object.entries(spec.properties)) {
      if (value[key] !== undefined) checkValue(sub, value[key], `${path}.${key}`)
    }
  }
}

/**
 * 包一层参数校验再交给宿主。宿主 ctx.tools.register 不做 schema 校验，
 * 模型传错类型会直接在 execute 里炸；这里提前挡成一条可读的报错。
 */
function withValidation(def) {
  const schema = def.parameters
  if (!schema || schema.type !== 'object' || !schema.properties) return def
  return {
    ...def,
    async execute(args, exec) {
      try {
        checkValue({ type: 'object', properties: schema.properties, required: schema.required }, args || {}, 'args')
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { ok: false, error: msg, text: `参数不合法：${msg}` }
      }
      return def.execute(args, exec)
    },
  }
}

export function createTools(deps) {
  const {
    ctx,
    cfg,
    allowed,
    sendText,
    sendFile,
    callApi,
    activitySnapshot,
    sessionRows,
    getOwnerUin,
    getSessionId,
    setLilySessionId,
    isListening,
    mayEmit,
    EMIT_DENIED,
    mayRebind,
    REBIND_DENIED,
    listWorkspaces,
    ensureWorkspaceId,
    setBinding,
    sessionExists,
    hangupToSwitchboard,
    nextLilyGeneration,
    lilyTitle,
    saveState,
    recordError,
    DEFAULTS,
    markSelfSent,
    isQqTurn,
    statusPayload,
    statusText,
  } = deps

  /** 注册包装：先校验参数，再交给宿主。 */
  const reg = (def) => ctx.tools.register(withValidation(def))

  const text = (value) => [{ type: 'text', text: value }]

  // qq_send_message was removed 2026-11-25 (user decision): in a QQ-bound
  // session the assistant text is mirrored back by src/replies.js anyway, so
  // the only thing this tool could do was send the same words twice. Text goes
  // through the reply; files go through qq_send_file.

  ctx.effect(
    () =>
      reg({
        name: 'qq_activity',
        description:
          'Live snapshot of what every DSH session is doing right now: running turns, background jobs with their ' +
          'elapsed time, todo progress. This is exactly what the owner gets by sending /任务 on QQ. ' +
          '看每个会话现在在干什么（跑着的回合、后台任务、待办进度），和 QQ 上发 /任务 得到的是同一份。',
        parameters: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: '可选：序号（如 2）、标题片段、或 session 尾号，只看一个会话。',
            },
          },
          required: [],
        },
        output: {
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          render(_args, value) {
            return text(value?.text || '（没有可显示的会话）')
          },
        },
        timeoutMs: 20_000,
        isConcurrencySafe: () => true,
        async execute(args) {
          const snapshot = await activitySnapshot(String(args?.filter || ''))
          return { text: snapshot }
        },
      }),
    'qq.tool.activity',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_send_file',
        description:
          'Send one file from this computer to the owner\'s QQ private chat. ' +
          '把电脑里的文件发到主人 QQ 上：给绝对路径或工作区里能解析的路径。' +
          'The file leaves this machine, so only send what the owner asked for.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '文件路径（绝对路径，或相对当前工作目录）。' },
            name: { type: 'string', description: '在 QQ 里显示的文件名；不填用原文件名。' },
          },
          required: ['file'],
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, file: { type: 'string' }, to: { type: 'string' }, error: { type: 'string' } },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text(`没发出去：${value?.error || '未知错误'}`)
            return text(`已把 ${value.file} 发到 QQ ${value.to}。`)
          },
        },
        timeoutMs: 120_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!(await mayEmit(exec))) return { ok: false, error: EMIT_DENIED }
          const target = String(getOwnerUin() || '').trim()
          if (!target) return { ok: false, error: '还没有 QQ 号，先让对方发一条消息' }
          try {
            const sent = await sendFile(target, args.file, args.name)
            // A file does not stand in for the text: the turn-end mirror must
            // still deliver whatever the model wrote (19:56 case: 「我批改过了，
            // 发你 QQ 了」+ the file). So this one deliberately does NOT mark.
            return { ok: true, file: sent, to: target }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'qq.tool.send_file',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_status',
        description: 'Report the QQ bridge state: whether NapCat answers, which session is bound, and who may talk. 查 QQ 桥当前状态。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              napcat: { type: 'string' },
              sessionId: { type: 'string' },
              ownerUin: { type: 'string' },
              allowed: { type: 'array', items: { type: 'string' } },
              listening: { type: 'boolean' },
            },
            required: ['ok'],
          },
          render(_args, value) {
            return text(statusText(value))
          },
        },
        timeoutMs: 15_000,
        isConcurrencySafe: () => true,
        async execute() {
          return statusPayload()
        },
      }),
    'qq.tool.status',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_list_sessions',
        description:
          'List recent DeepSeek Harness sessions with a short id, so the user can pick which session QQ should drive. ' +
          '列出最近的会话，问用户要把哪个接到 QQ 上。',
        parameters: {
          type: 'object',
          properties: {
            all: { type: 'boolean', description: 'true 时连内部会话（mnemon 委派评审之类）一起列；默认折叠。' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string' },
                    short: { type: 'string' },
                    title: { type: 'string' },
                    cwd: { type: 'string' },
                    running: { type: 'boolean' },
                    updatedAt: { type: 'string' },
                    bound: { type: 'boolean' },
                  },
                },
              },
            },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text('列不出来。')
            const rows = (value.sessions || []).map(
              (s, i) =>
                `${i + 1}. ${s.title || s.short}${s.bound ? '  ← 当前绑定' : ''}` +
                `\n   ${s.cwd || ''}${s.running ? '  [运行中]' : ''}  · ${s.short}`,
            )
            const hidden = Number(value.hiddenNoise || 0)
            const foot = hidden > 0 ? `\n\n（另有 ${hidden} 条内部会话已折叠：mnemon 委派评审之类）` : ''
            return text(rows.length ? rows.join('\n') + foot : '没有可用的会话。')
          },
        },
        timeoutMs: 20_000,
        isConcurrencySafe: () => true,
        async execute(args) {
          const { rows, hiddenNoise } = await sessionRows(Boolean(args?.all))
          return { ok: true, sessions: rows, hiddenNoise }
        },
      }),
    'qq.tool.list_sessions',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_workspaces',
        description:
          'List the agent workspaces on this machine with a number each. The user picks a number to open a NEW conversation there. ' +
          '列出工作区和编号（选编号 = 在该工作区开一个全新对话）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              workspaces: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { index: { type: 'integer' }, name: { type: 'string' }, path: { type: 'string' } },
                },
              },
            },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text('列不出来。')
            const rows = (value.workspaces || []).map((w) => `${w.index}. ${w.name}`)
            return text(rows.length ? rows.join('  ') : '没有工作区。')
          },
        },
        timeoutMs: 15_000,
        isConcurrencySafe: () => true,
        async execute() {
          const names = await listWorkspaces()
          const root = cfg.workspacesRoot || DEFAULTS.workspacesRoot
          return {
            ok: true,
            workspaces: names.map((name, i) => ({ index: i + 1, name, path: `${root}\\${name}` })),
          }
        },
      }),
    'qq.tool.workspaces',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_call_workspace',
        description:
          'Open a NEW conversation in the chosen workspace and route QQ messages into it. Accepts the workspace number from qq_workspaces or its name. ' +
          '在指定工作区新建一个对话并接通；用户说"新开一个"或给工作区编号时调用。',
        parameters: {
          type: 'object',
          properties: {
            workspace: { type: 'string', description: '工作区编号（如 "1"）或名字（如 Work）。' },
          },
          required: ['workspace'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              sessionId: { type: 'string' },
              workspace: { type: 'string' },
              cwd: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text(`没开成：${value?.error || '未知错误'}`)
            return text(
              `在 ${value.workspace} 开了个新对话（${value.cwd}）。\n现在 QQ 的消息进这里，你说的话那边能接上。`,
            )
          },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!mayRebind(exec)) return { ok: false, error: REBIND_DENIED }
          const want = String(args.workspace || '').trim()
          if (!want) return { ok: false, error: '需要工作区编号或名字' }
          const names = await listWorkspaces()
          const root = cfg.workspacesRoot || DEFAULTS.workspacesRoot
          let name
          if (/^\d+$/.test(want)) name = names[Number(want) - 1]
          else name = names.find((n) => n.toLowerCase() === want.toLowerCase())
          if (!name) return { ok: false, error: `没有这个工作区：${want}` }
          const cwd = `${root}\\${name}`
          try {
            const workspaceId = await ensureWorkspaceId(cwd)
            const created = await ctx.sessionController.create(
              workspaceId ? { workspaceId } : { cwd },
            )
            const fresh = String(created.sessionId)
            try {
              await ctx.sessionController.rename({ sessionId: fresh, title: `${name} · QQ` })
            } catch {
              /* cosmetic */
            }
            await setBinding(fresh, `tool:qq_call_workspace(${name})`, exec?.agent?.id)
            return { ok: true, sessionId: fresh, workspace: name, cwd }
          } catch (error) {
            await recordError('workspace.create', error)
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'qq.tool.call_workspace',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_bind_session',
        description:
          'Bind one DSH session to the QQ bridge so QQ private messages drive it. ' +
          'Accepts a full sessionId or any unique tail of one. 把某个会话接到 QQ 上。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: '完整 sessionId，或它的一段唯一后缀（如列表里的 8 位尾部）；传 "new" 新建一个专用会话再绑定。',
            },
            cwd: { type: 'string', description: 'sessionId="new" 时的会话工作目录，例如 D:\\work\\demo。' },
          },
          required: ['sessionId'],
        },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, sessionId: { type: 'string' }, error: { type: 'string' } },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text(`没绑上：${value?.error || '未知错误'}`)
            return text(`已把这个会话接到 QQ：${value.sessionId}\n现在 QQ 私聊的消息会进这里。`)
          },
        },
        timeoutMs: 25_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!mayRebind(exec)) return { ok: false, error: REBIND_DENIED }
          const want = String(args.sessionId || '').trim()
          if (!want) return { ok: false, error: '需要 sessionId' }

          // "new" creates a dedicated session in the requested directory.
          if (want === 'new' || want === 'create') {
            try {
              const targetCwd = args.cwd ? String(args.cwd) : undefined
              const workspaceId = targetCwd ? await ensureWorkspaceId(targetCwd) : undefined
              const created = await ctx.sessionController.create(
                workspaceId ? { workspaceId } : { cwd: targetCwd },
              )
              const fresh = String(created.sessionId)
              const gen = await nextLilyGeneration()
              try {
                await ctx.sessionController.rename({ sessionId: fresh, title: lilyTitle(gen) })
              } catch {
                /* cosmetic */
              }
              await saveState({ lilyGeneration: gen })
              setLilySessionId(fresh)
              await setBinding(fresh, `tool:qq_bind_session(${lilyTitle(gen)})`, exec?.agent?.id)
              await saveState({ lilySessionId })
              return { ok: true, sessionId: fresh }
            } catch (error) {
              await recordError('session.create', error)
              return { ok: false, error: error instanceof Error ? error.message : String(error) }
            }
          }

          // A bare number means "the Nth row of the list Lily just read out".
          const { rows } = await sessionRows(false)
          let target
          if (/^\d+$/.test(want)) {
            target = rows[Number(want) - 1]?.sessionId
            if (!target) return { ok: false, error: `列表里没有第 ${want} 条，先列一遍再报号` }
          } else {
            target =
              rows.find((r) => r.sessionId === want)?.sessionId ||
              rows.find((r) => r.short === want)?.sessionId ||
              rows.find((r) => r.sessionId.endsWith(want))?.sessionId ||
              rows.find((r) => r.sessionId.includes(want))?.sessionId
          }
          if (!target) return { ok: false, error: `没找到会话：${want}` }
          try {
            if (!(await sessionExists(target))) return { ok: false, error: '会话读不到（可能已归档或不存在）' }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          await setBinding(target, `tool:qq_bind_session(${want})`, exec?.agent?.id)
          return { ok: true, sessionId: target }
        },
      }),
    'qq.tool.bind_session',
  )

  ctx.effect(
    () =>
      reg({
        name: 'qq_hangup',
        description:
          'Hang up the forwarded call: drop the current binding and route QQ messages back to Lily, the switchboard. ' +
          'Use this when the user says 挂断 / 挂了 / hang up. 用户说挂断时调用，回到 Lily 总机。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, sessionId: { type: 'string' }, error: { type: 'string' } },
            required: ['ok'],
          },
          render(_args, value) {
            if (!value?.ok) return text(`没挂断：${value?.error || '未知错误'}`)
            return text(`已挂断，QQ 消息回到 Lily 总机（${value.sessionId}）。`)
          },
        },
        timeoutMs: 15_000,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
          if (!mayRebind(exec)) return { ok: false, error: REBIND_DENIED }
          try {
            const fresh = await hangupToSwitchboard(`tool:qq_hangup(${String(exec?.agent?.id || '').slice(-8)})`)
            return { ok: true, sessionId: fresh }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    'qq.tool.hangup',
  )
}
