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
import { attachGoal } from './goal.js'
import { attachToolTrim } from './tooltrim.js'
import { attachGuard } from './guard.js'
import { attachMicroCompact } from './microcompact.js'

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

  attachPrompts(ctx)
  attachToolTrim(ctx)
  attachGuard(ctx)
  attachMicroCompact(ctx)
  attachOutbound(ctx, { routeOf })

  attachProgress(ctx, {
    routeOf,
    modelOf: (chatKey) => bridge.selectionOfKey(chatKey),
    windowOf: bridge.windowOf,
    goalOf: (sessionId) => bridge.goalOf(sessionId),
  })
  attachGoal(ctx, { routeOf })

  const started = []
  for (const [appId, lark] of bots) {
    if (appId === CLI_APP_ID) continue
    const ws = lark.start(async (msg) => {
      process.stderr.write(
        `[dsh-feishu] inbound ${appId} ${msg.messageType} ${msg.messageId} chat=${msg.chatId}\n`,
      )
      await onInbound({ appId, lark, msg, bridge, inboxRoot })
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
      return onInbound({ appId: CLI_APP_ID, lark: cliLark, msg, bridge, inboxRoot })
    },
    waitIdle: (appId, chatId) => bridge.waitIdle(appId, chatId),
  }))

  await Promise.all(started.map((ws) => ws.ready))
  process.stderr.write(`[dsh-feishu] ready bots=${[...bots.keys()].join(',')} cwd=${cwd} inbox=${inboxRoot}\n`)
  return started
}

async function onInbound({ appId, lark, msg, bridge, inboxRoot }) {
  const text = (msg.text || '').trim()
  const ackEmoji = text.toLowerCase() === '/stop' ? 'OK' : 'THUMBSUP'
  void lark.react(msg.messageId, ackEmoji)

  const resources = msg.resources || []
  if (!text && resources.length === 0) {
    await lark.sendText(msg.chatId, '空消息')
    return
  }

  if (text.toLowerCase() === '/stop') {
    const ok = bridge.stop(appId, msg.chatId)
    if (ok === 'goal') {
      await lark.sendText(msg.chatId, '已停。Goal 已暂停，续跑用 /goal resume')
    } else {
      await lark.sendText(msg.chatId, ok ? '已停' : '当前没有在跑的任务')
    }
    return
  }

  if (text === '/clear') {
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
    const reply = await bridge.resumeAt(appId, msg.chatId, token)
    await lark.sendText(msg.chatId, reply)
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
    const reply = await bridge.runGoal(appId, msg.chatId, text)
    await lark.sendText(msg.chatId, reply)
    return
  }

  if (text.startsWith('/')) {
    await lark.sendText(msg.chatId, '本期支持 /stop /clear /model /status /compact /resume /rename /bye /goal')
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
