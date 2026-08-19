import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { createCardStore, formField, lockedCard, parseCardAction } from './cards.js'
import { presentResume, resumePickFailed } from './resume.js'
import { attachMicroCompact } from './microcompact.js'
import { attachCmd } from './cmd.js'

export const name = 'dsh-feishu'
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'systemPrompt', 'tools']

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

  void boot(ctx, { bots, bridge, routeOf, cwd, inboxRoot, cliLark }).then((started) => {
    handles.push(...started)
  }).catch((err) => {
    process.stderr.write(`[dsh-feishu] boot failed: ${err}\n`)
  })
}

function readBots() {
  const out = []
  const seen = new Set()
  const pairs = [
    [process.env.FEISHU_APP_ID, process.env.FEISHU_APP_SECRET],
    [process.env.FEISHU_APP_ID_2, process.env.FEISHU_APP_SECRET_2],
    [process.env.FEISHU_APP_ID_3, process.env.FEISHU_APP_SECRET_3],
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
      await onInbound({ appId, lark, msg, bridge, inboxRoot, cards, goalViews })
    }, {
      onCard: (data) => onCardAction({ appId, lark, data, cards, bridge, views: goalViews }),
    })
    started.push(ws)
  }

  const sockPath = process.env.DSH_FEISHU_CLI_SOCK || '/tmp/dsh-feishu-cli.sock'
  started.push(attachCliServer({
    socketPath: sockPath,
    lark: cliLark,
    onInbound: (msg) => {
      process.stderr.write(
        `[dsh-feishu] inbound ${CLI_APP_ID} ${msg.messageType} ${msg.messageId} chat=${msg.chatId}\n`,
      )
      return onInbound({ appId: CLI_APP_ID, lark: cliLark, msg, bridge, inboxRoot, cards, goalViews })
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
      template: 'green',
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

async function onInbound({ appId, lark, msg, bridge, inboxRoot, cards, goalViews }) {
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
    await lark.sendText(msg.chatId, '已清空，下一句会开新会话')
    return
  }

  if (text === '/model' || text.startsWith('/model ')) {
    const token = text.slice('/model'.length).trim()
    const reply = await bridge.setModel(appId, msg.chatId, token)
    await lark.sendText(msg.chatId, reply)
    return
  }

  if (text === '/status' || text.startsWith('/status ')) {
    const reply = await bridge.status(appId, msg.chatId)
    await lark.sendText(msg.chatId, reply)
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
    const { items } = await bridge.listResumeItems(appId, msg.chatId)
    if (items.length === 0) {
      await lark.sendText(msg.chatId, '没有可恢复的会话。先聊一句，或 /clear 过的也会出现在这里。')
      return
    }
    try {
      await presentResume({ store: cards, lark, appId, chatId: msg.chatId, items })
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
    await presentGoal({
      views: goalViews,
      lark,
      appId,
      chatId: msg.chatId,
      goal: result.goal,
      notice: noticeOfGoalLine(text),
    })
    return
  }

  if (text.startsWith('/')) {
    await lark.sendText(msg.chatId, '本期支持 /stop /clear /model /status /compact /resume /rename /bye /goal')
    return
  }

  const pendingAsk = cards?.finds(appId, msg.chatId, 'ask')?.[0]
  if (pendingAsk && text) {
    cards.settle(pendingAsk.id, { custom: text })
    return
  }

  const notes = []
  for (const res of resources) {
    try {
      notes.push(await ingestResource(lark, inboxRoot, msg.messageId, res))
    } catch (err) {
      notes.push(`附件失败：${res.kind} ${err?.message || err}`)
    }
  }
  const body = [text, ...notes].filter(Boolean).join('\n')
  const needOmni = resources.some((res) => res.kind === 'image' || res.kind === 'audio' || res.kind === 'video')
  await bridge.deliver(appId, msg.chatId, body, needOmni ? { omnicore: true } : undefined)
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

function inboxDir(inboxRoot) {
  const dir = join(inboxRoot, 'inbox')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeInbox(inboxRoot, fileKey, ext, buf) {
  const safe = String(fileKey || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const path = join(inboxDir(inboxRoot), `${Date.now()}-${safe}.${ext}`)
  writeFileSync(path, buf)
  return path
}

async function ingestResource(lark, inboxRoot, messageId, res) {
  const type = res.kind === 'image' ? 'image' : 'file'
  const buf = await lark.downloadResource(messageId, res.fileKey, type)
  if (!buf) throw new Error('下载失败')

  if (res.kind === 'image') {
    const kind = sniffImage(buf) || 'png'
    const path = writeInbox(inboxRoot, res.fileKey, kind, buf)
    return `收到图片，已存 ${path}`
  }

  const ext = extOf(res)
  const path = writeInbox(inboxRoot, res.fileKey || res.name, ext, buf)
  if (res.kind === 'audio') return `收到语音，已存 ${path}`
  if (res.kind === 'video') return `收到视频，已存 ${path}`
  return `收到文件 ${res.name || ''}，已存 ${path}`.trim()
}

function extOf(res) {
  const name = String(res.name || '')
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '') || 'bin'
  }
  if (res.kind === 'audio') return 'opus'
  if (res.kind === 'video') return 'mp4'
  return 'bin'
}
