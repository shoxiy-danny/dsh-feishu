import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mediaTypeOf,
  contentHasImage,
  stripImageBlocks,
  stripSessionImages,
  stripMissingImageBlocks,
  stripMissingSessionImages,
  attachmentObjectPath,
} from './vision.js'
import { visionOf, visionOfAlias } from './bridge.js'

const SHA_A = `sha256:${'a'.repeat(64)}`
const SHA_B = `sha256:${'b'.repeat(64)}`

function imageBlock(name, id = 'sha256:x') {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 12,
      width: 1,
      height: 1,
      ...name ? { name } : {},
    },
  }
}

function makeSession() {
  const log = []
  const nodes = []
  const session = {
    eventAt(i) { return log[i] ?? null },
    surface: { nodes },
    append(type, data, opts) {
      const event = { type, seq: log.length, data, ...(opts || {}) }
      log.push(event)
      const op = opts?.surfaceOp
      if (op?.op === 'replace') {
        const i = nodes.indexOf(op.start)
        if (i >= 0) nodes[i] = event.seq
      } else {
        nodes.push(event.seq)
      }
      return event
    },
  }
  return { session, log, nodes }
}

test('mediaTypeOf maps sniffed kinds', () => {
  assert.equal(mediaTypeOf('png'), 'image/png')
  assert.equal(mediaTypeOf('jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('jpg'), 'image/jpeg')
  assert.equal(mediaTypeOf('webp'), 'image/webp')
  assert.equal(mediaTypeOf('gif'), 'image/gif')
  assert.equal(mediaTypeOf('bin'), 'image/png')
})

test('contentHasImage walks nested tool-result', () => {
  assert.equal(contentHasImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(contentHasImage([imageBlock('/a.png')]), true)
  assert.equal(contentHasImage([{
    type: 'tool-result',
    content: [{ type: 'text', text: 'x' }, imageBlock('/b.png')],
  }]), true)
})

test('stripImageBlocks drops images and keeps sibling text', () => {
  const out = stripImageBlocks([
    { type: 'text', text: '收到图片，已存 /inbox/a.png' },
    imageBlock('/inbox/a.png'),
  ])
  assert.deepEqual(out, [{ type: 'text', text: '收到图片，已存 /inbox/a.png' }])
  assert.equal(contentHasImage(out), false)
})

test('stripImageBlocks image-only falls back to attachment name', () => {
  const out = stripImageBlocks([imageBlock('/inbox/solo.png')])
  assert.deepEqual(out, [{ type: 'text', text: '收到图片，已存 /inbox/solo.png。这是主人刚发的附件，立刻看，不要等主人再提。' }])
})

test('stripImageBlocks image-only without name uses placeholder', () => {
  const out = stripImageBlocks([imageBlock()])
  assert.deepEqual(out, [{ type: 'text', text: '[图片已从历史移除]' }])
})

test('stripImageBlocks recurses into tool-result', () => {
  const out = stripImageBlocks([{
    type: 'tool-result',
    toolCallId: 'c1',
    isError: false,
    content: [
      { type: 'text', text: '<path>/x.png</path>' },
      imageBlock('/x.png'),
    ],
  }])
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'tool-result')
  assert.deepEqual(out[0].content, [{ type: 'text', text: '<path>/x.png</path>' }])
})

test('stripSessionImages replaces user and tool surfaces, skips text-only', () => {
  const { session, log } = makeSession()
  const userSeq = session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [
      { type: 'text', text: '收到图片，已存 /inbox/a.png' },
      imageBlock('/inbox/a.png'),
    ],
    source: { kind: 'user' },
  }).seq
  session.append('user/message', {
    id: 'u2',
    role: 'user',
    content: [{ type: 'text', text: '纯文字' }],
    source: { kind: 'user' },
  })
  const toolSeq = session.append('tool/result', {
    message: {
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'p' }, imageBlock('/t.png')],
      }],
    },
  }).seq

  const n = stripSessionImages(session)
  assert.equal(n, 2)
  const replacedUser = log.find((ev) => ev.surfaceOp?.op === 'replace' && ev.surfaceOp.start === userSeq)
  assert.ok(replacedUser)
  assert.equal(contentHasImage(replacedUser.data.content), false)
  assert.match(replacedUser.data.content[0].text, /inbox\/a\.png/)
  const replacedTool = log.find((ev) => ev.surfaceOp?.op === 'replace' && ev.surfaceOp.start === toolSeq)
  assert.ok(replacedTool)
  assert.equal(contentHasImage(replacedTool.data.message.content), false)
})

test('stripSessionImages no-op without images', () => {
  const { session } = makeSession()
  session.append('user/message', {
    content: [{ type: 'text', text: 'hi' }],
  })
  assert.equal(stripSessionImages(session), 0)
  assert.equal(stripSessionImages(null), 0)
})

test('attachmentObjectPath shards sha256', () => {
  const sha = 'a'.repeat(64)
  assert.equal(
    attachmentObjectPath('/home/user/.dsh', `sha256:${sha}`),
    `/home/user/.dsh/attachments/v1/objects/aa/${sha}`,
  )
  assert.equal(attachmentObjectPath('/x', 'bad'), null)
})

test('stripMissingImageBlocks keeps present images and replaces missing', () => {
  const present = imageBlock('/inbox/ok.png', SHA_A)
  const missing = imageBlock('/inbox/gone.png', SHA_B)
  const exists = (id) => id === SHA_A
  const out = stripMissingImageBlocks([
    { type: 'text', text: 'hi' },
    present,
    missing,
  ], exists)
  assert.equal(out[0].text, 'hi')
  assert.equal(out[1], present)
  assert.equal(out[2].type, 'text')
  assert.match(out[2].text, /gone\.png/)
  assert.equal(contentHasImage([out[1]]), true)
})

test('stripMissingImageBlocks no-op when all present', () => {
  const content = [imageBlock('/inbox/a.png', SHA_A)]
  const same = stripMissingImageBlocks(content, () => true)
  assert.equal(same, content)
})

test('stripMissingSessionImages only rewrites missing surfaces', () => {
  const { session, log } = makeSession()
  const keepSeq = session.append('user/message', {
    content: [imageBlock('/inbox/ok.png', SHA_A)],
  }).seq
  const dropSeq = session.append('user/message', {
    content: [imageBlock('/inbox/gone.png', SHA_B)],
  }).seq
  const n = stripMissingSessionImages(session, (id) => id === SHA_A)
  assert.equal(n, 1)
  assert.equal(contentHasImage(log[keepSeq].data.content), true)
  const replaced = log.find((ev) => ev.surfaceOp?.op === 'replace'
    && ev.surfaceOp.start === dropSeq)
  assert.ok(replaced)
  assert.equal(contentHasImage(replaced.data.content), false)
  assert.match(replaced.data.content[0].text, /gone\.png/)
})

test('vision is opt-in per model in the table', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-vision-'))
  const file = join(dir, 'models.json')
  writeFileSync(file, JSON.stringify({
    see: { provider: 'gw', model: 'eye-model', vision: true },
    blind: { provider: 'gw', model: 'text-model' },
  }))
  process.env.DSH_FEISHU_MODELS = file
  // bridge 在模块加载时读模型表，换表后要重新 import
  const mod = await import(`./bridge.js?t=${Date.now()}`)
  assert.equal(mod.visionOfAlias('see'), true)
  assert.equal(mod.visionOf({ provider: 'gw', model: 'eye-model' }), true)
  assert.equal(mod.visionOfAlias('blind'), false)
  assert.equal(mod.visionOf({ provider: 'gw', model: 'text-model' }), false)
  assert.equal(mod.visionOf({ provider: 'gw', model: 'not-listed' }), false)
  assert.equal(mod.visionOf(null), false)
  delete process.env.DSH_FEISHU_MODELS
})
