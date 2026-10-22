import { existsSync } from 'node:fs'
import { join } from 'node:path'

function eventOf(session, seq) {
  if (typeof session?.eventAt === 'function') return session.eventAt(seq)
  return session?.events?.[seq] || null
}

const SHA_ID = /^sha256:([a-f0-9]{64})$/

export function attachmentObjectPath(home, attachmentId) {
  const match = SHA_ID.exec(String(attachmentId || ''))
  if (!match) return null
  const sha = match[1]
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
}

export function attachmentObjectExists(attachmentId, home = process.env.DSH_HOME) {
  if (!home) return true
  const path = attachmentObjectPath(home, attachmentId)
  if (!path) return false
  return existsSync(path)
}

export function mediaTypeOf(kind) {
  if (kind === 'png') return 'image/png'
  if (kind === 'jpeg' || kind === 'jpg') return 'image/jpeg'
  if (kind === 'webp') return 'image/webp'
  if (kind === 'gif') return 'image/gif'
  return 'image/png'
}

export function contentHasImage(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => block?.type === 'image'
    || (block?.type === 'tool-result' && contentHasImage(block.content)))
}

export function stripImageBlocks(content) {
  if (!Array.isArray(content)) return content
  const out = []
  const paths = []
  let dropped = 0
  for (const block of content) {
    if (!block) continue
    if (block.type === 'image') {
      dropped += 1
      const name = block.attachment?.name
      if (typeof name === 'string' && name.trim()) paths.push(name.trim())
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      out.push({ ...block, content: stripImageBlocks(block.content) })
      continue
    }
    out.push(block)
  }
  if (out.length === 0 && dropped) {
    const text = paths.length
      ? paths.map((path) => `收到图片，已存 ${path}。这是主人刚发的附件，立刻看，不要等主人再提。`).join('\n')
      : '[图片已从历史移除]'
    out.push({ type: 'text', text })
  }
  return out
}

export function stripSessionImages(session) {
  if (!session?.surface?.nodes || typeof session.append !== 'function') return 0
  let n = 0
  for (const seq of [...session.surface.nodes]) {
    const event = eventOf(session, seq)
    if (!event) continue
    if (event.type === 'user/message') {
      const content = event.data?.content
      if (!contentHasImage(content)) continue
      session.append('user/message', {
        ...event.data,
        content: stripImageBlocks(content),
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      n += 1
      continue
    }
    if (event.type === 'tool/result') {
      const msg = event.data?.message
      const content = msg?.content
      if (!contentHasImage(content)) continue
      session.append('tool/result', {
        ...event.data,
        message: { ...msg, content: stripImageBlocks(content) },
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      n += 1
    }
  }
  return n
}

function missingImageText(block) {
  const name = block?.attachment?.name
  if (typeof name === 'string' && name.trim()) {
    return `[图片对象缺失，已从历史移除] ${name.trim()}`
  }
  return '[图片对象缺失，已从历史移除]'
}

export function stripMissingImageBlocks(content, exists) {
  if (!Array.isArray(content)) return content
  const check = typeof exists === 'function' ? exists : attachmentObjectExists
  const out = []
  let changed = false
  for (const block of content) {
    if (!block) continue
    if (block.type === 'image') {
      if (check(block.attachment?.attachmentId)) {
        out.push(block)
      } else {
        changed = true
        out.push({ type: 'text', text: missingImageText(block) })
      }
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const nested = stripMissingImageBlocks(block.content, check)
      if (nested === block.content) {
        out.push(block)
      } else {
        changed = true
        out.push({ ...block, content: nested })
      }
      continue
    }
    out.push(block)
  }
  return changed ? out : content
}

export function stripMissingSessionImages(session, exists) {
  if (!session?.surface?.nodes || typeof session.append !== 'function') return 0
  const check = typeof exists === 'function' ? exists : attachmentObjectExists
  let n = 0
  for (const seq of [...session.surface.nodes]) {
    const event = eventOf(session, seq)
    if (!event) continue
    if (event.type === 'user/message') {
      const content = event.data?.content
      if (!contentHasImage(content)) continue
      const next = stripMissingImageBlocks(content, check)
      if (next === content) continue
      session.append('user/message', {
        ...event.data,
        content: next,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      n += 1
      continue
    }
    if (event.type === 'tool/result') {
      const msg = event.data?.message
      const content = msg?.content
      if (!contentHasImage(content)) continue
      const next = stripMissingImageBlocks(content, check)
      if (next === content) continue
      session.append('tool/result', {
        ...event.data,
        message: { ...msg, content: next },
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      n += 1
    }
  }
  return n
}
