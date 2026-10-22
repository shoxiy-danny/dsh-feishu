import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mediaTypeOf } from './vision.js'
import { attachmentNote, extOf, sniffImage, writeInbox } from './inbox.js'
import { createBridge } from './bridge.js'
import { createLark } from './lark.js'
import { CLI_APP_ID, createCliLark } from './cli-lark.js'
import { attachCliServer } from './cli-server.js'
import { attachProgress } from './progress.js'
import { attachPrompts } from './prompts.js'
import { attachOutbound } from './outbound.js'
import { attachGoal, createGoalViews, dismissGoal, noticeOfGoalLine, presentGoal } from './goal.js'
import { attachToolTrim } from './tooltrim.js'
import { attachGuard } from './guard.js'
import { attachAsk } from './ask.js'
import { checkedPicks, createCardStore, formField, lockedCard, modelCard, parseCardAction } from './cards.js'
import { presentResume, resumePageCard, resumePickFailed } from './resume.js'
import { attachMicroCompact } from './microcompact.js'
import { attachCmd } from './cmd.js'
import { collectUsage, formatUsage, parseUsageArg, usageCard } from './usage.js'

export const name = 'dsh-feishu'
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'systemPrompt', 'tools', 'attachments']

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME
  if (!dshHome) throw new Error('dsh-feishu: DSH_HOME is required')
  const cwd = process.env.DSH_FEISHU_CWD || homedir()
  const inboxRoot = process.env.DSH_FEISHU_INBOX
    || process.env.DSH_FEISHU_WORKSPACE
    || join(dirname(dshHome), 'workspace')

  const creds = readBots()
  if (creds.length === 0) throw new Error('dsh-feishu: FEISHU_APP_ID / FEISHU_APP_SECRET missing')

  const bots = new Map()
  for (const item of creds) {
    bots.set(item.appId, createLark(item))
  }
  const cliLark = createCliLark({})
  bots.set(CLI_APP_ID, cliLark)

  const bridge = createBridge(ctx, {
    cwd,
    mapPath: join(dshHome, 'feishu-chats.json'),
    primaryAppId: creds[0].appId,
  })

  function routeOf(sessionId) {
    const route = bridge.routeOf(sessionId)
    if (!route) return null
    return { ...route, lark: bots.get(route.appId) || null }
  }

  const handles = []

  ctx.effect(() => {
    return () => {
      for (const ws of handles) ws?.stop?.()
      void bridge.disposeAll()
    }
  })

  void boot(ctx, { bots, bridge, routeOf, cwd, inboxRoot, cliLark }).then(async (started) => {
    handles.push(...started)
    void announceRestart({ bots, bridge })
  }).catch((err) => {
    process.stderr.write(`[dsh-feishu] boot failed: ${err}\n`)
  })
}

async function announceRestart({ bots, bridge }) {
  try {
    const version = dshVersion()
    const warmed = await bridge.warmup()
    const cont = takeContinue(warmed)
    for (const item of warmed) {
      const lark = bots.get(item.appId)
      if (!lark) continue
      const bits = [
        item.title ? `会话「${item.title}」` : '',
        item.model && item.model !== '?' ? `模型 ${item.model}` : '',
      ].filter(Boolean).join(' · ')
      let body = `${bits ? bits + ' · ' : ''}已接上，直接说话就行。`
      if (cont && item.appId === cont.appId && item.chatId === cont.chatId) {
        body += `\n---\n**续跑指令**\n${cont.text}`
      }
      await lark.sendCard(item.chatId, lockedCard({ title: '已重启', template: 'turquoise', body }))
    }
    process.stderr.write(`[dsh-feishu] restart announce sent chats=${warmed.length} version=${version}\n`)
    if (cont) {
      process.stderr.write(`[dsh-feishu] continue -> ${cont.appId}::${cont.chatId}: ${String(cont.text).slice(0, 80)}\n`)
      await bridge.deliver(cont.appId, cont.chatId, String(cont.text))
    }
  } catch (err) {
    process.stderr.write(`[dsh-feishu] restart announce failed: ${err}\n`)
  }
}

// 重启包装脚本写入的续跑指令：读出并立即消费（防崩溃重投），10 分钟过期
function takeContinue(warmed) {
  const file = join(process.env.DSH_HOME || '', 'restart-continue.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try { writeFileSync(file, JSON.stringify({ consumed: true }) + '\n') } catch { /* ignore */ }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    process.stderr.write('[dsh-feishu] continue file unparsable\n')
    return null
  }
  if (!data?.text || Date.now() - (data.ts || 0) > 10 * 60_000) {
    process.stderr.write('[dsh-feishu] continue skipped: empty or expired\n')
    return null
  }
  if (typeof data.chatKey === 'string' && data.chatKey.includes('::')) {
    const i = data.chatKey.indexOf('::')
    return { appId: data.chatKey.slice(0, i), chatId: data.chatKey.slice(i + 2), text: String(data.text) }
  }
  if (warmed.length === 1) {
    return { appId: warmed[0].appId, chatId: warmed[0].chatId, text: String(data.text) }
  }
  process.stderr.write('[dsh-feishu] continue skipped: no target chat\n')
  return null
}

function dshVersion() {
  try {
    const real = realpathSync(process.argv[1])
    const pkg = JSON.parse(readFileSync(join(dirname(real), '..', 'package.json'), 'utf8'))
    return pkg.version || '?'
  } catch {
    return '?'
  }
}

function readBots() {
  const out = []
  const seen = new Set()
  const pairs = [
    [process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET],
    [process.env.FEISHU_APP_ID_2, process.env.FEISHU_APP_SECRET_2],
    [process.env.FEISHU_APP_ID_3, process.env.FEISHU_APP_SECRET_3],
    [process.env.FEISHU_APP_ID_4, process.env.FEISHU_APP_SECRET_4],
  ]
  for (const [appId, appSecret] of pairs) {
    if (!appId || !appSecret) continue
    if (seen.has(appId)) continue
    seen.add(appId)
    out.push({
      appId,
      appSecret,
      domain: process.env.FEISHU_DOMAIN,
    })
  }
  return out
}

async function boot(ctx, { bots, bridge, routeOf, cwd, inboxRoot, cliLark }) {
  await ctx.get('loader')?.await()
  if (ctx.get('agents') === undefined) return []
  const attachments = ctx.get('attachments')

  const cards = createCardStore()
  const goalViews = createGoalViews()
  attachPrompts(ctx)
  attachToolTrim(ctx)
  attachGuard(ctx, { routeOf, store: cards })
  attachAsk(ctx, { routeOf, store: cards })
  attachMicroCompact(ctx)
  attachCmd(ctx, { routeOf, bridge })
  attachOutbound(ctx, { routeOf })

  attachProgress(ctx, {
    routeOf,
    modelOf: (chatKey) => bridge.selectionOfKey(chatKey),
    windowOf: bridge.windowOf,
    goalOf: (sessionId) => bridge.goalOf(sessionId),
  })
  attachGoal(ctx, { routeOf, views: goalViews })

  const started = []
  for (const [appId, lark] of bots) {
    if (appId === CLI_APP_ID) continue
    const ws = lark.start(async (msg) => {
      process.stderr.write(
        `[dsh-feishu] inbound ${appId} ${msg.messageType} ${msg.messageId} chat=${msg.chatId}\n`,
      )
      await onInbound({ appId, lark, msg, bridge, inboxRoot, cards, goalViews, attachments })
    }, {
      onCard: (data) => onCardAction({ appId, lark, data, cards, bridge, views: goalViews }),
    })
    started.push(ws)
  }

  const sockPath = process.env.DSH_FEISHU_CLI_SOCK || '/tmp/dsh-feishu-cli.sock'
  started.push(attachCliServer({
    socketPath: sockPath,
    lark: cliLark,
    bridge,
    onInbound: (msg) => {
      process.stderr.write(
        `[dsh-feishu] inbound ${CLI_APP_ID} ${msg.messageType} ${msg.messageId} chat=${msg.chatId}\n`,
      )
      return onInbound({ appId: CLI_APP_ID, lark: cliLark, msg, bridge, inboxRoot, cards, goalViews, attachments })
    },
    waitIdle: (appId, chatId) => bridge.waitIdle(appId, chatId),
  }))

  await Promise.all(started.map((ws) => ws.ready))
  process.stderr.write(`[dsh-feishu] ready bots=${[...bots.keys()].join(',')} cwd=${cwd} inbox=${inboxRoot}\n`)
  return started
}

async function onCardAction({ appId, lark, data, cards, bridge, views }) {
  const action = parseCardAction(data)
  const token = String(action.value?.token || '')
  if (action.value?.kind === 'goal') {
    const rec = token ? views?.get(token) : null
    if (!rec || rec.appId !== appId) {
      return { toast: { type: 'info', content: '这张卡片已失效' } }
    }
    const op = String(action.value.op || '')
    let line = ''
    if (op === 'pause' || op === 'resume' || op === 'clear') {
      line = `/goal ${op}`
    } else if (op === 'create' || op === 'edit') {
      const objective = formField(action, 'objective')
      if (!objective) {
        return { toast: { type: 'info', content: op === 'edit' ? '请填写新的目标内容' : '请填写目标' } }
      }
      line = op === 'edit' ? `/goal edit ${objective}` : `/goal ${objective}`
    } else {
      return { toast: { type: 'info', content: '未知操作' } }
    }
    const result = await bridge.runGoal(appId, rec.chatId, line)
    if (!result.ok) {
      return { toast: { type: 'info', content: String(result.text || '操作失败').slice(0, 40) } }
    }
    await presentGoal({
      views,
      lark: rec.lark || lark,
      appId,
      chatId: rec.chatId,
      goal: result.goal,
      notice: op,
      compact: op === 'create' || op === 'edit',
    })
    return { toast: { type: 'info', content: goalToast(op) } }
  }
  const rec = token ? cards.get(token) : null
  if (!rec || rec.appId !== appId) {
    return { toast: { type: 'info', content: '这张卡片已失效' } }
  }
  if (rec.kind === 'guard') {
    const verdict = action.value?.verdict === 'allow' ? 'allow' : 'deny'
    cards.settle(token, { verdict })
    return { toast: { type: 'info', content: verdict === 'allow' ? '已允许' : '已拒绝' } }
  }
  if (rec.kind === 'ask') {
    if (action.value?.op === 'multi') {
      const selected = checkedPicks(action, rec.options || [])
      if (!selected.length) {
        return { toast: { type: 'info', content: '请至少选择一项' } }
      }
      cards.settle(token, { selected })
      return { toast: { type: 'info', content: '已选择' } }
    }
    if (action.value?.op === 'custom' || !action.value?.opt) {
      const custom = formField(action, 'answer')
      if (!custom) {
        return { toast: { type: 'info', content: '请填写回答后再提交' } }
      }
      cards.settle(token, { custom })
      return { toast: { type: 'info', content: '已提交回答' } }
    }
    const opt = String(action.value.opt || '')
    cards.settle(token, { selected: opt ? [opt] : [] })
    return { toast: { type: 'info', content: '已选择' } }
  }
  if (rec.kind === 'model') {
    if (action.value?.op === 'stay') {
      cards.settle(token, { stay: true })
      return cardAck('未切换', lockedCard({
        title: '未切换',
        template: 'grey',
        body: '保持当前模型。',
      }))
    }
    const alias = String(action.value?.alias || '')
    let reply
    try {
      reply = await bridge.setModel(appId, rec.chatId, alias)
    } catch (err) {
      reply = `切换失败：${err?.message || err}`
    }
    const ok = !reply.startsWith('未知模型') && !reply.startsWith('切换失败')
    cards.settle(token, { picked: ok ? alias : undefined })
    return cardAck(ok ? '已切换' : '没切成', lockedCard({
      title: ok ? '已切换' : '没切成',
      template: ok ? 'turquoise' : 'red',
      body: reply,
    }))
  }
  if (rec.kind === 'resume') {
    const op = String(action.value?.op || '')
    if (op === 'stay') {
      cards.settle(token, { stay: true })
      return cardAck('留在当前会话', lockedCard({
        title: '未切换',
        template: 'grey',
        body: '留在当前会话。',
      }))
    }
    if (op === 'page') {
      const page = String(action.value?.page || '')
      try {
        const { view, card } = await resumePageCard(rec, bridge, page)
        return cardAck(`第 ${view.page}/${view.pages} 页`, card)
      } catch (err) {
        process.stderr.write(`[dsh-feishu] resume page failed: ${err}\n`)
        return { toast: { type: 'info', content: '翻页失败' } }
      }
    }
    if (op === 'pick') {
      const n = String(action.value?.n || '')
      cards.settle(token, { picked: n })
      setTimeout(() => {
        void finishResumePick({ appId, lark: rec.lark || lark, rec, n, bridge, views })
      }, 0)
      return cardAck('正在切换', lockedCard({
        title: '正在切换',
        template: 'blue',
        body: '正在切到所选会话。',
      }))
    }
    return { toast: { type: 'info', content: '未知操作' } }
  }
  return { toast: { type: 'info', content: '已记录' } }
}

function cardAck(content, card) {
  return {
    toast: { type: 'info', content },
    card: { type: 'raw', data: card },
  }
}

async function presentModelPicker({ store, lark, appId, chatId, view }) {
  for (const rec of store.finds(appId, chatId, 'model')) {
    store.settle(rec.id, { abort: true, reason: 'replaced' })
  }
  const id = randomUUID()
  const messageId = await lark.sendCard(chatId, modelCard({ id, current: view.current, groups: view.groups }))
  store.add({
    id,
    kind: 'model',
    appId,
    chatId,
    messageId,
    lark,
    resolve: (result) => {
      if (result?.picked) return
      if (result?.timeout) {
        void lockModel({ messageId, lark }, {
          title: '选型卡片已过期',
          template: 'grey',
          body: '再发 /model 看新卡片。',
        })
        return
      }
      if (result?.abort) {
        void lockModel({ messageId, lark }, {
          title: result.reason === 'replaced' ? '已更新' : '已切换',
          template: result.reason === 'replaced' ? 'grey' : 'turquoise',
          body: result.reason === 'replaced' ? '请查看下方新卡片。' : '已用斜杠切到别的模型。',
        })
      }
    },
  })
  return messageId
}

async function lockModel(rec, { title, template, body }) {
  if (!rec?.messageId || !rec.lark?.editCard) return
  try {
    await rec.lark.editCard(rec.messageId, lockedCard({
      title: title || '已结束',
      template: template || 'grey',
      body: body || '',
    }))
  } catch (err) {
    process.stderr.write(`[dsh-feishu] model card lock failed: ${err}\n`)
  }
}

async function finishResumePick({ appId, lark, rec, n, bridge, views }) {
  const reply = await bridge.resumeAt(appId, rec.chatId, n)
  if (resumePickFailed(reply)) {
    if (rec.messageId && lark?.editCard) {
      await lark.editCard(rec.messageId, lockedCard({
        title: '切不过去',
        template: 'red',
        body: reply,
      })).catch((err) => {
        process.stderr.write(`[dsh-feishu] resume pick fail card: ${err}\n`)
      })
    }
    return
  }
  await dismissGoal(views, lark, appId, rec.chatId, '已切到别的会话。')
  if (rec.messageId && lark?.editCard) {
    await lark.editCard(rec.messageId, lockedCard({
      title: '已切换',
      template: 'turquoise',
      body: reply,
    })).catch((err) => {
      process.stderr.write(`[dsh-feishu] resume pick ok card: ${err}\n`)
    })
  }
}

function goalToast(op) {
  if (op === 'pause') return '已暂停自动续跑'
  if (op === 'resume') return '已恢复自动续跑'
  if (op === 'clear') return '已清除当前目标'
  if (op === 'create') return '已设定目标'
  if (op === 'edit') return '已保存修改'
  return '已更新'
}

async function onInbound({ appId, lark, msg, bridge, inboxRoot, cards, goalViews, attachments }) {
  const text = (msg.text || '').trim()
  const ackEmoji = text.toLowerCase() === '/stop' ? 'OK' : 'THUMBSUP'
  void lark.react(msg.messageId, ackEmoji)

  const resources = msg.resources || []
  if (!text && resources.length === 0) {
    await lark.sendText(msg.chatId, '空消息')
    return
  }

  if (text.toLowerCase() === '/stop') {
    cards?.rejectAll(appId, msg.chatId, 'stop')
    const ok = bridge.stop(appId, msg.chatId)
    if (ok === 'goal') {
      await lark.sendText(msg.chatId, '已停止。目标已暂停自动续跑，可在卡片上恢复，或发送 /goal resume。')
      if (goalViews) {
        const result = await bridge.runGoal(appId, msg.chatId, '/goal')
        if (result.goal) {
          await presentGoal({
            views: goalViews,
            lark,
            appId,
            chatId: msg.chatId,
            goal: result.goal,
          })
        }
      }
    } else {
      await lark.sendText(msg.chatId, ok ? '已停' : '当前没有在跑的任务')
    }
    return
  }

  if (text === '/clear') {
    cards?.rejectAll(appId, msg.chatId, 'clear')
    await dismissGoal(goalViews, lark, appId, msg.chatId, '会话已清空。')
    await bridge.clear(appId, msg.chatId)
    const sel = bridge.selectionOf(appId, msg.chatId)
    const modelName = sel?.model ? `。当前模型：${sel.model}` : ''
    const body = `已清空，下一句会开新会话${modelName}`
    if (appId === CLI_APP_ID) {
      await lark.sendText(msg.chatId, body)
    } else {
      await lark.sendCard(msg.chatId, lockedCard({
        title: '会话已清空',
        template: 'indigo',
        body,
      }))
    }
    return
  }

  if (text === '/model' || text.startsWith('/model ')) {
    const token = text.slice('/model'.length).trim()
    if (!token && appId !== CLI_APP_ID) {
      try {
        await presentModelPicker({ store: cards, lark, appId, chatId: msg.chatId, view: bridge.modelGroups(appId, msg.chatId) })
      } catch (err) {
        process.stderr.write(`[dsh-feishu] model card failed: ${err}\n`)
        await lark.sendText(msg.chatId, await bridge.setModel(appId, msg.chatId, ''))
      }
      return
    }
    for (const rec of cards?.finds(appId, msg.chatId, 'model') || []) {
      cards.settle(rec.id, { abort: true, reason: 'switched' })
    }
    const reply = await bridge.setModel(appId, msg.chatId, token)
    await lark.sendText(msg.chatId, reply)
    return
  }

  if (text === '/usage' || text.startsWith('/usage ')) {
    const parsed = parseUsageArg(text.slice('/usage'.length).trim())
    if (!parsed.ok) {
      await lark.sendText(msg.chatId, parsed.error)
      return
    }
    const report = collectUsage({ dshHome: process.env.DSH_HOME, window: parsed.window })
    const reply = { text: formatUsage(report), card: usageCard(report) }
    if (appId === CLI_APP_ID) {
      await lark.sendText(msg.chatId, reply.text)
      return
    }
    try {
      await lark.sendCard(msg.chatId, reply.card)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] usage card failed: ${err}\n`)
      await lark.sendCard(msg.chatId, {
        schema: '2.0',
        config: { update_multi: true },
        header: {
          title: { tag: 'plain_text', content: `用量 · ${parsed.window.label}` },
          template: 'turquoise',
        },
        body: { elements: [{ tag: 'markdown', content: reply.text }] },
      })
    }
    return
  }

  if (text === '/status' || text.startsWith('/status ')) {
    const reply = await bridge.status(appId, msg.chatId)
    if (appId === CLI_APP_ID) {
      await lark.sendText(msg.chatId, reply.text)
      return
    }
    try {
      await lark.sendCard(msg.chatId, reply.card)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] status card failed: ${err}\n`)
      await lark.sendCard(msg.chatId, {
        schema: '2.0',
        config: { update_multi: true },
        header: {
          title: { tag: 'plain_text', content: reply.card?.header?.title?.content || '未命名会话' },
          template: 'turquoise',
        },
        body: { elements: [{ tag: 'markdown', content: reply.text }] },
      })
    }
    return
  }

  if (text === '/compact' || text.startsWith('/compact ')) {
    const hint = text.slice('/compact'.length).trim()
    const reply = await bridge.compact(appId, msg.chatId, hint)
    await lark.sendText(msg.chatId, reply)
    return
  }

  if (text === '/resume' || text.startsWith('/resume ')) {
    const token = text.slice('/resume'.length).trim()
    if (token) {
      const reply = await bridge.resumeAt(appId, msg.chatId, token)
      if (!resumePickFailed(reply)) {
        await dismissGoal(goalViews, lark, appId, msg.chatId, '已切到别的会话。')
        for (const rec of cards?.finds(appId, msg.chatId, 'resume') || []) {
          cards.settle(rec.id, { abort: true, reason: 'switched' })
        }
      }
      await lark.sendText(msg.chatId, reply)
      return
    }
    const view = await bridge.listResumeItems(appId, msg.chatId)
    if (view.items.length === 0) {
      await lark.sendText(msg.chatId, '没有可恢复的会话。先聊一句，或 /clear 过的也会出现在这里。')
      return
    }
    try {
      await presentResume({
        store: cards,
        lark,
        appId,
        chatId: msg.chatId,
        items: view.items,
        page: view.page,
        pages: view.pages,
        total: view.total,
      })
    } catch (err) {
      process.stderr.write(`[dsh-feishu] resume card failed: ${err}\n`)
      await lark.sendText(msg.chatId, await bridge.listResumes(appId, msg.chatId))
    }
    return
  }

  if (text === '/rename' || text.startsWith('/rename ')) {
    const name = text.slice('/rename'.length).trim()
    const reply = await bridge.rename(appId, msg.chatId, name)
    await lark.sendText(msg.chatId, reply)
    return
  }

  if (text === '/bye' || text.startsWith('/bye ')) {
    await bridge.deliver(appId, msg.chatId, text)
    return
  }

  if (text === '/goal' || text.startsWith('/goal ')) {
    const result = await bridge.runGoal(appId, msg.chatId, text)
    if (!result.ok) {
      await lark.sendText(msg.chatId, result.text)
      return
    }
    const notice = noticeOfGoalLine(text)
    await presentGoal({
      views: goalViews,
      lark,
      appId,
      chatId: msg.chatId,
      goal: result.goal,
      notice,
      compact: notice === 'create' || notice === 'edit',
    })
    return
  }

  if (text.startsWith('/')) {
    await lark.sendText(msg.chatId, '本期支持 /stop /clear /model /status /usage /compact /resume /rename /bye /goal')
    return
  }

  const pendingAsk = cards?.finds(appId, msg.chatId, 'ask')?.[0]
  if (pendingAsk && text) {
    cards.settle(pendingAsk.id, { custom: text })
    return
  }

  const notes = []
  const nativeImages = []
  let needOmni = false
  let stripHistoryImages = false
  const vision = Boolean(bridge.visionOf(bridge.selectionOf(appId, msg.chatId)))
  for (const res of resources) {
    try {
      const ingested = await ingestResource(lark, inboxRoot, msg.messageId, res, { vision })
      notes.push(ingested.note)
      if (res.kind === 'audio' || res.kind === 'video') needOmni = true
      if (res.kind === 'image' || res.kind === 'file') stripHistoryImages = true
      if (res.kind === 'image') {
        if (vision && ingested.buf) {
          try {
            if (!attachments?.saveImage) throw new Error('no attachment store')
            const ref = await attachments.saveImage({
              data: ingested.buf,
              mediaType: ingested.mediaType,
              name: ingested.path,
            })
            nativeImages.push(ref)
          } catch (err) {
            process.stderr.write(`[dsh-feishu] saveImage failed, OmniCore fallback: ${err}\n`)
            needOmni = true
          }
        } else {
          needOmni = true
        }
      }
    } catch (err) {
      notes.push(`附件失败：${res.kind} ${err?.message || err}`)
    }
  }
  const body = [text, ...notes].filter(Boolean).join('\n')
  await bridge.deliver(
    appId,
    msg.chatId,
    body,
    needOmni ? { omnicore: true } : undefined,
    undefined,
    nativeImages.length ? nativeImages : undefined,
    stripHistoryImages ? { stripHistoryImages: true } : undefined,
  )
}

async function ingestResource(lark, inboxRoot, messageId, res, opts = {}) {
  const type = res.kind === 'image' ? 'image' : 'file'
  const buf = await lark.downloadResource(messageId, res.fileKey, type)
  if (!buf) throw new Error('下载失败')

  if (res.kind === 'image') {
    const kind = sniffImage(buf) || 'png'
    const leaf = res.name && /\.[A-Za-z0-9]+$/.test(res.name) ? res.name : `图片.${kind}`
    const path = writeInbox(inboxRoot, leaf, buf)
    return {
      note: attachmentNote('图片', res.name || '', path, { vision: opts.vision }),
      path,
      buf,
      mediaType: mediaTypeOf(kind),
    }
  }

  const name = res.name || ''
  const leaf = name || `文件.${extOf(res)}`
  const path = writeInbox(inboxRoot, leaf, buf)
  if (res.kind === 'audio') return { note: attachmentNote('语音', name, path) }
  if (res.kind === 'video') return { note: attachmentNote('视频', name, path) }
  return { note: attachmentNote('文件', name, path) }
}
