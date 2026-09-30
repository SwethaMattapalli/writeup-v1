#!/usr/bin/env bash
# Build WriteUp-Setup-0.1.0.exe from the signed-electron Windows folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/app/dist"
UNPACKED="$DIST/WriteUp-win"
ZIP="$DIST/WriteUp-0.1.0-win-x64.zip"
OUT="$DIST/WriteUp-Setup-0.1.0.exe"
WORK="${TMPDIR:-/tmp}/writeup-sfx"
STUB_SRC="$ROOT/scripts/windows-setup-stub.go"

cd "$ROOT/app"
if [[ ! -f build/index.html ]]; then
  npm run build
fi
python3 "$ROOT/scripts/package-win-electron.py"

if [[ ! -f "$UNPACKED/electron.exe" ]]; then
  echo "Missing $UNPACKED/electron.exe" >&2
  exit 1
fi

mkdir -p "$WORK"
echo "[WriteUp] Creating Windows zip…"
rm -f "$ZIP"
python3 - <<PY
from pathlib import Path
import zipfile
src = Path("$UNPACKED")
out = Path("$ZIP")
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for p in src.rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(src))
print("wrote", out, out.stat().st_size)
PY

GO_BIN="$(command -v go || true)"
if [[ -z "$GO_BIN" ]]; then
  if [[ ! -x "$WORK/go/bin/go" ]]; then
    echo "[WriteUp] Downloading Go toolchain…"
    curl -fsSL -o "$WORK/go.tgz" "https://go.dev/dl/go1.23.6.linux-amd64.tar.gz"
    tar -C "$WORK" -xzf "$WORK/go.tgz"
  fi
  GO_BIN="$WORK/go/bin/go"
fi

echo "[WriteUp] Cross-compiling Windows installer stub…"
cd "$WORK"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO_BIN" build -ldflags="-s -w" -o "$WORK/stub.exe" "$STUB_SRC"

echo "[WriteUp] Writing $OUT"
WRITEUP_STUB="$WORK/stub.exe" WRITEUP_ZIP="$ZIP" WRITEUP_OUT="$OUT" python3 - <<'PY'
from pathlib import Path
import os, struct

stub = Path(os.environ["WRITEUP_STUB"]).read_bytes()
payload = Path(os.environ["WRITEUP_ZIP"]).read_bytes()
tag = b"WRITEUP_INSTALL1"
trailer = struct.pack("<Q", len(payload)) + tag
out = Path(os.environ["WRITEUP_OUT"])
out.write_bytes(stub + payload + trailer)
print(f"wrote {out} ({out.stat().st_size} bytes)")
PY
ls -lh "$OUT"
echo "[WriteUp] Copy WriteUp-Setup-0.1.0.exe to a Windows PC and run it."
echo "[WriteUp] If the setup EXE is blocked, unzip WriteUp-0.1.0-win-x64.zip and run WriteUp.cmd"
