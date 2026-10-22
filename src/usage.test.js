import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beijingDayStart,
  collectUsage,
  formatAgo,
  formatCache,
  formatExact,
  formatShare,
  formatTok,
  formatUsage,
  parseUsageArg,
  tokensOf,
  usageCard,
} from './usage.js'

const DAY = 86_400_000

test('parseUsageArg windows', () => {
  const now = Date.parse('2026-09-24T12:00:00+08:00')
  const def = parseUsageArg('', now)
  assert.equal(def.ok, true)
  assert.equal(def.window.key, '7d')
  assert.equal(def.window.since, now - 7 * DAY)

  const today = parseUsageArg('today', now)
  assert.equal(today.window.key, 'today')
  assert.equal(today.window.since, beijingDayStart(now))
  assert.equal(today.window.since, Date.parse('2026-09-24T00:00:00+08:00'))

  const all = parseUsageArg('all', now)
  assert.equal(all.window.key, 'all')
  assert.equal(all.window.since, null)

  const bad = parseUsageArg('week')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /未知时间窗/)
})

test('beijingDayStart is midnight CST', () => {
  const late = Date.parse('2026-09-24T01:30:00+08:00')
  const utcEvening = Date.parse('2026-09-23T16:10:00Z')
  assert.equal(beijingDayStart(late), Date.parse('2026-09-24T00:00:00+08:00'))
  assert.equal(beijingDayStart(utcEvening), Date.parse('2026-09-24T00:00:00+08:00'))
})

test('formatTok / formatCache / formatAgo', () => {
  assert.equal(formatTok(0), '0')
  assert.equal(formatTok(999), '999')
  assert.equal(formatTok(1500), '1.5K')
  assert.equal(formatTok(30720), '31K')
  assert.equal(formatTok(1_200_000), '1.2M')
  assert.equal(formatCache(512, 10416 + 512), '5%')
  assert.equal(formatCache(0, 0), '-')
  const now = 1_000_000
  assert.equal(formatAgo(now - 12_000, now), '12s前')
  assert.equal(formatAgo(now - 5 * 60_000, now), '5m前')
  assert.equal(formatAgo(now - 3 * 3600_000, now), '3.0h前')
})

test('tokensOf / formatShare / formatExact', () => {
  assert.equal(tokensOf({ input: 3500, output: 800 }), 4300)
  assert.equal(tokensOf({}), 0)
  assert.equal(formatShare(4300, 4300), '100%')
  assert.equal(formatShare(2150, 4300), '50%')
  assert.equal(formatShare(0, 0), '-')
  assert.equal(formatExact(55_951_658), '55,951,658')
  assert.equal(formatExact(0), '0')
})

// 别名表来自 DSH_FEISHU_MODELS。测试里用一条临时 models.json 提供，不依赖私有网关。
function withModels(aliases, body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-usage-models-'))
  const file = join(dir, 'models.json')
  const spec = {}
  for (const [alias, model] of Object.entries(aliases)) {
    spec[alias] = { provider: 'test-gw', model }
  }
  writeFileSync(file, JSON.stringify(spec))
  const prev = process.env.DSH_FEISHU_MODELS
  process.env.DSH_FEISHU_MODELS = file
  try {
    return body()
  } finally {
    if (prev === undefined) delete process.env.DSH_FEISHU_MODELS
    else process.env.DSH_FEISHU_MODELS = prev
  }
}

// bot 显示名来自 DSH_FEISHU_BOT_LABELS，不是源码里写死的 App ID。
function withBotLabels(labels, body) {
  const prev = process.env.DSH_FEISHU_BOT_LABELS
  process.env.DSH_FEISHU_BOT_LABELS = labels
  try {
    return body()
  } finally {
    if (prev === undefined) delete process.env.DSH_FEISHU_BOT_LABELS
    else process.env.DSH_FEISHU_BOT_LABELS = prev
  }
}

test('collectUsage counts message usage and maps bot', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
  const sess = 'session-aaa-111'
  const dir = join(root, 'sessions', '--home-user--', sess)
  mkdirSync(dir, { recursive: true })
  const t1 = Date.parse('2026-09-20T10:00:00+08:00')
  const t2 = Date.parse('2026-09-23T10:00:00+08:00')
  const tOld = Date.parse('2026-09-01T10:00:00+08:00')
  writeFileSync(join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'session', id: sess, createdAt: tOld }),
    msgLine(tOld, 1, 'grok-4.6', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }),
    msgLine(t1, 2, 'grok-4.6', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 }),
    { type: 'assistant/chunk', time: t1, data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 } } } },
    msgLine(t2, 3, 'agnes-3.0-flash', { inputTokens: 2000, outputTokens: 80 }),
  ].map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
  writeFileSync(join(root, 'feishu-chats.json'), JSON.stringify({
    'cli_testbot::oc_1': { sessionId: sess, model: 'grk' },
  }))

  const now = Date.parse('2026-09-24T12:00:00+08:00')
  const report = withModels(
    { grk: 'grok-4.6', agn: 'agnes-3.0-flash' },
    () => withBotLabels('cli_testbot=Alice', () => collectUsage({
      dshHome: root,
      window: { key: '7d', label: '近7天', since: now - 7 * DAY },
      now,
    })),
  )
  assert.equal(report.total.requests, 2)
  assert.equal(report.total.input, 1000 + 500 + 2000)
  assert.equal(report.total.output, 280)
  assert.equal(report.total.cacheRead, 500)
  assert.equal(report.models.length, 2)
  assert.equal(report.models[0].alias, 'agn')
  assert.equal(report.models[1].alias, 'grk')
  assert.equal(report.bots[0].name, 'Alice')
  assert.equal(report.bots[0].requests, 2)
})

test('collectUsage skips stale files by mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-old-'))
  const dir = join(root, 'sessions', '--home-user--', 'session-old')
  mkdirSync(dir, { recursive: true })
  const t = Date.parse('2026-08-01T10:00:00+08:00')
  writeFileSync(join(dir, 'session.jsonl'), msgLine(t, 1, 'grok-4.6', { inputTokens: 9, outputTokens: 1 }) + '\n')
  execFileSync('touch', ['-d', '2026-08-01 10:00:00', join(dir, 'session.jsonl')])
  const now = Date.parse('2026-09-24T12:00:00+08:00')
  const report = collectUsage({
    dshHome: root,
    window: { key: '7d', label: '近7天', since: now - 7 * DAY },
    now,
  })
  assert.equal(report.skipped, 1)
  assert.equal(report.total.requests, 0)
})

test('collectUsage prefers session.v4 over leftover jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-v-'))
  const dir = join(root, 'sessions', '--home-user--', 'session-v')
  mkdirSync(dir, { recursive: true })
  const t = Date.parse('2026-09-23T10:00:00+08:00')
  writeFileSync(join(dir, 'session.jsonl'), msgLine(t, 1, 'grok-4.6', { inputTokens: 9, outputTokens: 1 }) + '\n')
  writeFileSync(join(dir, 'session.v4.jsonl'), msgLine(t, 1, 'step-3.7-flash', { inputTokens: 40, outputTokens: 8 }) + '\n')
  const now = Date.parse('2026-09-24T12:00:00+08:00')
  const report = withModels(
    { stf: 'step-3.7-flash' },
    () => collectUsage({ dshHome: root, window: { key: 'all', label: '全部', since: null }, now }),
  )
  assert.equal(report.total.requests, 1)
  assert.equal(report.models[0].alias, 'stf')
  assert.equal(report.total.input, 40)
})

test('collectUsage reads concatenated zstd frames', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-usage-z-'))
  const dir = join(root, 'sessions', '--home-user--', 'session-z')
  mkdirSync(dir, { recursive: true })
  const t = Date.parse('2026-09-23T10:00:00+08:00')
  const raw = msgLine(t, 1, 'step-3.7-flash', { inputTokens: 40, outputTokens: 8, cacheReadTokens: 10 }) + '\n'
  const plain = join(dir, 'plain.jsonl')
  const zstd = join(dir, 'session.jsonl.zstd')
  writeFileSync(plain, raw)
  execFileSync('zstd', ['-q', '-f', '-o', zstd, plain])
  const now = Date.parse('2026-09-24T12:00:00+08:00')
  const report = withModels(
    { stf: 'step-3.7-flash' },
    () => collectUsage({ dshHome: root, window: { key: 'all', label: '全部', since: null }, now }),
  )
  assert.equal(report.total.requests, 1)
  assert.equal(report.models[0].alias, 'stf')
  assert.equal(report.total.input, 50)
})

test('formatUsage and usageCard', () => {
  const now = Date.parse('2026-09-24T15:04:00+08:00')
  const report = {
    window: { key: '7d', label: '近7天', since: now - 7 * DAY },
    now,
    scanned: 12,
    skipped: 3,
    total: { requests: 9, input: 3500, output: 800, cacheRead: 700, lastSeen: now },
    models: [{ alias: 'grk', model: 'grok-4.6', requests: 9, input: 3500, output: 800, cacheRead: 700, lastSeen: now - 12_000 }],
    bots: [{ appId: 'cli_testbot', name: 'Alice', requests: 9, input: 3500, output: 800, cacheRead: 700, lastSeen: now }],
  }
  const text = formatUsage(report)
  assert.match(text, /^用量 · 近7天/)
  assert.match(text, /扫于 2026-09-24 15:04/)
  assert.match(text, /总量  4.3K  \(4,300\)/)
  assert.match(text, /请求  9/)
  assert.match(text, /输入  3.5K/)
  assert.match(text, /grk  9次  4.3K  100%/)
  assert.match(text, /入 3.5K \/ 出 800/)
  assert.match(text, /Alice/)
  const card = usageCard(report)
  assert.equal(card.schema, '2.0')
  assert.equal(card.header.title.content, '用量 · 近7天')
  const dump = JSON.stringify(card)
  assert.match(dump, /4\.3K/)
  assert.match(dump, /4,300/)
  assert.match(dump, /3\.5K/)
  assert.match(dump, /grk/)
  assert.match(dump, /Alice/)
  assert.doesNotMatch(dump, /"tag":"button"/)
})

test('formatUsage empty window', () => {
  const text = formatUsage({
    window: { key: 'today', label: '今天', since: 1 },
    now: 2,
    scanned: 0,
    total: { requests: 0, input: 0, output: 0, cacheRead: 0, lastSeen: 0 },
    models: [],
    bots: [],
  })
  assert.match(text, /今天没有用量记录/)
})

function msgLine(time, turn, model, usage) {
  return JSON.stringify({
    type: 'assistant/message',
    time,
    data: {
      turn,
      step: 1,
      message: { source: { kind: 'model', provider: 'test-gw', model } },
      usage,
    },
  })
}
