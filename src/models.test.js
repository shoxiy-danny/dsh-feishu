import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aliasMap, aliasOf, loadModels, selectionFromAlias, windowOf } from './models.js'

test('builtin models when no file', () => {
  const prev = process.env.DSH_FEISHU_MODELS
  delete process.env.DSH_FEISHU_MODELS
  const models = loadModels()
  assert.deepEqual(Object.keys(models).sort(), ['dsf', 'dsp'])
  assert.equal(models.dsf.provider, 'deepseek-official')
  assert.equal(aliasOf(models, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }), 'dsp')
  assert.equal(windowOf(models, models.dsf), 1_000_000)
  assert.deepEqual(selectionFromAlias(models, 'dsf'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  if (prev === undefined) delete process.env.DSH_FEISHU_MODELS
  else process.env.DSH_FEISHU_MODELS = prev
})

test('load models.json override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-models-'))
  const path = join(dir, 'models.json')
  writeFileSync(path, JSON.stringify({
    glm: { provider: 'my-glm', model: 'glm-5', window: 200000 },
  }))
  const prev = process.env.DSH_FEISHU_MODELS
  process.env.DSH_FEISHU_MODELS = path
  const models = loadModels()
  assert.equal(models.glm.model, 'glm-5')
  assert.equal(models.glm.window, 200000)
  assert.equal(aliasMap(models)['my-glm:glm-5'], 'glm')
  assert.equal(models.dsf, undefined)
  if (prev === undefined) delete process.env.DSH_FEISHU_MODELS
  else process.env.DSH_FEISHU_MODELS = prev
})
