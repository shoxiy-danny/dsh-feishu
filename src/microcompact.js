const GATE_TOKENS = 100_000
const THRESHOLD_CHARS = 8192
const HEAD_CHARS = 4096
const TAIL_CHARS = 1024
const KEEP_VIEWS = 3
const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

const COMPACTABLE = new Set([
  'read',
  'glob',
  'grep',
  'bash',
  'web_search',
  'web_fetch',
  'mcp__browser-mcp__web_search',
  'mcp__browser-mcp__fetch_page',
])

function codePointLength(text) {
  return Array.from(text).length
}

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

function resultBlock(event) {
  return event?.data?.message?.content?.[0] || null
}

function resultId(block, event, seq) {
  return block?.toolCallId
    || event?.data?.message?.source?.callId
    || event?.data?.callId
    || `seq:${seq}`
}

function resultText(block) {
  const content = block?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

function alreadyPruned(block) {
  const text = resultText(block)
  return text.includes('tool result middle pruned') || text.startsWith('[旧工具结果已清]')
}

function measureBlocks(blocks) {
  let chars = 0
  if (!Array.isArray(blocks)) return 0
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chars += codePointLength(block.text)
    }
  }
  return chars
}

function pruneBlocks(blocks) {
  const totalChars = measureBlocks(blocks)
  if (totalChars <= THRESHOLD_CHARS) return null

  const removedStart = HEAD_CHARS
  const removedEnd = totalChars - TAIL_CHARS
  const pruned = []
  let consumed = 0
  let markerInserted = false

  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      if (block) pruned.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
    if (marker) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }
  return markerInserted ? pruned : null
}

function seenViews(session, resultSeq) {
  const events = session?.events
  if (!events || typeof resultSeq !== 'number') return 0
  const list = Array.isArray(events) ? events : Object.values(events)
  let n = 0
  for (const event of list) {
    if (event?.type !== 'step/start') continue
    const seq = event.seq
    if (typeof seq === 'number' && seq > resultSeq) n += 1
  }
  return n
}

function collectFrozenIds(session) {
  const frozen = new Set()
  if (!session?.surface?.nodes) return frozen
  for (const seq of session.surface.nodes) {
    const event = session.events?.[seq]
    if (event?.type !== 'tool/result') continue
    frozen.add(resultId(resultBlock(event), event, seq))
  }
  return frozen
}

function applyPruneGate(session, tokens, state, pruneFn) {
  if (!session?.surface?.nodes || !session.append) return { opened: false, pruned: 0 }
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    return { opened: Boolean(state.get(session)), pruned: 0 }
  }

  let gate = state.get(session)
  if (!gate) {
    if (tokens < GATE_TOKENS) return { opened: false, pruned: 0 }
    gate = { frozen: collectFrozenIds(session) }
    state.set(session, gate)
    return { opened: true, pruned: 0 }
  }

  const names = callNames(session)
  const cut = typeof pruneFn === 'function' ? pruneFn : pruneBlocks
  let n = 0
  for (const seq of [...session.surface.nodes]) {
    const event = session.events[seq]
    if (event?.type !== 'tool/result') continue
    const block = resultBlock(event)
    if (!block || block.isError) continue
    const id = resultId(block, event, seq)
    if (gate.frozen.has(id)) continue
    const name = names.get(block.toolCallId || event.data?.message?.source?.callId || event.data?.callId)
    if (!name || !COMPACTABLE.has(name)) continue
    if (alreadyPruned(block)) continue
    if (measureBlocks(block.content) <= THRESHOLD_CHARS) continue
    if (seenViews(session, seq) < KEEP_VIEWS) continue

    const content = cut(block.content)
    if (!content) continue
    session.append('tool/result', {
      ...event.data,
      message: {
        ...event.data.message,
        content: [{ ...block, content }],
      },
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    n += 1
  }
  return { opened: true, pruned: n }
}

function measureTokens(ctx, session) {
  const meter = ctx.get?.('tokenMeter')
  if (!meter?.measure) return null
  try {
    const total = meter.measure(session)?.totalTokens
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
    return total
  } catch (err) {
    process.stderr.write(`[dsh-feishu] prune-gate tokenMeter: ${err}\n`)
    return null
  }
}

export function attachMicroCompact(ctx) {
  const state = new WeakMap()
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const session = payload.agent?.session
      const tokens = measureTokens(ctx, session)
      const pruner = ctx.get?.('toolResultPruner')
      const cut = pruner?.pruneContent ? (blocks) => pruner.pruneContent(blocks) : pruneBlocks
      const { opened, pruned } = applyPruneGate(session, tokens, state, cut)
      if (pruned) {
        process.stderr.write(`[dsh-feishu] prune-gate opened=${opened} pruned=${pruned}\n`)
      }
    } catch (err) {
      process.stderr.write(`[dsh-feishu] prune-gate: ${err}\n`)
    }
    return next()
  })
  process.stderr.write('[dsh-feishu] prune-gate: 100K then keep-3 head/tail\n')
}

export {
  GATE_TOKENS,
  THRESHOLD_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  KEEP_VIEWS,
  PRUNE_MARKER,
  COMPACTABLE,
  codePointLength,
  measureBlocks,
  pruneBlocks,
  seenViews,
  alreadyPruned,
  applyPruneGate,
}
