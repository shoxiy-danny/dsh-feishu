import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatGoalError, formatGoalStatus, parseGoalObjective } from './goal.js'
import { aliasOf, loadModels, selectionFromAlias, windowOf as modelWindow } from './models.js'
import { collectHost, formatBytes, formatStatus, measureContext, sessionFileBytes } from './status.js'
import { enableMcp } from './tooltrim.js'

export function createBridge(ctx, options) {
  const { cwd, mapPath, primaryAppId } = options
  if (!primaryAppId) throw new Error('dsh-feishu: FEISHU_APP_ID is required for chat map keys')
  const MODELS = loadModels()
  const migrated = migrateMap(loadMap(mapPath), primaryAppId, MODELS)
  const chats = migrated.map
  const historyPath = join(dirname(mapPath), 'feishu-history.json')
  const history = loadHistory(historyPath)
  const live = new Map()
  const sessionToRoute = new Map()
  const selections = new Map()

  function keyOf(appId, chatId) {
    return `${appId}::${chatId}`
  }

  function parseKey(key) {
    const i = String(key).indexOf('::')
    if (i < 0) return { appId: primaryAppId, chatId: String(key) }
    return { appId: key.slice(0, i), chatId: key.slice(i + 2) }
  }

  function persist() {
    mkdirSync(dirname(mapPath), { recursive: true })
    writeFileSync(mapPath, JSON.stringify(chats, null, 2) + '\n')
  }

  function persistHistory() {
    mkdirSync(dirname(historyPath), { recursive: true })
    writeFileSync(historyPath, JSON.stringify({ items: history.items }, null, 2) + '\n')
  }

  function remember(appId, chatId, sessionId, title) {
    const id = String(sessionId)
    const now = Date.now()
    const existing = history.items.find((item) => item.id === id)
    if (existing) {
      existing.chatId = chatId
      existing.appId = appId
      existing.updatedAt = now
      if (title) existing.title = title
    } else {
      history.items.unshift({
        id,
        appId,
        chatId,
        title: title || '',
        updatedAt: now,
      })
    }
    history.items = history.items
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50)
    persistHistory()
  }

  if (migrated.changed) persist()

  for (const [key, entry] of Object.entries(chats)) {
    const { appId, chatId } = parseKey(key)
    if (entry.model && MODELS[entry.model]) {
      selections.set(key, selectionFromAlias(MODELS, entry.model))
    }
    if (entry.sessionId && !history.items.some((item) => item.id === String(entry.sessionId))) {
      remember(appId, chatId, entry.sessionId)
    }
  }

  function defaultSelection() {
    return ctx.agentDefaultModel.currentSelection()
  }

  function selectionOf(appId, chatId) {
    return selections.get(keyOf(appId, chatId)) || defaultSelection()
  }

  function selectionOfKey(chatKey) {
    return selections.get(chatKey) || defaultSelection()
  }

  function writeChat(appId, chatId, patch) {
    const key = keyOf(appId, chatId)
    const prev = chats[key] || {}
    const next = { ...prev }
    if (patch.dropSession) delete next.sessionId
    else if (patch.sessionId) next.sessionId = String(patch.sessionId)
    if (patch.model) next.model = patch.model
    if (!next.sessionId && !next.model) delete chats[key]
    else chats[key] = next
    persist()
  }

  function persistUsedModel(appId, chatId, selected) {
    const alias = aliasOf(MODELS, selected)
    if (alias === '?' || chats[keyOf(appId, chatId)]?.model === alias) return
    writeChat(appId, chatId, { model: alias })
  }

  function attachSelection(agentCtx, selected) {
    const ref = { current: selected, assembled: undefined }
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const current = ref.current
      const assembled = await next()
      ref.assembled = current
      if (!current) return assembled
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: current.provider,
          model: current.model,
        },
      }
    })
    agentCtx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const selectedNow = ref.assembled
      if (!selectedNow) return resolved
      const { reasoningEffort: _drop, ...rest } = resolved
      return {
        ...rest,
        provider: selectedNow.provider,
        model: selectedNow.model,
        ...(selectedNow.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selectedNow.reasoningEffort }),
      }
    })
    return ref
  }

  async function resumeAgent(sessionId, selected) {
    const box = { ref: null }
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selected.provider, model: selected.model },
      setup: (agentCtx) => {
        box.ref = attachSelection(agentCtx, selected)
      },
    })
    handle._modelRef = box.ref
    await handle.agent.whenIdle()
    return handle
  }

  function holderOf(sessionId) {
    const sid = String(sessionId)
    for (const [key, handle] of live) {
      if (String(handle.agent.id) === sid) {
        const { appId, chatId } = parseKey(key)
        return { chatKey: key, appId, chatId, handle }
      }
    }
    return null
  }

  async function stealIfHeld(sessionId, wantKey) {
    const held = holderOf(sessionId)
    if (!held) return null
    if (held.chatKey === wantKey) return held.handle
    throw new Error(`会话正被另一个窗口占用（${shortApp(held.appId)}）。那边 /clear 或等它结束再 /resume`)
  }

  async function ensure(appId, chatId) {
    const chatKey = keyOf(appId, chatId)
    const existing = live.get(chatKey)
    if (existing) return existing

    const selected = selectionOf(appId, chatId)
    const mapped = chats[chatKey]?.sessionId
    if (mapped) {
      await stealIfHeld(mapped, chatKey)
      try {
        const handle = await resumeAgent(mapped, selected)
        bind(appId, chatId, handle, selected)
        persistUsedModel(appId, chatId, selected)
        remember(appId, chatId, handle.agent.id)
        process.stderr.write(`[dsh-feishu] resumed ${chatKey} -> ${handle.agent.id} model=${aliasOf(MODELS, selected)}\n`)
        return handle
      } catch (err) {
        process.stderr.write(`[dsh-feishu] resume failed ${chatKey}: ${err}\n`)
        if (String(err?.message || err).includes('占用')) throw err
      }
    }

    const box = { ref: null }
    const handle = await ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd },
      agentOptions: { provider: selected.provider, model: selected.model },
      setup: (agentCtx) => {
        box.ref = attachSelection(agentCtx, selected)
      },
    })
    handle._modelRef = box.ref
    await handle.agent.whenIdle()
    bind(appId, chatId, handle, selected)
    writeChat(appId, chatId, { sessionId: handle.agent.id, model: aliasOf(MODELS, selected) === '?' ? undefined : aliasOf(MODELS, selected) })
    remember(appId, chatId, handle.agent.id)
    process.stderr.write(`[dsh-feishu] created ${chatKey} -> ${handle.agent.id} model=${aliasOf(MODELS, selected)}\n`)
    return handle
  }

  function bind(appId, chatId, handle, selected) {
    const chatKey = keyOf(appId, chatId)
    if (!handle._modelRef) {
      handle._modelRef = { current: selected, assembled: undefined }
    } else {
      handle._modelRef.current = selected
    }
    selections.set(chatKey, selected)
    live.set(chatKey, handle)
    sessionToRoute.set(String(handle.agent.id), { appId, chatId, chatKey })
  }

  function routeOf(sessionId) {
    return sessionToRoute.get(String(sessionId)) || null
  }

  function chatOf(sessionId) {
    return routeOf(sessionId)?.chatId
  }

  function userMessage(text) {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([{ type: 'text', text: text || '(空消息)' }]),
      source: Object.freeze({ kind: 'user' }),
    })
  }

  async function deliver(appId, chatId, text, packs) {
    const handle = await ensure(appId, chatId)
    const agent = handle.agent
    if (packs?.omnicore) enableMcp(agent, 'omnicore')
    if (packs?.browser) enableMcp(agent, 'browser')
    const msg = userMessage(text)
    if (agent.status === 'running') agent.steer(msg)
    else agent.followup(msg)
  }

  function stop(appId, chatId) {
    const handle = live.get(keyOf(appId, chatId))
    if (!handle) return false
    const goal = readGoal(handle.agent)
    handle.agent.cancel({ kind: 'user' })
    return goal?.phase === 'active' && goal.activation === 'armed' ? 'goal' : true
  }

  function readGoal(agent) {
    const goals = ctx.get('goals')
    if (!goals || !agent) return null
    try {
      return goals.get(agent) || null
    } catch (err) {
      process.stderr.write(`[dsh-feishu] goals.get: ${err}\n`)
      return null
    }
  }

  function goalOf(sessionId) {
    const held = holderOf(sessionId)
    return held ? readGoal(held.handle.agent) : null
  }

  function goalResult(ok, text, goal) {
    return { ok, text, goal: goal || null }
  }

  async function runGoal(appId, chatId, line) {
    const handle = await ensure(appId, chatId)
    const trimmed = String(line || '').trim()
    if (trimmed === '/goal') {
      const goal = readGoal(handle.agent)
      return goalResult(true, formatGoalStatus(goal), goal)
    }

    const rest = trimmed.replace(/^\/goal\s*/i, '')
    const control = rest.toLowerCase()
    if (control === 'pause' || control === 'resume' || control === 'clear') {
      const commands = ctx.get('commands')
      if (!commands?.execute) return goalResult(false, 'Goal 命令服务不可用', null)
      try {
        const exec = await commands.execute(handle.agent, trimmed, new AbortController().signal)
        if (!exec) return goalResult(true, formatGoalStatus(null), null)
        if (exec.result.kind === 'error') {
          return goalResult(false, formatGoalError(exec.result.text), readGoal(handle.agent))
        }
        const after = readGoal(handle.agent)
        if (after) return goalResult(true, formatGoalStatus(after), after)
        return goalResult(true, '已清除。再设用 /goal <目标>', null)
      } catch (err) {
        process.stderr.write(`[dsh-feishu] /goal failed: ${err}\n`)
        return goalResult(false, `Goal 失败：${err?.message || err}`, readGoal(handle.agent))
      }
    }

    const goals = ctx.get('goals')
    if (!goals) return goalResult(false, 'Goal 服务不可用', null)
    const isEdit = /^edit(?=\s)/iu.test(rest)
    const rawObj = isEdit ? rest.replace(/^edit\s+/iu, '').trim() : rest
    const { objective, maxGoalRounds } = parseGoalObjective(rawObj)
    if (!objective) {
      return goalResult(false, isEdit
        ? '修改目标时必须填写新内容。'
        : '目标不能为空。可在句末写「最多跑3轮」。', readGoal(handle.agent))
    }

    const request = maxGoalRounds ? { objective, maxGoalRounds } : { objective }
    const current = readGoal(handle.agent)
    try {
      if (isEdit) {
        if (!current) return goalResult(false, '当前没有目标。请先设定后再修改。', null)
        if (current.phase === 'complete') {
          const created = goals.create(handle.agent, request)
          return goalResult(true, formatGoalStatus(created), created)
        }
        const edited = goals.edit(handle.agent, {
          id: current.id,
          revision: current.revision,
        }, request)
        return goalResult(true, formatGoalStatus(edited), edited)
      }
      if (current && current.phase !== 'complete') {
        return goalResult(false, '已有未完成的目标。请先修改当前目标，或清除后再设定新目标。', current)
      }
      const created = goals.create(handle.agent, request)
      return goalResult(true, formatGoalStatus(created), created)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] /goal mutate failed: ${err}\n`)
      return goalResult(false, formatGoalError(err?.message || String(err)), readGoal(handle.agent))
    }
  }

  async function clear(appId, chatId) {
    const chatKey = keyOf(appId, chatId)
    const handle = live.get(chatKey)
    if (handle) {
      sessionToRoute.delete(String(handle.agent.id))
      live.delete(chatKey)
      try { await handle.dispose() } catch (err) {
        process.stderr.write(`[dsh-feishu] dispose failed: ${err}\n`)
      }
    }
    if (chats[chatKey]?.sessionId) writeChat(appId, chatId, { dropSession: true })
  }

  async function listResumeItems(appId, chatId) {
    const current = chats[keyOf(appId, chatId)]?.sessionId
      || (live.get(keyOf(appId, chatId)) && String(live.get(keyOf(appId, chatId)).agent.id))
      || null
    const query = ctx.get('sessionQuery')
    const mine = history.items.slice(0, 8)
    if (mine.length === 0) return { current, items: [] }

    const ids = mine.map((item) => item.id)
    let titles = []
    if (query?.readTitleSnapshots) {
      try {
        titles = await query.readTitleSnapshots(ids)
      } catch (err) {
        process.stderr.write(`[dsh-feishu] readTitleSnapshots: ${err}\n`)
      }
    }
    const titleById = new Map()
    for (const row of titles) {
      if (row?.status === 'fulfilled') {
        const sid = String(row.value?.session?.id || row.sessionId || '')
        const title = row.value?.title?.title
        if (sid && title) titleById.set(sid, title)
      }
    }

    const home = dirname(mapPath)
    const items = mine.map((item, i) => {
      const held = holderOf(item.id)
      const bytes = sessionFileBytes(home, item.id)
      return {
        n: i + 1,
        id: item.id,
        title: item.title || titleById.get(item.id) || item.id.slice(0, 12),
        when: formatWhen(item.updatedAt),
        from: item.appId && item.appId !== appId ? shortApp(item.appId) : '',
        size: bytes ? formatBytes(bytes) : '',
        busy: Boolean(held && held.chatKey !== keyOf(appId, chatId)),
        current: item.id === current,
      }
    })
    return { current, items }
  }

  async function listResumes(appId, chatId) {
    const { items } = await listResumeItems(appId, chatId)
    if (items.length === 0) return '没有可恢复的会话。先聊一句，或 /clear 过的也会出现在这里。'
    const lines = items.map((item) => {
      const mark = item.current ? '*' : ' '
      const from = item.from ? `  [${item.from}]` : ''
      const busy = item.busy ? ' 占用' : ''
      const size = item.size ? `  ${item.size}` : ''
      return `${mark}${item.n}. ${item.title}${from}${busy}  ${item.when}${size}`
    })
    return `近期会话（多 bot 共用，* 当前）\n${lines.join('\n')}\n\n/resume 2 切到第 2 条。占用中的不能同时握。`
  }

  async function resumeAt(appId, chatId, token) {
    const raw = String(token || '').trim()
    if (!raw) return listResumes(appId, chatId)
    const n = Number.parseInt(raw, 10)
    const mine = history.items.slice(0, 8)
    if (!Number.isInteger(n) || n < 1 || n > mine.length) {
      return `序号无效。用 /resume 看列表，或 /resume 1–${mine.length || 0}`
    }
    const target = mine[n - 1]
    const chatKey = keyOf(appId, chatId)
    const current = live.get(chatKey)
    if (current && String(current.agent.id) === target.id) {
      return `已经在「${target.title || target.id.slice(0, 12)}」`
    }

    const held = holderOf(target.id)
    if (held && held.chatKey !== chatKey) {
      return `切不过去：会话正被另一个窗口占用（${shortApp(held.appId)}）。那边 /clear 或等它结束再试`
    }

    if (current) {
      sessionToRoute.delete(String(current.agent.id))
      live.delete(chatKey)
      try { await current.dispose() } catch (err) {
        process.stderr.write(`[dsh-feishu] dispose before resume: ${err}\n`)
      }
    }

    const selected = selectionOf(appId, chatId)
    try {
      const handle = await resumeAgent(target.id, selected)
      bind(appId, chatId, handle, selected)
      persistUsedModel(appId, chatId, selected)
      writeChat(appId, chatId, { sessionId: handle.agent.id })
      remember(appId, chatId, handle.agent.id, target.title)
      return `已切到 ${n}. ${target.title || target.id.slice(0, 12)}`
    } catch (err) {
      process.stderr.write(`[dsh-feishu] resumeAt failed: ${err}\n`)
      return `切不过去：${err?.message || err}`
    }
  }

  async function rename(appId, chatId, title) {
    const name = String(title || '').trim()
    if (!name) return '用法：/rename 名字'
    const handle = live.get(keyOf(appId, chatId)) || await ensure(appId, chatId)
    const sessionTitle = ctx.get('sessionTitle')
    const session = handle.agent?.session
    if (!sessionTitle?.rename || !session) return '改名服务不可用'
    try {
      const snap = sessionTitle.rename(session, name)
      remember(appId, chatId, handle.agent.id, snap.title)
      return `已命名为「${snap.title}」`
    } catch (err) {
      process.stderr.write(`[dsh-feishu] rename failed: ${err}\n`)
      return `改名失败：${err?.message || err}`
    }
  }

  async function setModel(appId, chatId, token) {
    const key = String(token || '').trim().toLowerCase()
    const chatKey = keyOf(appId, chatId)
    if (!key) {
      const cur = selectionOf(appId, chatId)
      const lines = Object.entries(MODELS).map(([k, v]) =>
        `${k === aliasOf(MODELS, cur) ? '* ' : '  '}${v.label}`,
      )
      return `当前 ${aliasOf(MODELS, cur)} (${cur.model})\n${lines.join('\n')}`
    }
    const next = MODELS[key]
    if (!next) {
      return `未知模型 \`${token}\`。可用：${Object.keys(MODELS).join(' / ')}`
    }

    const selected = { provider: next.provider, model: next.model }
    selections.set(chatKey, selected)
    writeChat(appId, chatId, { model: key })

    const handle = live.get(chatKey)
    if (handle?._modelRef) handle._modelRef.current = selected
    return `已切换到 ${next.label}，下一轮生效`
  }

  async function status(appId, chatId) {
    const chatKey = keyOf(appId, chatId)
    const handle = live.get(chatKey)
    const selected = selectionOf(appId, chatId)
    const alias = aliasOf(MODELS, selected)
    const sessionId = handle
      ? String(handle.agent.id)
      : (chats[chatKey]?.sessionId || null)
    let session = handle?.agent?.session || null
    if (!session && sessionId) {
      const sessions = ctx.get('sessions')
      session = (typeof sessions?.get === 'function'
        ? (sessions.get(sessionId) ?? sessions.get(String(sessionId)))
        : null) || null
    }
    if (!session && sessionId) {
      const persistence = ctx.get('sessionPersistence')
      if (typeof persistence?.inspect === 'function') {
        try {
          const inspection = await persistence.inspect(sessionId)
          if (inspection?.events) session = { events: inspection.events }
        } catch (err) {
          process.stderr.write(`[dsh-feishu] status inspect: ${err}\n`)
        }
      }
    }
    const context = measureContext({
      meter: ctx.get('tokenMeter'),
      session,
      window: modelWindow(MODELS, selected),
    })
    return formatStatus({
      alias,
      model: selected?.model,
      hasSession: Boolean(sessionId),
      context,
      agentStatus: handle?.agent?.status || null,
      host: collectHost(),
    })
  }

  async function compact(appId, chatId, hint) {
    const handle = live.get(keyOf(appId, chatId))
    if (!handle) return '当前没有会话，先说一句话再 /compact'
    const compaction = ctx.get('compaction')
    if (!compaction?.compactNow) return '压缩服务不可用'

    if (hint) {
      try { handle.agent.inject(userMessage(`Compact focus: ${hint}`)) } catch (err) {
        process.stderr.write(`[dsh-feishu] compact hint inject: ${err}\n`)
      }
    }

    try {
      const result = await compaction.compactNow(handle.agent, new AbortController().signal)
      if (!result) return '还没有可压缩的历史'
      return `已压缩 ${result.shadowedSeqs.length} 条（约 ${result.shadowedTokenCount} tokens）`
    } catch (err) {
      const code = err?.code
      if (code === 'busy') return '正在跑任务或已在压缩，等空闲再 /compact'
      if (code === 'cancelled') return '压缩已取消'
      if (code === 'changed') return '压缩时历史变了，会话未改，可再试'
      if (code === 'summary') return '没压出有效摘要，会话未改'
      if (code === 'commit') return '压缩没有干净结束，先看一眼再试'
      if (code === 'persistence') return '压缩完了但没存上'
      process.stderr.write(`[dsh-feishu] compact failed: ${err}\n`)
      return `压缩失败：${err?.message ?? err}`
    }
  }

  async function disposeAll() {
    const handles = [...live.values()]
    live.clear()
    sessionToRoute.clear()
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})))
  }

  async function waitIdle(appId, chatId, ms = 180_000) {
    const handle = live.get(keyOf(appId, chatId))
    if (!handle) return false
    const agent = handle.agent
    if (typeof agent.whenIdle === 'function') {
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('waitIdle timeout')), ms)),
      ])
      return true
    }
    return true
  }

  return {
    deliver, stop, clear, setModel, status, compact, runGoal, goalOf,
    listResumeItems, listResumes, resumeAt, rename, waitIdle,
    chatOf, routeOf, selectionOf, selectionOfKey,
    windowOf: (sel) => modelWindow(MODELS, sel),
    disposeAll,
  }
}

function shortApp(appId) {
  const labels = parseBotLabels()
  if (labels[appId]) return labels[appId]
  if (appId === 'cli') return 'cli'
  const id = String(appId || '')
  return id.length <= 10 ? id : id.slice(0, 10)
}

function parseBotLabels() {
  const raw = process.env.DSH_FEISHU_BOT_LABELS || ''
  const out = {}
  for (const item of raw.split(',')) {
    const i = item.indexOf('=')
    if (i < 1) continue
    const id = item.slice(0, i).trim()
    const label = item.slice(i + 1).trim()
    if (id && label) out[id] = label
  }
  return out
}

function formatWhen(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(5, 16)
  } catch {
    return ''
  }
}

function loadHistory(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { items: Array.isArray(raw.items) ? raw.items : [] }
  } catch {
    return { items: [] }
  }
}

function normalizeEntry(value, models) {
  if (typeof value === 'string' && value) return { sessionId: value }
  if (!value || typeof value !== 'object') return null
  const sessionId = typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : undefined
  const model = typeof value.model === 'string' && models[value.model] ? value.model : undefined
  if (!sessionId && !model) return null
  return {
    ...sessionId ? { sessionId } : {},
    ...model ? { model } : {},
  }
}

function loadMap(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function migrateMap(raw, appId, models) {
  const out = {}
  let changed = false
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.includes('::') ? k : `${appId}::${k}`
    if (!k.includes('::') || typeof v === 'string') changed = true
    const entry = normalizeEntry(v, models)
    if (entry) out[key] = entry
  }
  if (changed) {
    process.stderr.write('[dsh-feishu] migrated chat map to (appId, chat_id, model)\n')
  }
  return { map: out, changed }
}
