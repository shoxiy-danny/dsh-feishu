import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askCard, checkedPicks, createCardStore, formField, formList, goalCard, lockedCard, modelCard, parseCardAction, resumeCard } from './cards.js'

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

test('lockedCard keeps indigo header for /clear', () => {
  const card = lockedCard({
    title: '会话已清空',
    template: 'indigo',
    body: '已清空，下一句会开新会话。当前模型：grok-4.7',
  })
  assert.equal(card.header.title.content, '会话已清空')
  assert.equal(card.header.template, 'indigo')
  assert.equal(card.body.elements[0].content, '已清空，下一句会开新会话。当前模型：grok-4.7')
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
  assert.equal(form.elements[1].form_action_type, 'submit')
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
  const buttons = collectButtons(card.body.elements).filter((b) => b.behaviors?.[0]?.value?.kind === 'ask')
  assert.equal(buttons[0].behaviors[0].value.opt, 'HTML')
  assert.equal(buttons[0].text.content, '1 · HTML')
})

test('askCard multiSelect uses checker list, not dropdown or option buttons', () => {
  const card = askCard({
    id: 'ask-multi-1',
    header: '多选测试',
    question: '选几种吃的？',
    options: [
      { label: '火锅', description: '热的' },
      { label: '烧烤' },
      { label: '日料' },
    ],
    multiSelect: true,
  })
  const forms = card.body.elements.filter((el) => el.tag === 'form')
  assert.equal(forms.length, 2)
  const pick = forms.find((el) => el.elements.some((item) => item.tag === 'checker'))
  assert.ok(pick)
  const checkers = pick.elements.filter((el) => el.tag === 'checker')
  assert.equal(checkers.length, 3)
  assert.deepEqual(checkers.map((el) => el.name), ['pick_0', 'pick_1', 'pick_2'])
  assert.equal(checkers[0].text.tag, 'lark_md')
  assert.match(checkers[0].text.content, /火锅/)
  assert.equal(checkers[1].text.content, '2 · 烧烤')
  const submit = pick.elements.find((el) => el.tag === 'button')
  assert.equal(submit.name, 'submit_picks')
  assert.equal(submit.form_action_type, 'submit')
  assert.deepEqual(submit.behaviors[0].value, { kind: 'ask', token: 'ask-multi-1', op: 'multi' })
  assert.equal(pick.elements.some((el) => el.tag === 'multi_select_static'), false)
  const buttons = collectButtons(card.body.elements).filter((b) => b.behaviors?.[0]?.value?.opt)
  assert.equal(buttons.length, 0)
  const hint = card.body.elements.find((el) => el.tag === 'markdown' && el.content.includes('提交选择'))
  assert.ok(hint)
})

test('formList reads multi_select form_value', () => {
  const parsed = parseCardAction({
    event: {
      action: {
        tag: 'button',
        name: 'submit',
        value: { kind: 'ask', token: 'tok', op: 'multi' },
        form_value: { picks: ['火锅', ' 烧烤 '] },
      },
    },
  })
  assert.equal(parsed.value.op, 'multi')
  assert.deepEqual(formList(parsed, 'picks'), ['火锅', '烧烤'])
  assert.deepEqual(formList(parsed, 'missing'), [])
})

test('checkedPicks reads checker form_value', () => {
  const parsed = parseCardAction({
    event: {
      action: {
        tag: 'button',
        name: 'submit_picks',
        value: { kind: 'ask', token: 'tok', op: 'multi' },
        form_value: { pick_0: true, pick_1: false, pick_2: 'true' },
      },
    },
  })
  assert.deepEqual(checkedPicks(parsed, ['火锅', '烧烤', '日料']), ['火锅', '日料'])
  assert.deepEqual(checkedPicks(parsed, []), [])
})

test('askCard menu lists descriptions and rows pair up', () => {
  const card = askCard({
    id: 'ask-2',
    question: '怎么处理？',
    options: [
      { label: '升级', description: '装最新版' },
      { label: '先不升' },
      { label: '看日志', description: '再决定' },
    ],
  })
  const menu = card.body.elements.find((el) => el.tag === 'markdown' && el.content.includes('1. 升级'))
  assert.ok(menu)
  assert.match(menu.content, /<font color='grey'>装最新版<\/font>/)
  const sets = card.body.elements.filter((el) => el.tag === 'column_set')
  assert.equal(sets.length, 2)
  assert.equal(sets[0].columns.length, 2)
  assert.equal(sets[1].columns.length, 2)
  assert.equal(sets[1].columns[1].elements.length, 0)
})

test('resumeCard wires pick and stay', () => {
  const card = resumeCard({
    id: 'resume-tok',
    items: [
      { n: 1, title: '当前会话', when: '08-20 10:00', size: '3.4M', current: true },
      { n: 2, title: '旧会话', when: '08-19 09:00', from: 'Bob', busy: true },
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
  assert.equal(card.body.elements.some((el) => el.tag === 'column_set'), false)
})

test('resumeCard paginates when more than one page', () => {
  const items = [
    { n: 9, title: '第九', when: '08-18 09:00' },
    { n: 10, title: '第十', when: '08-17 08:00' },
  ]
  const card = resumeCard({
    id: 'resume-tok',
    items,
    page: 2,
    pages: 3,
    total: 20,
  })
  const hints = card.body.elements.filter((el) => el.tag === 'markdown').map((el) => el.content)
  assert.ok(hints.some((text) => text.includes('第 2/3 页 · 共 20 条')))
  assert.ok(!hints.some((text) => text.includes('/resume')))
  const buttons = collectButtons(card.body.elements)
  const prev = buttons.find((el) => el.text.content === '上一页')
  const next = buttons.find((el) => el.text.content === '下一页')
  assert.equal(prev.disabled, false)
  assert.deepEqual(prev.behaviors[0].value, { kind: 'resume', token: 'resume-tok', op: 'page', page: '1' })
  assert.equal(next.disabled, false)
  assert.deepEqual(next.behaviors[0].value, { kind: 'resume', token: 'resume-tok', op: 'page', page: '3' })
})

test('resumeCard disables prev on first page and next on last page', () => {
  const first = resumeCard({
    id: 'tok-a',
    items: [{ n: 1, title: 'A' }],
    page: 1,
    pages: 2,
    total: 9,
  })
  const last = resumeCard({
    id: 'tok-b',
    items: [{ n: 9, title: 'I' }],
    page: 2,
    pages: 2,
    total: 9,
  })
  const firstBtns = collectButtons(first.body.elements)
  const lastBtns = collectButtons(last.body.elements)
  const firstPrev = firstBtns.find((el) => el.text.content === '上一页')
  const firstNext = firstBtns.find((el) => el.text.content === '下一页')
  const lastPrev = lastBtns.find((el) => el.text.content === '上一页')
  const lastNext = lastBtns.find((el) => el.text.content === '下一页')
  assert.equal(firstPrev.disabled, true)
  assert.equal(firstPrev.behaviors, undefined)
  assert.equal(firstNext.disabled, false)
  assert.deepEqual(firstNext.behaviors[0].value.page, '2')
  assert.equal(lastPrev.disabled, false)
  assert.deepEqual(lastPrev.behaviors[0].value.page, '1')
  assert.equal(lastNext.disabled, true)
  assert.equal(lastNext.behaviors, undefined)
})

function collectButtons(elements, out = []) {
  for (const el of elements || []) {
    if (el.tag === 'button') out.push(el)
    if (el.tag === 'column') collectButtons(el.elements, out)
    if (el.tag === 'column_set') collectButtons(el.columns, out)
  }
  return out
}

test('modelCard groups pro first, two per row, marks current, has stay', () => {
  const card = modelCard({
    id: 'model-tok',
    current: 'stf',
    groups: [
      {
        key: 'pro', title: 'Pro · 重量级', hint: '硬活',
        items: [{ alias: 'glm', label: 'glm = glm-5.3', short: 'glm-5.3' }, { alias: 'grk', label: 'grk = grok-4.6', short: 'grok-4.6' }],
      },
      {
        key: 'flash', title: 'Flash · 轻量级', hint: '快省',
        items: [{ alias: 'dsf', label: 'dsf = deepseek-flash', short: 'deepseek-flash' }, { alias: 'stf', label: 'stf = step-3.7-flash', short: 'step-3.7-flash' }],
      },
    ],
  })
  assert.equal(card.header.title.content, '切换模型')
  const sets = card.body.elements.filter((el) => el.tag === 'column_set')
  assert.equal(sets.length, 2)
  for (const set of sets) {
    assert.equal(set.flex_mode, 'bisect')
    assert.equal(set.columns.length, 2)
    assert.equal(set.columns[0].tag, 'column')
    assert.equal(set.columns[0].elements[0].tag, 'button')
  }
  const proTitle = card.body.elements.find((el) => el.tag === 'markdown' && el.content.includes('Pro · 重量级'))
  const flashTitle = card.body.elements.find((el) => el.tag === 'markdown' && el.content.includes('Flash · 轻量级'))
  assert.match(proTitle.content, /font color='blue'/)
  assert.match(flashTitle.content, /font color='green'/)
  const proIdx = card.body.elements.indexOf(proTitle)
  const flashIdx = card.body.elements.indexOf(flashTitle)
  assert.ok(flashIdx > proIdx)

  const buttons = collectButtons(card.body.elements)
  assert.equal(buttons.length, 5)
  assert.equal(buttons[0].text.content, 'glm · glm-5.3')
  const cur = buttons.find((b) => b.text.content.includes('stf'))
  assert.equal(cur.type, 'primary')
  assert.equal(cur.text.content, '* stf · step-3.7-flash')
  assert.deepEqual(cur.behaviors[0].value, { kind: 'model', token: 'model-tok', alias: 'stf' })
  const plain = buttons.find((b) => b.text.content.includes('dsf'))
  assert.equal(plain.type, 'default')
  const stay = card.body.elements.find((el) => el.tag === 'button' && el.behaviors?.[0]?.value?.op === 'stay')
  assert.ok(stay)
  assert.deepEqual(stay.behaviors[0].value, { kind: 'model', token: 'model-tok', op: 'stay' })
})

test('modelCard colors CodeBuddy group orange', () => {
  const card = modelCard({
    id: 'model-tok',
    current: 'cds',
    groups: [
      { key: 'cb', title: 'CodeBuddy', hint: 'CodeBuddy 通道', items: [{ alias: 'cgp', short: 'cb-glm-5.3' }, { alias: 'cds', short: 'cb-dsf' }] },
    ],
  })
  const title = card.body.elements.find((el) => el.tag === 'markdown' && el.content.includes('CodeBuddy'))
  assert.match(title.content, /font color='orange'/)
})
