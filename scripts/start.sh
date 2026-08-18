#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.local/node22/bin:${PATH}"
export DSH_HOME="${DSH_HOME:-$ROOT/.dsh-home}"
export DSH_FEISHU_CWD="${DSH_FEISHU_CWD:-$HOME}"
export DSH_FEISHU_INBOX="${DSH_FEISHU_INBOX:-$ROOT/workspace}"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
export DSH_TELEMETRY_DISABLED=1

if [[ ! -f "$ROOT/.env" ]]; then
  echo "missing $ROOT/.env  (copy .env.example)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

if [[ -z "${DEEPSEEK_API_KEY:-}" || -z "${FEISHU_APP_ID:-}" || -z "${FEISHU_APP_SECRET:-}" ]]; then
  echo "DEEPSEEK_API_KEY / FEISHU_* missing in .env" >&2
  exit 1
fi

if [[ ! -d "$DSH_HOME/profiles/feishu" ]]; then
  echo "profile missing; run $ROOT/scripts/setup.sh first" >&2
  exit 1
fi

mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/dsh-feishu_$(date +%Y-%m-%d).log"
echo "[dsh-feishu] log $LOG"

cd "$DSH_FEISHU_CWD"
exec dsh --profile feishu >>"$LOG" 2>&1
