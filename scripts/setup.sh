#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/node22/bin:${PATH}"
export DSH_HOME="${DSH_HOME:-$ROOT/.dsh-home}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  echo "need Node 22 on PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null; then
  corepack enable
  corepack prepare pnpm@10.15.1 --activate
fi

if ! command -v dsh >/dev/null; then
  npm install -g @deepseek-ai/dsh
fi

mkdir -p "$DSH_HOME" "$ROOT/workspace" "$ROOT/logs"
chmod 600 "$ROOT/.env" 2>/dev/null || true

dsh plugin --profile feishu add "$ROOT"

PATCH="$DSH_HOME/profiles/feishu/cordis.patch.yml"
if [[ ! -f "$PATCH" ]] || grep -q '^\[\]$' "$PATCH"; then
  cat > "$PATCH" <<'YAML'
# Profile overlay. Bundle already disables plan-mode / hmr.
[]
YAML
fi

echo "=== dump-config ==="
dsh --profile feishu --dump-config | tee "$ROOT/logs/dump-config.yml"
echo "=== forbidden rows ==="
if grep -E 'webserver|client-ui|dsh-web-app|headless-runner' "$ROOT/logs/dump-config.yml"; then
  echo "FAIL: web/headless rows present" >&2
  exit 1
fi
echo "OK: no web-app / headless rows"
echo "Next: copy .env.example to .env, then ./scripts/start.sh"
