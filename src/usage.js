import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from './models.js'

const DAY_MS = 86_400_000
const BJ_OFFSET = 8 * 3600 * 1000
const MAX_LOG = 128 * 1024 * 1024

// 别名表来自 DSH_FEISHU_MODELS 指向的 models.json，外加内置 dsf。
// 不认识的模型就原样显示 model id，不硬编码任何私有网关。
function aliasTable() {
  const out = { 'deepseek-flash': 'dsf' }
  let models = {}
  try {
    models = loadModels()
  } catch {
    models = {}
  }
  for (const [alias, spec] of Object.entries(models)) {
    out[`${spec.provider}:${spec.model}`] = alias
    out[spec.model] = alias
  }
  return out
}

// bot 显示名列 DSH_FEISHU_BOT_LABELS，形如 `cli_xxx=Alice,cli_yyy=Bob`。
function botNames() {
  const out = new Map([['cli', 'cli']])
  const raw = String(process.env.DSH_FEISHU_BOT_LABELS || '')
  for (const item of raw.split(',')) {
    const i = item.indexOf('=')
    if (i < 1) continue
    const id = item.slice(0, i).trim()
    const label = item.slice(i + 1).trim()
    if (id && label) out.set(id, label)
  }
  return out
}

export function beijingDayStart(nowMs) {
  return Math.floor((Number(nowMs) + BJ_OFFSET) / DAY_MS) * DAY_MS - BJ_OFFSET
}

export function parseUsageArg(raw, nowMs = Date.now()) {
  const arg = String(raw || '').trim().toLowerCase()
  if (!arg || arg === '7d' || arg === '7' || arg === '近7天') {
    return {
      ok: true,
      window: { key: '7d', label: '近7天', since: nowMs - 7 * DAY_MS },
    }
  }
  if (arg === 'today' || arg === '今天') {
    return {
      ok: true,
      window: { key: 'today', label: '今天', since: beijingDayStart(nowMs) },
    }
  }
  if (arg === 'all' || arg === '全部') {
    return { ok: true, window: { key: 'all', label: '全部', since: null } }
  }
  return { ok: false, error: '未知时间窗。用法：/usage  ·  /usage today  ·  /usage all' }
}

export function formatTok(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '?'
  if (v < 1000) return String(Math.round(v))
  if (v < 1_000_000) {
    const k = v / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}K`
  }
  const m = v / 1_000_000
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}

export function formatAgo(ts, now) {
  if (!ts) return '-'
  let d = Number(now) - Number(ts)
  if (!Number.isFinite(d)) return '-'
  if (d < 0) d = 0
  if (d < 90_000) return `${Math.floor(d / 1000)}s前`
  if (d < 90 * 60_000) return `${Math.floor(d / 60_000)}m前`
  if (d < 48 * 3600_000) return `${(d / 3_600_000).toFixed(1)}h前`
  return `${Math.round(d / DAY_MS)}d前`
}

export function formatCache(cacheRead, input) {
  if (!input) return '-'
  return `${Math.round((100 * cacheRead) / input)}%`
}

export function tokensOf(row) {
  return num(row?.input) + num(row?.output)
}

export function formatShare(part, whole) {
  const p = Number(part)
  const w = Number(whole)
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return '-'
  return `${Math.round((100 * p) / w)}%`
}

export function formatExact(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '?'
  return Math.round(v).toLocaleString('en-US')
}

export function collectUsage({ dshHome, window, now = Date.now() } = {}) {
  const since = window?.since ?? null
  const sessionsRoot = join(String(dshHome || ''), 'sessions')
  const bots = loadBotMap(dshHome)
  const names = botNames()
  const alias = aliasTable()
  const models = new Map()
  const byBot = new Map()
  const total = blankRow()
  let scanned = 0
  let skipped = 0

  for (const file of listLogs(sessionsRoot)) {
    scanned++
    if (since != null) {
      try {
        if (statSync(file).mtimeMs < since) {
          skipped++
          continue
        }
      } catch {
        skipped++
        continue
      }
    }
    const text = readLog(file)
    if (!text) continue
    const sessionId = sessionIdOf(file)
    const appId = bots.get(sessionId) || ''
    foldLog(text, { since, models, byBot, total, appId, alias, names })
  }

  return {
    window: window || { key: '7d', label: '近7天', since },
    now,
    scanned,
    skipped,
    total,
    models: sortModels(models),
    bots: sortBots(byBot),
  }
}

export function formatUsage(report) {
  const label = report.window?.label || '近7天'
  const t = report.total || blankRow()
  const grand = tokensOf(t)
  const lines = [
    `用量 · ${label}`,
    `扫于 ${formatClock(report.now)}`,
    '',
    `总量  ${formatTok(grand)}  (${formatExact(grand)})`,
    `请求  ${t.requests}`,
    `输入  ${formatTok(t.input)}`,
    `输出  ${formatTok(t.output)}`,
    `缓存  ${formatCache(t.cacheRead, t.input)}`,
  ]
  if (!report.models?.length) {
    lines.push('', `${label}没有用量记录`)
    return lines.join('\n')
  }
  lines.push('', '模型')
  for (const row of report.models) {
    lines.push(modelLine(row, report.now, grand))
  }
  if (report.bots?.length) {
    lines.push('', 'Bot')
    for (const row of report.bots) {
      lines.push(`${pad(row.name, 5)}  ${row.requests}次  ${formatTok(tokensOf(row))}  ·  ${formatTok(row.input)} / ${formatTok(row.output)}`)
    }
  }
  return lines.join('\n')
}

export function usageCard(report) {
  const label = report.window?.label || '近7天'
  const t = report.total || blankRow()
  const grand = tokensOf(t)
  const elements = [
    { tag: 'markdown', content: '**合计**', text_size: 'heading' },
    metricRow([
      { label: '总量', value: formatTok(grand), hint: formatExact(grand), color: 'blue' },
      { label: '请求', value: String(t.requests), hint: `${report.scanned || 0} 个会话`, color: 'blue' },
    ]),
    metricRow([
      { label: '输入', value: formatTok(t.input), hint: `缓存 ${formatCache(t.cacheRead, t.input)}`, color: 'green' },
      { label: '输出', value: formatTok(t.output), color: 'neutral' },
      { label: '缓存命中', value: formatCache(t.cacheRead, t.input), hint: formatTok(t.cacheRead), color: 'green' },
    ], '4px 0 0 0'),
  ]
  if (!report.models?.length) {
    elements.push({ tag: 'markdown', content: `${label}没有用量记录` })
  } else {
    elements.push({ tag: 'markdown', content: '**模型**', text_size: 'heading' })
    elements.push({
      tag: 'markdown',
      content: report.models.map((row) => modelLine(row, report.now, grand)).join('\n'),
    })
  }
  if (report.bots?.length) {
    elements.push({ tag: 'markdown', content: '**Bot**', text_size: 'heading' })
    elements.push({
      tag: 'markdown',
      content: report.bots
        .map((row) => `${row.name}  ${row.requests}次  ·  ${formatTok(tokensOf(row))}  ·  ${formatTok(row.input)} / ${formatTok(row.output)}`)
        .join('\n'),
    })
  }
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `用量 · ${label}` },
      subtitle: { tag: 'plain_text', content: `扫于 ${formatClock(report.now)}` },
      template: 'turquoise',
      icon: { tag: 'standard_icon', token: 'member_filled' },
    },
    body: { elements },
  }
}

function foldLog(text, { since, models, byBot, total, appId, alias, names }) {
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type !== 'assistant/message') continue
    const usage = ev.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const time = Number(ev.time)
    if (since != null && (!Number.isFinite(time) || time < since)) continue
    const uncached = num(usage.inputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const output = num(usage.outputTokens)
    const input = uncached + cacheRead
    const model = String(ev.data?.message?.source?.model || '')
    const provider = String(ev.data?.message?.source?.provider || '')
    const name = alias[`${provider}:${model}`] || alias[model] || model || '?'
    addRow(total, { requests: 1, input, output, cacheRead, lastSeen: time })
    addRow(bucket(models, name, { alias: name, model: model || name }), {
      requests: 1, input, output, cacheRead, lastSeen: time,
    })
    if (appId) {
      addRow(bucket(byBot, appId, { appId, name: names.get(appId) || shortId(appId) }), {
        requests: 1, input, output, cacheRead, lastSeen: time,
      })
    }
  }
}

function listLogs(root) {
  const out = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sess of sessions) {
      if (!sess.isDirectory() || !sess.name.startsWith('session-')) continue
      const dir = join(root, project.name, sess.name)
      const file = logFileOf(dir)
      if (file) out.push(file)
    }
  }
  return out
}

function logFileOf(dir) {
  let best = null
  let bestRank = -1
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const rank = logRank(name)
    if (rank < 0) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
    } catch {
      continue
    }
    if (rank > bestRank) {
      best = file
      bestRank = rank
    }
  }
  return best
}

function logRank(name) {
  if (name === 'session.jsonl') return 1
  if (name === 'session.jsonl.zstd') return 2
  const m = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(String(name))
  if (!m) return -1
  return 10 + Number(m[1])
}

function readLog(file) {
  if (file.endsWith('.zstd')) {
    try {
      return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: MAX_LOG })
    } catch {
      return ''
    }
  }
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function loadBotMap(dshHome) {
  const map = new Map()
  const hist = readJson(join(String(dshHome || ''), 'feishu-history.json'))
  const items = Array.isArray(hist?.items) ? hist.items : []
  items.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  for (const item of items) {
    if (item?.id && item.appId) map.set(String(item.id), String(item.appId))
  }
  const chats = readJson(join(String(dshHome || ''), 'feishu-chats.json'))
  if (chats && typeof chats === 'object') {
    for (const [key, val] of Object.entries(chats)) {
      const sessionId = val?.sessionId
      if (!sessionId) continue
      const i = String(key).indexOf('::')
      const appId = i < 0 ? String(key) : String(key).slice(0, i)
      map.set(String(sessionId), appId)
    }
  }
  return map
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function sessionIdOf(file) {
  const parts = String(file).split('/')
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith('session-')) return parts[i]
  }
  return ''
}

function blankRow() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, lastSeen: 0 }
}

function bucket(map, key, extra) {
  let row = map.get(key)
  if (!row) {
    row = { ...blankRow(), ...extra }
    map.set(key, row)
  }
  return row
}

function addRow(row, delta) {
  row.requests += delta.requests
  row.input += delta.input
  row.output += delta.output
  row.cacheRead += delta.cacheRead
  if (delta.lastSeen > row.lastSeen) row.lastSeen = delta.lastSeen
}

function sortModels(map) {
  return [...map.values()].sort((a, b) => b.requests - a.requests || b.input - a.input)
}

function sortBots(map) {
  return [...map.values()].sort((a, b) => b.requests - a.requests)
}

function shortId(appId) {
  const id = String(appId || '')
  return id.length <= 10 ? id : id.slice(0, 10)
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function modelLine(row, now, grand) {
  const name = row.alias || row.model || '?'
  const tok = tokensOf(row)
  return `${name}  ${row.requests}次  ${formatTok(tok)}  ${formatShare(tok, grand)}  ·  入 ${formatTok(row.input)} / 出 ${formatTok(row.output)}  缓存 ${formatCache(row.cacheRead, row.input)}  ${formatAgo(row.lastSeen, now)}`
}

function pad(s, n) {
  const t = String(s || '')
  return t.length >= n ? t : t + ' '.repeat(n - t.length)
}

function formatClock(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t + BJ_OFFSET)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function metricRow(items, margin) {
  return {
    tag: 'column_set',
    flex_mode: items.length <= 2 ? 'bisect' : 'trisect',
    horizontal_spacing: '8px',
    horizontal_align: 'center',
    margin: margin || '8px 0 0 0',
    columns: items.map((item) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: 'grey',
      padding: '8px',
      vertical_spacing: '4px',
      vertical_align: 'top',
      elements: tileElements(item),
    })),
  }
}

function tileElements({ label, value, hint, color }) {
  const elements = [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: String(label),
        text_size: 'notation',
        text_align: 'center',
        text_color: 'grey',
      },
    },
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: String(value),
        text_size: 'heading',
        text_align: 'center',
        text_color: 'default',
      },
    },
  ]
  if (hint) {
    elements.push({
      tag: 'markdown',
      content: `<text_tag color='${color || 'neutral'}'>${hint}</text_tag>`,
      text_align: 'center',
      text_size: 'notation',
    })
  }
  return elements
}
