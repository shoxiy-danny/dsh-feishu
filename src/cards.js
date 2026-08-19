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
  const token = String(id || '')
  const elements = [
    { tag: 'markdown', content: header ? `**${header}**\n${question}` : `**${question}**` },
  ]
  if (detail) elements.push({ tag: 'markdown', content: String(detail) })
  if (options?.length) {
    for (const [i, opt] of options.entries()) {
      const label = String(opt.label || '').slice(0, 40)
      elements.push({
        tag: 'button',
        element_id: eid('opt', token, i),
        type: i === 0 ? 'primary' : 'default',
        text: { tag: 'plain_text', content: label || `选项 ${i + 1}` },
        behaviors: [{ type: 'callback', value: { kind: 'ask', token, opt: opt.label } }],
      })
      if (opt.description) {
        elements.push({ tag: 'markdown', content: `_${opt.description}_` })
      }
    }
    elements.push({ tag: 'markdown', content: '也可在下方填写后提交，或直接回复本条消息。先提交的为准。' })
  } else {
    elements.push({ tag: 'markdown', content: '请在下方填写后提交，或直接回复本条消息。' })
  }
  elements.push(inputForm({
    formName: `ask_${safeId(token)}`,
    fieldName: 'answer',
    prefix: 'a',
    token,
    kind: 'ask',
    op: 'custom',
    label: '回答',
    placeholder: '填写回答后点「提交回答」',
    submit: '提交回答',
    required: true,
  }))
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: header || '需要选择' },
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

export function resumeCard({ id, items }) {
  const token = String(id || '')
  const elements = [
    { tag: 'markdown', content: '点一条切过去。占用中的不能同时握。点「都不选」留在当前。也可 `/resume 2`。' },
  ]
  for (const [i, item] of (items || []).entries()) {
    const n = Number(item.n || i + 1)
    const bits = []
    if (item.from) bits.push(item.from)
    if (item.when) bits.push(item.when)
    if (item.size) bits.push(item.size)
    if (item.busy) bits.push('占用')
    if (item.current) bits.push('当前')
    const hint = bits.length ? `\n_${bits.join(' · ')}_` : ''
    elements.push({
      tag: 'button',
      element_id: eid('rb', token, i),
      type: item.current ? 'primary' : 'default',
      text: { tag: 'plain_text', content: resumeButtonLabel(item, n) },
      behaviors: [{ type: 'callback', value: { kind: 'resume', token, op: 'pick', n: String(n) } }],
    })
    if (hint) elements.push({ tag: 'markdown', content: hint.trim() })
  }
  elements.push({
    tag: 'button',
    element_id: eid('rs', token),
    type: 'default',
    text: { tag: 'plain_text', content: '都不选，留在当前' },
    behaviors: [{ type: 'callback', value: { kind: 'resume', token, op: 'stay' } }],
  })
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '选择会话' },
      template: 'blue',
    },
    body: { elements },
  }
}

function resumeButtonLabel(item, n) {
  const mark = item.current ? '* ' : ''
  const busy = item.busy ? ' 占用' : ''
  return `${mark}${n}. ${item.title || ''}${busy}`.slice(0, 40)
}

export function goalCard({ id, title, template, body, actions, form }) {
  const token = String(id || '')
  const elements = [
    { tag: 'markdown', content: String(body || '') },
  ]
  if (form) {
    elements.push({ tag: 'hr' })
    elements.push(inputForm({
      formName: `goal_${safeId(token)}`,
      fieldName: form.field || 'objective',
      prefix: 'g',
      token,
      kind: 'goal',
      op: form.op,
      label: form.label,
      placeholder: form.placeholder,
      defaultValue: form.defaultValue,
      submit: form.submit,
      required: true,
    }))
  }
  if (actions?.length) {
    if (!form) elements.push({ tag: 'hr' })
    for (const [i, act] of actions.entries()) {
      const op = String(act.op || '')
      elements.push({
        tag: 'button',
        element_id: eid('gb', token, i),
        type: act.type || 'default',
        text: { tag: 'plain_text', content: String(act.label || op) },
        behaviors: [{ type: 'callback', value: { kind: 'goal', token, op } }],
      })
    }
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title || '目标' },
      template: template || 'blue',
    },
    body: { elements },
  }
}

function inputForm({
  formName,
  fieldName,
  prefix,
  token,
  kind,
  op,
  label,
  placeholder,
  defaultValue,
  submit,
  required,
}) {
  const input = {
    tag: 'input',
    element_id: eid(`${prefix}i`, token),
    name: fieldName,
    required: required !== false,
    width: 'fill',
    input_type: 'multiline_text',
    rows: 3,
    auto_resize: true,
    max_length: 1000,
    placeholder: { tag: 'plain_text', content: placeholder || '请填写' },
  }
  if (label) input.label = { tag: 'plain_text', content: label }
  if (defaultValue) input.default_value = String(defaultValue).slice(0, 1000)
  return {
    tag: 'form',
    name: formName,
    elements: [
      input,
      {
        tag: 'button',
        element_id: eid(`${prefix}s`, token),
        type: 'primary',
        action_type: 'form_submit',
        name: 'submit',
        text: { tag: 'plain_text', content: submit || '提交' },
        behaviors: [{ type: 'callback', value: { kind, token, op } }],
      },
    ],
  }
}

function safeId(token) {
  return String(token || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'x'
}

function eid(prefix, token, i) {
  const tail = i === undefined ? '' : String(i)
  return `${prefix}${safeId(token).slice(0, 8)}${tail}`.slice(0, 20)
}

export function formField(action, name) {
  const raw = action?.formValue?.[name]
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object') {
    if (typeof raw.value === 'string') return raw.value.trim()
    if (typeof raw.input_value === 'string') return raw.input_value.trim()
  }
  if (typeof action?.inputValue === 'string') return action.inputValue.trim()
  return ''
}

export function parseCardAction(data) {
  const event = data?.event ?? data
  const action = event?.action ?? {}
  let value = action.value ?? {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = { raw: value } }
  }
  if (!value || typeof value !== 'object') value = {}
  const formValue = action.form_value && typeof action.form_value === 'object' ? action.form_value : {}
  return {
    openId: event?.operator?.open_id ?? event?.open_id ?? '',
    chatId: event?.context?.open_chat_id ?? event?.open_chat_id ?? '',
    messageId: event?.context?.open_message_id ?? event?.open_message_id ?? '',
    value,
    formValue,
    inputValue: typeof action.input_value === 'string' ? action.input_value : '',
    tag: action.tag || '',
    name: action.name || '',
  }
}
