import { existsSync, readFileSync } from 'node:fs'

const BUILTIN = {
  dsf: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    label: 'dsf = deepseek-flash',
    window: 1_000_000,
  },
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const [alias, spec] of Object.entries(raw)) {
    const key = String(alias || '').trim().toLowerCase()
    if (!key || !spec?.provider || !spec?.model) continue
    out[key] = {
      provider: String(spec.provider),
      model: String(spec.model),
      label: spec.label ? String(spec.label) : `${key} = ${spec.model}`,
      window: Number(spec.window) > 0 ? Number(spec.window) : 1_000_000,
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
