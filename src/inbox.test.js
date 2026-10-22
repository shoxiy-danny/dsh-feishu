import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentNote,
  extOf,
  fileHint,
  safeLeaf,
  sniffImage,
  writeInbox,
} from './inbox.js'

test('sniffImage maps magic bytes', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), 'png')
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg')
  assert.equal(sniffImage(Buffer.from(Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
  ]))), 'webp')
  assert.equal(sniffImage(Buffer.from('not-an-image!!')), null)
})

test('safeLeaf keeps Chinese names and strips paths', () => {
  assert.equal(safeLeaf('横州图.zip'), '横州图.zip')
  assert.equal(safeLeaf('C:\\\\Users\\\\a\\\\营业执照.jpg'), '营业执照.jpg')
  assert.equal(safeLeaf('/tmp/a/b.png'), 'b.png')
  assert.equal(safeLeaf('a/b\\c:*.png'), 'c__.png')
  assert.equal(safeLeaf(''), '')
  assert.equal(safeLeaf('..'), '')
})

test('writeInbox uses original filename', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-'))
  try {
    const path = writeInbox(root, '横州图.zip', Buffer.from('zip'))
    assert.match(path, /inbox\/\d+-横州图\.zip$/)
    assert.equal(readFileSync(path, 'utf8'), 'zip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fileHint routes zip xlsx docx pdf away from read', () => {
  assert.match(fileHint('文件', '横州图.zip'), /压缩包/)
  assert.match(fileHint('文件', 'a.xlsx'), /openpyxl/)
  assert.match(fileHint('文件', 'a.docx'), /Word/)
  assert.match(fileHint('文件', 'a.pdf'), /PDF/)
  assert.match(fileHint('文件', 'a.txt'), /立刻用 read/)
  assert.match(fileHint('语音', 'a.opus'), /OmniCore/)
  assert.doesNotMatch(fileHint('文件', '横州图.zip'), /立刻用 read 读/)
})

test('attachmentNote vision image does not ask read_image', () => {
  const note = attachmentNote('图片', '执照.jpg', '/inbox/执照.jpg', { vision: true })
  assert.match(note, /直接看像素/)
  assert.match(note, /不要再 read/)
})

test('attachmentNote zip tells unzip', () => {
  const note = attachmentNote('文件', '横州图.zip', '/inbox/横州图.zip')
  assert.match(note, /横州图\.zip/)
  assert.match(note, /压缩包/)
  assert.doesNotMatch(note, /立刻用 read 读/)
})

test('extOf reads suffix from original name', () => {
  assert.equal(extOf({ name: '横州图.zip' }), 'zip')
  assert.equal(extOf({ kind: 'audio' }), 'opus')
  assert.equal(extOf({ kind: 'video' }), 'mp4')
  assert.equal(extOf({}), 'bin')
})
