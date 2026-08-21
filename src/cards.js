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
        {
          tag: 'markdown',
          content: `<font color='red'>**危险命令，默认拒绝**</font>　<font color='grey'>触发：\`${kind}\`</font>`,
        },
        { tag: 'hr' },
        { tag: 'markdown', content: '```bash\n' + clip(command) + '\n```' },
        {
          tag: 'column_set',
          flex_mode: 'bisect',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'top',
              elements: [{
                tag: 'button',
                element_id: `deny_${id.slice(0, 8)}`,
                type: 'default',
                text: { tag: 'plain_text', content: '拒绝' },
                behaviors: [{ type: 'callback', value: { kind: 'guard', token: id, verdict: 'deny' } }],
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              vertical_align: 'top',
              elements: [{
                tag: 'button',
                element_id: `allow_${id.slice(0, 8)}`,
                type: 'danger',
                text: { tag: 'plain_text', content: '允许这一次' },
                behaviors: [{ type: 'callback', value: { kind: 'guard', token: id, verdict: 'allow' } }],
              }],
            },
          ],
        },
      ],
    },
  }
}

export function askCard({ id, header, question, detail, options }) {
  const token = String(id || '')
  const opts = (options || []).map((opt, i) => ({
    n: i + 1,
    value: opt.label,
    label: (String(opt.label || '').trim() || `选项 ${i + 1}`).slice(0, 40),
    description: opt.description ? String(opt.description).trim() : '',
  }))
  const elements = [
    { tag: 'markdown', content: `**${question}**` },
  ]
  if (detail) elements.push({ tag: 'markdown', content: String(detail) })
  if (opts.length && opts.some((o) => o.description)) {
    const menu = opts
      .map((o) => `**${o.n}. ${o.label}**${o.description ? `　<font color='grey'>${o.description}</font>` : ''}`)
      .join('\n')
    elements.push({ tag: 'markdown', content: menu })
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
  if (opts.length) {
    elements.push({ tag: 'hr' })
    for (let i = 0; i < opts.length; i += 2) {
      elements.push(askButtonRow(token, opts.slice(i, i + 2)))
    }
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>点选项或直接打字回复，先到的算数。</font>`,
    })
  } else {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>填框提交，或直接打字回复。</font>`,
    })
  }
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

function askButtonRow(token, opts) {
  const columns = opts.map((o) => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'top',
    elements: [{
      tag: 'button',
      element_id: eid('opt', token, o.n - 1),
      type: o.n === 1 ? 'primary' : 'default',
      text: { tag: 'plain_text', content: `${o.n} · ${o.label}`.slice(0, 40) },
      behaviors: [{ type: 'callback', value: { kind: 'ask', token, opt: o.value } }],
    }],
  }))
  if (columns.length === 1) {
    columns.push({ tag: 'column', width: 'weighted', weight: 1, elements: [] })
  }
  return { tag: 'column_set', flex_mode: 'bisect', columns }
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
    { tag: 'markdown', content: `<font color='grey'>点一条切过去；占用中的不能同时握。也可直接发 \`/resume 2\`。</font>` },
  ]
  for (const [i, item] of (items || []).entries()) {
    const n = Number(item.n || i + 1)
    const bits = []
    if (item.from) bits.push(item.from)
    if (item.when) bits.push(item.when)
    if (item.size) bits.push(item.size)
    if (item.busy) bits.push('占用')
    if (item.current) bits.push('当前')
    const hint = bits.length ? `\n<font color='grey'>${bits.join(' · ')}</font>` : ''
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

const MODEL_TIER_COLORS = { pro: 'blue', flash: 'green' }

export function modelCard({ id, current, groups }) {
  const token = String(id || '')
  const elements = [
    { tag: 'markdown', content: `当前 \`${current || '?'}\`。点一个切换，本会话记住；带别名直切（\`/model dsf\`）仍然可用。` },
  ]
  for (const group of groups || []) {
    elements.push({ tag: 'hr' })
    const color = MODEL_TIER_COLORS[group.key]
    const title = color ? `<font color='${color}'>**${group.title}**</font>` : `**${group.title}**`
    const hint = group.hint ? `　_${group.hint}_` : ''
    elements.push({ tag: 'markdown', content: `${title}${hint}` })
    const items = group.items || []
    for (let i = 0; i < items.length; i += 2) {
      elements.push(modelButtonRow(token, items.slice(i, i + 2), current))
    }
  }
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'button',
    element_id: eid('ms', token),
    type: 'default',
    text: { tag: 'plain_text', content: '都不选，保持当前' },
    behaviors: [{ type: 'callback', value: { kind: 'model', token, op: 'stay' } }],
  })
  elements.push({ tag: 'markdown', content: '卡片 10 分钟内有效，过期后重发 /model 即可。' })
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '切换模型' },
      template: 'blue',
    },
    body: { elements },
  }
}

function modelButtonRow(token, items, current) {
  const columns = items.map((item) => {
    const isCur = item.alias === current
    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [{
        tag: 'button',
        element_id: eid('mb', token, item.alias),
        type: isCur ? 'primary' : 'default',
        text: { tag: 'plain_text', content: `${isCur ? '* ' : ''}${item.alias} · ${item.short || item.label}`.slice(0, 40) },
        behaviors: [{ type: 'callback', value: { kind: 'model', token, alias: item.alias } }],
      }],
    }
  })
  if (columns.length === 1) {
    columns.push({ tag: 'column', width: 'weighted', weight: 1, elements: [] })
  }
  return { tag: 'column_set', flex_mode: 'bisect', columns }
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
    rows: 1,
    auto_resize: true,
    max_length: 1000,
    placeholder: { tag: 'plain_text', content: placeholder || '请填写' },
  }
  if (label) input.label = { tag: 'plain_text', content: label }
  if (defaultValue) input.default_value = String(defaultValue).slice(0, 1000)
  return {
    tag: 'form',
    element_id: eid(`${prefix}f`, token),
    name: formName,
    elements: [
      input,
      {
        tag: 'button',
        element_id: eid(`${prefix}s`, token),
        type: 'primary',
        name: 'submit',
        form_action_type: 'submit',
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
