// MCP 分组默认 omnicore / browser；想接别的 MCP 就设
// DSH_FEISHU_MCP_PACKS='omnicore:^mcp__OmniCore__;browser:^mcp__browser-mcp__'。
const PACKS = parsePacks(process.env.DSH_FEISHU_MCP_PACKS || 'omnicore:^mcp__OmniCore__;browser:^mcp__browser-mcp__')
const PACK_IDS = PACKS.map((p) => p.id)

const ALWAYS = new Set(
  String(process.env.DSH_FEISHU_ALWAYS_TOOLS || [
    'mcp__browser-mcp__web_search',
    'mcp__browser-mcp__fetch_page',
  ].join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
)

const GLOB_SKIP = /(?:^|\/)(?:node_modules|\.git|\.pnpm)(?:\/|$)/

const packs = new WeakMap()

function parsePacks(raw) {
  const out = []
  for (const item of String(raw || '').split(';')) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const i = trimmed.indexOf(':')
    if (i < 1) continue
    const id = trimmed.slice(0, i).trim()
    const pattern = trimmed.slice(i + 1).trim()
    if (!id || !pattern) continue
    try {
      out.push({ id, re: new RegExp(pattern) })
    } catch (err) {
      process.stderr.write(`[dsh-feishu] bad MCP pack ${id}: ${err}\n`)
    }
  }
  return out
}

function packOf(agent) {
  if (!agent) return Object.fromEntries(PACK_IDS.map((id) => [id, false]))
  let pack = packs.get(agent)
  if (!pack) {
    pack = Object.fromEntries(PACK_IDS.map((id) => [id, false]))
    packs.set(agent, pack)
  }
  return pack
}

function packOfName(name) {
  return PACKS.find((item) => item.re.test(name)) || null
}

function textOf(result) {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function filterGlobText(text) {
  const lines = String(text).split('\n')
  const kept = []
  let skipped = 0
  let footer = ''
  for (const line of lines) {
    if (line.startsWith('(Showing ') || line.startsWith('(Omitted ')) {
      footer = line
      continue
    }
    if (GLOB_SKIP.test(line)) {
      skipped += 1
      continue
    }
    kept.push(line)
  }
  if (skipped === 0) return null
  const out = [...kept, `（已滤掉 ${skipped} 条 node_modules/.git/.pnpm）`]
  if (footer) out.push(footer)
  return out.join('\n')
}

function visible(name, pack) {
  if (DROP.has(name)) return false
  if (ALWAYS.has(name)) return true
  const spec = packOfName(name)
  if (!spec) return true
  return Boolean(pack[spec.id])
}

function enableTool() {
  return {
    name: 'enable_mcp',
    description:
      '为本会话打开一组 MCP 工具，打开后本会话不再收回。omnicore=图/语音/视频；browser=点选/截图/多步浏览。搜索和读网页不用开，直接用 mcp__browser-mcp__web_search / fetch_page。',
    parameters: {
      type: 'object',
      properties: {
        pack: {
          type: 'string',
          enum: PACK_IDS.length ? PACK_IDS : ['none'],
          description: '要打开哪一组 MCP',
        },
      },
      required: ['pack'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { result: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.result ?? '') }]
      },
    },
    async execute(args, exec) {
      const which = String(args?.pack || '')
      if (!PACK_IDS.includes(which)) {
        throw new Error(`pack 只能是：${PACK_IDS.join(' / ') || '(未配置)'}`)
      }
      const pack = enableMcp(exec.agent, which)
      return {
        result: `已打开 ${which}。本会话后续轮次能直接调这些工具，不用再 enable。当前：${PACK_IDS.map((id) => `${id}=${pack[id]}`).join(' ')}`,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '打开 MCP',
      kind: 'other',
      rawInput: args?.pack,
    }),
  }
}

export function peekMcp(agent) {
  return packOf(agent)
}

export function enableMcp(agent, which) {
  const pack = packOf(agent)
  if (which in pack) pack[which] = true
  return pack
}

export function attachToolTrim(ctx) {
  const tools = ctx.get('tools')
  if (tools?.register && PACK_IDS.length) {
    try {
      tools.register(enableTool())
      process.stderr.write('[dsh-feishu] enable_mcp registered\n')
    } catch (err) {
      process.stderr.write(`[dsh-feishu] enable_mcp: ${err}\n`)
    }
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const nextAssembly = await next()
    const list = Array.isArray(nextAssembly?.tools) ? nextAssembly.tools : []
    const pack = packOf(context?.agent)
    const kept = list.filter((tool) => visible(tool?.name, pack))
    if (kept.length === list.length) return nextAssembly
    return { ...nextAssembly, tools: kept }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (DROP.has(exec.name)) {
      return { kind: 'deny', reason: `${exec.name} 已从飞书面摘掉` }
    }
    const spec = packOfName(exec.name)
    if (spec && !ALWAYS.has(exec.name) && !packOf(exec.agent)[spec.id]) {
      return { kind: 'deny', reason: `先 enable_mcp pack=${spec.id}，再调 ${exec.name}` }
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'glob' || result?.isError) return next()
    const text = textOf(result)
    if (!text) return next()
    const filtered = filterGlobText(text)
    if (!filtered) return next()
    return { kind: 'accept', content: [{ type: 'text', text: filtered }] }
  })

  process.stderr.write(`[dsh-feishu] tool trim: MCP packs + glob skip node_modules\n`)
}
