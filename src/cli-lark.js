import { randomUUID } from 'node:crypto'

export const CLI_APP_ID = 'cli'

const DEFAULT_CHAT = 'local'

export function createCliLark({ emit } = {}) {
  const chats = new Map()

  function inbox(chatId) {
    const key = String(chatId || DEFAULT_CHAT)
    let item = chats.get(key)
    if (!item) {
      item = { seq: 0, events: [] }
      chats.set(key, item)
    }
    return item
  }

  function push(chatId, event) {
    const box = inbox(chatId)
    box.events.push(event)
    try { emit?.(chatId, event) } catch { /* ignore */ }
    return event.id || ''
  }

  function nextId(chatId) {
    const box = inbox(chatId)
    box.seq += 1
    return `cli-out-${chatId}-${box.seq}`
  }

  async function sendText(chatId, text) {
    const body = String(text ?? '')
    if (!chatId || !body.trim()) return ''
    const id = nextId(chatId)
    push(chatId, { type: 'text', id, text: body, at: Date.now() })
    return id
  }

  function progressCard(text) {
    return { text: String(text ?? '') }
  }

  async function sendCard(chatId, card) {
    if (!chatId) return ''
    const id = nextId(chatId)
    const text = typeof card === 'string' ? card : (card?.text || JSON.stringify(card))
    push(chatId, { type: 'card', id, text, at: Date.now() })
    return id
  }

  function chatOfMessage(messageId) {
    for (const [chatId, box] of chats) {
      if (box.events.some((ev) => ev.id === messageId)) return chatId
    }
    return chats.keys().next().value || DEFAULT_CHAT
  }

  async function editCard(messageId, card) {
    if (!messageId) return false
    const text = typeof card === 'string' ? card : (card?.text || JSON.stringify(card))
    push(chatOfMessage(messageId), { type: 'edit', id: messageId, text, at: Date.now() })
    return true
  }

  async function react(messageId, emoji) {
    if (!messageId || !emoji) return false
    push(chatOfMessage(messageId), { type: 'react', id: messageId, emoji, at: Date.now() })
    return true
  }

  async function downloadResource() {
    return null
  }

  async function sendFile(chatId, filePath, opts = {}) {
    const id = nextId(chatId)
    push(chatId, {
      type: 'file',
      id,
      path: String(filePath || ''),
      voice: Boolean(opts.voice),
      at: Date.now(),
    })
    return `file recorded (${filePath})`
  }

  function start() {
    return {
      stop() {},
      ready: Promise.resolve(),
    }
  }

  function drain(chatId) {
    const box = inbox(chatId)
    const out = box.events
    box.events = []
    return out
  }

  function peek(chatId) {
    return inbox(chatId).events.slice()
  }

  return {
    appId: CLI_APP_ID,
    sendText,
    sendCard,
    editCard,
    progressCard,
    react,
    downloadResource,
    sendFile,
    start,
    drain,
    peek,
    makeInbound,
  }
}

export function makeInbound({ chatId = DEFAULT_CHAT, text = '', resources = [] } = {}) {
  return {
    senderId: 'cli-local',
    chatId: String(chatId || DEFAULT_CHAT),
    chatType: 'p2p',
    messageId: `cli-in-${randomUUID()}`,
    messageType: 'text',
    text: String(text || ''),
    resources: Array.isArray(resources) ? resources : [],
  }
}
