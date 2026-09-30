#!/usr/bin/env bash
# Single launcher: sets up deps then starts backend + frontend.
# Usage: ./dev.sh [backend-port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT/app"
BACKEND_DIR="$ROOT/backend"
PORT="${1:-8090}"

# ── Frontend: install node_modules if missing ─────────────────────────────
if [[ ! -d "$APP_DIR/node_modules" ]]; then
    echo "[WriteUp] Installing frontend dependencies..."
    (cd "$APP_DIR" && npm install)
fi

# ── Backend: create .venv if missing ─────────────────────────────────────
if [[ ! -d "$BACKEND_DIR/.venv" ]]; then
    echo "[WriteUp] Creating Python virtual environment..."
    python3 -m venv "$BACKEND_DIR/.venv"
fi

# ── Backend: install/sync requirements ───────────────────────────────────
echo "[WriteUp] Installing backend dependencies..."
"$BACKEND_DIR/.venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt"

# ── Load .env ────────────────────────────────────────────────────────────
if [[ -f "$BACKEND_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$BACKEND_DIR/.env"
    set +a
fi

# ── Start backend in background ───────────────────────────────────────────
echo "[WriteUp] Starting backend on http://localhost:${PORT}..."
cd "$BACKEND_DIR"
"$BACKEND_DIR/.venv/bin/uvicorn" main:app --host 127.0.0.1 --port "$PORT" &
BACKEND_PID=$!

# ── Start frontend (blocks until closed) ─────────────────────────────────
echo "[WriteUp] Starting frontend..."
cd "$APP_DIR"
npm run dev

# ── Cleanup on exit ───────────────────────────────────────────────────────
kill "$BACKEND_PID" 2>/dev/null || true
