import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

// 记忆根：DSH_FEISHU_MEMORY_DIR 指到含 MEMORY.md 的目录。没设就不加载记忆段。
export function memoryRoot() {
  const dir = process.env.DSH_FEISHU_MEMORY_DIR
  if (!dir) return null
  try {
    if (existsSync(join(dir, 'MEMORY.md'))) return realpathSync(dir)
  } catch {
    return null
  }
  return null
}

export function readMemoryIndex() {
  const root = memoryRoot()
  if (!root) return { ok: false, root: null, text: '' }
  try {
    const text = readFileSync(join(root, 'MEMORY.md'), 'utf8').trim()
    if (!text) return { ok: false, root, text: '' }
    return { ok: true, root, text }
  } catch {
    return { ok: false, root, text: '' }
  }
}

export function escapePrompt(text) {
  return String(text).replaceAll('{{', '{ {')
}

export function memorySectionText() {
  const { ok, root } = readMemoryIndex()
  if (!ok) {
    if (!root && !process.env.DSH_FEISHU_MEMORY_DIR) return ''
    return [
      '记忆索引未加载。',
      '把 DSH_FEISHU_MEMORY_DIR 指向一个含 MEMORY.md 的目录。',
    ].join('\n')
  }
  return [
    `记忆根：${root}`,
    'MEMORY.md 是指针目录，不要把整份塞进稳定前缀。',
    '用某条：先 Read 索引，再 Read 它指向的分文件。',
    '写记忆：单文件 + frontmatter，再更新 MEMORY.md 一行。',
  ].join('\n')
}
