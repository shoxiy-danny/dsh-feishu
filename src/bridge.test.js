import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverMode, waitAgentStatus, restoreOverrideAfterTurn } from './bridge.js'

test('running text still steers', () => {
  assert.equal(deliverMode('running', {}), 'steer')
  assert.equal(deliverMode('running', undefined), 'steer')
})

test('running attachment also steers', () => {
  assert.equal(deliverMode('running', { queue: 'followup' }), 'steer')
})

test('idle input always followups', () => {
  assert.equal(deliverMode('idle', {}), 'followup')
  assert.equal(deliverMode('idle', { queue: 'followup' }), 'followup')
})

test('waitAgentStatus returns true when already matching', async () => {
  assert.equal(await waitAgentStatus({ status: 'running' }, 'running', 200, 20), true)
})

test('waitAgentStatus times out when status never matches', async () => {
  assert.equal(await waitAgentStatus({ status: 'idle' }, 'running', 80, 20), false)
})

test('override restore waits for running then idle, not idle-at-start', async () => {
  const handle = { _modelRef: { current: { model: 'stf' } } }
  const prev = { model: 'grk' }
  let idleResolve
  const agent = {
    status: 'idle',
    whenIdle: () => new Promise((resolve) => { idleResolve = resolve }),
    cancel() { agent.cancelled = true },
  }
  const done = restoreOverrideAfterTurn(agent, handle, prev, { startMs: 400, idleMs: 2_000 })
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(handle._modelRef.current.model, 'stf')
  agent.status = 'running'
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(handle._modelRef.current.model, 'stf')
  idleResolve()
  agent.status = 'idle'
  await done
  assert.equal(handle._modelRef.current.model, 'grk')
  assert.equal(agent.cancelled, undefined)
})

test('override timeout cancels instead of handing off to session model mid-turn', async () => {
  const handle = { _modelRef: { current: { model: 'stf' } } }
  const prev = { model: 'grk' }
  const agent = {
    status: 'running',
    whenIdle: () => new Promise(() => {}),
    cancel() { agent.cancelled = true; agent.status = 'idle' },
  }
  await restoreOverrideAfterTurn(agent, handle, prev, { startMs: 50, idleMs: 80 })
  assert.equal(agent.cancelled, true)
  assert.equal(handle._modelRef.current.model, 'grk')
})
