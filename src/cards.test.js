import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askCard, createCardStore, formField, goalCard, parseCardAction, resumeCard } from './cards.js'

test('settle is first-wins', () => {
  const store = createCardStore()
  let got
  store.add({
    id: 't1',
    kind: 'ask',
    appId: 'a',
    chatId: 'c',
    resolve: (v) => { got = v },
    ttlMs: 60_000,
  })
  assert.ok(store.settle('t1', { custom: 'yes' }))
  assert.equal(store.settle('t1', { selected: ['no'] }), null)
  assert.deepEqual(got, { custom: 'yes' })
})

test('rejectAll drops pending on that chat only', () => {
  const store = createCardStore()
  const seen = []
  store.add({
    id: 'a1', kind: 'guard', appId: 'a', chatId: 'c1',
    resolve: (v) => seen.push(['a1', v]), ttlMs: 60_000,
  })
  store.add({
    id: 'a2', kind: 'ask', appId: 'a', chatId: 'c2',
    resolve: (v) => seen.push(['a2', v]), ttlMs: 60_000,
  })
  store.rejectAll('a', 'c1', 'stop')
  assert.equal(store.get('a1'), null)
  assert.ok(store.get('a2'))
  assert.deepEqual(seen, [['a1', { abort: true, reason: 'stop' }]])
  store.settle('a2', { custom: 'later' })
})

test('parseCardAction reads nested and flat payloads', () => {
  const nested = parseCardAction({
    event: {
      operator: { open_id: 'ou_1' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      action: { value: { kind: 'guard', token: 't', verdict: 'deny' } },
    },
  })
  assert.equal(nested.openId, 'ou_1')
  assert.equal(nested.chatId, 'oc_1')
  assert.equal(nested.value.verdict, 'deny')

  const flat = parseCardAction({
    open_id: 'ou_2',
    open_chat_id: 'oc_2',
    action: { value: '{"kind":"ask","token":"x","opt":"HTML"}' },
  })
  assert.equal(flat.openId, 'ou_2')
  assert.equal(flat.value.opt, 'HTML')
})

test('parseCardAction reads form_value', () => {
  const parsed = parseCardAction({
    event: {
      action: {
        tag: 'button',
        name: 'submit',
        value: { kind: 'goal', token: 'tok', op: 'edit' },
        form_value: { objective: '  把 README 补上安装步骤  ' },
      },
    },
  })
  assert.equal(parsed.value.op, 'edit')
  assert.equal(formField(parsed, 'objective'), '把 README 补上安装步骤')
})

test('goalCard wires form submit and action buttons', () => {
  const card = goalCard({
    id: 'token-goal-1',
    title: '目标进行中',
    template: 'blue',
    body: '目标：写 README',
    actions: [
      { op: 'pause', label: '暂停自动续跑', type: 'default' },
      { op: 'clear', label: '清除当前目标', type: 'danger' },
    ],
    form: {
      op: 'edit',
      field: 'objective',
      label: '修改目标',
      placeholder: '填写新的目标内容',
      defaultValue: '写 README',
      submit: '保存修改',
    },
  })
  assert.equal(card.schema, '2.0')
  const form = card.body.elements.find((el) => el.tag === 'form')
  assert.ok(form)
  assert.equal(form.elements[0].tag, 'input')
  assert.equal(form.elements[0].name, 'objective')
  assert.equal(form.elements[1].action_type, 'form_submit')
  assert.deepEqual(form.elements[1].behaviors[0].value, { kind: 'goal', token: 'token-goal-1', op: 'edit' })
  const buttons = card.body.elements.filter((el) => el.tag === 'button')
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons[0].behaviors[0].value, { kind: 'goal', token: 'token-goal-1', op: 'pause' })
  assert.equal(buttons[1].type, 'danger')
})

test('askCard always includes answer form', () => {
  const card = askCard({
    id: 'ask-1',
    header: '选择格式',
    question: '报告用哪种格式？',
    options: [{ label: 'HTML', description: '单页' }],
  })
  const form = card.body.elements.find((el) => el.tag === 'form')
  assert.ok(form)
  assert.equal(form.elements[0].name, 'answer')
  assert.equal(form.elements[1].behaviors[0].value.op, 'custom')
  const buttons = card.body.elements.filter((el) => el.tag === 'button')
  assert.equal(buttons[0].behaviors[0].value.opt, 'HTML')
})

test('resumeCard wires pick and stay', () => {
  const card = resumeCard({
    id: 'resume-tok',
    items: [
      { n: 1, title: '当前会话', when: '08-20 10:00', size: '3.4M', current: true },
      { n: 2, title: '旧会话', when: '08-19 09:00', from: 'bot-2', busy: true },
    ],
  })
  assert.equal(card.header.title.content, '选择会话')
  const buttons = card.body.elements.filter((el) => el.tag === 'button')
  assert.equal(buttons.length, 3)
  assert.equal(buttons[0].type, 'primary')
  assert.deepEqual(buttons[0].behaviors[0].value, { kind: 'resume', token: 'resume-tok', op: 'pick', n: '1' })
  assert.deepEqual(buttons[1].behaviors[0].value, { kind: 'resume', token: 'resume-tok', op: 'pick', n: '2' })
  assert.match(buttons[1].text.content, /占用/)
  const hints = card.body.elements.filter((el) => el.tag === 'markdown').map((el) => el.content)
  assert.ok(hints.some((text) => text.includes('3.4M')))
  assert.deepEqual(buttons[2].behaviors[0].value, { kind: 'resume', token: 'resume-tok', op: 'stay' })
  assert.equal(buttons[2].text.content, '都不选，留在当前')
})
