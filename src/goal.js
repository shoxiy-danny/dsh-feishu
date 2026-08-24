import { randomUUID } from 'node:crypto'
import { goalCard, lockedCard } from './cards.js'

const NEAR_REMAINING = 3

const PHASE_ZH = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
}

export const EMPTY_GOAL_HELP = [
  '当前没有进行中的目标。填写后点「设定并开始」。',
  '进程重启或切换会话后不会自动续跑，需要点「恢复自动续跑」。',
  '也可继续使用斜杠命令：`/goal <目标>`，句末可写「最多跑3轮」。',
].join('\n')

const ROUND_PATTERNS = [
  /[，,。.\s]*(?:最多(?:跑|进行)?|不超过|至多)\s*(\d+)\s*轮[。.\s]*/u,
  /[，,。.\s]*(?:--rounds?|-n)\s+(\d+)\s*$/iu,
  /[，,。.\s]*(?:max(?:imum)?(?:\s+goal)?\s*rounds?|(?<!-)\brounds?)\s*[:=]?\s*(\d+)\s*$/iu,
]

export function parseGoalObjective(raw) {
  let text = String(raw || '').trim()
  let maxGoalRounds
  for (const re of ROUND_PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isInteger(n) || n < 1 || n > 256) continue
    maxGoalRounds = n
    text = text.replace(re, '').replace(/[，,。.\s]+$/u, '').trim()
    break
  }
  return { objective: text, maxGoalRounds }
}

export function formatGoalError(text) {
  const raw = String(text || '')
  if (/already/i.test(raw) && /active|paused|blocked/i.test(raw)) {
    return '已有未完成的目标。请先修改当前目标，或清除后再设定新目标。'
  }
  if (/No goal is currently set/i.test(raw) || /requires one/i.test(raw)) {
    return '当前没有目标。请先设定后再操作。'
  }
  if (/replacement objective/i.test(raw) || /invalid-edit|Goal editing requires/i.test(raw)) {
    return '修改目标时必须填写新内容。'
  }
  if (/not valid for the current state/i.test(raw)) {
    return '当前状态不支持该操作。请发送 /goal 查看可执行项。'
  }
  return raw || '目标操作失败'
}

export function formatGoalStatus(goal) {
  if (!goal) return EMPTY_GOAL_HELP
  const phase = PHASE_ZH[goal.phase] || goal.phase
  const armed = goal.activation === 'armed' ? '已武装（会自动续轮）' : '未武装（需恢复自动续跑）'
  const lines = [
    `Goal：${phase}`,
    `目标：${goal.objective}`,
    `轮次：${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `激活：${armed}`,
  ]
  if (goal.phase === 'blocked' && goal.blockedReason) {
    lines.splice(1, 0, `阻塞：${goal.blockedReason.code}: ${goal.blockedReason.message}`)
  }
  lines.push('', `下一步：${hintZh(goal)}`)
  return lines.join('\n')
}

function hintZh(goal) {
  if (goal.phase === 'complete') return '设定新目标，或清除当前目标'
  if (goal.phase === 'active' && goal.activation === 'armed') {
    return '可修改目标、暂停自动续跑，或清除当前目标'
  }
  return '可恢复自动续跑、修改目标，或清除当前目标'
}

export function formatGoalTag(goal) {
  if (!goal || goal.phase === 'complete') return ''
  const rounds = `${goal.roundsStarted}/${goal.maxGoalRounds}`
  const remain = goal.maxGoalRounds - goal.roundsStarted
  const near = goal.phase === 'active' && remain <= NEAR_REMAINING ? ' near' : ''
  if (goal.phase === 'paused') return ` G${rounds} paused`
  if (goal.phase === 'blocked') return ` G${rounds} blocked`
  return ` G${rounds}${near}`
}

export function goalActions(goal) {
  if (!goal) return []
  if (goal.phase === 'complete') {
    return [{ op: 'clear', label: '清除当前目标', type: 'default' }]
  }
  const actions = []
  if (goal.phase === 'active' && goal.activation === 'armed') {
    actions.push({ op: 'pause', label: '暂停自动续跑', type: 'default' })
  } else {
    actions.push({ op: 'resume', label: '恢复自动续跑', type: 'primary' })
  }
  actions.push({ op: 'clear', label: '清除当前目标', type: 'danger' })
  return actions
}

export function goalForm(goal) {
  if (!goal || goal.phase === 'complete') {
    return {
      op: 'create',
      field: 'objective',
      label: '目标',
      placeholder: '描述要完成的事项。句末可写「最多跑3轮」',
      submit: '设定并开始',
    }
  }
  return {
    op: 'edit',
    field: 'objective',
    label: '修改目标',
    placeholder: '填写新的目标内容。句末可写「最多跑3轮」',
    defaultValue: goal.objective,
    submit: '保存修改',
  }
}

export function noticeOfGoalLine(line) {
  const rest = String(line || '').trim().replace(/^\/goal\s*/i, '')
  if (!rest) return undefined
  const control = rest.toLowerCase()
  if (control === 'pause' || control === 'resume' || control === 'clear') return control
  if (/^edit(?=\s)/iu.test(rest)) return 'edit'
  return 'create'
}

export function buildGoalCard(id, goal, notice, { noForm = false, compact = false } = {}) {
  if (compact) {
    return goalCard({
      id,
      title: compactTitle(goal, notice),
      template: goalCardTemplate(goal),
      body: compactBody(goal, notice),
      actions: [],
      form: null,
    })
  }
  return goalCard({
    id,
    title: goalCardTitle(goal, notice),
    template: goalCardTemplate(goal),
    body: goalCardBody(goal, notice, noForm),
    actions: goalActions(goal),
    form: noForm ? null : goalForm(goal),
  })
}

function compactTitle(goal, notice) {
  if (notice === 'create') return '目标已设定'
  if (notice === 'edit') return '目标已保存'
  if (notice === 'complete') return '目标已完成'
  if (!goal) return notice === 'clear' ? '目标已清除' : '当前没有目标'
  if (goal.phase === 'blocked') return '目标已阻塞'
  if (goal.phase === 'paused') return '目标已暂停'
  return '目标进行中'
}

function compactBody(goal, notice) {
  const lead = noticeLine(notice)
  if (!goal) return [lead, EMPTY_GOAL_HELP].filter(Boolean).join('\n\n')
  const rounds = `${goal.roundsStarted}/${goal.maxGoalRounds}`
  return [`**目标** ${goal.objective}`, `轮次 ${rounds}`].join('\n')
}

function goalCardTitle(goal, notice) {
  if (!goal) return notice === 'clear' ? '目标已清除' : '当前没有目标'
  if (notice === 'complete' || goal.phase === 'complete') return '目标已完成'
  if (notice === 'block' || goal.phase === 'blocked') return '目标已阻塞'
  if (goal.phase === 'paused') return '目标已暂停'
  return '目标进行中'
}

function goalCardTemplate(goal) {
  if (!goal) return 'grey'
  if (goal.phase === 'complete') return 'green'
  if (goal.phase === 'blocked') return 'red'
  if (goal.phase === 'paused') return 'yellow'
  if (goal.activation !== 'armed') return 'orange'
  return 'blue'
}

function goalCardBody(goal, notice, noForm = false) {
  const lead = noticeLine(notice)
  if (!goal) return [lead, EMPTY_GOAL_HELP].filter(Boolean).join('\n\n')
  const phase = PHASE_ZH[goal.phase] || goal.phase
  const armed = goal.activation === 'armed'
    ? '已武装，会自动续轮'
    : '未武装，需点「恢复自动续跑」'
  const lines = []
  if (lead) lines.push(lead)
  lines.push(`**目标** ${goal.objective}`)
  if (goal.phase === 'blocked' && goal.blockedReason) {
    lines.push(`**阻塞** ${goal.blockedReason.code}: ${goal.blockedReason.message}`)
  }
  lines.push(`阶段：${phase} · 轮次 ${goal.roundsStarted}/${goal.maxGoalRounds}`)
  lines.push(`激活：${armed}`)
  lines.push('')
  lines.push(noForm ? '要修改或新建目标，重新发送 /goal。' : cardHint(goal))
  return lines.join('\n')
}

function noticeLine(notice) {
  if (notice === 'complete') return '**已完成。**'
  if (notice === 'block') return '**已阻塞。**'
  if (notice === 'pause') return '已暂停自动续跑。'
  if (notice === 'resume') return '已恢复自动续跑。'
  if (notice === 'clear') return '已清除当前目标。'
  if (notice === 'create') return '已设定目标。'
  if (notice === 'edit') return '已保存目标修改。'
  return ''
}

function cardHint(goal) {
  if (!goal || goal.phase === 'complete') {
    return '在下方填写新目标后提交。斜杠命令 `/goal <目标>` 仍然可用。'
  }
  return '在下方修改目标后提交。斜杠命令 `/goal edit <目标>` 仍然可用。'
}

export function createGoalViews() {
  const byToken = new Map()
  const byChat = new Map()

  function keyOf(appId, chatId) {
    return `${appId}::${chatId}`
  }

  function get(token) {
    return byToken.get(String(token || '')) || null
  }

  function current(appId, chatId) {
    const token = byChat.get(keyOf(appId, chatId))
    return token ? byToken.get(token) || null : null
  }

  function put(rec) {
    const key = keyOf(rec.appId, rec.chatId)
    const prevToken = byChat.get(key)
    if (prevToken && prevToken !== rec.id) byToken.delete(prevToken)
    byChat.set(key, rec.id)
    byToken.set(rec.id, rec)
  }

  function forget(appId, chatId) {
    const key = keyOf(appId, chatId)
    const token = byChat.get(key)
    if (!token) return null
    const rec = byToken.get(token) || null
    byChat.delete(key)
    byToken.delete(token)
    return rec
  }

  return { get, current, put, forget }
}

export async function dismissGoal(views, lark, appId, chatId, body) {
  const rec = views?.forget(appId, chatId)
  if (!rec?.messageId || !lark?.editCard) return rec
  void lark.editCard(rec.messageId, lockedCard({
    title: '目标已失效',
    template: 'grey',
    body: body || '会话已清空。',
  })).catch((err) => {
    process.stderr.write(`[dsh-feishu] goal card dismiss failed: ${err}\n`)
  })
  return rec
}

export async function presentGoal({ views, lark, appId, chatId, goal, notice, replace = true, noForm = false, compact = false }) {
  const id = randomUUID()
  const card = buildGoalCard(id, goal, notice, { noForm, compact })
  const prev = views.current(appId, chatId)

  if (replace && prev?.messageId) {
    try {
      const ok = await lark.editCard(prev.messageId, card)
      if (ok) {
        views.put({ id, appId, chatId, messageId: prev.messageId, lark })
        return prev.messageId
      }
    } catch (err) {
      process.stderr.write(`[dsh-feishu] goal card edit failed: ${err}\n`)
    }
  }

  if (prev?.messageId) {
    void lark.editCard(prev.messageId, lockedCard({
      title: '目标已更新',
      template: 'grey',
      body: '请查看下方新卡片。',
    })).catch((err) => {
      process.stderr.write(`[dsh-feishu] goal card lock failed: ${err}\n`)
    })
  }

  try {
    const messageId = await lark.sendCard(chatId, card)
    views.put({ id, appId, chatId, messageId, lark })
    return messageId
  } catch (err) {
    process.stderr.write(`[dsh-feishu] goal card send failed: ${formatLarkErr(err)}\n`)
    if (lark.sendText) {
      await lark.sendText(chatId, fallbackGoalText(goal, notice)).catch(() => {})
    }
    return ''
  }
}

function fallbackGoalText(goal, notice) {
  const lead = noticeLine(notice)
  if (!goal) return [lead, EMPTY_GOAL_HELP].filter(Boolean).join('\n\n')
  return goalCardBody(goal, notice).replace(/\*\*/g, '')
}

function formatLarkErr(err) {
  const data = err?.response?.data
  if (data?.msg) return `${data.code || ''} ${data.msg}`.trim()
  return String(err?.message || err)
}

export function attachGoal(ctx, { routeOf, views }) {
  ctx.on('goal/changed', ({ agent, change }) => {
    const route = routeOf(agent.id)
    if (!route?.chatId || !route.lark) return
    const op = change?.operation
    if (op !== 'complete' && op !== 'block') return
    const goal = change.goal
    if (views && route.appId) {
      void presentGoal({
        views,
        lark: route.lark,
        appId: route.appId,
        chatId: route.chatId,
        goal,
        notice: op === 'block' ? 'block' : 'complete',
        compact: op === 'complete',
      }).catch((err) => {
        process.stderr.write(`[dsh-feishu] goal notify failed: ${err}\n`)
      })
      return
    }
    const rounds = goal ? `${goal.roundsStarted}/${goal.maxGoalRounds}` : '?'
    let text
    if (op === 'complete') {
      text = `Goal 完成（${rounds}）\n${goal?.objective || ''}`.trim()
    } else {
      const reason = goal?.blockedReason
      const detail = reason ? `${reason.code}: ${reason.message}` : ''
      text = `Goal 阻塞（${rounds}）\n${detail}`.trim()
    }
    void route.lark.sendText(route.chatId, text).catch((err) => {
      process.stderr.write(`[dsh-feishu] goal notify failed: ${err}\n`)
    })
  })
}
