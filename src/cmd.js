const ALLOWED = new Set(['rename'])

function parseCommand(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, error: '空命令。用法：/rename 短名' }
  const body = text.startsWith('/') ? text.slice(1) : text
  const i = body.search(/\s/)
  const name = (i < 0 ? body : body.slice(0, i)).toLowerCase()
  const arg = (i < 0 ? '' : body.slice(i + 1)).trim()
  if (!name) return { ok: false, error: '空命令。用法：/rename 短名' }
  if (!ALLOWED.has(name)) {
    return {
      ok: false,
      error: `不允许 /${name}。可用：/rename`,
    }
  }
  return { ok: true, name, arg }
}

async function runCommand(parsed, { route, bridge }) {
  if (!route?.appId || !route?.chatId) {
    return { ok: false, text: '当前没有对应的飞书会话' }
  }
  if (parsed.name === 'rename') {
    if (!parsed.arg) return { ok: false, text: '用法：/rename 短名' }
    const text = await bridge.rename(route.appId, route.chatId, parsed.arg)
    const ok = typeof text === 'string' && text.startsWith('已命名为')
    return { ok, text }
  }
  return { ok: false, text: `未实现 /${parsed.name}` }
}

export function attachCmd(ctx, { routeOf, bridge }) {
  const tools = ctx.get('tools')
  if (!tools?.register) {
    process.stderr.write('[dsh-feishu] tools missing; SlashCommand not registered\n')
    return
  }
  if (!bridge?.rename || typeof routeOf !== 'function') {
    process.stderr.write('[dsh-feishu] SlashCommand: bridge/routeOf missing\n')
    return
  }

  tools.register({
    name: 'SlashCommand',
    description:
      'Execute the /rename slash command to rename the current session. SlashCommand({ command: "/rename 短名" }). Only /rename is allowed.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Slash command with args, e.g. "/rename 8K门keep3"',
        },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.result ?? '') }]
      },
    },
    async execute(args, exec) {
      const parsed = parseCommand(args?.command)
      if (!parsed.ok) throw new Error(parsed.error)
      const route = routeOf(String(exec.agent?.id || ''))
      const out = await runCommand(parsed, { route, bridge })
      if (!out.ok) throw new Error(out.text)
      return { result: out.text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'SlashCommand',
      kind: 'other',
      rawInput: args?.command,
    }),
  })

  process.stderr.write('[dsh-feishu] SlashCommand registered (/rename)\n')
}

export { ALLOWED, parseCommand, runCommand }
