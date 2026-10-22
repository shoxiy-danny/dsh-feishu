import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aliasMap, aliasOf, loadModels, modelGroups, selectionFromAlias, visionOf, windowOf } from './models.js'

test('builtin models when no file', () => {
  const prev = process.env.DSH_FEISHU_MODELS
  delete process.env.DSH_FEISHU_MODELS
  const models = loadModels()
  assert.deepEqual(Object.keys(models).sort(), ['dsf'])
  assert.equal(models.dsf.provider, 'deepseek-official')
  assert.equal(aliasOf(models, { provider: 'deepseek-official', model: 'deepseek-flash' }), 'dsf')
  assert.equal(windowOf(models, models.dsf), 1_000_000)
  assert.deepEqual(selectionFromAlias(models, 'dsf'), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
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

test('tier / vision / short defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-tier-'))
  const path = join(dir, 'models.json')
  writeFileSync(path, JSON.stringify({
    a: { provider: 'gw', model: 'big-pro', tier: 'pro', vision: true, short: 'big' },
    b: { provider: 'gw', model: 'small-flash' },
    c: { provider: 'gw', model: 'weird', tier: 'nonsense' },
  }))
  const prev = process.env.DSH_FEISHU_MODELS
  process.env.DSH_FEISHU_MODELS = path
  const models = loadModels()
  assert.equal(models.a.tier, 'pro')
  assert.equal(models.a.vision, true)
  assert.equal(models.a.short, 'big')
  assert.equal(models.b.tier, 'other')
  assert.equal(models.b.vision, false)
  assert.equal(models.b.short, 'small-flash')
  assert.equal(models.c.tier, 'other')
  assert.equal(visionOf(models, { provider: 'gw', model: 'big-pro' }), true)
  assert.equal(visionOf(models, { provider: 'gw', model: 'small-flash' }), false)
  assert.equal(visionOf(models, null), false)

  const view = modelGroups(models, 'a')
  assert.equal(view.current, 'a')
  assert.deepEqual(view.groups.map((g) => g.key), ['pro', 'other'])
  assert.deepEqual(view.groups[0].items.map((i) => i.alias), ['a'])
  if (prev === undefined) delete process.env.DSH_FEISHU_MODELS
  else process.env.DSH_FEISHU_MODELS = prev
})
