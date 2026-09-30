#!/usr/bin/env python3
"""Pack WriteUp for Windows using the official signed electron.exe.

electron-builder rewrites the EXE (icons / asar integrity) and that drops
Electron's Authenticode signature. Windows Application Control then blocks
WriteUp.exe. This packer leaves electron.exe untouched.
"""
from __future__ import annotations

import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
OUT = APP / "dist" / "WriteUp-win"
CACHE = Path("/tmp/writeup-electron-cache")
ELECTRON_VERSION = "33.4.11"
ZIP_NAME = f"electron-v{ELECTRON_VERSION}-win32-x64.zip"
URL = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/{ZIP_NAME}"


def copytree(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def main() -> None:
    if not (APP / "build" / "index.html").exists():
        raise SystemExit("Run `npm run build` in app/ first.")

    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / ZIP_NAME
    if not archive.exists():
        print(f"[WriteUp] Downloading signed Electron {ELECTRON_VERSION}…")
        urllib.request.urlretrieve(URL, archive)

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    print("[WriteUp] Extracting official electron.exe (signature kept)…")
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(OUT)

    default_asar = OUT / "resources" / "default_app.asar"
    if default_asar.exists():
        default_asar.unlink()

    app_dir = OUT / "resources" / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(APP / "package.json", app_dir / "package.json")
    copytree(APP / "electron", app_dir / "electron")
    copytree(APP / "build", app_dir / "build")

    backend_src = ROOT / "backend"
    backend_dst = OUT / "resources" / "backend"
    backend_dst.mkdir(parents=True, exist_ok=True)
    for name in ("main.py", "models.py", "llm.py", "db.py", "sanitize.py", "requirements.txt"):
        src = backend_src / name
        if src.exists():
            shutil.copy2(src, backend_dst / name)

    (OUT / "WriteUp.cmd").write_text(
        "@echo off\r\n"
        "cd /d \"%~dp0\"\r\n"
        "if /I \"%~1\"==\"--startup\" timeout /t 12 /nobreak >nul\r\n"
        "start \"\" /min \"%~dp0electron.exe\"\r\n",
        encoding="ascii",
    )

    pkg = json.loads((APP / "package.json").read_text())
    print(f"[WriteUp] Windows folder ready: {OUT}")
    print(f"[WriteUp] Launcher: {OUT / 'WriteUp.cmd'} -> signed electron.exe")
    print(f"[WriteUp] version {pkg.get('version')}")


if __name__ == "__main__":
    main()
