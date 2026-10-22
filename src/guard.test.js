import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { rewriteRestartCommand, isDangerousRemovalPath, classifyDanger } from './guard.js'

const HOME = homedir()

const KEY = 'cli_testbot::oc_0000000000000000000000000000'
const SCRIPT = '/home/u/bin/restart-harness.sh'

test('restart script without key gets current window appended', () => {
  assert.equal(
    rewriteRestartCommand('bash ~/bin/restart-harness.sh "续跑指令"', KEY, SCRIPT),
    `bash ~/bin/restart-harness.sh "续跑指令" ${JSON.stringify(KEY)}`,
  )
})

test('restart script with no args keeps empty text and sets key as $2', () => {
  assert.equal(
    rewriteRestartCommand('bash ~/bin/restart-harness.sh', KEY, SCRIPT),
    `bash ~/bin/restart-harness.sh "" ${JSON.stringify(KEY)}`,
  )
})

test('restart script that already has a chatKey is left alone', () => {
  const cmd = 'bash ~/bin/restart-harness.sh "续跑" "cli_other::oc_other"'
  assert.equal(rewriteRestartCommand(cmd, KEY, SCRIPT), cmd)
})

test('unrelated bash is left alone', () => {
  assert.equal(rewriteRestartCommand('ls /tmp', KEY, SCRIPT), 'ls /tmp')
})

test('missing chatKey or script name does not rewrite', () => {
  const cmd = 'bash ~/bin/restart-harness.sh "续跑"'
  assert.equal(rewriteRestartCommand(cmd, '', SCRIPT), cmd)
  assert.equal(rewriteRestartCommand(cmd, 'local', SCRIPT), cmd)
  assert.equal(rewriteRestartCommand(cmd, KEY, ''), cmd)
})

test('a different script name is not touched', () => {
  const cmd = 'bash ~/bin/restart-other.sh "续跑"'
  assert.equal(rewriteRestartCommand(cmd, KEY, SCRIPT), cmd)
})

test('shell variable rm targets are not treated as home-dir paths', () => {
  assert.equal(isDangerousRemovalPath('$COOKIE_JAR', HOME), false)
  assert.equal(isDangerousRemovalPath('${COOKIE_JAR}', HOME), false)
  assert.equal(isDangerousRemovalPath('"$TMP_FILE"', HOME), false)
  assert.equal(isDangerousRemovalPath('$(mktemp)', HOME), false)
  assert.equal(isDangerousRemovalPath('`mktemp`', HOME), false)
})

test('$HOME and its children are still dangerous', () => {
  assert.equal(isDangerousRemovalPath('$HOME', HOME), true)
  assert.equal(isDangerousRemovalPath('${HOME}', HOME), true)
  assert.equal(isDangerousRemovalPath('$HOME/.cache', HOME), true)
  assert.equal(isDangerousRemovalPath('~/Projects', HOME), true)
})

test('cookie-jar cleanup no longer raises a guard card', () => {
  assert.equal(classifyDanger('bash', { command: 'rm -f "$COOKIE_JAR"' }), null)
  assert.equal(classifyDanger('bash', { command: 'rm -f "$COOKIE_JAR"\n' }), null)
})

test('broad and home rm are still caught', () => {
  assert.equal(classifyDanger('bash', { command: 'rm -rf' }), '未点名或大范围 rm')
  assert.equal(classifyDanger('bash', { command: 'rm -rf "$HOME"' }), '未点名或大范围 rm')
  assert.equal(classifyDanger('bash', { command: 'rm -rf ~/Projects' }), '未点名或大范围 rm')
  assert.equal(classifyDanger('bash', { command: 'rm -rf /tmp/x/*' }), '未点名或大范围 rm')
  assert.equal(classifyDanger('bash', { command: 'rm -rf .' }), '未点名或大范围 rm')
  assert.equal(classifyDanger('bash', { command: 'find ~/x -delete' }), '批量删除')
  assert.equal(classifyDanger('bash', { command: 'ls | xargs rm' }), '批量删除')
})

test('killing the daemon itself is caught', () => {
  assert.equal(classifyDanger('bash', { command: 'pkill -f dsh' }), '自杀重启 / 杀本进程')
  assert.equal(classifyDanger('bash', { command: 'pkill -f dsh-feishu' }), '自杀重启 / 杀本进程')
  assert.equal(classifyDanger('bash', { command: 'kill $(pidof dsh --profile feishu)' }), '自杀重启 / 杀本进程')
  assert.equal(classifyDanger('bash', { command: 'kill -9 12345' }), null)
})
