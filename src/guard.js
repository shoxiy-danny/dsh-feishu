import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { approvalCard, lockedCard, waitCard } from './cards.js'

const DENY =
  'Blocked a high-risk command. Tap Allow once on the Feishu card. Typing yes does not approve. Single-file and skill edits are fine.'

const HOME = homedir().replace(/\/+$/, '')

const SKILL_RE = /(?:^|\/)\.claude\/skills(?:\/|$)|(?:^|\/)\.dsh\/skills(?:\/|$)/
const GIT_DIR_RE = /(?:^|\/)\.git(?:\/|$)/

const RM_TOKEN = /(?:^|[;&|\n`\s(])(?:sudo\s+)*(?:\/bin\/)?rm(?:\s|$)/
const FIND_DELETE = /\bfind\b[\s\S]{0,240}\s-(?:delete|exec)\b/
const XARGS_RM = /\bxargs\b[\s\S]{0,80}\brm\b/
const GIT_CLEAN_FORCE = /\bgit\s+clean\b[\s\S]{0,40}(?:-[a-zA-Z]*f|-f)/
const GIT_RESET_HARD = /\bgit\s+reset\s+(?:--hard|--merge|--keep)\b/
const GIT_CHECKOUT_BROAD = /\bgit\s+checkout\s+(?:--\s+)?(?:\.|:\S)/
const GIT_RESTORE_BROAD = /\bgit\s+restore\b[\s\S]{0,60}(?:\s\.|\s--worktree|\s--source|\s\*)/
const MKFS = /\bmkfs(?:\.\w+)?\b/
const DD_DISK = /\bdd\b[\s\S]{0,80}\bof=\/dev\//
const SHRED = /\bshred\b/
const WIPEFS = /\bwipefs\b/
const DROP_DB = /\b(?:drop\s+database|drop\s+schema|truncate\s+table)\b/i
const FORCE_PUSH = /\bgit\s+push\b[\s\S]{0,60}(?:--force|--force-with-lease|-f)\b/
const GIT_PUSH_DELETE = /\bgit\s+push\b[\s\S]{0,40}--delete\b/
const KILL_SELF = /\b(?:pkill|killall|kill)\b[\s\S]{0,40}(?:\bdsh\b|\bfeishu\b)/

function stripQuotes(token) {
  return String(token || '').replace(/^['"]|['"]$/g, '')
}

function expandHome(path) {
  if (path === '~' || path === '$HOME' || path === '${HOME}') return HOME
  if (path.startsWith('~/')) return HOME + path.slice(1)
  if (path.startsWith('$HOME/')) return HOME + path.slice(5)
  if (path.startsWith('${HOME}/')) return HOME + path.slice(7)
  return path
}

function normalize(path) {
  const expanded = expandHome(stripQuotes(path)).replace(/\/+$/, '') || '/'
  return expanded.replace(/\/{2,}/g, '/')
}

export function isDangerousRemovalPath(rawPath, cwd = HOME) {
  const token = stripQuotes(rawPath)
  if (!token) return true
  if (token === '*' || token.endsWith('/*') || token.endsWith('/*/') || token === './*') return true
  if (token === '.' || token === '..') return true

  const expanded = expandHome(token)
  const absolute = isAbsolute(expanded) || expanded.startsWith('/')
    ? normalize(expanded)
    : normalize(resolve(cwd, expanded))

  if (absolute === '/' || absolute === HOME) return true
  if (dirname(absolute) === '/') return true
  if (dirname(absolute) === HOME) return true
  if (GIT_DIR_RE.test(absolute + '/')) return true
  return false
}

function tokensAfterRm(command) {
  const match = command.match(/(?:^|[;&|\n`\s(])(?:sudo\s+)*(?:\/bin\/)?rm(?=\s|$)/)
  if (!match || match.index == null) return []
  const rest = command.slice(match.index + match[0].length)
  const cut = rest.search(/[;&|\n]/)
  const args = (cut < 0 ? rest : rest.slice(0, cut)).trim()
  const out = []
  let seenEnd = false
  for (const token of args.split(/\s+/).filter(Boolean)) {
    if (!seenEnd && token === '--') {
      seenEnd = true
      continue
    }
    if (!seenEnd && token.startsWith('-') && token !== '-' && token !== '--') continue
    out.push(token)
  }
  return out
}

function rmLooksBroad(command) {
  const paths = tokensAfterRm(command)
  if (paths.length === 0) return true
  if (paths.every((path) => SKILL_RE.test(normalize(path)))) return false
  return paths.some((path) => isDangerousRemovalPath(path))
}

export function classifyDanger(name, args) {
  if (name !== 'bash') return null
  const command = String(args?.command || '')
  if (!command.trim()) return null

  if (KILL_SELF.test(command)) return 'kill dsh process'
  if (MKFS.test(command) || DD_DISK.test(command) || SHRED.test(command) || WIPEFS.test(command)) {
    return 'disk wipe'
  }
  if (DROP_DB.test(command)) return 'drop database'
  if (FORCE_PUSH.test(command) || GIT_PUSH_DELETE.test(command)) return 'destructive git push'
  if (GIT_CLEAN_FORCE.test(command) || GIT_RESET_HARD.test(command) || GIT_CHECKOUT_BROAD.test(command) || GIT_RESTORE_BROAD.test(command)) {
    return 'destructive git rewind'
  }
  if (FIND_DELETE.test(command) || XARGS_RM.test(command)) return 'bulk delete'
  if (RM_TOKEN.test(command) && rmLooksBroad(command)) return 'unnamed or broad rm'
  return null
}

export function attachGuard(ctx, { routeOf, store } = {}) {
  if (process.env.DSH_FEISHU_GUARD === '0') {
    process.stderr.write('[dsh-feishu] high-risk bash guard off\n')
    return
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    const kind = classifyDanger(exec.name, exec.arguments)
    if (!kind) return next()
    const command = String(exec.arguments?.command || '')
    const route = exec.agent && routeOf ? routeOf(exec.agent.id) : null
    if (!route?.lark || !route.chatId || !store) {
      process.stderr.write(`[dsh-feishu] guard deny ${kind} (no card route)\n`)
      return { kind: 'deny', reason: `${DENY} (${kind})` }
    }

    const id = randomUUID()
    const card = approvalCard({ id, kind, command })
    let messageId = ''
    try {
      messageId = await route.lark.sendCard(route.chatId, card)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] guard card failed: ${err}\n`)
      return { kind: 'deny', reason: `${DENY} (${kind}; card failed)` }
    }

    process.stderr.write(`[dsh-feishu] guard wait ${kind} token=${id}\n`)
    const rec = {
      id,
      kind: 'guard',
      appId: route.appId,
      chatId: route.chatId,
      messageId,
      lark: route.lark,
    }
    const onAbort = () => store.settle(id, { abort: true })
    exec.signal?.addEventListener('abort', onAbort, { once: true })
    let result
    try {
      result = await waitCard(store, rec)
    } finally {
      exec.signal?.removeEventListener('abort', onAbort)
    }

    if (result?.verdict === 'allow') {
      void route.lark.editCard(messageId, lockedCard({
        title: '已允许这一次',
        template: 'green',
        body: `原因：\`${kind}\`\n\`\`\`bash\n${command}\n\`\`\``,
      }))
      process.stderr.write(`[dsh-feishu] guard allow ${kind}\n`)
      return next()
    }

    const title = result?.timeout ? '审核已过期' : result?.abort ? '审核已取消' : '已拒绝'
    void route.lark.editCard(messageId, lockedCard({
      title,
      template: 'grey',
      body: `原因：\`${kind}\`\n\`\`\`bash\n${command}\n\`\`\``,
    }))
    process.stderr.write(`[dsh-feishu] guard deny ${kind} ${title}\n`)
    return { kind: 'deny', reason: `${DENY} (${kind})` }
  })
  process.stderr.write('[dsh-feishu] high-risk bash guard on (card)\n')
}
