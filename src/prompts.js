import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memorySectionText, readMemoryIndex } from './memory.js'
import { attachHeaders } from './headers.js'
import { loadSettings } from './settings.js'

const PACKAGED = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

const SECTIONS = [
  { file: '00-identity.md', name: 'feishu:identity', order: 1 },
  { file: '10-rules.md', name: 'feishu:rules', order: 10 },
  { file: '20-tools.md', name: 'feishu:tools', order: 20 },
]

function promptsDir() {
  const override = process.env.DSH_FEISHU_PROMPTS_DIR
  if (override && existsSync(override)) return override
  return PACKAGED
}

function readPrompt(dir, name) {
  return readFileSync(join(dir, name), 'utf8').trim()
}

export function attachPrompts(ctx) {
  const prompt = ctx.get('systemPrompt')
  if (!prompt) {
    process.stderr.write('[dsh-feishu] systemPrompt missing; product prompts not loaded\n')
    return
  }

  const dir = promptsDir()
  for (const spec of SECTIONS) {
    const path = join(dir, spec.file)
    if (!existsSync(path)) continue
    prompt.section({
      name: spec.name,
      order: spec.order,
      text: readPrompt(dir, spec.file),
    })
  }

  const memText = memorySectionText()
  if (memText) {
    prompt.section({
      name: 'feishu:memory',
      order: 40,
      text: memText,
    })
    const mem = readMemoryIndex()
    if (mem.ok) {
      process.stderr.write(`[dsh-feishu] MEMORY pointer -> ${mem.root}\n`)
    }
  }

  attachHeaders(ctx, loadSettings())

  let version = '?'
  try { version = readPrompt(dir, 'VERSION') } catch { /* optional */ }
  process.stderr.write(`[dsh-feishu] prompts v${version} loaded from ${dir}\n`)
}
