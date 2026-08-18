const NEAR_REMAINING = 3

const PHASE_ZH = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
}

export const EMPTY_GOAL_HELP = [
  '当前没有 Goal。',
  '',
  '设一个目标后，我会自己多轮推进，直到完成、阻塞或轮次用尽。',
  '进程重启 / 切会话后不会自动续跑，要显式 /goal resume。',
  '',
  '用法：',
  '/goal <目标>        设定并开始推进；可在句末写「最多跑3轮」',
  '/goal               查看当前状态',
  '/goal edit <目标>   改目标，不换阶段',
  '/goal pause         暂停自动续跑',
  '/goal resume        续跑（停过 / 重启后）',
  '/goal clear         清掉当前 Goal',
  '',
  '例子：',
  '/goal 在当前目录补一份 README 安装步骤，最多跑3轮',
  '/goal 把这个目录的测试补上，写完对照仓库核实',
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
    return '已经有未完成的 Goal。改目标用 /goal edit <目标>，换新的先 /goal clear。'
  }
  if (/No goal is currently set/i.test(raw) || /requires one/i.test(raw)) {
    return '当前没有 Goal。先 /goal <目标> 设定。'
  }
  if (/replacement objective/i.test(raw) || /invalid-edit|Goal editing requires/i.test(raw)) {
    return '改目标要带新内容。例：/goal edit 把 README 补上安装步骤'
  }
  if (/not valid for the current state/i.test(raw)) {
    return '这个操作对当前状态无效。发 /goal 看能做什么。'
  }
  return raw || 'Goal 命令失败'
}

export function formatGoalStatus(goal) {
  if (!goal) return EMPTY_GOAL_HELP
  const phase = PHASE_ZH[goal.phase] || goal.phase
  const armed = goal.activation === 'armed' ? '已武装（会自动续轮）' : '未武装（要 /goal resume 才续跑）'
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
  if (goal.phase === 'complete') return '/goal <新目标> 或 /goal clear'
  if (goal.phase === 'active' && goal.activation === 'armed') {
    return '/goal edit <目标>  /  /goal pause  /  /goal clear'
  }
  return '/goal resume  /  /goal edit <目标>  /  /goal clear'
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

export function attachGoal(ctx, { routeOf }) {
  ctx.on('goal/changed', ({ agent, change }) => {
    const route = routeOf(agent.id)
    if (!route?.chatId || !route.lark) return
    const op = change?.operation
    if (op !== 'complete' && op !== 'block') return
    const goal = change.goal
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
