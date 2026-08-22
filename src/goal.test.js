import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGoalCard,
  createGoalViews,
  dismissGoal,
  goalActions,
  goalForm,
  noticeOfGoalLine,
  presentGoal,
} from './goal.js'

function sample(patch = {}) {
  return {
    id: 'g1',
    revision: 1,
    objective: '写 README',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 3,
    ...patch,
  }
}

test('goalActions follow phase and activation', () => {
  assert.deepEqual(goalActions(null), [])
  assert.deepEqual(goalActions(sample()).map((a) => a.op), ['pause', 'clear'])
  assert.equal(goalActions(sample())[0].label, '暂停自动续跑')
  assert.deepEqual(goalActions(sample({ activation: 'disarmed' })).map((a) => a.op), ['resume', 'clear'])
  assert.equal(goalActions(sample({ phase: 'paused' }))[0].label, '恢复自动续跑')
  assert.deepEqual(goalActions(sample({ phase: 'blocked' })).map((a) => a.op), ['resume', 'clear'])
  assert.deepEqual(goalActions(sample({ phase: 'complete' })).map((a) => a.op), ['clear'])
})

test('goalForm is create when empty or complete, edit otherwise', () => {
  assert.equal(goalForm(null).op, 'create')
  assert.equal(goalForm(null).submit, '设定并开始')
  assert.equal(goalForm(sample({ phase: 'complete' })).op, 'create')
  assert.equal(goalForm(sample()).op, 'edit')
  assert.equal(goalForm(sample()).submit, '保存修改')
  assert.equal(goalForm(sample()).defaultValue, '写 README')
})

test('noticeOfGoalLine maps slash lines', () => {
  assert.equal(noticeOfGoalLine('/goal'), undefined)
  assert.equal(noticeOfGoalLine('/goal pause'), 'pause')
  assert.equal(noticeOfGoalLine('/goal resume'), 'resume')
  assert.equal(noticeOfGoalLine('/goal clear'), 'clear')
  assert.equal(noticeOfGoalLine('/goal edit 新目标'), 'edit')
  assert.equal(noticeOfGoalLine('/goal 写个文件，最多跑3轮'), 'create')
})

test('buildGoalCard colors and buttons', () => {
  const active = buildGoalCard('tok1', sample())
  assert.equal(active.header.template, 'blue')
  assert.equal(active.header.title.content, '目标进行中')
  assert.ok(active.body.elements.some((el) => el.tag === 'button' && el.behaviors[0].value.op === 'pause'))
  const form = active.body.elements.find((el) => el.tag === 'form')
  assert.equal(form.elements[1].behaviors[0].value.op, 'edit')

  const blocked = buildGoalCard('tok2', sample({
    phase: 'blocked',
    blockedReason: { code: 'need-login', message: '要登录' },
  }), 'block')
  assert.equal(blocked.header.template, 'red')
  assert.ok(blocked.body.elements[0].content.includes('要登录'))

  const empty = buildGoalCard('tok3', null, 'clear')
  assert.equal(empty.header.title.content, '目标已清除')
  assert.equal(empty.body.elements.filter((el) => el.tag === 'button').length, 0)
  assert.equal(empty.body.elements.find((el) => el.tag === 'form').elements[1].behaviors[0].value.op, 'create')
})

test('buildGoalCard noForm collapses input', () => {
  const collapsed = buildGoalCard('tok4', sample(), 'create', { noForm: true })
  assert.equal(collapsed.body.elements.find((el) => el.tag === 'form'), undefined)
  assert.ok(collapsed.body.elements[0].content.includes('重新发送 /goal'))
  assert.ok(collapsed.body.elements[0].content.includes(sample().objective))

  const normal = buildGoalCard('tok5', sample(), 'create')
  assert.ok(normal.body.elements.find((el) => el.tag === 'form'))
})

test('goal views rotate token per chat', () => {
  const views = createGoalViews()
  views.put({ id: 'a', appId: 'app', chatId: 'c', messageId: 'm1' })
  views.put({ id: 'b', appId: 'app', chatId: 'c', messageId: 'm2' })
  assert.equal(views.get('a'), null)
  assert.equal(views.current('app', 'c').id, 'b')
  assert.equal(views.forget('app', 'c').id, 'b')
  assert.equal(views.current('app', 'c'), null)
})

test('presentGoal edits current card then rotates token', async () => {
  const views = createGoalViews()
  const edits = []
  const sends = []
  const lark = {
    async editCard(id, card) {
      edits.push({ id, title: card.header.title.content })
      return true
    },
    async sendCard(chatId, card) {
      sends.push({ chatId, title: card.header.title.content })
      return 'm-new'
    },
  }
  views.put({ id: 'old', appId: 'app', chatId: 'c', messageId: 'm1', lark })
  const messageId = await presentGoal({
    views,
    lark,
    appId: 'app',
    chatId: 'c',
    goal: sample({ phase: 'paused' }),
    notice: 'pause',
  })
  assert.equal(messageId, 'm1')
  assert.equal(sends.length, 0)
  assert.equal(edits[0].id, 'm1')
  assert.equal(edits[0].title, '目标已暂停')
  assert.ok(views.get('old') === null)
  assert.ok(views.current('app', 'c').id)
  assert.notEqual(views.current('app', 'c').id, 'old')
})

test('dismissGoal locks and forgets', async () => {
  const views = createGoalViews()
  const edits = []
  const lark = {
    async editCard(id, card) {
      edits.push({ id, title: card.header.title.content })
      return true
    },
  }
  views.put({ id: 'x', appId: 'app', chatId: 'c', messageId: 'm9', lark })
  await dismissGoal(views, lark, 'app', 'c', '会话已清空。')
  await Promise.resolve()
  assert.equal(views.current('app', 'c'), null)
  assert.equal(edits[0].title, '目标已失效')
})
