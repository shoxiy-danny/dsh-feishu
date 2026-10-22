import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memorySectionText, readMemoryIndex } from './memory.js'
import { attachHeaders } from './headers.js'
import { loadSettings } from './settings.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const PROMPTS = join(ROOT, 'prompts')

const SECTIONS = [
  { file: '00-identity.md', name: 'feishu:identity', order: 1 },
  { file: '10-rules.md', name: 'feishu:rules', order: 10 },
  { file: '20-tools.md', name: 'feishu:tools', order: 20 },
]

function readPrompt(name) {
  return readFileSync(join(PROMPTS, name), 'utf8').trim()
}

export function attachPrompts(ctx) {
  const prompt = ctx.get('systemPrompt')
  if (!prompt) {
    process.stderr.write('[dsh-feishu] systemPrompt missing; product prompts not loaded\n')
    return
  }

  for (const spec of SECTIONS) {
    prompt.section({
      name: spec.name,
      order: spec.order,
      text: readPrompt(spec.file),
    })
  }

  const mem = readMemoryIndex()
  prompt.section({
    name: 'feishu:memory',
    order: 40,
    text: memorySectionText(),
  })
  if (mem.ok) {
    process.stderr.write(`[dsh-feishu] MEMORY pointer -> ${mem.root} (index ${mem.text.length} chars, not inlined)\n`)
  } else {
    process.stderr.write(`[dsh-feishu] MEMORY index MISSING root=${mem.root || 'none'}\n`)
  }

  attachHeaders(ctx, loadSettings())

  let version = '?'
  try { version = readPrompt('VERSION') } catch {}
  process.stderr.write(`[dsh-feishu] prompts v${version} loaded from ${PROMPTS}\n`)
}
