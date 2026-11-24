// /qq 命令：在会话里直接控制绑定（bind / off / status / jobs）。
/**
 * @param {object} deps
 * @param {object} deps.ctx
 * @param {object} deps.cfg
 * @param {Set<string>} deps.allowed
 * @param {() => string} deps.getSessionId
 * @param {() => string} deps.getOwnerUin
 * @param {Function} deps.setBinding
 * @param {Function} deps.activitySnapshot
 */
export function createCommand({ ctx, cfg, allowed, getSessionId, getOwnerUin, setBinding, activitySnapshot }) {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'qq',
        description:
          'Connect this session to the messaging bridge. `/qq bind` makes QQ private messages drive THIS session; `/qq status` shows the bridge; `/qq off` unbinds.',
        handler: async (invocation) => {
          const arg = String(invocation.rawInput || '').trim().toLowerCase()
          if (arg === 'bind' || arg === 'on') {
            await setBinding(String(invocation.agent.id), 'command:/qq bind', invocation.agent.id)
            return {
              kind: 'success',
              text:
                `这个会话已经接到企鹅桥上了。\n` +
                `之后从手机私聊发来的消息会进这里，回答也会发回聊天。\n` +
                `（session: ${getSessionId()}）`,
            }
          }
          if (arg === 'off' || arg === 'unbind') {
            await setBinding('', 'command:/qq off', invocation.agent.id)
            return { kind: 'success', text: '已解除桥绑定。' }
          }
          if (arg === 'jobs' || arg.startsWith('jobs ') || arg === 'activity' || arg.startsWith('activity ') || arg === '任务') {
            const wanted = arg.replace(/^(jobs|activity|任务)\s*/i, '').trim()
            return { kind: 'success', text: await activitySnapshot(wanted) }
          }
          return {
            kind: 'success',
            text: [
              `绑定会话：${getSessionId() ? getSessionId() : '否（用 /qq bind 绑）'}`,
              `最近发消息的号：${getOwnerUin() || '（还没有）'}`,
              `白名单：${[...allowed].join(', ') || '（空，谁都不能用）'}`,
              `NapCat 地址：${cfg.napcatUrl}`,
            ].join('\n'),
          }
        },
      }),
    'qq.command',
  )
}
