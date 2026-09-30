#!/usr/bin/env bash
# Build WriteUp installers for the current OS (or pass a package.json script name).
# Usage:
#   ./package.sh              # Linux AppImage + .deb, Windows NSIS .exe, or macOS .dmg
#   ./package.sh dist:win     # Windows installer + portable .exe (from Linux or Windows)
#   ./package.sh dist:linux
#   ./package.sh dist:mac
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$ROOT/scripts/make-icon.py"

cd "$ROOT/app"
if [[ ! -d node_modules ]]; then
  echo "[WriteUp] Installing npm packages…"
  npm install
fi

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Linux*)  TARGET="dist:linux" ;;
    Darwin*) TARGET="dist:mac" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) TARGET="dist:win" ;;
    *)       TARGET="dist" ;;
  esac
fi

if [[ "$TARGET" == "dist:mac" || "$TARGET" == "mac" ]]; then
  echo "[WriteUp] Building signed and notarized macOS installers…"
  npm run dist:mac
  exit 0
fi

echo "[WriteUp] Building $TARGET…"
npm run "$TARGET"

# On Linux, also produce a Windows Setup.exe (Electron cannot emit NSIS without Wine).
if [[ -z "${1:-}" && "$(uname -s)" == Linux ]]; then
  echo "[WriteUp] Packaging Windows installer…"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win dir --publish never || true
  bash "$ROOT/scripts/make-windows-installer.sh" || echo "[WriteUp] Windows Setup.exe skipped"
fi

echo
echo "[WriteUp] Installers are in: $ROOT/app/dist"
ls -lh "$ROOT/app/dist" | sed -n '1,40p'
