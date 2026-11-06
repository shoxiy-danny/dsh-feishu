import { formatGoalTag } from './goal.js'
import { aliasMap, loadModels } from './models.js'

const DEBOUNCE_MS = 300

// 折叠面板一行一条记录，超出就把最早的挤掉，避免卡片无限长。
// 标题里的总数报真实条数，不受这个上限影响。
const MAX_PANEL_LINES = 24

// 硬计时提醒：一轮任务跑满这么久，结束时不经过模型判断，直接加急提醒。
// 设 0 可关闭。
const LONG_TASK_BUZZ_MS_DEFAULT = 5 * 60_000

function longTaskBuzzMs() {
  return Number(process.env.DSH_FEISHU_LONG_BUZZ_MS ?? LONG_TASK_BUZZ_MS_DEFAULT)
}

// 只统计真人发起的轮次，续跑 / 定时 / 系统补投不提醒
const AUTO_USER_PREFIXES = ['Current runtime context', '<system-reminder', '[续跑]']

function aliasOfSelection(sel) {
  if (!sel) return '?'
  const aliases = aliasMap(loadModels())
  return aliases[`${sel.provider}:${sel.model}`] || String(sel.model || '?').slice(0, 12)
}

export function attachProgress(ctx, { routeOf, modelOf, windowOf, goalOf, senderOf }) {
  // chatKey -> 当前这张进度卡：老编辑块逻辑，一张卡建成后原地 editCard
  const cards = new Map()
  // chatKey -> 已经收尾的进度卡（保留几轮，晚到的 tool/result 还能找到自己那行）
  const doneCards = new Map()
  const chatSession = new Map()
  const runs = new Map()
  // 还没发出去的正文：chatKey -> { text, sealed }
  const prose = new Map()

  function buzzLong(route, ms) {
    const limit = longTaskBuzzMs()
    if (!limit || ms < limit) return
    const openId = senderOf?.(route.chatKey) || ''
    if (!openId || !route.lark?.buzz) return
    const mins = Math.round(ms / 60_000)
    void route.lark.buzz(route.chatId, openId, `跑完了，用时 ${mins} 分钟`).catch((err) => {
      process.stderr.write(`[dsh-feishu] long-task buzz failed: ${err}\n`)
    })
  }

  function stateOf(chatKey) {
    let s = cards.get(chatKey)
    if (!s) {
      s = {
        msgId: null,
        lastEditAt: 0,
        lastPct: null,
        // 这张卡上的记录，一行一条：工具或 thinking。
        // 状态是活的，同一条记录只改自己那行，永远不追新行。
        rows: [],
        timer: null,
        dirty: false,
        // 内容版本号：建卡期间（sendCard 还没回来）攒的更新，落地后靠它补画
        version: 0,
        painted: 0,
        // 收尾类型。卡还没落地就收尾时先记在这，落地回调负责定格
        settled: null,
        head: '',
        // 有正文发在这个卡后面，卡已经不在最新位置了
        moved: false,
      }
      cards.set(chatKey, s)
    }
    return s
  }

  // goal 轮次后缀（如 ` G1/5`）。没设目标或目标已完成就返回空串。
  function goalTagOf(chatKey) {
    const sessionId = chatSession.get(chatKey)
    if (!sessionId || !goalOf) return ''
    try {
      return formatGoalTag(goalOf(sessionId))
    } catch {
      return ''
    }
  }

  function percent(chatKey) {
    const meter = ctx.get('tokenMeter')
    const sessions = ctx.get('sessions')
    if (!meter || !sessions) return null
    const sessionId = chatSession.get(chatKey)
    if (!sessionId) return null
    try {
      const session = typeof sessions.get === 'function'
        ? (sessions.get(sessionId) ?? sessions.get(String(sessionId)))
        : null
      if (!session) return null
      const m = meter.measure(session)
      const total = m?.totalTokens
      if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
      const window = windowOf?.(modelOf?.(chatKey)) || 1_000_000
      return Math.max(0, Math.min(99, Math.round((total / window) * 100)))
    } catch (err) {
      process.stderr.write(`[dsh-feishu] tokenMeter: ${err}\n`)
      return null
    }
  }

  // 折叠标题前缀，就是老进度块那一行开头的 [dsf-6%]。
  // 读不到占比时只留别名，别让标题开个空括号。
  function prefix(chatKey) {
    const alias = aliasOfSelection(modelOf?.(chatKey))
    const pct = percent(chatKey)
    const s = cards.get(chatKey)
    if (s && pct !== null) s.lastPct = pct
    const shown = pct ?? s?.lastPct ?? null
    const head = shown === null ? alias : `${alias}-${shown}%`
    return `[${head}${goalTagOf(chatKey)}]`
  }

  // bash 命令里 cd 前缀会把有用信息挤到看不见的地方，先剥掉
  function stripCdPrefix(cmd) {
    return cmd.replace(/^(?:cd\s+[^&;|]+\s*(?:&&|;)\s*)+/i, '').trim()
  }

  // 路径太长时保留尾部（文件名/最后两级），比从头部截断有用得多
  function shortPath(p) {
    const one = String(p).trim().replace(/^\/+/, '')
    const home = String(process.env.HOME || '').replace(/^\/+/, '')
    const rel = home && (one === home || one.startsWith(home + '/'))
      ? '~' + one.slice(home.length)
      : one
    if (rel.length <= 52) return rel
    const parts = rel.split('/')
    return '…/' + parts.slice(-2).join('/')
  }

  // 多行脚本/heredoc 只取真正干活的那条命令，别把整段 shell 糊到卡片上
  function summarizeCommand(raw) {
    const cmd = stripCdPrefix(String(raw))
    if (!cmd) return ''

    // python3 - <<'PY' / bash <<EOF：命令本身没信息量，从脚本体里找第一句有效代码
    const heredocHead = cmd.match(/^([^\n]*)<<-?\s*['"]?(\w+)['"]?/)
    if (heredocHead) {
      const before = heredocHead[1].trim().replace(/[-\s]+$/, '')
      const body = cmd.split('\n').slice(1)
      const firstCode = body
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && l !== heredocHead[2])
      // 命令名 + 第一句代码，比光秃秃一个「-」有信息量
      if (firstCode) {
        const line = `${before} ${firstCode}`.trim()
        return line.length > 64 ? `${line.slice(0, 61)}…` : line
      }
      return before.length > 64 ? `${before.slice(0, 61)}…` : before
    }

    const firstLine = cmd.split('\n')[0].trim()
    const segs = firstLine.split(/&&|;|\|\|/).map((x) => x.trim()).filter(Boolean)
    const real = segs.find((x) => !/^(set|export|source|\.|cd)\b/.test(x)) || segs[0] || ''
    const one = real || firstLine
    return one.length > 64 ? `${one.slice(0, 61)}…` : one
  }

  // 按工具类型给一句话摘要，参照 ZGrok：显示「动词 + 目标」，不贴原始参数。
  function detailOf(name, rawArgs) {
    let args = rawArgs
    if (typeof args === 'string') {
      try { args = JSON.parse(args) } catch { return '' }
    }
    if (!args || typeof args !== 'object') return ''

    const path = args.file_path || args.path
    switch (name) {
      case 'bash':
        return summarizeCommand(args.command || '')
      case 'read':
      case 'write':
      case 'edit':
      case 'unlink':
        return typeof path === 'string' ? shortPath(path) : ''
      case 'glob':
        return typeof args.pattern === 'string' ? args.pattern.slice(0, 48) : ''
      case 'grep': {
        const pat = typeof args.pattern === 'string' ? args.pattern.slice(0, 32) : ''
        const where = typeof path === 'string' ? ` in ${shortPath(path)}` : ''
        return pat ? `${pat}${where}` : ''
      }
      case 'send_file':
        return typeof path === 'string' ? shortPath(path) : ''
      default: {
        // 其余工具：命令/路径/查询都试一遍，取到第一个能用的
        if (typeof args.command === 'string') return summarizeCommand(args.command)
        if (typeof path === 'string') return shortPath(path)
        const q = args.query || args.url || args.pattern
        if (typeof q === 'string') {
          const one = q.split('\n')[0].trim()
          return one.length > 56 ? `${one.slice(0, 53)}…` : one
        }
        return ''
      }
    }
  }

  // 折叠标题 = 老进度块那一行：`[dsf-6%] Bash...(5)`。
  // 它只对自己折叠的内容负责：里面还有 Running 才报正在跑的名字，
  // 全跑完（含 Failed）就定格成 Done (N)。标题不该比内容活得久。
  function panelHeading(rows, head) {
    if (!rows || rows.length === 0) return ''
    const total = rows.length
    const running = rows.filter((row) => row.status === 'running')
    if (running.length === 0) return `${head} Done (${total})`
    const last = running[running.length - 1]
    const raw = last.name || 'tool'
    const name = raw.charAt(0).toUpperCase() + raw.slice(1)
    // 多个同时在跑时点出并发数，单个就直接报名字
    if (running.length > 1) return `${head} ${name} +${running.length - 1}...(${total})`
    return `${head} ${name}...(${total})`
  }

  // 记录行：行首一个彩色圆点表示状态，后面是状态词 + 工具名 + 摘要。
  // 点用 U+2022 手打、颜色靠 <font color>：飞书 native 列表点没法逐行改色，
  // 只能放弃列表换三色。绿=完成、蓝=进行中、红=失败。
  // 注意 <font> 只在折叠面板里可靠，正文 markdown 里会渲染成方块占位，别往正文写。
  function toolLine(row) {
    const failed = row.status === 'failed'
    const running = row.status === 'running'
    const mark = running ? 'Running' : failed ? 'Failed' : 'Completed'
    const color = running ? 'blue' : failed ? 'red' : 'green'
    const detail = row.detail ? ` · ${row.detail}` : ''
    const name = String(row.name || 'tool')
    return `<font color='${color}'>•</font> ${mark} · ${name.charAt(0).toUpperCase()}${name.slice(1)}${detail}`
  }

  // 工具这次算不算失败。
  // 底座的 isError 只覆盖 spawn 失败 / 中断；命令跑到非零退出码它不算错，
  // 只在结果正文末尾拼一行 `[exit code: N]`（dsh-tool-bash/lib/index.js）。
  // 所以光看 isError 的话 `cat 不存在的文件` 全是绿的——失败永远不显红。
  function failedResult(data, msg) {
    if (data?.error || msg?.isError) return true
    const content = msg?.content
    if (!Array.isArray(content)) return false
    const text = content
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text || ''))
      .join('\n')
    // [exit code: 0] 也照写，所以必须排除 0；另外 timed out / killed 也算失败
    return /\[exit code: (?!0\])\d+\]|\[timed out after \d+ms\]|\[killed by signal:/.test(text)
  }

  // ---- 进度卡：一张卡从开到收，内容靠 editCard 原地改 ----
  // 老版本的编辑块逻辑，唯一区别是块里装的是折叠面板而不是一行标题。

  function bump(s) {
    s.version += 1
  }

  function cardOf(rows, label) {
    return { lines: rows.slice(-MAX_PANEL_LINES).map(toolLine), label }
  }

  function schedule(route) {
    const s = cards.get(route.chatKey)
    if (!s || s.timer) return
    // 防抖吞掉的那次更新得补一次，否则最后一行会一直挂在 Running
    s.timer = setTimeout(() => {
      s.timer = null
      if (s.dirty) paint(route, { force: true })
    }, DEBOUNCE_MS)
    if (typeof s.timer.unref === 'function') s.timer.unref()
  }

  function paint(route, { force = false } = {}) {
    const chatKey = route.chatKey
    const s = cards.get(chatKey)
    if (!s || s.settled || s.rows.length === 0) return
    if (!force) {
      const now = Date.now()
      if (now - s.lastEditAt < DEBOUNCE_MS) {
        s.dirty = true
        schedule(route)
        return
      }
    }
    s.dirty = false
    s.lastEditAt = Date.now()
    s.painted = s.version
    const label = panelHeading(s.rows, prefix(chatKey))
    const card = route.lark.progressCard(cardOf(s.rows, label))

    if (s.msgId && s.msgId !== 'pending') {
      void route.lark.editCard(s.msgId, card).catch((err) => {
        process.stderr.write(`[dsh-feishu] progress edit failed: ${err}\n`)
      })
      return
    }
    if (s.msgId === 'pending') return
    s.msgId = 'pending'
    void route.lark.sendCard(route.chatId, card).then((id) => {
      s.msgId = id || null
      if (!id) return
      // 建卡期间卡上已经变了：落地后立刻补一版，别让它停在建卡那一刻
      if (s.settled) settleCard(route, s, id)
      else if (s.painted !== s.version) paint(route, { force: true })
    }).catch((err) => {
      s.msgId = null
      process.stderr.write(`[dsh-feishu] progress create failed: ${err}\n`)
    })
  }

  function textOfChunk(chunk) {
    for (const key of ['text', 'delta', 'textDelta', 'content', 'value']) {
      const raw = chunk?.[key]
      if (typeof raw === 'string' && raw) return raw
    }
    return ''
  }

  // 正文边出边攒，不往飞书上推。流式卡只有一个 markdown 元素，
  // 表格在流式渲染里出不来；所以等这一步说完再一次性发普通卡片，
  // 交给 markdownToFeishuCard 把表格拼成 div.fields，才看得见。
  function pushProse(route, piece) {
    const chatKey = route.chatKey
    let p = prose.get(chatKey)
    if (!p) {
      p = { text: '', sealed: false }
      prose.set(chatKey, p)
    }
    p.text += piece
  }

  // 收尾：把这一步攒的完整文本一次性发出去。
  // 后面还有工具要跑就是过程正文，独立发一条；这一轮说完了走绿头终局卡。
  function sealProse(route, { final, text }) {
    const chatKey = route.chatKey
    const p = prose.get(chatKey)
    const body = (text || p?.text || '').trim()
    if (p) {
      prose.delete(chatKey)
      p.sealed = true
    }
    if (!body) return true
    const alias = aliasOfSelection(modelOf?.(chatKey))
    if (final) {
      void route.lark.sendFinal(route.chatId, body, alias).catch((err) => {
        process.stderr.write(`[dsh-feishu] final reply failed: ${err}\n`)
      })
    } else {
      void route.lark.sendText(route.chatId, body).catch((err) => {
        process.stderr.write(`[dsh-feishu] reply failed: ${err}\n`)
      })
    }
    return true
  }

  // 飞书的消息发出去就不能移动。卡先发、正文后发，卡就被正文压到上面去了。
  // 所以正文一发完就打个 moved 标记：下一批记录来临前先把旧卡定格，
  // 另起一张空卡接着收。旧卡只留它自己那段的行，新卡也只装新行，不重复。
  function migrateIfMoved(route) {
    const s = cards.get(route.chatKey)
    if (!s || !s.moved) return
    s.moved = false
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    const id = s.msgId
    if (s.rows.length > 0) {
      s.settled = 'done'
      s.head = prefix(route.chatKey)
      if (id && id !== 'pending') settleCard(route, s, id)
    }
    s.rows = []
    s.msgId = null
    s.settled = null
    s.version = 0
    s.painted = 0
    s.lastEditAt = 0
  }

  // 思考也是一条记录：模型每步先 reasoning，这里挂一行，工具一来就收掉。
  // 同一步里 reasoning 帧很多，只留第一行。
  function pushThinking(route) {
    migrateIfMoved(route)
    const s = stateOf(route.chatKey)
    const last = s.rows[s.rows.length - 1]
    if (last && last.kind === 'thinking' && last.status === 'running') return
    s.rows.push({ kind: 'thinking', callId: '', name: 'thinking', detail: '', status: 'running' })
    bump(s)
    paint(route)
  }

  function pushTool(route, name, rawArgs, callId) {
    migrateIfMoved(route)
    const s = stateOf(route.chatKey)
    // 走到工具这一步，前面的思考就结束了
    for (const row of s.rows) {
      if (row.kind === 'thinking' && row.status === 'running') row.status = 'completed'
    }
    // 同一次调用重复进来（事件重放）不再追一条
    if (callId && s.rows.some((row) => row.callId && row.callId === callId)) return
    s.rows.push({
      kind: 'tool',
      callId: callId || '',
      name: String(name || 'tool'),
      detail: detailOf(name, rawArgs),
      status: 'running',
    })
    bump(s)
    paint(route)
  }

  // 状态变更只改原来那行，不管它在哪张卡上（包括已经收尾的卡）
  function settleTool(route, callId, failed) {
    if (!callId) return
    const chatKey = route.chatKey
    const status = failed ? 'failed' : 'completed'
    const live = cards.get(chatKey)
    const liveRow = live?.rows.find((row) => row.callId && row.callId === callId)
    if (liveRow) {
      liveRow.status = status
      bump(live)
      paint(route, { force: true })
      return
    }
    for (const entry of doneCards.get(chatKey) || []) {
      const row = entry.rows.find((r) => r.callId && r.callId === callId)
      if (!row) continue
      row.status = status
      const label = `${entry.head} Done (${entry.rows.length})`
      void route.lark.editCard(entry.msgId, route.lark.progressCard(cardOf(entry.rows, label)))
        .catch((err) => {
          process.stderr.write(`[dsh-feishu] progress repaint failed: ${err}\n`)
        })
      return
    }
  }

  // 把卡定格成终态：还在 Running 的行按收尾类型收掉，标题换成 Done/Failed。
  // 收尾后这张卡不再接受新行，但晚到的 tool/result 还能改自己那一行。
  function settleCard(route, s, id) {
    const kind = s.settled
    const rows = s.rows.map((row) => (row.status === 'running'
      ? { ...row, status: kind === 'fail' ? 'failed' : 'completed' }
      : row))
    s.rows = rows
    const label = `${s.head} ${kind === 'fail' ? 'Failed' : 'Done'} (${rows.length})`
    const history = doneCards.get(route.chatKey) || []
    history.push({ msgId: id, rows, head: s.head })
    if (history.length > 6) history.shift()
    doneCards.set(route.chatKey, history)
    void route.lark.editCard(id, route.lark.progressCard(cardOf(rows, label))).catch((err) => {
      process.stderr.write(`[dsh-feishu] progress done failed: ${err}\n`)
    })
  }

  function finish(route, kind) {
    const chatKey = route.chatKey
    const s = cards.get(chatKey)
    if (!s) return
    // 前缀要在删卡之前取：占比缓存在 s 上
    const head = prefix(chatKey)
    cards.delete(chatKey)
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    s.dirty = false
    s.settled = kind
    s.head = head
    if (s.rows.length === 0) return
    // 卡还在路上：等它落地再定格，否则这张卡会永久停在建卡那一刻
    if (!s.msgId || s.msgId === 'pending') return
    settleCard(route, s, s.msgId)
  }

  // 两种帧：reasoning 挂 Thinking 行，text 攒成正文。正文仍不进卡，
  // 攒完一步再决定是过程文本还是终局绿卡。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame?.type !== 'chunk') return
    const route = routeOf(agent?.id)
    if (!route?.chatId || !route.lark) return
    const chunk = frame.chunk
    if (chunk?.type === 'reasoning-delta') {
      pushThinking(route)
      return
    }
    if (chunk?.type && !['text', 'text-delta', 'textDelta'].includes(chunk.type)) return
    const piece = textOfChunk(chunk)
    if (!piece) return
    pushProse(route, piece)
  })

  ctx.on('session/event', (session, event) => {
    const route = routeOf(session.header.id)
    if (!route?.chatId || !route.lark) return
    chatSession.set(route.chatKey, String(session.header.id))

    if (event.type === 'assistant/message') {
      // 这一步的文字。消息体里带着完整的 text 块，优先用它；
      // 万一哪天没了，就用流 chunk 攒下来的那份兜底。
      const blocks = event.data?.message?.content ?? []
      const hasToolCall = blocks.some((block) => block?.type === 'tool-call')
      const fromBlocks = blocks
        .filter((block) => block?.type === 'text' && String(block.text || '').trim() !== '')
        .map((block) => String(block.text))
        .join('')
        .trim()
      const text = fromBlocks
      // 没有文字但有攒着的 chunk 也得走收尾
      if (!text && !prose.get(route.chatKey)) return
      // 还有工具要跑：这是过程正文，独立发一条文本消息，不碰卡。
      // 没有工具了：这一轮说完了，卡定格成 Done，正文走绿头终局卡。
      const streamed = sealProse(route, { final: !hasToolCall, text })
      if (hasToolCall) {
        // 正文已经把卡压到上面去了：下一批记录要换新卡接在正文下面
        const live = cards.get(route.chatKey)
        if (live?.msgId) live.moved = true
        return
      }
      finish(route, 'done')
      if (streamed) return
    }

    if (event.type === 'tool/call') {
      pushTool(route, event.data.name, event.data.arguments, event.data.callId)
    }

    if (event.type === 'tool/result') {
      const msg = event.data?.message ?? {}
      const rid = msg.toolCallId || msg.source?.callId || event.data?.callId
      settleTool(route, rid, failedResult(event.data, msg))
    }

    // 任何 user/message 都意味着「新一轮开始」：上一轮的卡账本不再翻
    if (event.type === 'user/message') {
      doneCards.delete(route.chatKey)
      // 上一轮没收掉的正文不能漏进这一轮
      const stale = prose.get(route.chatKey)
      if (stale) {
        prose.delete(route.chatKey)
        stale.sealed = true
      }
    }

    // 真人发起本轮才起计时；续跑 / 系统补投的轮次跳过
    if (event.type === 'user/message' && !runs.has(route.chatKey)) {
      const blocks = event.data?.content ?? []
      const text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text || ''))
        .join('')
        .trim()
      const auto = !text || AUTO_USER_PREFIXES.some((p) => text.startsWith(p))
      if (!auto) {
        runs.set(route.chatKey, { startedAt: Date.now() })
      }
    }

    // 一轮真正结束只认这个事件。agent/status 的 idle 每步都会来一次，
    // 拿它收卡就会一步一张卡——这正是之前「大量独立卡」的来源。
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        const err = reason.error
        const why = `${err?.code ?? 'error'}: ${err?.message ?? 'unknown'}`
        void route.lark.sendText(route.chatId, `失败：${why}`).catch((sendErr) => {
          process.stderr.write(`[dsh-feishu] error reply failed: ${sendErr}\n`)
        })
      }
      finish(route, reason?.kind === 'error' ? 'fail' : 'done')
      // 正文还没发出去（没有 assistant/message 或事件丢了）：按终局发掉
      const open = prose.get(route.chatKey)
      if (open) sealProse(route, { final: true, text: open.text })
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const route = routeOf(agent.id)
    if (!route?.chatId || !route.lark) return
    // 底座先把状态置 running 再进 step，第一个 token 之前界面是空的。
    // 不吐 reasoning 的模型只有这个信号，靠它打出 Thinking。
    if (status === 'running') {
      pushThinking(route)
      return
    }
    if (status !== 'idle') return
    const run = runs.get(route.chatKey)
    runs.delete(route.chatKey)
    if (run) buzzLong(route, Date.now() - run.startedAt)
  })
}
