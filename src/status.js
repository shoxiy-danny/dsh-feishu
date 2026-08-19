import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus, hostname, loadavg } from 'node:os'
import { join } from 'node:path'

export function formatTokensK(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '?'
  const k = v / 1000
  if (k < 10) return `${k.toFixed(1).replace(/\.0$/, '')}K`
  return `${Math.round(k)}K`
}

export function formatBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return '?'
  if (v >= 1024 ** 3) {
    const g = v / 1024 ** 3
    return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)}G`
  }
  if (v >= 1024 ** 2) {
    const m = v / 1024 ** 2
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  return `${Math.round(v / 1024)}K`
}

const SESSION_LOGS = ['session.jsonl.zstd', 'session.jsonl']

export function sessionFileBytes(root, sessionId) {
  const id = String(sessionId || '')
  if (!root || !id) return 0
  const sessionsRoot = join(root, 'sessions')
  try {
    for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const dir = join(sessionsRoot, project.name, id)
      const size = logBytes(dir)
      if (size) return size
    }
  } catch {
    return 0
  }
  return 0
}

function logBytes(dir) {
  for (const name of SESSION_LOGS) {
    try {
      const st = statSync(join(dir, name))
      if (st.isFile() && st.size > 0) return st.size
    } catch { /* missing */ }
  }
  return 0
}

export function parseMeminfo(text) {
  const get = (key) => {
    const m = String(text || '').match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) * 1024 : 0
  }
  const total = get('MemTotal')
  const avail = get('MemAvailable') || get('MemFree')
  return { total, used: Math.max(0, total - avail), avail }
}

export function readMem() {
  try {
    return parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
  } catch {
    return { total: 0, used: 0, avail: 0 }
  }
}

export function parseDf(text) {
  const line = String(text || '').trim().split('\n').find((row, i) => i > 0 && row.trim())
  if (!line) return { total: 0, used: 0, avail: 0, mount: '?' }
  const parts = line.trim().split(/\s+/)
  return {
    total: Number(parts[1] || 0) * 1024,
    used: Number(parts[2] || 0) * 1024,
    avail: Number(parts[3] || 0) * 1024,
    mount: parts[5] || '/',
  }
}

export function readDisk(path = '/') {
  try {
    return parseDf(execFileSync('df', ['-k', path], { encoding: 'utf8' }))
  } catch {
    return { total: 0, used: 0, avail: 0, mount: path }
  }
}

export function readCpu() {
  const n = Math.max(1, cpus().length)
  const [l1, l5, l15] = loadavg()
  return {
    n,
    l1,
    l5,
    l15,
    pct: Math.round((l1 / n) * 100),
  }
}

export function collectHost() {
  return {
    hostname: hostname(),
    mem: readMem(),
    disk: readDisk('/'),
    cpu: readCpu(),
  }
}

export function measureContext({ meter, session, sessions, sessionId, window }) {
  if (!meter) return null
  try {
    const live = session
      || (sessionId && typeof sessions?.get === 'function'
        ? (sessions.get(sessionId) ?? sessions.get(String(sessionId)))
        : null)
    if (!live) return null
    const m = meter.measure(live)
    const total = m?.totalTokens
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
    const win = Number(window) > 0 ? Number(window) : 1_000_000
    return {
      total,
      window: win,
      pct: Math.max(0, Math.min(100, Math.round((total / win) * 100))),
    }
  } catch (err) {
    process.stderr.write(`[dsh-feishu] status tokenMeter: ${err}\n`)
    return null
  }
}

function pctOf(used, total) {
  if (!total) return 0
  return Math.max(0, Math.round((used / total) * 100))
}

export function formatStatus({ alias, model, hasSession, context, agentStatus, host }) {
  const name = alias || '?'
  const full = model && model !== name ? ` = ${model}` : ''
  const lines = [
    '会话',
    `模型  ${name}${full}`,
  ]
  if (!hasSession) {
    lines.push('上下文  无会话')
  } else if (!context) {
    lines.push('上下文  暂不可测')
  } else {
    lines.push(
      `上下文  ${context.pct}%  ·  ${formatTokensK(context.total)} / ${formatTokensK(context.window)}`,
    )
  }
  if (agentStatus) lines.push(`状态  ${agentStatus}`)

  const h = host || collectHost()
  const mem = h.mem || { total: 0, used: 0 }
  const disk = h.disk || { total: 0, used: 0 }
  const cpu = h.cpu || { n: 1, l1: 0, l5: 0, l15: 0, pct: 0 }
  lines.push(
    '',
    mem.total
      ? `内存  ${formatBytes(mem.used)} / ${formatBytes(mem.total)}  已用 ${pctOf(mem.used, mem.total)}%`
      : '内存  不可读',
    disk.total
      ? `磁盘  ${formatBytes(disk.used)} / ${formatBytes(disk.total)}  已用 ${pctOf(disk.used, disk.total)}%`
      : '磁盘  不可读',
    `CPU   ${cpu.n}核  ·  ${cpu.pct}%`,
  )
  return lines.join('\n')
}
