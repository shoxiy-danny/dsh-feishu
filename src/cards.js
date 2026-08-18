const DEFAULT_TTL = 10 * 60 * 1000

export function chatKey(appId, chatId) {
  return `${appId}::${chatId}`
}

export function createCardStore() {
  const pending = new Map()
  const byChat = new Map()

  function add(rec) {
    pending.set(rec.id, rec)
    const key = chatKey(rec.appId, rec.chatId)
    let set = byChat.get(key)
    if (!set) {
      set = new Set()
      byChat.set(key, set)
    }
    set.add(rec.id)
    rec.timer = setTimeout(() => {
      settle(rec.id, { timeout: true })
    }, rec.ttlMs || DEFAULT_TTL)
  }

  function get(id) {
    return pending.get(id) || null
  }

  function finds(appId, chatId, kind) {
    const set = byChat.get(chatKey(appId, chatId))
    if (!set) return []
    return [...set]
      .map((id) => pending.get(id))
      .filter((rec) => rec && (!kind || rec.kind === kind))
  }

  function settle(id, result) {
    const rec = pending.get(id)
    if (!rec) return null
    pending.delete(id)
    const key = chatKey(rec.appId, rec.chatId)
    const set = byChat.get(key)
    if (set) {
      set.delete(id)
      if (set.size === 0) byChat.delete(key)
    }
    clearTimeout(rec.timer)
    try { rec.resolve(result) } catch { /* ignore */ }
    return rec
  }

  function rejectAll(appId, chatId, reason) {
    for (const rec of finds(appId, chatId)) {
      settle(rec.id, { abort: true, reason })
    }
  }

  return { add, get, finds, settle, rejectAll }
}

export function waitCard(store, rec) {
  return new Promise((resolve) => {
    rec.resolve = resolve
    store.add(rec)
  })
}

function clip(text, max = 800) {
  const body = String(text || '')
  if (body.length <= max) return body
  return `${body.slice(0, max)}\n…`
}

export function approvalCard({ id, kind, command }) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '高危操作待确认' },
      template: 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `模型想执行下面这条命令。\n原因：\`${kind}\`` },
        { tag: 'hr' },
        { tag: 'markdown', content: '```bash\n' + clip(command) + '\n```' },
        {
          tag: 'button',
          element_id: `deny_${id.slice(0, 8)}`,
          type: 'default',
          text: { tag: 'plain_text', content: '拒绝' },
          behaviors: [{ type: 'callback', value: { kind: 'guard', token: id, verdict: 'deny' } }],
        },
        {
          tag: 'button',
          element_id: `allow_${id.slice(0, 8)}`,
          type: 'danger',
          text: { tag: 'plain_text', content: '允许这一次' },
          behaviors: [{ type: 'callback', value: { kind: 'guard', token: id, verdict: 'allow' } }],
        },
      ],
    },
  }
}

export function askCard({ id, header, question, detail, options }) {
  const elements = [
    { tag: 'markdown', content: header ? `**${header}**\n${question}` : `**${question}**` },
  ]
  if (detail) elements.push({ tag: 'markdown', content: String(detail) })
  if (options?.length) {
    for (const [i, opt] of options.entries()) {
      const label = String(opt.label || '').slice(0, 40)
      elements.push({
        tag: 'button',
        element_id: `opt_${id.slice(0, 6)}_${i}`,
        type: i === 0 ? 'primary' : 'default',
        text: { tag: 'plain_text', content: label || `选项 ${i + 1}` },
        behaviors: [{ type: 'callback', value: { kind: 'ask', token: id, opt: opt.label } }],
      })
      if (opt.description) {
        elements.push({ tag: 'markdown', content: `_${opt.description}_` })
      }
    }
    elements.push({ tag: 'markdown', content: '也可以直接打字回答。先到的算数。' })
  } else {
    elements.push({ tag: 'markdown', content: '没有预设选项，直接打字回答。' })
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: header || '需要你选一下' },
      template: 'blue',
    },
    body: { elements },
  }
}

export function lockedCard({ title, template, body }) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title || '已结束' },
      template: template || 'grey',
    },
    body: {
      elements: [{ tag: 'markdown', content: body || '' }],
    },
  }
}

export function parseCardAction(data) {
  const event = data?.event ?? data
  const action = event?.action ?? {}
  let value = action.value ?? {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = { raw: value } }
  }
  if (!value || typeof value !== 'object') value = {}
  return {
    openId: event?.operator?.open_id ?? event?.open_id ?? '',
    chatId: event?.context?.open_chat_id ?? event?.open_chat_id ?? '',
    messageId: event?.context?.open_message_id ?? event?.open_message_id ?? '',
    value,
  }
}
