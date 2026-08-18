import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes, formatStatus, formatTokensK, measureContext, parseDf, parseMeminfo } from './status.js'

test('formatTokensK', () => {
  assert.equal(formatTokensK(0), '0K')
  assert.equal(formatTokensK(1500), '1.5K')
  assert.equal(formatTokensK(30720), '31K')
  assert.equal(formatTokensK(256000), '256K')
  assert.equal(formatTokensK(1_000_000), '1000K')
  assert.equal(formatTokensK(-1), '?')
})

test('formatBytes', () => {
  assert.equal(formatBytes(512), '1K')
  assert.equal(formatBytes(1536), '2K')
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0M')
  assert.equal(formatBytes(12 * 1024 ** 2), '12M')
  assert.equal(formatBytes(3.2 * 1024 ** 3), '3.2G')
  assert.equal(formatBytes(32 * 1024 ** 3), '32G')
  assert.equal(formatBytes(-1), '?')
})

test('parseMeminfo uses MemAvailable', () => {
  const got = parseMeminfo('MemTotal:       32768000 kB\nMemFree:         1000000 kB\nMemAvailable:   16384000 kB\n')
  assert.equal(got.total, 32768000 * 1024)
  assert.equal(got.avail, 16384000 * 1024)
  assert.equal(got.used, 16384000 * 1024)
})

test('parseDf first data line', () => {
  const got = parseDf('Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/vda1      104857600  52428800  52428800  50% /\n')
  assert.equal(got.total, 104857600 * 1024)
  assert.equal(got.used, 52428800 * 1024)
  assert.equal(got.mount, '/')
})

test('measureContext percent and missing session', () => {
  const sessions = { get: (id) => (id === 's1' ? { id: 's1' } : null) }
  const meter = { measure: () => ({ totalTokens: 125_000 }) }
  assert.deepEqual(measureContext({ meter, sessions, sessionId: 's1', window: 500_000 }), {
    total: 125_000,
    window: 500_000,
    pct: 25,
  })
  assert.deepEqual(measureContext({
    meter,
    session: { events: [] },
    window: 500_000,
  }), {
    total: 125_000,
    window: 500_000,
    pct: 25,
  })
  assert.equal(measureContext({ meter, sessions, sessionId: null, window: 500_000 }), null)
  assert.equal(measureContext({ meter, sessions, sessionId: 'missing', window: 500_000 }), null)
  assert.equal(measureContext({ sessions, sessionId: 's1', window: 500_000 }), null)
})

test('formatStatus no session', () => {
  const text = formatStatus({
    alias: 'grk',
    model: 'grok-4.6',
    hasSession: false,
    context: null,
    host: {
      hostname: 'box',
      mem: { total: 32 * 1024 ** 3, used: 16 * 1024 ** 3 },
      disk: { total: 100 * 1024 ** 3, used: 40 * 1024 ** 3 },
      cpu: { n: 8, l1: 1.23, l5: 0.8, l15: 0.5, pct: 15 },
    },
  })
  assert.match(text, /模型  grk = grok-4\.6/)
  assert.match(text, /上下文  无会话/)
  assert.doesNotMatch(text, /主机/)
  assert.match(text, /内存  16G \/ 32G  已用 50%/)
  assert.match(text, /磁盘  40G \/ 100G  已用 40%/)
  assert.match(text, /CPU   8核  ·  15%/)
})

test('formatStatus with context', () => {
  const text = formatStatus({
    alias: 'stf',
    model: 'step-3.7-flash',
    hasSession: true,
    context: { pct: 12, total: 30720, window: 256000 },
    agentStatus: 'idle',
    host: {
      hostname: 'box',
      mem: { total: 0, used: 0 },
      disk: { total: 0, used: 0 },
      cpu: { n: 4, l1: 0, l5: 0, l15: 0, pct: 0 },
    },
  })
  assert.match(text, /上下文  12%  ·  31K \/ 256K/)
  assert.match(text, /状态  idle/)
  assert.match(text, /内存  不可读/)
})
