// 会话活动快照：给 qq_activity 和聊天里的 /任务 用。
//
// 订阅所有会话的 session/event（不只绑定的那个），把「谁在跑、跑多久、
// 挂了几个后台任务、待办到哪一步」攒成一张手机能看的小票。攒的成本很低：
// 只在事件里写 Map，不做任何查询；真正拼字符串只在被问的时候做一次。
/**
 * @param {object} deps
 * @param {object} deps.ctx          插件上下文（只要 ctx.on / ctx.effect）
 * @param {(includeNoise?: boolean) => Promise<{rows: any[], hiddenNoise: number}>} deps.sessionRows
 */
export function createActivity({ ctx, sessionRows }) {
  // A live, self-capping view of what every session is doing right now. Fed by
  // session/event for ALL sessions (not just the bound one), so "/任务" can
  // answer without waiting behind whichever turn happens to be running.
  const report = new Map()

  function slot(sid) {
    let entry = report.get(sid)
    if (!entry) {
      entry = {
        sid,
        jobs: new Map(),
        todos: [],
        turn: null,
        turnStartedAt: 0,
        lastTool: '',
        lastToolAt: 0,
        lastDone: null,
        touchedAt: 0,
      }
      report.set(sid, entry)
    }
    return entry
  }

  function fmtDur(ms) {
    const total = Math.max(0, Math.round(ms / 1000))
    if (total < 60) return `${total}秒`
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return `${minutes}分${total % 60}秒`
    const hours = Math.floor(minutes / 60)
    return `${hours}小时${minutes % 60}分`
  }

  function fmtAgo(at) {
    if (!at) return ''
    return `${fmtDur(Date.now() - at)}前`
  }

  /** Tool name out of a tool/call payload, tolerant of shape drift. */
  function toolNameOf(data) {
    return String(data?.name || data?.toolName || data?.tool?.name || data?.call?.name || '')
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        const sid = session?.id ? String(session.id) : ''
        if (!sid || !event || typeof event.type !== 'string') return
        const now = Date.now()
        const entry = slot(sid)
        entry.touchedAt = now
        switch (event.type) {
          case 'job/registered': {
            const data = event.data || {}
            const jobId = String(data.jobId ?? '')
            if (!jobId || entry.jobs.size >= 32) break
            entry.jobs.set(jobId, {
              label: String(data.label || data.kind || '任务'),
              kind: String(data.kind || ''),
              startedAt: Number(data.startedAt) || now,
            })
            break
          }
          case 'job/settled': {
            const data = event.data || {}
            const job = entry.jobs.get(String(data.jobId ?? ''))
            if (job) {
              entry.jobs.delete(String(data.jobId ?? ''))
              entry.lastDone = { label: job.label, at: Number(data.finishedAt) || now }
            }
            break
          }
          case 'turn/start': {
            entry.turn = Number(event.data?.turn ?? 0) || null
            entry.turnStartedAt = now
            break
          }
          case 'turn/end': {
            entry.turn = null
            entry.turnStartedAt = 0
            break
          }
          case 'tool/call': {
            const name = toolNameOf(event.data)
            if (name) {
              entry.lastTool = name
              entry.lastToolAt = now
            }
            if (!entry.turnStartedAt) entry.turnStartedAt = now
            break
          }
          case 'todo/write': {
            const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
            entry.todos = todos.slice(0, 20).map((todo) => ({
              content: String(todo?.content ?? ''),
              status: String(todo?.status ?? 'pending'),
            }))
            break
          }
          default:
            break
        }
      }),
    'qq.activity-events',
  )

  /**
   * One phone-sized snapshot: which sessions are running, which background jobs
   * they hold, how far their todo list has got. `filter` keeps one session
   * (1-based index, title fragment, or the last 8 characters of its id).
   */
  async function activitySnapshot(filter = '') {
    const raw = String(filter || '').trim()
    const includeNoise = /^(all|全部|\*)$/i.test(raw) || /\sall$/i.test(raw)
    const { rows, hiddenNoise } = await sessionRows(includeNoise)
    const numbered = rows.map((row) => ({ row, state: report.get(row.sessionId) }))
    const isBusy = ({ row, state }) => Boolean(row.running) || (state ? state.jobs.size > 0 : false)
    const ordered = numbered
      .sort((a, b) => {
        if (a.row.bound !== b.row.bound) return a.row.bound ? -1 : 1
        if (isBusy(a) !== isBusy(b)) return isBusy(a) ? -1 : 1
        return String(b.row.updatedAt).localeCompare(String(a.row.updatedAt))
      })
      // Number after sorting so "／任务 2" always means the second line printed.
      .map((item, index) => ({ ...item, index: index + 1 }))
    const want = raw && !/^(all|全部|\*)$/i.test(raw) ? raw.toLowerCase().replace(/\s+all$/i, '') : ''
    const shown = want
      ? ordered.filter(({ row, index }) => {
          if (/^\d+$/.test(want)) return String(index) === want
          return (
            String(row.title).toLowerCase().includes(want) ||
            row.short === want ||
            String(row.sessionId).toLowerCase().endsWith(want)
          )
        })
      : ordered

    const lines = []
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
    lines.push(`【会话任务】${stamp}`)
    if (want && shown.length === 0) {
      lines.push(`没有对上下标的会话：${want}`)
      return lines.join('\n')
    }
    const limit = Math.min(shown.length, includeNoise ? 30 : 10)
    for (let i = 0; i < limit; i += 1) {
      const { row, index, state } = shown[i]
      const busy = isBusy({ row, state })
      const name = row.title || row.short
      const suffix = row.bound ? ' ★接通中' : ''
      const elapsed = state?.turnStartedAt ? Date.now() - state.turnStartedAt : 0
      const running = busy ? `跑着${elapsed > 10_000 ? ` ${fmtDur(elapsed)}` : ''}` : '空闲'
      lines.push(`${index}. ${name}${suffix} — ${running}`)
      const values = row.values || {}
      const goal = values.goal?.goal
      const teamTasks = Array.isArray(values.agentTeam?.tasks)
        ? values.agentTeam.tasks.filter((task) => task && task.status !== 'completed')
        : []
      let details = 0
      if (state) {
        const jobs = [...state.jobs.values()].slice(0, 3)
        for (const job of jobs) {
          const body = job.kind && job.kind !== job.label ? `${job.kind}「${job.label}」` : `「${job.label}」`
          lines.push(`   ▸ 后台 ${body} 已跑 ${fmtDur(Date.now() - job.startedAt)}`)
          details += 1
        }
        if (state.todos.length > 0 && details < 4) {
          const done = state.todos.filter((todo) => todo.status === 'completed').length
          const current = state.todos.find((todo) => todo.status === 'in_progress')
          lines.push(
            `   ▸ 待办 ${done}/${state.todos.length}${current ? ` · 进行中：${current.content}` : ''}`,
          )
          details += 1
        }
      }
      if (goal && details < 4) {
        const phase = { active: '进行中', paused: '暂停', blocked: '卡住', complete: '已完成' }[goal.phase] || goal.phase
        const rounds = goal.roundsStarted ? `，第 ${goal.roundsStarted} 轮` : ''
        lines.push(`   ▸ 目标：${goal.objective}（${phase}${rounds}）`)
        details += 1
      }
      if (teamTasks.length > 0 && details < 4) {
        const first = teamTasks[0]
        const subject = String(first.subject || first.description || '').slice(0, 40)
        lines.push(`   ▸ 小队 ${teamTasks.length} 项未完：${subject}`)
        details += 1
      }
      if (values.plan?.active && details < 4) {
        lines.push('   ▸ 计划模式开着')
        details += 1
      }
      if (state && details < 4) {
        if (busy && state.lastTool && Date.now() - state.lastToolAt < 10 * 60 * 1000) {
          lines.push(`   ▸ 最近动作：${state.lastTool}`)
        } else if (!busy && state.lastDone && Date.now() - state.lastDone.at < 30 * 60 * 1000) {
          lines.push(`   ▸ 刚跑完「${state.lastDone.label}」${fmtAgo(state.lastDone.at)}`)
        }
      }
      if (busy && !row.running) lines.push('   ▸ 没有活动中的回合，只剩后台任务')
    }
    if (shown.length > limit) lines.push(`… 还有 ${shown.length - limit} 个没列出（/任务 all 全列）`)
    const busyCount = ordered.filter(isBusy).length
    const noise = hiddenNoise > 0 && !includeNoise ? `，另有 ${hiddenNoise} 个内部会话没列（/任务 all）` : ''
    lines.push('')
    lines.push(`共 ${ordered.length} 个会话，${busyCount} 个在跑${noise}`)
    if (!want) lines.push('看单个：/任务 2（或 /任务 标题片段）')
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  return { activitySnapshot }
}
