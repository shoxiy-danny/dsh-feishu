import { existsSync, readFileSync } from 'node:fs'

const BUILTIN = {
  dsf: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    label: 'dsf = deepseek-flash',
    short: 'deepseek-flash',
    window: 1_000_000,
    tier: 'flash',
    vision: true,
  },
}

const TIERS = new Set(['pro', 'flash', 'cb', 'other'])

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [alias, spec] of Object.entries(raw)) {
    const key = String(alias || '').trim().toLowerCase()
    if (!key || !spec?.provider || !spec?.model) continue
    const model = String(spec.model)
    const tier = TIERS.has(String(spec.tier || '').trim().toLowerCase())
      ? String(spec.tier).trim().toLowerCase()
      : 'other'
    out[key] = {
      provider: String(spec.provider),
      model,
      label: spec.label ? String(spec.label) : `${key} = ${model}`,
      short: spec.short ? String(spec.short) : model,
      window: Number(spec.window) > 0 ? Number(spec.window) : 1_000_000,
      tier,
      vision: spec.vision === true,
    }
  }
  return Object.keys(out).length ? out : null
}

export function loadModels() {
  const path = process.env.DSH_FEISHU_MODELS
  if (path && existsSync(path)) {
    try {
      const parsed = normalize(JSON.parse(readFileSync(path, 'utf8')))
      if (parsed) {
        process.stderr.write(`[dsh-feishu] models loaded from ${path} (${Object.keys(parsed).join(', ')})\n`)
        return parsed
      }
      process.stderr.write(`[dsh-feishu] models file empty or invalid: ${path}\n`)
    } catch (err) {
      process.stderr.write(`[dsh-feishu] models file failed: ${err}\n`)
    }
  }
  return { ...BUILTIN }
}

export function aliasOf(models, sel) {
  if (!sel) return '?'
  for (const [alias, spec] of Object.entries(models)) {
    if (spec.provider === sel.provider && spec.model === sel.model) return alias
  }
  return sel.model || '?'
}

export function windowOf(models, sel) {
  if (!sel) return 1_000_000
  for (const spec of Object.values(models)) {
    if (spec.provider === sel.provider && spec.model === sel.model) return spec.window
  }
  return 1_000_000
}

// 模型能否原生吃图。表里没写的按 false 处理：走路径 + OmniCore 识图更稳。
export function visionOf(models, sel) {
  if (!sel) return false
  for (const spec of Object.values(models)) {
    if (spec.provider === sel.provider && spec.model === sel.model) return spec.vision === true
  }
  return false
}

export function selectionFromAlias(models, alias) {
  const spec = models[alias]
  if (!spec) return null
  return { provider: spec.provider, model: spec.model }
}

export function aliasMap(models) {
  const map = {}
  for (const [alias, spec] of Object.entries(models)) {
    map[`${spec.provider}:${spec.model}`] = alias
  }
  return map
}

// /model 卡片的分组。只显示表里真有的层，空层不出现。
export function modelGroups(models, current) {
  const order = [
    { key: 'pro', title: 'Pro · 重量级', hint: '硬活、长推理、写代码' },
    { key: 'flash', title: 'Flash · 轻量级', hint: '日常问答、快省' },
    { key: 'cb', title: '其它通道', hint: '第三方网关' },
    { key: 'other', title: '未分组', hint: '' },
  ]
  const groups = []
  for (const tier of order) {
    const items = Object.entries(models)
      .filter(([, spec]) => spec.tier === tier.key)
      .map(([alias, spec]) => ({ alias, label: spec.label, short: spec.short }))
    if (items.length) groups.push({ ...tier, items })
  }
  return { current, groups }
}
