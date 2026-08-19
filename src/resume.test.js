import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardStore } from './cards.js'
import { lockResume, presentResume, resumePickFailed } from './resume.js'

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
