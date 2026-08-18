const KEEP_CHARS = 400
const MARK = '[旧工具结果已清]'

const COMPACTABLE = new Set([
  'read',
  'glob',
  'grep',
  'bash',
  'write',
  'edit',
  'web_search',
  'web_fetch',
  'mcp__browser-mcp__web_search',
  'mcp__browser-mcp__fetch_page',
])

function callNames(session) {
  const map = new Map()
  const events = session?.events
  if (!events) return map
  const list = Array.isArray(events) ? events : Object.values(events)
  for (const event of list) {
    if (event?.type !== 'tool/call') continue
    const id = event.data?.callId
    const name = event.data?.name
    if (id && name) map.set(id, name)
  }
  return map
}

function resultText(block) {
  const content = block?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

function alreadyCleared(block) {
  const text = resultText(block)
  return text.startsWith(MARK) || text.includes('tool result middle pruned')
}

function pruneOldToolResults(agent, incomingTurn) {
  const session = agent?.session
  if (!session?.surface?.nodes || !session.append) return 0

  const names = callNames(session)
  let n = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number' || turn >= incomingTurn) continue

    const block = event.data?.message?.content?.[0]
    if (!block || block.isError) continue
    const callId = block.toolCallId || event.data?.message?.source?.callId
    const name = names.get(callId)
    if (!name || !COMPACTABLE.has(name)) continue
    if (alreadyCleared(block)) continue
    if (resultText(block).length <= KEEP_CHARS) continue

    const message = {
      ...event.data.message,
      content: [{
        ...block,
        content: [{ type: 'text', text: `${MARK} ${name}` }],
      }],
    }
    session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    n += 1
  }
  return n
}

export function attachMicroCompact(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (payload.step === 1 && payload.turn > 1) {
        const n = pruneOldToolResults(payload.agent, payload.turn)
        if (n) process.stderr.write(`[dsh-feishu] microcompact turn=${payload.turn} cleared=${n}\n`)
      }
    } catch (err) {
      process.stderr.write(`[dsh-feishu] microcompact: ${err}\n`)
    }
    return next()
  })
  process.stderr.write('[dsh-feishu] microcompact: old read/glob/grep/bash results\n')
}
