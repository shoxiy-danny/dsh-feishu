import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { escapePrompt } from './memory.js'

const NAMES = ['CLAUDE.md', 'AGENTS.md']
const MAX_BYTES = 32_768

function sessionIdOf(session) {
  return String(session?.header?.id || session?.id || '')
}

function filePathOf(event) {
  const name = event?.data?.name
  if (name !== 'read' && name !== 'write' && name !== 'edit') return null
  let args = event.data.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  const path = args?.file_path || args?.path
  if (typeof path !== 'string' || !path.trim()) return null
  return path.trim()
}

function excluded(abs, excludes) {
  return excludes.some((item) => item && abs.includes(item))
}

function walkHeaders(filePath, excludes) {
  const start = dirname(isAbsolute(filePath) ? filePath : resolve(filePath))
  const found = []
  const seen = new Set()
  let dir = start
  for (;;) {
    for (const name of NAMES) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      let abs
      try { abs = realpathSync(candidate) } catch { continue }
      if (seen.has(abs) || excluded(abs, excludes)) continue
      seen.add(abs)
      found.push(abs)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function readHeader(abs) {
  try {
    const buf = readFileSync(abs)
    if (buf.length > MAX_BYTES) return `${abs} (skipped, over ${MAX_BYTES} bytes)`
    return `### ${abs}\n\n${escapePrompt(buf.toString('utf8').trim())}`
  } catch (err) {
    return `### ${abs}\n\n(read failed: ${err.message})`
  }
}

export function attachHeaders(ctx, settings) {
  if (!settings.projectClaudeMd) {
    process.stderr.write('[dsh-feishu] project CLAUDE.md off\n')
    return
  }

  const prompt = ctx.get('systemPrompt')
  if (!prompt) return

  const bySession = new Map()

  prompt.context({
    name: 'feishu:headers',
    order: 50,
    text: (assemble) => {
      const id = String(assemble?.agent?.id || assemble?.agent?.session?.header?.id || '')
      const files = id ? bySession.get(id) : null
      if (!files || files.size === 0) return ''
      return [
        'CLAUDE.md / AGENTS.md found on paths opened in this session (deduped, mutable).',
        ...[...files].map(readHeader),
      ].join('\n\n')
    },
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'tool/call') return
    const path = filePathOf(event)
    if (!path) return
    const sid = sessionIdOf(session)
    if (!sid) return
    let set = bySession.get(sid)
    if (!set) {
      set = new Set()
      bySession.set(sid, set)
    }
    for (const abs of walkHeaders(path, settings.claudeMdExcludes)) {
      if (set.has(abs)) continue
      set.add(abs)
      process.stderr.write(`[dsh-feishu] header ${sid} + ${abs}\n`)
    }
  })

  process.stderr.write('[dsh-feishu] project CLAUDE.md on; path-walk CLAUDE.md/AGENTS.md\n')
}
