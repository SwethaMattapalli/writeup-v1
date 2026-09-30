#!/usr/bin/env bash
# Launch WriteUp in the browser. No custom .exe.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen3}"

if ! command -v python3 >/dev/null; then
  echo "Python 3 is required."
  exit 1
fi

if [[ ! -x "$ROOT/backend/.venv/bin/python" ]]; then
  echo "[WriteUp] Creating virtual environment…"
  python3 -m venv "$ROOT/backend/.venv"
fi

echo "[WriteUp] Installing backend packages…"
"$ROOT/backend/.venv/bin/python" -m pip install -q -r "$ROOT/backend/requirements.txt"

echo "[WriteUp] Opening http://127.0.0.1:8090"
(sleep 1; xdg-open "http://127.0.0.1:8090" >/dev/null 2>&1 || open "http://127.0.0.1:8090" >/dev/null 2>&1 || true) &

cd "$ROOT/backend"
exec "$ROOT/backend/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8090
