import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDanger, isDangerousRemovalPath } from './guard.js'

test('broad rm is dangerous, named file is not', () => {
  assert.equal(isDangerousRemovalPath('/tmp'), true)
  assert.equal(isDangerousRemovalPath('*'), true)
  assert.equal(isDangerousRemovalPath('/tmp/one.txt'), false)
  assert.equal(classifyDanger('bash', { command: 'rm -rf /tmp' }), 'unnamed or broad rm')
  assert.equal(classifyDanger('bash', { command: 'rm /tmp/one.txt' }), null)
  assert.equal(classifyDanger('read', { file_path: '/tmp' }), null)
})

test('destructive git and kill dsh', () => {
  assert.equal(classifyDanger('bash', { command: 'git push --force' }), 'destructive git push')
  assert.equal(classifyDanger('bash', { command: 'pkill dsh' }), 'kill dsh process')
})
