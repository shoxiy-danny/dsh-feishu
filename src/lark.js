import { createReadStream, unlinkSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as lark from '@larksuiteoapi/node-sdk'

const TEXT_LIMIT = 18000

export function createLark(creds = process.env) {
  const appId = creds.appId || creds.FEISHU_APP_ID
  const appSecret = creds.appSecret || creds.FEISHU_APP_SECRET
  const domain = creds.domain || creds.FEISHU_DOMAIN
  if (!appId || !appSecret) {
    throw new Error('dsh-feishu: FEISHU_APP_ID / FEISHU_APP_SECRET missing')
  }

  const client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    ...(domain ? { domain } : {}),
  })

  const seen = new Set()
  let botOpenId = ''

  function noteSeen(id) {
    if (!id) return
    seen.add(id)
    if (seen.size > 2000) {
      const first = seen.values().next().value
      seen.delete(first)
    }
  }

  function alreadySeen(id) {
    return Boolean(id) && seen.has(id)
  }

  async function fetchBotInfo() {
    try {
      const resp = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
        data: {},
      })
      botOpenId = resp?.bot?.open_id ?? ''
      if (botOpenId) process.stderr.write(`[dsh-feishu] bot ${appId} open_id=${botOpenId}\n`)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] bot info failed: ${err}\n`)
    }
  }

  async function sendText(chatId, text) {
    const body = String(text ?? '')
    if (!chatId || !body.trim()) return ''
    const chunks = splitText(body, TEXT_LIMIT)
    let lastId = ''
    for (const chunk of chunks) {
      lastId = await sendCard(chatId, markdownToFeishuCard('', chunk))
    }
    return lastId
  }

  function progressCard(text) {
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '' }, template: 'blue' },
      body: { elements: [{ tag: 'markdown', content: `- ${text}` }] },
    }
  }

  async function sendCard(chatId, card) {
    if (!chatId) return ''
    const resp = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    const id = resp?.data?.message_id ?? resp?.message_id ?? ''
    if (id) noteSeen(id)
    return id
  }

  async function editCard(messageId, card) {
    if (!messageId) return false
    const resp = await client.request({
      method: 'PATCH',
      url: `/open-apis/im/v1/messages/${messageId}`,
      data: { content: JSON.stringify(card) },
    })
    if (resp?.code && resp.code !== 0) {
      process.stderr.write(`[dsh-feishu] edit card FAIL: ${JSON.stringify(resp).slice(0, 300)}\n`)
      return false
    }
    return true
  }

  async function react(messageId, emoji) {
    if (!messageId || !emoji) return false
    try {
      await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return true
    } catch (err) {
      process.stderr.write(`[dsh-feishu] react failed: ${err?.response?.data?.msg || err?.message || err}\n`)
      return false
    }
  }

  function start(onInbound) {
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const event = data.event ?? data
          const sender = event.sender
          const message = event.message
          if (!sender || !message) return

          const senderId = sender.sender_id?.open_id ?? ''
          if (!senderId) return
          if (botOpenId && senderId === botOpenId) return

          const messageId = message.message_id
          if (alreadySeen(messageId)) return
          noteSeen(messageId)

          const messageType = message.message_type ?? 'text'
          const rawContent = message.content ?? '{}'
          const inbound = {
            senderId,
            chatId: message.chat_id,
            chatType: message.chat_type ?? 'p2p',
            messageId,
            messageType,
            text: extractText(messageType, rawContent),
            resources: parseResources(messageType, rawContent),
          }
          await onInbound(inbound)
        } catch (err) {
          process.stderr.write(`[dsh-feishu] inbound failed: ${err}\n`)
        }
      },
    })

    const ws = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.error,
      ...(domain ? { domain } : {}),
    })

    return {
      stop: () => {
        try { ws.stop?.() } catch {}
      },
      ready: fetchBotInfo().then(() => ws.start({ eventDispatcher })),
    }
  }

  async function downloadResource(messageId, fileKey, type) {
    if (!messageId || !fileKey) return null
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: type === 'image' ? 'image' : 'file' },
    })
    return toBuffer(resp)
  }

  async function sendFile(chatId, filePath, opts = {}) {
    const voice = Boolean(opts.voice)
    const fileName = basename(filePath)
    const ext = extname(filePath).toLowerCase()
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']
    const audioExts = ['.mp3', '.opus', '.wav', '.ogg', '.m4a', '.aac']

    if (voice && audioExts.includes(ext)) {
      let uploadPath = filePath
      if (ext !== '.opus') {
        const opusPath = filePath.replace(/\.[^.]+$/, '') + '_conv.opus'
        try {
          execFileSync('ffmpeg', ['-y', '-i', filePath, '-c:a', 'libopus', '-b:a', '32k', opusPath], {
            timeout: 30000,
            stdio: 'ignore',
          })
          uploadPath = opusPath
        } catch (err) {
          process.stderr.write(`[dsh-feishu] ffmpeg opus failed: ${err?.message || err}\n`)
        }
      }
      const fileResp = await client.im.file.create({
        data: {
          file_type: 'opus',
          file_name: basename(uploadPath),
          file: createReadStream(uploadPath),
        },
      })
      const fileKey = fileResp?.file_key
      if (!fileKey) throw new Error('语音上传失败')
      const msgResp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'audio',
          content: JSON.stringify({ file_key: fileKey }),
        },
      })
      const id = msgResp?.data?.message_id ?? msgResp?.message_id ?? ''
      if (id) noteSeen(id)
      if (uploadPath !== filePath) {
        try { unlinkSync(uploadPath) } catch {}
      }
      return `语音已发送 (${fileName})`
    }

    if (imageExts.includes(ext)) {
      const imgResp = await client.im.image.create({
        data: {
          image_type: 'message',
          image: createReadStream(filePath),
        },
      })
      const imageKey = imgResp?.image_key
      if (!imageKey) throw new Error('图片上传失败')
      const msgResp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      })
      const id = msgResp?.data?.message_id ?? msgResp?.message_id ?? ''
      if (id) noteSeen(id)
      return `图片已发送 (${fileName})`
    }

    const fileResp = await client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: createReadStream(filePath),
      },
    })
    const fileKey = fileResp?.file_key
    if (!fileKey) throw new Error('文件上传失败')
    const msgResp = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    })
    const id = msgResp?.data?.message_id ?? msgResp?.message_id ?? ''
    if (id) noteSeen(id)
    return `文件已发送 (${fileName})`
  }

  return { appId, sendText, sendCard, editCard, progressCard, react, downloadResource, sendFile, start }
}

function parseMarkdownTable(markdown) {
  const lines = markdown.trim().split('\n')
  if (lines.length < 2) return null
  const firstLine = lines[0].trim()
  const secondLine = lines[1].trim()
  if (!firstLine.startsWith('|') || !firstLine.endsWith('|')) return null
  if (!/^\|[\s-|:]+\|$/.test(secondLine)) return null
  const headers = firstLine.split('|').slice(1, -1).map((h) => h.trim())
  const columns = headers.map((name, idx) => ({ name: `col_${idx}`, display_name: name }))
  const rows = []
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('|') || !line.endsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    const row = {}
    cells.forEach((cell, idx) => {
      if (idx < columns.length) row[columns[idx].name] = cell
    })
    rows.push(row)
  }
  return { columns, rows }
}

function markdownToFeishuCard(title, markdown) {
  const lines = String(markdown ?? '').split('\n')
  const elements = []
  let inCodeBlock = false
  let codeContent = ''
  let pendingLanguage = 'text'
  const headingToSize = { '#': 'large', '##': 'medium', '###': 'small' }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('|') && trimmed.includes('|')) {
      const tableLines = []
      let j = i
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j].trim())
        j++
      }
      if (tableLines.length >= 2) {
        const table = parseMarkdownTable(tableLines.join('\n'))
        if (table) {
          elements.push({ tag: 'table', columns: table.columns, rows: table.rows })
          i = j - 1
          continue
        }
      }
    }

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const lang = pendingLanguage.toUpperCase() || 'text'
        elements.push({ tag: 'markdown', content: '```' + lang + '\n' + codeContent.trim() + '\n```' })
        codeContent = ''
        pendingLanguage = 'text'
        inCodeBlock = false
      } else {
        inCodeBlock = true
        const langMatch = line.match(/^```(\w*)$/)
        if (langMatch) pendingLanguage = langMatch[1] || 'text'
      }
      continue
    }

    if (inCodeBlock) {
      codeContent += line + '\n'
      continue
    }

    if (/^---+$/.test(line) || /^\*\*\*+$/.test(line)) {
      elements.push({ tag: 'hr' })
      continue
    }

    if (trimmed === '') continue

    const headingMatch = line.match(/^(#{1,3})\s+(.*)/)
    if (headingMatch) {
      const size = headingToSize[headingMatch[1]] || 'normal'
      elements.push({ tag: 'markdown', content: headingMatch[2], text_size: size })
      continue
    }

    const ulMatch = line.match(/^[-*+]\s+(.*)/)
    if (ulMatch) {
      elements.push({ tag: 'markdown', content: '• ' + ulMatch[1] })
      continue
    }

    const olMatch = line.match(/^\d+\.\s+(.*)/)
    if (olMatch) {
      elements.push({ tag: 'markdown', content: olMatch[0] })
      continue
    }

    elements.push({ tag: 'markdown', content: line })
  }

  if (inCodeBlock) {
    const lang = pendingLanguage.toUpperCase() || 'text'
    elements.push({ tag: 'markdown', content: '```' + lang + '\n' + codeContent.trim() + '\n```' })
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: title || '' },
      template: 'blue',
    },
    body: { elements },
  }
}

function extractText(messageType, content) {
  try {
    const parsed = JSON.parse(content)
    if (messageType === 'text') return String(parsed.text ?? '')
    if (messageType === 'post') return extractPostText(parsed)
    if (messageType === 'image') return ''
    if (messageType === 'audio') return ''
    if (messageType === 'file') return parsed.file_name ? String(parsed.file_name) : ''
    if (messageType === 'media' || messageType === 'video') return parsed.file_name ? String(parsed.file_name) : ''
    return ''
  } catch {
    return typeof content === 'string' ? content : ''
  }
}

function parseResources(messageType, content) {
  try {
    const parsed = JSON.parse(content)
    if (messageType === 'image' && parsed.image_key) {
      return [{ kind: 'image', fileKey: parsed.image_key }]
    }
    if (messageType === 'audio' && parsed.file_key) {
      return [{ kind: 'audio', fileKey: parsed.file_key, name: parsed.file_name }]
    }
    if (messageType === 'file' && parsed.file_key) {
      return [{ kind: 'file', fileKey: parsed.file_key, name: parsed.file_name }]
    }
    if ((messageType === 'media' || messageType === 'video') && (parsed.file_key || parsed.image_key)) {
      return [{ kind: 'video', fileKey: parsed.file_key || parsed.image_key, name: parsed.file_name }]
    }
    if (messageType === 'post') {
      return parsePostImages(parsed)
    }
    return []
  } catch {
    return []
  }
}

function parsePostImages(post) {
  let lang = post.zh_cn ?? post.en_us ?? post.ja_jp ?? Object.values(post)[0]
  if (typeof lang !== 'object' || lang === null) lang = post
  const out = []
  for (const paragraph of lang?.content ?? []) {
    if (!Array.isArray(paragraph)) continue
    for (const node of paragraph) {
      if (node?.tag === 'img' && node.image_key) {
        out.push({ kind: 'image', fileKey: node.image_key })
      }
    }
  }
  return out
}

async function toBuffer(resp) {
  if (!resp) return null
  if (Buffer.isBuffer(resp)) return resp
  if (resp instanceof ArrayBuffer) return Buffer.from(resp)
  if (ArrayBuffer.isView(resp)) return Buffer.from(resp.buffer, resp.byteOffset, resp.byteLength)
  if (typeof resp.arrayBuffer === 'function') {
    return Buffer.from(await resp.arrayBuffer())
  }
  if (typeof resp.getReadableStream === 'function') {
    return await new Promise((resolve) => {
      const chunks = []
      const stream = resp.getReadableStream()
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', () => resolve(null))
    })
  }
  const data = resp.data ?? resp.buffer
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  try { return Buffer.from(resp) } catch { return null }
}

function extractPostText(post) {
  let lang = post.zh_cn ?? post.en_us ?? post.ja_jp ?? Object.values(post)[0]
  if (typeof lang !== 'object' || lang === null) lang = post
  if (!lang) return ''
  const lines = []
  if (lang.title) lines.push(lang.title)
  for (const paragraph of lang.content ?? []) {
    const parts = []
    for (const node of paragraph) {
      if (node.tag === 'text') parts.push(node.text ?? '')
      else if (node.tag === 'a') parts.push(node.text ?? '')
      else if (node.tag === 'at') parts.push(`@${node.user_name ?? node.user_id ?? ''}`)
      else if (node.tag === 'img') parts.push('(图片)')
    }
    lines.push(parts.join(''))
  }
  return lines.join('\n')
}

function splitText(text, limit) {
  if (text.length <= limit) return [text]
  const out = []
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit))
  return out
}
