import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatGoalError, formatGoalStatus, parseGoalObjective } from './goal.js'
import {
  aliasOf as aliasOfModel,
  loadModels,
  modelGroups as groupsOf,
  selectionFromAlias as selectionOfAlias,
  visionOf as visionOfModel,
  windowOf as windowOfModel,
} from './models.js'
import { collectHost, formatBytes, formatStatus, measureContext, sessionFileBytes, statusCard } from './status.js'
import { enableMcp } from './tooltrim.js'
import { stripMissingSessionImages, stripSessionImages } from './vision.js'
import { RESUME_PAGE_SIZE, resumePaging } from './resume.js'

// 模型表来自 models.js（DSH_FEISHU_MODELS 指向的 json，外加内置 dsf）。
// 不硬编码任何私有网关；接线方式与「内置只有 dsf」的公开默认一致。
const MODELS = loadModels()

function aliasOf(sel) {
  return aliasOfModel(MODELS, sel)
}

export function windowOf(sel) {
  return windowOfModel(MODELS, sel)
}

export function visionOf(sel) {
  return visionOfModel(MODELS, sel)
}

export function visionOfAlias(alias) {
  return MODELS[alias]?.vision === true
}

// running 一律 steer（文字和附件），进当前轮下一步。idle 才 followup 开新轮。
export function deliverMode(status, _opts) {
  if (status !== 'running') return 'followup'
  return 'steer'
}

export async function waitAgentStatus(agent, want, ms = 15_000, step = 50) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (agent?.status === want) return true
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  return agent?.status === want
}

// -m 覆盖：等这一轮真正跑起来再等它结束；超时取消，不把任务交回会话主模型。
export async function restoreOverrideAfterTurn(agent, handle, prev, opts = {}) {
  const startMs = opts.startMs ?? 15_000
  const idleMs = opts.idleMs ?? 720_000
  const restore = () => {
    if (handle?._modelRef) handle._modelRef.current = prev
  }
  try {
    if (agent?.status !== 'running') {
      const started = await waitAgentStatus(agent, 'running', startMs)
      if (!started) {
        process.stderr.write('[dsh-feishu] -m override: agent never started, restore session model\n')
        restore()
        return
      }
    }
    const idle = typeof agent?.whenIdle === 'function'
      ? Promise.resolve(agent.whenIdle()).then(() => true).catch(() => true)
      : Promise.resolve(true)
    const timedOut = await Promise.race([
      idle.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), idleMs)),
    ])
    if (timedOut) {
      process.stderr.write('[dsh-feishu] -m override timed out, cancel; will not hand off to session model\n')
      try { agent?.cancel?.({ kind: 'user' }) } catch { /* ignore */ }
      await waitAgentStatus(agent, 'idle', 5_000)
    }
  } catch (err) {
    process.stderr.write(`[dsh-feishu] -m override restore: ${err}\n`)
  } finally {
    restore()
  }
}

export function createBridge(ctx, options) {
  const { cwd, mapPath, primaryAppId } = options
  if (!primaryAppId) throw new Error('dsh-feishu: FEISHU_APP_ID is required for chat map keys')
  const migrated = migrateMap(loadMap(mapPath), primaryAppId)
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
      selections.set(key, selectionOfAlias(MODELS, entry.model))
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
    const alias = aliasOf(selected)
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
        stripIfNeeded(handle, true, visionOf(selected))
        process.stderr.write(`[dsh-feishu] resumed ${chatKey} -> ${handle.agent.id} model=${aliasOf(selected)}\n`)
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
    writeChat(appId, chatId, { sessionId: handle.agent.id, model: aliasOf(selected) === '?' ? undefined : aliasOf(selected) })
    remember(appId, chatId, handle.agent.id)
    process.stderr.write(`[dsh-feishu] created ${chatKey} -> ${handle.agent.id} model=${aliasOf(selected)}\n`)
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

  function userMessage(text, images) {
    const content = [{ type: 'text', text: text || '(空消息)' }]
    if (Array.isArray(images)) {
      for (const image of images) {
        if (image) content.push({ type: 'image', attachment: image })
      }
    }
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze(content),
      source: Object.freeze({ kind: 'user' }),
    })
  }

  function stripIfNeeded(handle, fromVision, toVision) {
    if (!fromVision || toVision) return 0
    const session = handle?.agent?.session
    if (!session) return 0
    const n = stripSessionImages(session)
    if (n) process.stderr.write(`[dsh-feishu] stripped ${n} image surface(s) for text-only model\n`)
    return n
  }

  async function deliver(appId, chatId, text, packs, modelAlias, images, opts = {}) {
    const handle = await ensure(appId, chatId)
    const agent = handle.agent
    if (packs?.omnicore) enableMcp(agent, 'omnicore')
    if (packs?.browser) enableMcp(agent, 'browser')
    // 单次模型覆盖：只影响这一轮回复，跑完恢复会话原选型，不写持久化
    let overridePrev
    const sessionVision = visionOf(selectionOf(appId, chatId))
    let activeVision = sessionVision
    if (modelAlias && MODELS[modelAlias] && handle._modelRef) {
      overridePrev = handle._modelRef.current
      handle._modelRef.current = { provider: MODELS[modelAlias].provider, model: MODELS[modelAlias].model }
      activeVision = visionOfAlias(modelAlias)
      stripIfNeeded(handle, sessionVision, activeVision)
    }
    const session = agent.session
    if (opts.stripHistoryImages) {
      const n = stripSessionImages(session)
      if (n) process.stderr.write(`[dsh-feishu] stripped ${n} history image surface(s) before new attachment\n`)
    } else {
      const n = stripMissingSessionImages(session)
      if (n) process.stderr.write(`[dsh-feishu] stripped ${n} missing image surface(s)\n`)
    }
    const nativeImages = activeVision && Array.isArray(images) && images.length ? images : undefined
    const msg = userMessage(text, nativeImages)
    if (deliverMode(agent.status, opts) === 'followup') agent.followup(msg)
    else agent.steer(msg)
    if (overridePrev !== undefined) {
      // 不等这一轮结束：cron --no-wait 必须立刻返回。超时取消，不把活交回会话主模型。
      void restoreOverrideAfterTurn(agent, handle, overridePrev).catch((err) => {
        process.stderr.write(`[dsh-feishu] -m override: ${err}\n`)
      })
    }
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
        // dsh >= 0.1.1-rc.1 签名为 execute(agent, line, images, signal)，images 传空数组
        const exec = await commands.execute(handle.agent, trimmed, [], new AbortController().signal)
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

  async function listResumeItems(appId, chatId, page) {
    const current = chats[keyOf(appId, chatId)]?.sessionId
      || (live.get(keyOf(appId, chatId)) && String(live.get(keyOf(appId, chatId)).agent.id))
      || null
    const paging = resumePaging(history.items.length, page)
    if (paging.total === 0) return { current, items: [], ...paging }

    const start = (paging.page - 1) * RESUME_PAGE_SIZE
    const mine = history.items.slice(start, start + RESUME_PAGE_SIZE)
    const query = ctx.get('sessionQuery')
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
        n: start + i + 1,
        id: item.id,
        title: item.title || titleById.get(item.id) || item.id.slice(0, 12),
        when: formatWhen(item.updatedAt),
        from: item.appId && item.appId !== appId ? shortApp(item.appId) : '',
        size: bytes ? formatBytes(bytes) : '',
        busy: Boolean(held && held.chatKey !== keyOf(appId, chatId)),
        current: item.id === current,
      }
    })
    return { current, items, ...paging }
  }

  async function listResumes(appId, chatId, page) {
    const { items, page: p, pages, total } = await listResumeItems(appId, chatId, page)
    if (items.length === 0) return '没有可恢复的会话。先聊一句，或 /clear 过的也会出现在这里。'
    const lines = items.map((item) => {
      const mark = item.current ? '*' : ' '
      const from = item.from ? `  [${item.from}]` : ''
      const busy = item.busy ? ' 占用' : ''
      const size = item.size ? `  ${item.size}` : ''
      return `${mark}${item.n}. ${item.title}${from}${busy}  ${item.when}${size}`
    })
    const more = pages > 1 ? `\n第 ${p}/${pages} 页 · 共 ${total} 条。点卡片翻页。` : ''
    return `近期会话（两 bot 共用，* 当前）\n${lines.join('\n')}${more}\n\n点一条切过去。占用中的不能同时握。`
  }

  async function resumeAt(appId, chatId, token) {
    const raw = String(token || '').trim()
    if (!raw) return listResumes(appId, chatId)
    const n = Number.parseInt(raw, 10)
    const mine = history.items
    if (!Number.isInteger(n) || n < 1 || n > mine.length) {
      return `序号无效。用 /resume 看列表。`
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
      stripIfNeeded(handle, true, visionOf(selected))
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
        `${k === aliasOf(cur) ? '* ' : '  '}${v.label}`,
      )
      return `当前 ${aliasOf(cur)} (${cur.model})\n${lines.join('\n')}`
    }
    const next = MODELS[key]
    if (!next) {
      return `未知模型 \`${token}\`。可用：${Object.keys(MODELS).join(' / ')}`
    }

    const prev = selectionOf(appId, chatId)
    const selected = { provider: next.provider, model: next.model }
    const handle = live.get(chatKey)
    const stripped = stripIfNeeded(handle, visionOf(prev), next.vision === true)
    selections.set(chatKey, selected)
    writeChat(appId, chatId, { model: key })
    if (handle?._modelRef) handle._modelRef.current = selected
    const extra = stripped ? `。已把 ${stripped} 处历史图换成路径` : ''
    return `已切换到 ${next.label}，下一轮生效${extra}`
  }

  function modelGroups(appId, chatId) {
    return groupsOf(MODELS, aliasOf(selectionOf(appId, chatId)))
  }

  async function sessionTitleOf(sessionId, session) {
    if (!sessionId) return ''
    const remembered = history.items.find((item) => item.id === String(sessionId))?.title
    if (remembered) return remembered
    const query = ctx.get('sessionQuery')
    if (query?.readTitle) {
      try {
        const snap = await query.readTitle(sessionId)
        const title = snap?.title || snap?.title?.title
        if (typeof title === 'string' && title.trim()) return title.trim()
      } catch (err) {
        process.stderr.write(`[dsh-feishu] status title: ${err}\n`)
      }
    }
    const liveTitle = session?.header?.title || session?.title
    return typeof liveTitle === 'string' ? liveTitle : ''
  }

  async function status(appId, chatId) {
    const chatKey = keyOf(appId, chatId)
    const handle = live.get(chatKey)
    const selected = selectionOf(appId, chatId)
    const alias = aliasOf(selected)
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
          if (inspection?.events) {
            const events = inspection.events
            session = {
              events,
              seq: Array.isArray(events) ? events.length : 0,
              eventAt: (i) => events[i],
              snapshotEvents: () => events,
            }
          }
        } catch (err) {
          process.stderr.write(`[dsh-feishu] status inspect: ${err}\n`)
        }
      }
    }
    const context = measureContext({
      meter: ctx.get('tokenMeter'),
      session,
      window: windowOf(selected),
    })
    const payload = {
      alias,
      model: selected?.model,
      title: await sessionTitleOf(sessionId, session),
      hasSession: Boolean(sessionId),
      context,
      agentStatus: handle?.agent?.status || null,
      host: collectHost(),
    }
    return {
      text: formatStatus(payload),
      card: statusCard(payload),
    }
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

  async function warmup() {
    const warmed = []
    for (const [key, entry] of Object.entries(chats)) {
      if (!entry.sessionId) continue
      const { appId, chatId } = parseKey(key)
      if (appId === 'cli') continue
      try {
        await ensure(appId, chatId)
      } catch (err) {
        process.stderr.write(`[dsh-feishu] warmup ${key}: ${err}\n`)
        continue
      }
      const title = history.items.find((item) => item.id === String(entry.sessionId))?.title || ''
      warmed.push({ appId, chatId, title, model: entry.model || '' })
    }
    return warmed
  }

  return {
    deliver, stop, clear, setModel, modelGroups, status, compact, runGoal, goalOf,
    listResumeItems, listResumes, resumeAt, rename, waitIdle,
    chatOf, routeOf, selectionOf, selectionOfKey, windowOf, visionOf, disposeAll, warmup,
  }
}

// bot 显示名来自 DSH_FEISHU_BOT_LABELS，形如 `cli_xxx=Alice,cli_yyy=Bob`。
// 没配就退化成 App ID 前 10 位，源码里不写死任何 App ID。
function shortApp(appId) {
  if (appId === 'cli') return 'cli'
  const raw = String(process.env.DSH_FEISHU_BOT_LABELS || '')
  for (const item of raw.split(',')) {
    const i = item.indexOf('=')
    if (i < 1) continue
    if (item.slice(0, i).trim() === String(appId)) return item.slice(i + 1).trim()
  }
  const id = String(appId || '')
  return id.length <= 10 ? id : id.slice(0, 10)
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

function normalizeEntry(value) {
  if (typeof value === 'string' && value) return { sessionId: value }
  if (!value || typeof value !== 'object') return null
  const sessionId = typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : undefined
  const model = typeof value.model === 'string' && MODELS[value.model] ? value.model : undefined
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

function migrateMap(raw, appId) {
  const out = {}
  let changed = false
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.includes('::') ? k : `${appId}::${k}`
    if (!k.includes('::') || typeof v === 'string') changed = true
    const entry = normalizeEntry(v)
    if (entry) out[key] = entry
  }
  if (changed) {
    process.stderr.write(`[dsh-feishu] migrated chat map to (appId, chat_id, model)\n`)
  }
  return { map: out, changed }
}
