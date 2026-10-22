import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseResources } from './lark.js'

const HOSTS_POST = JSON.stringify({
  title: '',
  content: [[{ tag: 'text', text: '测试下这个文档看得到吗', style: [] }]],
  content_v2: [[{ tag: 'text', text: '测试下这个文档看得到吗', style: [] }]],
  files: [{
    file_key: 'file_v3_00160_3f5c345c-2bf2-4a4f-80aa-0758a1b9d58g',
    file_name: 'hosts',
    is_folder: false,
  }],
})

test('post files live beside the text, not inside content nodes', () => {
  assert.deepEqual(parseResources('post', HOSTS_POST), [{
    kind: 'file',
    fileKey: 'file_v3_00160_3f5c345c-2bf2-4a4f-80aa-0758a1b9d58g',
    name: 'hosts',
  }])
})

test('post still picks inline images and skips folders', () => {
  const raw = JSON.stringify({
    content: [[{ tag: 'img', image_key: 'img_1' }, { tag: 'file', file_key: 'file_inline', file_name: 'a.txt' }]],
    files: [{ file_key: 'file_dir', file_name: 'dir', is_folder: true }],
  })
  assert.deepEqual(parseResources('post', raw), [
    { kind: 'image', fileKey: 'img_1' },
    { kind: 'file', fileKey: 'file_inline', name: 'a.txt' },
  ])
})

test('plain file message unchanged', () => {
  assert.deepEqual(parseResources('file', JSON.stringify({
    file_key: 'file_1',
    file_name: 'a.xlsx',
  })), [{ kind: 'file', fileKey: 'file_1', name: 'a.xlsx' }])
})
