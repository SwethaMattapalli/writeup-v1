#!/usr/bin/env bash
# Start the WriteUp backend.
# Usage: ./start.sh [port]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8000}"

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [[ -z "${OLLAMA_BASE_URL:-}" && -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "ERROR: neither OLLAMA_BASE_URL nor OPENROUTER_API_KEY is set."
  echo "Copy backend/.env.example to backend/.env and fill in one of them."
  exit 1
fi

cd "$SCRIPT_DIR"

# Create venv if missing
if [[ ! -d ".venv" ]]; then
  echo "Creating Python virtual environment…"
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -q -r requirements.txt

echo "Starting WriteUp backend on http://localhost:${PORT}"
uvicorn main:app --host 127.0.0.1 --port "$PORT"
