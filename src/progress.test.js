import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 别名表来自 DSH_FEISHU_MODELS，先挂一份再 import progress（表在 attach 时读）。
const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-progress-'))
const modelsPath = join(dir, 'models.json')
writeFileSync(modelsPath, JSON.stringify({
  glm: { provider: 'test-gw', model: 'glm-5.3' },
}))
process.env.DSH_FEISHU_MODELS = modelsPath

const { attachProgress } = await import('./progress.js')

function makeCtx() {
  const handlers = new Map()
  return {
    on(name, fn) {
      handlers.set(name, fn)
    },
    get(name) {
      if (name === 'tokenMeter' || name === 'sessions') return null
      return null
    },
    emit(name, ...args) {
      return handlers.get(name)(...args)
    },
  }
}

function makeLark() {
  const calls = []
  return {
    calls,
    async sendText(_chatId, text) {
      calls.push({ kind: 'text', text })
      return 'm1'
    },
    async sendFinal(_chatId, text, alias) {
      calls.push({ kind: 'final', text, alias })
      return 'm2'
    },
    async sendCard() {
      return 'card'
    },
    async editCard() {
      return true
    },
  }
}

function assistantEvent(content) {
  return {
    type: 'assistant/message',
    data: { message: { content } },
  }
}

const GLM = { provider: 'test-gw', model: 'glm-5.3' }

test('assistant text without tool-call goes to sendFinal with model alias', () => {
  const ctx = makeCtx()
  const lark = makeLark()
  attachProgress(ctx, {
    routeOf: () => ({ chatId: 'c1', chatKey: 'app::c1', lark }),
    modelOf: () => GLM,
    windowOf: () => 1_000_000,
    goalOf: () => null,
  })
  ctx.emit('session/event', { header: { id: 's1' } }, assistantEvent([
    { type: 'text', text: '评估完了：可行。' },
  ]))
  assert.equal(lark.calls.length, 1)
  assert.equal(lark.calls[0].kind, 'final')
  assert.equal(lark.calls[0].alias, 'glm')
  assert.equal(lark.calls[0].text, '评估完了：可行。')
})

test('assistant text with tool-call keeps plain sendText', () => {
  const ctx = makeCtx()
  const lark = makeLark()
  attachProgress(ctx, {
    routeOf: () => ({ chatId: 'c1', chatKey: 'app::c1', lark }),
    modelOf: () => GLM,
    windowOf: () => 1_000_000,
    goalOf: () => null,
  })
  ctx.emit('session/event', { header: { id: 's1' } }, assistantEvent([
    { type: 'text', text: '先看一下文件。' },
    { type: 'tool-call', name: 'read' },
  ]))
  assert.equal(lark.calls.length, 1)
  assert.equal(lark.calls[0].kind, 'text')
})

test('whitespace-only text is skipped in both branches', () => {
  const ctx = makeCtx()
  const lark = makeLark()
  attachProgress(ctx, {
    routeOf: () => ({ chatId: 'c1', chatKey: 'app::c1', lark }),
    modelOf: () => GLM,
    windowOf: () => 1_000_000,
    goalOf: () => null,
  })
  ctx.emit('session/event', { header: { id: 's1' } }, assistantEvent([{ type: 'text', text: '\n  \n' }]))
  ctx.emit('session/event', { header: { id: 's1' } }, assistantEvent([
    { type: 'text', text: '' },
    { type: 'tool-call' },
  ]))
  assert.equal(lark.calls.length, 0)
})
