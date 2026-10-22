import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { approvalCard, lockedCard, waitCard } from './cards.js'

const DENY =
  '高危命令已拦，没执行。点卡片「允许这一次」才会跑。打字同意不算批准。改单个文件 / skill 不用审批。'

const HOME = homedir().replace(/\/+$/, '')

// 点名 skill 目录下的删除不算大范围；profile 私有的 skills 目录也算
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
// 自杀式重启：拿 pkill/kill 打自己的常驻进程。
// 除 dsh / feishu 外，`dsh-<名字>` 这类 profile 常驻进程也算（`pkill -f dsh-<profile>` 能绕过去）。
const KILL_SELF = /\b(?:pkill|killall|kill)\b[\s\S]{0,40}(?:\bdsh\b|\bfeishu\b|\bdsh-[\w-]+\b)/

function stripQuotes(token) {
  return String(token || '').replace(/^['"]|['"]$/g, '')
}

// rm 目标里带未展开的 shell 变量（`$VAR` / `${VAR}` / 反引号）时，值静态看不到。
// 把它当字面路径会在 cwd=家目录时解析成 `~/<变量名>`，误判成「家目录下一层」。
// 例外：`~` / `$HOME` / `${HOME}` 前缀能确定展开，仍走原判定。
const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/
const SHELL_VAR_RE = /\$\(|\$\{|\$[A-Za-z0-9_@*#?$!-]|`/

function isDynamicPath(token) {
  if (HOME_PREFIX_RE.test(token)) return false
  return SHELL_VAR_RE.test(token)
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
  if (isDynamicPath(token)) return false

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

function shellArgs(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i += 1
    if (i >= s.length) break
    const q = s[i]
    if (q === '"' || q === "'") {
      i += 1
      let buf = ''
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && q === '"' && i + 1 < s.length) {
          buf += s[i + 1]
          i += 2
          continue
        }
        buf += s[i]
        i += 1
      }
      if (i < s.length) i += 1
      out.push(buf)
    } else {
      let buf = ''
      while (i < s.length && !/\s/.test(s[i])) {
        buf += s[i]
        i += 1
      }
      out.push(buf)
    }
  }
  return out
}

function isChatKey(token) {
  return /^[\w.-]+::[\w.-]+$/.test(String(token || ''))
}

// bash 跑自己的重启脚本时，缺 appId::chatId 就补当前窗，重启后的回执知道往哪发。
// 脚本名走 DSH_FEISHU_RESTART_SCRIPT（basename 匹配）；没设就完全不碰命令。
export function rewriteRestartCommand(command, chatKey, scriptName = '') {
  if (!chatKey || !isChatKey(chatKey)) return command
  const base = String(scriptName || '').split('/').pop()
  if (!base) return command
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[;&|\\n\`\\s(])(?:bash\\s+)?(?:\\S*/)?${esc}\\b`)
  const found = command.search(re)
  if (found < 0) return command
  const scriptAt = command.indexOf(base, found)
  if (scriptAt < 0) return command
  const after = command.slice(scriptAt + base.length)
  const cut = after.search(/[;&|\n]/)
  const argsPart = cut < 0 ? after : after.slice(0, cut)
  const tail = cut < 0 ? '' : after.slice(cut)
  const args = shellArgs(argsPart)
  if (args.some(isChatKey)) return command
  const quoted = JSON.stringify(chatKey)
  const head = command.slice(0, scriptAt + base.length)
  if (args.length === 0) return `${head} "" ${quoted}${tail}`
  return `${head}${argsPart.replace(/\s+$/, '')} ${quoted}${tail}`
}

export function classifyDanger(name, args) {
  if (name !== 'bash') return null
  const command = String(args?.command || '')
  if (!command.trim()) return null

  if (KILL_SELF.test(command)) return '自杀重启 / 杀本进程'
  if (MKFS.test(command) || DD_DISK.test(command) || SHRED.test(command) || WIPEFS.test(command)) {
    return '磁盘擦除'
  }
  if (DROP_DB.test(command)) return '删库'
  if (FORCE_PUSH.test(command) || GIT_PUSH_DELETE.test(command)) return '破坏性 git push'
  if (GIT_CLEAN_FORCE.test(command) || GIT_RESET_HARD.test(command) || GIT_CHECKOUT_BROAD.test(command) || GIT_RESTORE_BROAD.test(command)) {
    return '破坏性 git 回退'
  }
  if (FIND_DELETE.test(command) || XARGS_RM.test(command)) return '批量删除'
  if (RM_TOKEN.test(command) && rmLooksBroad(command)) return '未点名或大范围 rm'
  return null
}

export function attachGuard(ctx, { routeOf, store } = {}) {
  if (process.env.DSH_FEISHU_GUARD === '0') {
    process.stderr.write('[dsh-feishu] high-risk bash guard off\n')
    return
  }
  const restartScript = process.env.DSH_FEISHU_RESTART_SCRIPT || ''
  ctx.on('tools/pre-execute', async (exec, next) => {
    const route = exec.agent && routeOf ? routeOf(exec.agent.id) : null
    if (exec.name === 'bash' && exec.arguments && route?.appId && route?.chatId && restartScript) {
      const key = `${route.appId}::${route.chatId}`
      const command = String(exec.arguments.command || '')
      const nextCmd = rewriteRestartCommand(command, key, restartScript)
      if (nextCmd !== command) {
        exec.arguments = { ...exec.arguments, command: nextCmd }
        process.stderr.write(`[dsh-feishu] restart continue chatKey=${key}\n`)
      }
    }
    const kind = classifyDanger(exec.name, exec.arguments)
    if (!kind) return next()
    const command = String(exec.arguments?.command || '')
    if (!route?.lark || !route.chatId || !store) {
      process.stderr.write(`[dsh-feishu] guard deny ${kind} (no card route)\n`)
      return { kind: 'deny', reason: `${DENY}（${kind}）` }
    }

    const id = randomUUID()
    const card = approvalCard({ id, kind, command })
    let messageId = ''
    try {
      messageId = await route.lark.sendCard(route.chatId, card)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] guard card failed: ${err}\n`)
      return { kind: 'deny', reason: `${DENY}（${kind}；发卡失败）` }
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
    return { kind: 'deny', reason: `${DENY}（${kind}）` }
  })
  process.stderr.write('[dsh-feishu] high-risk bash guard on (card)\n')
}
