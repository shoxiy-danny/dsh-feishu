import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardStore } from './cards.js'
import { lockResume, presentResume, resumePageCard, resumePaging, resumePickFailed } from './resume.js'

test('resumePickFailed only matches switch errors', () => {
  assert.equal(resumePickFailed('切不过去：会话正被另一个窗口占用'), true)
  assert.equal(resumePickFailed('序号无效。用 /resume 看列表'), true)
  assert.equal(resumePickFailed('已切到 2. 旧会话'), false)
  assert.equal(resumePickFailed('已经在「当前会话」'), false)
})

test('presentResume locks previous card when replaced', async () => {
  const store = createCardStore()
  const edits = []
  const sends = []
  const lark = {
    async sendCard(chatId, card) {
      sends.push({ chatId, title: card.header.title.content })
      return `m${sends.length}`
    },
    async editCard(id, card) {
      edits.push({ id, title: card.header.title.content })
      return true
    },
  }
  await presentResume({
    store,
    lark,
    appId: 'app',
    chatId: 'c',
    items: [{ n: 1, title: 'A', current: true }],
  })
  await presentResume({
    store,
    lark,
    appId: 'app',
    chatId: 'c',
    items: [{ n: 1, title: 'B', current: true }],
  })
  await Promise.resolve()
  assert.equal(sends.length, 2)
  assert.equal(edits[0].id, 'm1')
  assert.equal(edits[0].title, '已更新')
  const leftover = store.finds('app', 'c', 'resume')
  assert.equal(leftover.length, 1)
  store.settle(leftover[0].id, { abort: true, reason: 'test' })
})

test('resumePaging clamps page and empty list', () => {
  assert.deepEqual(resumePaging(0, 3), { page: 1, pages: 1, total: 0 })
  assert.deepEqual(resumePaging(8, 1), { page: 1, pages: 1, total: 8 })
  assert.deepEqual(resumePaging(9, 2), { page: 2, pages: 2, total: 9 })
  assert.deepEqual(resumePaging(20, 99), { page: 3, pages: 3, total: 20 })
  assert.deepEqual(resumePaging(20, 0), { page: 1, pages: 3, total: 20 })
  assert.deepEqual(resumePaging(20, 'x'), { page: 1, pages: 3, total: 20 })
})

test('resumePageCard rebuilds the same token', async () => {
  const rec = { id: 'tok', appId: 'app', chatId: 'c' }
  const bridge = {
    async listResumeItems(appId, chatId, page) {
      assert.equal(appId, 'app')
      assert.equal(chatId, 'c')
      assert.equal(page, '2')
      return {
        items: [{ n: 9, title: '第九' }],
        page: 2,
        pages: 3,
        total: 20,
      }
    },
  }
  const { view, card } = await resumePageCard(rec, bridge, '2')
  assert.equal(view.page, 2)
  assert.equal(card.header.title.content, '选择会话')
  const pick = card.body.elements.find((el) => el.tag === 'button' && el.behaviors?.[0]?.value?.op === 'pick')
  assert.deepEqual(pick.behaviors[0].value, { kind: 'resume', token: 'tok', op: 'pick', n: '9' })
})

test('lockResume removes buttons', async () => {
  const edits = []
  const rec = {
    messageId: 'm1',
    lark: {
      async editCard(id, card) {
        edits.push({
          id,
          title: card.header.title.content,
          body: card.body.elements[0].content,
          buttons: card.body.elements.filter((el) => el.tag === 'button').length,
        })
        return true
      },
    },
  }
  await lockResume(rec, { title: '已切换', template: 'green', body: '已切到 2. 旧会话' })
  assert.equal(edits[0].title, '已切换')
  assert.equal(edits[0].body, '已切到 2. 旧会话')
  assert.equal(edits[0].buttons, 0)
})
