import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GATE_TOKENS,
  THRESHOLD_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  KEEP_VIEWS,
  PRUNE_MARKER,
  COMPACTABLE,
  measureBlocks,
  pruneBlocks,
  seenViews,
  alreadyPruned,
  applyPruneGate,
} from './microcompact.js'

function textBlocks(text) {
  return [{ type: 'text', text }]
}

function fatText(n) {
  return 'x'.repeat(n)
}

function makeSession() {
  const events = []
  const nodes = []
  const session = {
    events,
    surface: { nodes },
    append(type, data, opts) {
      const event = {
        type,
        seq: events.length,
        data,
        ...(opts || {}),
      }
      events.push(event)
      if (type === 'tool/result') {
        const op = opts?.surfaceOp
        if (op?.op === 'replace') {
          const i = nodes.indexOf(op.start)
          if (i >= 0) nodes[i] = event.seq
        } else {
          nodes.push(event.seq)
        }
      }
      return event
    },
  }
  return session
}

function addCall(session, { callId, name }) {
  const event = {
    type: 'tool/call',
    seq: session.events.length,
    data: { callId, name },
  }
  session.events.push(event)
  return event
}

function addResult(session, { callId, text, isError = false }) {
  return session.append('tool/result', {
    message: {
      content: [{
        toolCallId: callId,
        isError,
        content: textBlocks(text),
      }],
      source: { callId },
    },
  })
}

function addStepStart(session, turn, step) {
  const event = {
    type: 'step/start',
    seq: session.events.length,
    data: { turn, step },
  }
  session.events.push(event)
  return event
}

test('pruneBlocks keeps official head and tail', () => {
  const text = fatText(20_000)
  const out = pruneBlocks(textBlocks(text))
  assert.ok(out)
  const joined = out.map((b) => b.text).join('')
  assert.equal(joined.slice(0, HEAD_CHARS), text.slice(0, HEAD_CHARS))
  assert.equal(joined.slice(-TAIL_CHARS), text.slice(-TAIL_CHARS))
  assert.ok(joined.includes('tool result middle pruned'))
  assert.ok(measureBlocks(out) <= THRESHOLD_CHARS)
  assert.equal(pruneBlocks(textBlocks(fatText(THRESHOLD_CHARS))), null)
})

test('alreadyPruned recognizes official marker', () => {
  assert.equal(alreadyPruned({ content: textBlocks('hello') }), false)
  assert.equal(alreadyPruned({ content: textBlocks(`head${PRUNE_MARKER}tail`) }), true)
  assert.equal(alreadyPruned({ content: textBlocks('[旧工具结果已清] grep') }), true)
})

test('seenViews counts later step/start only', () => {
  const session = makeSession()
  addStepStart(session, 1, 1)
  const result = addResult(session, { callId: 'c1', text: fatText(9000) })
  assert.equal(seenViews(session, result.seq), 0)
  addStepStart(session, 1, 2)
  addStepStart(session, 1, 3)
  addStepStart(session, 2, 1)
  assert.equal(seenViews(session, result.seq), 3)
})

test('below 100K does not prune', () => {
  const session = makeSession()
  const state = new WeakMap()
  addCall(session, { callId: 'c1', name: 'read' })
  const result = addResult(session, { callId: 'c1', text: fatText(20_000) })
  addStepStart(session, 1, 2)
  addStepStart(session, 1, 3)
  addStepStart(session, 1, 4)
  const got = applyPruneGate(session, GATE_TOKENS - 1, state)
  assert.deepEqual(got, { opened: false, pruned: 0 })
  assert.equal(session.surface.nodes[0], result.seq)
  assert.equal(alreadyPruned(session.events[result.seq].data.message.content[0]), false)
})

test('crossing 100K freezes current results and does not prune this beat', () => {
  const session = makeSession()
  const state = new WeakMap()
  addCall(session, { callId: 'old', name: 'read' })
  addResult(session, { callId: 'old', text: fatText(20_000) })
  addStepStart(session, 1, 2)
  addStepStart(session, 1, 3)
  addStepStart(session, 1, 4)
  const first = applyPruneGate(session, GATE_TOKENS, state)
  assert.deepEqual(first, { opened: true, pruned: 0 })
  assert.equal(session.surface.nodes.length, 1)

  addCall(session, { callId: 'new', name: 'grep' })
  addResult(session, { callId: 'new', text: fatText(20_000) })
  addStepStart(session, 2, 1)
  addStepStart(session, 2, 2)
  addStepStart(session, 2, 3)
  const second = applyPruneGate(session, GATE_TOKENS + 10, state)
  assert.equal(second.opened, true)
  assert.equal(second.pruned, 1)
  const oldBlock = session.events[session.surface.nodes[0]].data.message.content[0]
  const newBlock = session.events[session.surface.nodes[1]].data.message.content[0]
  assert.equal(alreadyPruned(oldBlock), false)
  assert.equal(alreadyPruned(newBlock), true)
})

test('keep 3: prune only on the fourth send', () => {
  const session = makeSession()
  const state = new WeakMap()
  applyPruneGate(session, GATE_TOKENS, state)

  addCall(session, { callId: 'g', name: 'grep' })
  const result = addResult(session, { callId: 'g', text: fatText(12_000) })
  assert.equal(applyPruneGate(session, GATE_TOKENS + 1, state).pruned, 0)

  addStepStart(session, 1, 2)
  assert.equal(applyPruneGate(session, GATE_TOKENS + 1, state).pruned, 0)
  addStepStart(session, 1, 3)
  assert.equal(applyPruneGate(session, GATE_TOKENS + 1, state).pruned, 0)
  addStepStart(session, 1, 4)
  assert.equal(KEEP_VIEWS, 3)
  const last = applyPruneGate(session, GATE_TOKENS + 1, state)
  assert.equal(last.pruned, 1)
  assert.notEqual(session.surface.nodes[0], result.seq)
  assert.equal(alreadyPruned(session.events[session.surface.nodes[0]].data.message.content[0]), true)
})

test('short results and skill and errors stay', () => {
  const session = makeSession()
  const state = new WeakMap()
  applyPruneGate(session, GATE_TOKENS, state)

  addCall(session, { callId: 's', name: 'skill' })
  addResult(session, { callId: 's', text: fatText(20_000) })
  addCall(session, { callId: 'r', name: 'read' })
  addResult(session, { callId: 'r', text: fatText(100) })
  addCall(session, { callId: 'e', name: 'bash' })
  addResult(session, { callId: 'e', text: fatText(20_000), isError: true })
  addStepStart(session, 3, 1)
  addStepStart(session, 3, 2)
  addStepStart(session, 3, 3)
  const got = applyPruneGate(session, GATE_TOKENS + 1, state)
  assert.equal(got.pruned, 0)
  assert.equal(session.surface.nodes.length, 3)
})

test('write and edit are not on the gate list', () => {
  assert.equal(COMPACTABLE.has('write'), false)
  assert.equal(COMPACTABLE.has('edit'), false)
  assert.equal(COMPACTABLE.has('skill'), false)
  assert.equal(COMPACTABLE.has('read'), true)
})
