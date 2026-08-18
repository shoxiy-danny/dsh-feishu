import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

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
      'Memory index was not loaded.',
      'Set DSH_FEISHU_MEMORY_DIR to a folder that contains MEMORY.md.',
    ].join('\n')
  }
  return [
    `Memory root: ${root}`,
    'MEMORY.md is an index of pointers. Do not inline the whole file every turn.',
    'To use a note: Read the index, then Read the file it points to.',
    'To write a note: one file + frontmatter, then add one line to MEMORY.md.',
  ].join('\n')
}
