import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

export function safeLeaf(value) {
  const raw = String(value || '')
  const leaf = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').trim().slice(0, 180)
  return clean === '' || clean === '.' || clean === '..' ? '' : clean
}

export function inboxDir(inboxRoot) {
  const dir = join(inboxRoot, 'inbox')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeInbox(inboxRoot, name, buf) {
  const leaf = safeLeaf(name) || 'file.bin'
  const dir = inboxDir(inboxRoot)
  let path = join(dir, `${Date.now()}-${leaf}`)
  if (existsSync(path)) {
    const ext = extname(leaf)
    const stem = ext ? leaf.slice(0, -ext.length) : leaf
    path = join(dir, `${Date.now()}-${stem}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  }
  writeFileSync(path, buf)
  return path
}

export function extOf(res) {
  const name = String(res?.name || '')
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '') || 'bin'
  }
  if (res?.kind === 'audio') return 'opus'
  if (res?.kind === 'video') return 'mp4'
  return 'bin'
}

export function fileHint(kind, name) {
  if (kind === 'audio' || kind === '语音') return '立刻用 OmniCore 转写，不要用 read。'
  if (kind === 'video' || kind === '视频') return '立刻用 OmniCore 转写，不要用 read。'
  if (kind === 'image' || kind === '图片') return '这是主人刚发的附件，立刻看，不要等主人再提。'
  const leaf = String(name || '').toLowerCase()
  if (/\.(zip|rar|7z|tar|tgz|gz)$/.test(leaf) || leaf.endsWith('.tar.gz')) {
    return '这是压缩包。先解压到独立空目录，再按内部文件类型处理：图用 read_image，xlsx 用 Python/openpyxl，不要对 zip 本身用 read。'
  }
  if (/\.(xlsx|xls)$/.test(leaf)) {
    return '这是表格。用 Python/openpyxl 读表，不要用 read（xlsx 不是 UTF-8 文本）。'
  }
  if (/\.(docx|doc)$/.test(leaf)) {
    return '这是 Word。用 Python 抽文本，不要对 docx 本身用 read。'
  }
  if (leaf.endsWith('.pdf')) {
    return '这是 PDF。用工具抽文本或转图后再看，不要对 PDF 本身用 read。'
  }
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(leaf)) {
    return '这是图片文件。用 read_image 看，不要用 read。'
  }
  if (/\.(txt|md|csv|json|xml|html|js|ts|py|yml|yaml|log)$/.test(leaf)) {
    return '立刻用 read 读，不要等主人再提。'
  }
  return '先看扩展名再选工具；二进制不要用 read。'
}

export function attachmentNote(kind, name, path, opts = {}) {
  const title = name ? `${kind} ${name}` : kind
  if (kind === '图片' && opts.vision) {
    return `收到${title}，已存 ${path}。本轮已作为图片送入，直接看像素，不要再 read / read_image。`
  }
  return `收到${title}，已存 ${path}。${fileHint(kind, name)}`
}
