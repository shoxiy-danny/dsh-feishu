import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardStore, parseCardAction } from './cards.js'

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
