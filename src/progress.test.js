// 进度卡 = 老编辑块逻辑：一张卡 sendCard 建成，之后 editCard 原地改。
// 唯一区别是块里装的是折叠面板：标题还是老那一行 `[dsf-6%] Bash...(5)`，
// thinking 和每个工具各占面板里的一行，状态变了只改自己那行。
// 正文不参与这张卡，照旧单独发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachProgress } from './progress.js'

function makeCtx(overrides = {}) {
  const handlers = new Map()
  return {
    on(name, fn) {
      handlers.set(name, fn)
    },
    get(name) {
      if (overrides[name] !== undefined) return overrides[name]
      return null
    },
    emit(name, ...args) {
      return handlers.get(name)(...args)
    },
  }
}

// 防抖窗口：连发的更新会攒到窗口末尾补一版，等这么久就能看到最终卡面
const TICK = 350
const sleep = (ms = TICK) => new Promise((r) => setTimeout(r, ms))

function makeLark() {
  const sends = []
  const writes = []
  const texts = []
  const finals = []
  let seq = 0
  return {
    sends,
    writes,
    texts,
    finals,
    gate: null,
    release() {
      const g = this.gate
      this.gate = null
      if (g) g.resolve()
    },
    // 和 lark.js 的 progressCard 同构：折叠面板一行一条记录
    progressCard({ title = '', text = '', lines = [], status = '', suffix = '', label = '' } = {}) {
      const elements = []
      if (text) elements.push({ tag: 'markdown', content: text })
      if (lines.length > 0) {
        elements.push({
          tag: 'collapsible_panel',
          expanded: true,
          header: {
            title: {
              tag: 'markdown',
              content: `**${[label || `Done (${lines.length})`, suffix].filter(Boolean).join(' · ')}**`,
            },
          },
          elements: lines.map((line) => ({ tag: 'markdown', content: line })),
        })
      }
      if (status) elements.push({ tag: 'markdown', content: status })
      const card = { schema: '2.0', body: { elements } }
      if (title) card.header = { title: { tag: 'plain_text', content: title } }
      return card
    },
    async sendCard(_chatId, card) {
      const id = `card-${++seq}`
      sends.push({ id, card })
      writes.push({ id, card })
      if (this.gate) await this.gate.promise
      return id
    },
    async editCard(msgId, card) {
      writes.push({ id: msgId, card })
      return true
    },
    async sendText(_chatId, text) {
      texts.push(text)
      return 'm1'
    },
    async sendFinal(_chatId, text, alias) {
      finals.push({ text, alias })
      return 'm2'
    },
  }
}

function panelOf(card) {
  for (const el of card?.body?.elements || []) {
    if (el.tag === 'collapsible_panel') return el
  }
  return null
}

function panelTitle(card) {
  return String(panelOf(card)?.header?.title?.content || '').replace(/\*\*/g, '')
}

function panelLines(card) {
  return (panelOf(card)?.elements || []).map((el) => el.content)
}

// 某张卡（按 msgId）最后落成的样子
function cardState(lark, id) {
  return lark.writes.filter((w) => w.id === id).at(-1)?.card
}

function latestCard(lark) {
  return lark.writes.at(-1)?.card
}

// sendCard 发的都是普通卡（进度卡 / 正文卡），没有 CardKit 流式卡了
const progressSends = (lark) => lark.sends

const GLM = { provider: 'deepseek-official', model: 'deepseek-flash' }

function wire(ctx, lark, overrides = {}) {
  return attachProgress(ctx, {
    routeOf: () => ({ chatId: 'c1', chatKey: 'app::c1', lark }),
    modelOf: () => GLM,
    windowOf: () => 1_000_000,
    goalOf: () => null,
    ...overrides,
  })
}

function assistantEvent(content) {
  return { type: 'assistant/message', data: { message: { content } } }
}

function userEvent(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

function toolCallEvent(callId, name, args = {}) {
  return { type: 'tool/call', data: { callId, name, arguments: args } }
}

function toolResultEvent(callId, text = 'ok') {
  return {
    type: 'tool/result',
    data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } },
  }
}

function reasoningFrame(text = '想一下') {
  return {
    agent: { id: 's1' },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text } },
  }
}

const running = (id = 's1') => ['agent/status', { agent: { id, status: 'running' }, status: 'running' }]
const idle = (id = 's1') => ['agent/status', { agent: { id, status: 'idle' }, status: 'idle' }]
const turnEnd = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } })
const textChunk = (text) => ({
  agent: { id: 's1' },
  frame: { type: 'chunk', chunk: { type: 'text', text } },
})

// 一步的正文：assistant/message 带着这一步的 text 块。
// 期间还能收到流 chunk，那是兜底路径，单测里单独喂。
function say(ctx, text) {
  send(ctx, assistantEvent([{ type: 'text', text }]))
}

function send(ctx, event) {
  ctx.emit('session/event', { header: { id: 's1' } }, event)
}

// ── 正文：和工具卡完全分开 ──────────────────────────────────────────────

test('assistant text without tool-call goes to sendFinal with model alias', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)
  say(ctx, '评估完了：可行。')
  send(ctx, turnEnd())
  await sleep(80)
  assert.equal(lark.finals.length, 1)
  assert.equal(lark.finals[0].text, '评估完了：可行。')
  assert.equal(lark.finals[0].alias, 'dsf')
  assert.equal(lark.texts.length, 0)
  assert.equal(lark.sends.length, 0, '正文不走卡')
})

test('prose with a tool-call goes out as a plain card once the step ends', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(60)
  send(ctx, assistantEvent([{ type: 'text', text: '先看一下文件。' }, { type: 'tool-call', name: 'read' }]))
  await sleep(60)

  assert.equal(lark.texts.length, 1, '过程正文要发一条普通卡')
  assert.equal(lark.texts[0], '先看一下文件。')
  assert.equal(lark.finals.length, 0, '过程正文不该走终局卡')
  assert.equal(lark.sends.length, 1, '正文不另起卡')
})
test('whitespace-only text is skipped in both branches', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)
  say(ctx, '\n  \n')
  send(ctx, turnEnd())
  await sleep(20)
  assert.equal(lark.texts.length, 0)
  assert.equal(lark.finals.length, 0)
})

// ── 一张卡：工具调用全靠 editCard 追加，不新开卡 ─────────────────────────

test('a tool call opens one progress card with a folding panel', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/tmp/notes/x.md' }))
  await sleep(20)

  assert.equal(lark.sends.length, 1, '一次工具调用只该建一张卡')
  assert.equal(panelTitle(latestCard(lark)), '[dsf] Read...(1)')
  const lines = panelLines(latestCard(lark))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /Running · Read · tmp\/notes\/x\.md/)
})

test('every later tool folds into the same card instead of opening another', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/tmp/notes/a.md' }))
  await sleep(20)
  send(ctx, toolCallEvent('t2', 'bash', { command: 'ls -la' }))
  send(ctx, toolCallEvent('t3', 'grep', { pattern: 'foo', path: '/tmp/notes/b' }))
  await sleep()

  assert.equal(lark.sends.length, 1, '整轮只该有一张进度卡')
  const card = latestCard(lark)
  assert.equal(panelLines(card).length, 3)
  assert.match(panelTitle(card), /Grep \+2\.\.\.\(3\)$/, '三个工具都在跑时要报并发数')
})

test('a finished tool turns its own row green and the heading reports Done', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/tmp/notes/x.md' }))
  await sleep(20)
  send(ctx, toolResultEvent('t1', 'file body'))
  await sleep(20)

  const card = latestCard(lark)
  assert.equal(panelTitle(card), '[dsf] Done (1)')
  assert.match(panelLines(card)[0], /Completed · Read · tmp\/notes\/x\.md/)
})

test('thinking is a row inside the same panel and is settled by the first tool', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  ctx.emit(...running())
  await sleep(20)
  assert.equal(panelTitle(latestCard(lark)), '[dsf] Thinking...(1)')
  assert.match(panelLines(latestCard(lark))[0], /Running · Thinking/)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'git status' }))
  await sleep()

  assert.equal(lark.sends.length, 1, 'thinking 和工具共用同一张卡')
  const card = latestCard(lark)
  assert.equal(panelLines(card).length, 2)
  assert.match(panelLines(card)[0], /Completed · Thinking/, '工具一来思考就该收掉')
  assert.match(panelLines(card)[1], /Running · Bash · git status/)
  assert.match(panelTitle(card), /Bash\.\.\.\(2\)$/)
})

test('reasoning frames do not stack up rows within the same step', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  ctx.emit('agent/assistant-stream', reasoningFrame('第一段'))
  ctx.emit('agent/assistant-stream', reasoningFrame('第二段'))
  ctx.emit('agent/assistant-stream', reasoningFrame('第三段'))
  await sleep()

  assert.equal(panelLines(latestCard(lark)).length, 1, '同一步的 reasoning 只留一行')
})

test('a tool repeated with the same callId does not add a second row', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep()

  assert.equal(panelLines(latestCard(lark)).length, 1)
})

// ── 状态变更只改原来那行，不管那张卡走到哪了 ─────────────────────────────

test('a late tool result updates the row on the card that already closed', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'make' }))
  await sleep(20)
  const firstId = lark.sends[0].id
  // 正文把它收尾了
  send(ctx, assistantEvent([{ type: 'text', text: '编译中。' }, { type: 'tool-call', name: 'bash' }]))
  send(ctx, assistantEvent([{ type: 'text', text: '好了。' }]))
  await sleep(20)
  assert.equal(lark.sends.length, 1)

  // 结果现在才回来：必须改那张已收尾的卡，不许新建一条记录
  send(ctx, toolResultEvent('t1'))
  await sleep(20)

  assert.equal(lark.sends.length, 1, '晚到的结果不该再开卡')
  const card = cardState(lark, firstId)
  assert.equal(panelLines(card).length, 1, '同一行不能被追加成两条')
  assert.match(panelLines(card)[0], /Completed · Bash · make/)
  assert.match(panelTitle(card), /Done \(1\)$/)
})

test('a tool result with no matching call does not invent a row', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  send(ctx, toolResultEvent('t-unknown'))
  await sleep(20)

  const card = latestCard(lark)
  assert.equal(panelLines(card).length, 1)
  assert.match(panelTitle(card), /Read\.\.\.\(1\)$/, '乱序结果不该把行收掉')
})

test('a leftover Running row is settled when the turn ends', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  // idle 每步都会来，不能拿它收卡
  ctx.emit(...idle())
  await sleep(20)
  assert.match(panelTitle(latestCard(lark)), /Read\.\.\./, 'idle 不该把卡收掉')

  send(ctx, turnEnd())
  await sleep(30)
  const card = latestCard(lark)
  assert.match(panelLines(card)[0], /Completed · Read/)
  assert.equal(panelTitle(card), '[dsf] Done (1)')
})
test('a failed tool gets a red dot and a Failed heading when everything inside failed', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'cat nope' }))
  await sleep(20)
  send(ctx, toolResultEvent('t1', 'cat: nope: No such file\n[exit code: 1]'))
  await sleep(20)

  const card = latestCard(lark)
  assert.match(panelLines(card)[0], /<font color='red'>/)
  assert.match(panelLines(card)[0], /Failed · Bash/)
  assert.equal(panelTitle(card), '[dsf] Done (1)')
})

test('exit code zero stays successful', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'true' }))
  await sleep(20)
  send(ctx, toolResultEvent('t1', 'done\n[exit code: 0]'))
  await sleep(20)

  assert.match(panelLines(latestCard(lark))[0], /<font color='green'>/)
})

// ── 收尾：正文独立发，卡定格 ────────────────────────────────────────────

test('the final prose closes the card and leaves the tool rows in place', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  send(ctx, toolResultEvent('t1'))
  await sleep(20)
  say(ctx, '看完了。')
  send(ctx, turnEnd())
  await sleep(80)

  assert.equal(lark.texts.length, 0, '终局正文不该走过程文本')
  assert.equal(lark.finals.length, 1)
  assert.equal(lark.finals[0].text, '看完了。')
  assert.equal(lark.finals[0].alias, 'dsf')
  assert.equal(lark.sends.length, 1, '工具只该有一张进度卡')
  const card = cardState(lark, lark.sends[0].id)
  assert.equal(panelTitle(card), '[dsf] Done (1)')
  assert.match(panelLines(card)[0], /Completed · Read · a$/)
  // 卡上只有折叠面板，没有正文
  assert.equal(card.body.elements.length, 1)
  assert.equal(card.body.elements[0].tag, 'collapsible_panel')
})
test('a new turn starts a fresh card instead of counting the previous one', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  say(ctx, '第一轮完。')
  send(ctx, turnEnd())
  await sleep(30)

  send(ctx, userEvent('再来'))
  send(ctx, toolCallEvent('t2', 'bash', { command: 'date' }))
  await sleep(20)

  assert.equal(progressSends(lark).length, 2, '新一轮另起一张进度卡')
  assert.equal(panelTitle(progressSends(lark)[1].card), '[dsf] Bash...(1)')
})
// ── 上限与标题计数 ────────────────────────────────────────────────────

test('the panel keeps the newest rows but the heading reports the real total', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  for (let i = 0; i < 30; i += 1) {
    send(ctx, toolCallEvent(`t${i}`, 'read', { file_path: `/f${i}` }))
  }
  await sleep()

  const card = latestCard(lark)
  assert.equal(panelLines(card).length, 24, '面板只留最新 24 行')
  assert.match(panelLines(card).at(-1), /Read · f29$/)
  assert.match(panelTitle(card), /\.\.\.\(30\)$/, '标题必须报真实条数')
})

test('the heading prefix carries the context percent and the goal round', async () => {
  const ctx = makeCtx({
    tokenMeter: { measure: () => ({ totalTokens: 420_000 }) },
    sessions: { get: () => ({}) },
  })
  const lark = makeLark()
  wire(ctx, lark, {
    goalOf: () => ({ phase: 'active', roundsStarted: 1, maxGoalRounds: 10 }),
  })

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)

  assert.equal(panelTitle(latestCard(lark)), '[dsf-42% G1/10] Read...(1)')
})

// ── pending 竞态：卡还在路上 ──────────────────────────────────────────

test('rows that arrive while the card is still being sent are painted once it lands', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  let resolve
  lark.gate = { promise: new Promise((r) => { resolve = r }), resolve: () => resolve() }
  send(ctx, toolCallEvent('t1', 'bash', { command: 'ls' }))
  await sleep(20)
  send(ctx, toolCallEvent('t2', 'read', { file_path: '/a' }))
  await sleep(20)

  lark.release()
  await sleep(60)

  assert.equal(lark.sends.length, 1)
  const card = latestCard(lark)
  assert.equal(panelLines(card).length, 2, '落地后要把建卡期间攒的行补上')
  assert.match(panelTitle(card), /\.\.\.\(2\)$/)
})

test('a card that lands after the turn ended is settled, not left on Running', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  let resolve
  lark.gate = { promise: new Promise((r) => { resolve = r }), resolve: () => resolve() }
  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  say(ctx, '好。')
  send(ctx, turnEnd())
  await sleep(20)

  lark.release()
  await sleep(120)

  const card = cardState(lark, progressSends(lark)[0].id)
  assert.equal(panelTitle(card), '[dsf] Done (1)')
  assert.match(panelLines(card)[0], /Completed · Read/)
})
// ── 长任务提醒 ────────────────────────────────────────────────────────

function makeBuzzLark() {
  const buzzes = []
  return {
    buzzes,
    progressCard() {
      return { schema: '2.0', body: { elements: [] } }
    },
    async sendCard() {
      return 'card'
    },
    async editCard() {
      return true
    },
    async sendText() {
      return 'm1'
    },
    async sendFinal() {
      return 'm2'
    },
    async buzz(_chatId, openId, text) {
      buzzes.push({ openId, text })
      return { ok: true }
    },
  }
}

function attachWithBuzz(ctx, lark, senderOf = () => 'ou_user') {
  wire(ctx, lark, { senderOf })
}

test('long turn (>=5min) buzzes once on idle', () => {
  const ctx = makeCtx()
  const lark = makeBuzzLark()
  attachWithBuzz(ctx, lark)
  send(ctx, userEvent('帮我跑个长任务'))
  assert.equal(lark.buzzes.length, 0, '不该在开始时就响')
  const realNow = Date.now
  Date.now = () => realNow() + 6 * 60_000
  try {
    ctx.emit(...idle())
  } finally {
    Date.now = realNow
  }
  assert.equal(lark.buzzes.length, 1)
  assert.equal(lark.buzzes[0].openId, 'ou_user')
  assert.match(lark.buzzes[0].text, /6 分钟/)
})

test('short turn does not buzz', () => {
  const ctx = makeCtx()
  const lark = makeBuzzLark()
  attachWithBuzz(ctx, lark)
  send(ctx, userEvent('短任务'))
  ctx.emit(...idle())
  assert.equal(lark.buzzes.length, 0)
})

test('auto (non-human) turns are excluded from long-task timing', () => {
  const ctx = makeCtx()
  const lark = makeBuzzLark()
  attachWithBuzz(ctx, lark)
  send(ctx, userEvent('Current runtime context. snapshot'))
  ctx.emit(...idle())
  assert.equal(lark.buzzes.length, 0)
})

test('missing sender open_id skips long-task buzz silently', () => {
  const ctx = makeCtx()
  const lark = makeBuzzLark()
  attachWithBuzz(ctx, lark, () => '')
  send(ctx, userEvent('任务'))
  ctx.emit(...idle())
  assert.equal(lark.buzzes.length, 0)
})

test('an errored turn closes the card as Failed and says why', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'sleep 9' }))
  await sleep(20)
  send(ctx, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'too long' } } } })
  ctx.emit(...idle())
  await sleep(30)

  assert.equal(panelTitle(latestCard(lark)), '[dsf] Failed (1)')
  assert.equal(lark.texts.at(-1), '失败：TIMEOUT: too long')
})

// ── 正文主通道：assistant/message 的 text 块 ─────────────────────────────

test('prose in the assistant message goes out as text while tools keep running', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'ls' }))
  await sleep(20)
  send(ctx, assistantEvent([{ type: 'text', text: '看一眼。' }, { type: 'tool-call', name: 'read' }]))
  await sleep(20)

  assert.equal(lark.texts.length, 1, '过程正文必须作为文本消息发出去')
  assert.equal(lark.texts[0], '看一眼。')
  assert.equal(lark.finals.length, 0)
  assert.equal(lark.sends.length, 1, '正文不该另起一张卡')
})

test('the assistant message without a tool-call is the final reply and closes the card', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'read', { file_path: '/a' }))
  await sleep(20)
  send(ctx, assistantEvent([{ type: 'text', text: '看完了。' }]))
  await sleep(20)

  assert.equal(lark.finals.length, 1)
  assert.equal(lark.finals[0].text, '看完了。')
  assert.equal(lark.texts.length, 0)
  assert.equal(lark.sends.length, 1)
  assert.equal(panelTitle(latestCard(lark)), '[dsf] Done (1)')
})

test('a chunk-only step still reaches the user once', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  // 消息体没带 text 块，只有流 chunk：靠攒下来的那份兜底
  ctx.emit('agent/assistant-stream', textChunk('同一句话。'))
  send(ctx, assistantEvent([{ type: 'tool-call', name: 'bash' }]))
  await sleep(80)

  assert.equal(lark.texts.length, 1)
  assert.equal(lark.texts[0], '同一句话。')
  assert.equal(lark.finals.length, 0)
})
test('text is not sent twice when both the chunk and the message carry it', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  ctx.emit('agent/assistant-stream', textChunk('同一句话。'))
  send(ctx, assistantEvent([{ type: 'text', text: '同一句话。' }, { type: 'tool-call', name: 'bash' }]))
  await sleep(80)

  assert.equal(lark.texts.length, 1, '消息体里的正文优先，chunk 那份不能重复发')
  assert.equal(lark.texts[0], '同一句话。')
  assert.equal(lark.finals.length, 0)
  assert.equal(lark.sends.length, 0, '正文不另起卡')
})

// ── 卡被正文压下去之后要跟着正文往下走 ─────────────────────────────────

test('a card pushed up by prose is closed and a fresh one takes over below it', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'ls' }))
  await sleep(20)
  const first = lark.sends[0].id
  assert.equal(panelTitle(cardState(lark, first)), '[dsf] Bash...(1)')

  // 过程正文发出来，卡就被压到上面去了
  send(ctx, assistantEvent([{ type: 'text', text: '第一步完了。' }, { type: 'tool-call', name: 'read' }]))
  await sleep(20)
  assert.equal(lark.texts.length, 1)

  // 下一批记录必须换新卡，接在正文下面
  send(ctx, toolCallEvent('t2', 'read', { file_path: '/b' }))
  await sleep()

  assert.equal(lark.sends.length, 2, '正文之后要换一张卡，卡才在最新位置')
  assert.equal(panelTitle(cardState(lark, first)), '[dsf] Done (1)', '旧卡定格')
  assert.equal(panelLines(cardState(lark, first)).length, 1, '旧卡只留自己那段的行')

  const second = lark.sends[1].id
  assert.equal(panelLines(cardState(lark, second)).length, 1, '新卡不能把旧行再抄一遍')
  assert.match(panelLines(cardState(lark, second))[0], /Read · b$/)
})

test('a late result after migration still finds its row on the old card', async () => {
  const ctx = makeCtx()
  const lark = makeLark()
  wire(ctx, lark)

  send(ctx, toolCallEvent('t1', 'bash', { command: 'make' }))
  await sleep(20)
  const first = lark.sends[0].id
  send(ctx, assistantEvent([{ type: 'text', text: '编译一下。' }, { type: 'tool-call', name: 'bash' }]))
  await sleep(20)
  send(ctx, toolCallEvent('t2', 'read', { file_path: '/b' }))
  await sleep()
  assert.equal(lark.sends.length, 2)

  // 第一个工具的结果现在才回来：要改第一张卡，不许在新卡上追一条
  send(ctx, toolResultEvent('t1'))
  await sleep(30)

  assert.equal(lark.sends.length, 2, '不该再开卡')
  assert.match(panelLines(cardState(lark, first))[0], /Completed · Bash · make/)
  assert.equal(panelLines(cardState(lark, first)).length, 1, '同一行不能被追加')
})
