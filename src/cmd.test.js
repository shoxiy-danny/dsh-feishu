import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOWED, parseCommand, runCommand } from './cmd.js'

test('allowlist is rename only', () => {
  assert.deepEqual([...ALLOWED], ['rename'])
})

test('parseCommand accepts slash and bare rename', () => {
  assert.deepEqual(parseCommand('/rename 8K门keep3'), {
    ok: true, name: 'rename', arg: '8K门keep3',
  })
  assert.deepEqual(parseCommand('rename 短名'), { ok: true, name: 'rename', arg: '短名' })
  assert.equal(parseCommand('/status').ok, false)
  assert.equal(parseCommand('/clear').ok, false)
  assert.equal(parseCommand('/stop now').ok, false)
  assert.equal(parseCommand('/model grk').ok, false)
  assert.equal(parseCommand('').ok, false)
  assert.match(parseCommand('/status').error, /不允许/)
})

test('runCommand rename needs a title and a route', async () => {
  const calls = []
  const bridge = {
    rename: async (appId, chatId, title) => {
      calls.push([appId, chatId, title])
      return `已命名为「${title}」`
    },
  }
  const miss = await runCommand({ ok: true, name: 'rename', arg: 'x' }, { route: null, bridge })
  assert.equal(miss.ok, false)
  const noArg = await runCommand({ ok: true, name: 'rename', arg: '' }, {
    route: { appId: 'a', chatId: 'c' },
    bridge,
  })
  assert.equal(noArg.ok, false)
  const ok = await runCommand({ ok: true, name: 'rename', arg: '8K门keep3' }, {
    route: { appId: 'bot', chatId: 'oc_1' },
    bridge,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.text, '已命名为「8K门keep3」')
  assert.deepEqual(calls, [['bot', 'oc_1', '8K门keep3']])
})
