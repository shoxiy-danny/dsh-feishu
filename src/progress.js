import { formatGoalTag } from './goal.js'
import { aliasMap, loadModels } from './models.js'

const DEBOUNCE_MS = 300

export function attachProgress(ctx, { routeOf, modelOf, windowOf, goalOf }) {
  const aliases = aliasMap(loadModels())
  const buffers = new Map()
  const cards = new Map()
  const chatSession = new Map()

  function buf(sessionId) {
    const key = String(sessionId)
    let item = buffers.get(key)
    if (!item) {
      item = { error: '' }
      buffers.set(key, item)
    }
    return item
  }

  function stateOf(chatKey) {
    let s = cards.get(chatKey)
    if (!s) {
      s = {
        msgId: null,
        lastType: null,
        count: 0,
        lastEditAt: 0,
        lastPct: null,
      }
      cards.set(chatKey, s)
    }
    return s
  }

  function prefix(chatKey) {
    const sel = modelOf?.(chatKey)
    let alias = '?'
    if (sel) {
      alias = aliases[`${sel.provider}:${sel.model}`] || String(sel.model || '?').slice(0, 12)
    }
    const pct = percent(chatKey)
    const s = cards.get(chatKey)
    if (s && pct !== null) s.lastPct = pct
    const shown = pct ?? s?.lastPct ?? null
    const sessionId = chatSession.get(chatKey)
    let goalTag = ''
    if (sessionId && goalOf) {
      try { goalTag = formatGoalTag(goalOf(sessionId)) } catch { /* ignore */ }
    }
    return shown === null ? `[${alias}${goalTag}]` : `[${alias}-${shown}%${goalTag}]`
  }

  function percent(chatKey) {
    const meter = ctx.get('tokenMeter')
    const sessions = ctx.get('sessions')
    if (!meter || !sessions) return null
    const sessionId = chatSession.get(chatKey)
    if (!sessionId) return null
    try {
      const session = typeof sessions.get === 'function'
        ? (sessions.get(sessionId) ?? sessions.get(String(sessionId)))
        : null
      if (!session) return null
      const m = meter.measure(session)
      const total = m?.totalTokens
      if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
      const window = windowOf?.(modelOf?.(chatKey)) || 1_000_000
      return Math.max(0, Math.min(99, Math.round((total / window) * 100)))
    } catch (err) {
      process.stderr.write(`[dsh-feishu] tokenMeter: ${err}\n`)
      return null
    }
  }

  function push(route, typeKey) {
    const lark = route.lark
    const chatKey = route.chatKey
    const s = stateOf(chatKey)
    s.count = typeKey === s.lastType ? s.count + 1 : 1
    s.lastType = typeKey

    const now = Date.now()
    if (now - s.lastEditAt < DEBOUNCE_MS) return
    s.lastEditAt = now

    const label = typeKey === 'thinking' ? 'Thinking' : `Using ${typeKey}`
    const text = s.count > 1
      ? `${prefix(chatKey)} ${label}...(${s.count})`
      : `${prefix(chatKey)} ${label}...`
    const card = lark.progressCard(text)

    if (s.msgId && s.msgId !== 'pending') {
      void lark.editCard(s.msgId, card).catch((err) => {
        process.stderr.write(`[dsh-feishu] progress edit failed: ${err}\n`)
      })
      return
    }
    if (s.msgId === 'pending') return
    s.msgId = 'pending'
    void lark.sendCard(route.chatId, card).then((id) => {
      s.msgId = id || null
    }).catch((err) => {
      s.msgId = null
      process.stderr.write(`[dsh-feishu] progress create failed: ${err}\n`)
    })
  }

  function finish(route, kind) {
    const chatKey = route.chatKey
    const s = cards.get(chatKey)
    if (!s) return
    const id = s.msgId
    cards.delete(chatKey)
    if (!id || id === 'pending') return
    const text = kind === 'fail'
      ? `${prefix(chatKey)} Failed.`
      : `${prefix(chatKey)} Done.`
    void route.lark.editCard(id, route.lark.progressCard(text)).catch((err) => {
      process.stderr.write(`[dsh-feishu] progress done failed: ${err}\n`)
    })
  }

  ctx.on('session/event', (session, event) => {
    const route = routeOf(session.header.id)
    if (!route?.chatId || !route.lark) return
    chatSession.set(route.chatKey, String(session.header.id))
    const item = buf(session.header.id)

    if (event.type === 'assistant/chunk') {
      const chunk = event.data?.chunk
      const kind = chunk?.type ?? chunk?.kind
      if (kind === 'thinking' || kind === 'reasoning' || chunk?.thinking) {
        push(route, 'thinking')
      }
    }

    if (event.type === 'assistant/message') {
      // 过滤空文本块：有的模型在 tool_use 前会吐只有空白/换行的 text。
      const blocks = event.data.message.content ?? []
      // 判据与 agent-loop 一致：无 tool-call 即本轮终局（toolCalls.length === 0 -> completed），
      // 末条发绿头 Done 卡，中间过程发言维持普通蓝头。
      const hasToolCall = blocks.some((block) => block.type === 'tool-call')
      const text = blocks
        .filter((block) => block.type === 'text' && String(block.text || '').trim() !== '')
        .map((block) => block.text)
        .join('')
        .trim()
      if (text) {
        finish(route, 'done')
        if (hasToolCall) {
          void route.lark.sendText(route.chatId, text).catch((err) => {
            process.stderr.write(`[dsh-feishu] reply failed: ${err}\n`)
          })
        } else {
          const sel = modelOf?.(route.chatKey)
          const alias = sel
            ? (aliases[`${sel.provider}:${sel.model}`] || String(sel.model || '?').slice(0, 12))
            : '?'
          void route.lark.sendFinal(route.chatId, text, alias).catch((err) => {
            process.stderr.write(`[dsh-feishu] final reply failed: ${err}\n`)
          })
        }
      }
    }

    if (event.type === 'tool/call') {
      push(route, event.data.name || 'tool')
    }

    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') {
      const err = event.data.reason.error
      item.error = `${err?.code ?? 'error'}: ${err?.message ?? 'unknown'}`
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const route = routeOf(agent.id)
    if (!route?.chatId || !route.lark) return
    if (status === 'running') {
      push(route, 'thinking')
      return
    }
    if (status !== 'idle') return
    const item = buffers.get(String(agent.id))
    buffers.delete(String(agent.id))
    if (item?.error) {
      finish(route, 'fail')
      void route.lark.sendText(route.chatId, `失败：${item.error}`).catch((err) => {
        process.stderr.write(`[dsh-feishu] error reply failed: ${err}\n`)
      })
      return
    }
    finish(route, 'done')
  })
}
