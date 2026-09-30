#!/usr/bin/env python3
"""Pack WriteUp for macOS using the official signed Electron.app.

Produces zip archives (no .dmg — that requires macOS tools). Users unzip and
drag WriteUp.app into /Applications.

Built from Linux/WSL the same way as the Windows signed-electron packer.

Important: macOS refuses to launch the app if Unix execute bits are lost in the
zip (common when packing on Linux). This script preserves +x from the official
Electron zip and forces it on Mach-O / helper binaries.
"""
from __future__ import annotations

import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
OUT_ROOT = APP / "dist"
CACHE = Path("/tmp/writeup-electron-cache")
ELECTRON_VERSION = "33.4.11"

# Apple Silicon first (most new Macs), then Intel.
ARCHES = (
    ("arm64", "darwin-arm64"),
    ("x64", "darwin-x64"),
)


def copytree(src: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    """True when the zip entry is a Unix symlink (critical for .app frameworks)."""
    return stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF)


def extract_zip_with_symlinks(archive: Path, dest: Path) -> None:
    """Extract Electron.zip recreating symlinks (ZipFile.extractall breaks them on Linux)."""
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = info.filename
            if not name or name.endswith("/"):
                (dest / name).mkdir(parents=True, exist_ok=True)
                continue
            out = dest / name
            out.parent.mkdir(parents=True, exist_ok=True)
            if is_zip_symlink(info):
                target = zf.read(info).decode("utf-8")
                if out.exists() or out.is_symlink():
                    out.unlink()
                out.symlink_to(target)
                continue
            with zf.open(info) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            mode = (info.external_attr >> 16) & 0o7777
            if mode:
                try:
                    out.chmod(mode)
                except OSError:
                    pass


def download_electron(platform_arch: str) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    zip_name = f"electron-v{ELECTRON_VERSION}-{platform_arch}.zip"
    archive = CACHE / zip_name
    if not archive.exists():
        url = (
            f"https://github.com/electron/electron/releases/download/"
            f"v{ELECTRON_VERSION}/{zip_name}"
        )
        print(f"[WriteUp] Downloading {zip_name}…")
        urllib.request.urlretrieve(url, archive)
    return archive


def unix_mode_from_zipinfo(info: zipfile.ZipInfo) -> int:
    mode = (info.external_attr >> 16) & 0o7777
    return mode


def restore_permissions_from_zip(archive: Path, dest_root: Path) -> None:
    """Re-apply +x from the official Electron zip after extractall."""
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            mode = unix_mode_from_zipinfo(info)
            target = dest_root / info.filename
            if not target.is_file():
                continue
            if mode & 0o111:
                target.chmod(target.stat().st_mode | 0o111)
            elif mode:
                # Keep non-exec mode bits when present
                target.chmod((target.stat().st_mode & ~0o777) | (mode & 0o777))


def force_macos_executables(app_bundle: Path) -> None:
    """Ensure launchers / helpers / dylibs are executable (Gatekeeper + dyld)."""
    patterns = (
        "Contents/MacOS/*",
        "Contents/Frameworks/*/Versions/*/Helpers/*",
        "Contents/Frameworks/*/*.app/Contents/MacOS/*",
        "Contents/Frameworks/*.framework/Versions/*/Helpers/*",
        "Contents/Frameworks/**/MacOS/*",
    )
    for pattern in patterns:
        for path in app_bundle.glob(pattern):
            if path.is_file():
                path.chmod(path.stat().st_mode | 0o111)

    # Framework binaries often have no extension
    frameworks = app_bundle / "Contents" / "Frameworks"
    if frameworks.is_dir():
        for path in frameworks.rglob("*"):
            if not path.is_file():
                continue
            name = path.name
            rel = str(path.relative_to(app_bundle)).replace("\\", "/")
            needs_exec = (
                "/MacOS/" in rel
                or name.endswith(".dylib")
                or name.endswith(".so")
                or name in {"Electron", "Electron Helper", "Electron Helper (GPU)",
                            "Electron Helper (Plugin)", "Electron Helper (Renderer)",
                            "chrome_crashpad_handler"}
                or (path.parent.name == "Versions" or path.parent.name in {"A", "Current"})
                and "Framework" in name
            )
            # Also: file named same as framework folder without extension
            if path.parent.name in {"A", "Current"} and "." not in name:
                needs_exec = True
            if needs_exec:
                path.chmod(path.stat().st_mode | 0o111)


def patch_plist(plist_path: Path, *, name: str, bundle_id: str) -> None:
    """Update CFBundle* keys so Dock / Finder show WriteUp."""
    if not plist_path.exists():
        return
    raw = plist_path.read_bytes()
    try:
        data = plistlib.loads(raw)
    except Exception:
        text = raw.decode("utf-8", errors="replace")
        for key, value in (
            ("CFBundleName", name),
            ("CFBundleDisplayName", name),
            ("CFBundleIdentifier", bundle_id),
        ):
            text = re.sub(
                rf"(<key>{key}</key>\s*<string>)[^<]*(</string>)",
                rf"\g<1>{value}\g<2>",
                text,
            )
        plist_path.write_text(text, encoding="utf-8")
        return

    data["CFBundleName"] = name
    data["CFBundleDisplayName"] = name
    data["CFBundleIdentifier"] = bundle_id
    data["CFBundleExecutable"] = data.get("CFBundleExecutable", "Electron")
    with plist_path.open("wb") as f:
        plistlib.dump(data, f, fmt=plistlib.FMT_XML)


def brand_app_bundle(app_bundle: Path) -> Path:
    """Rename Electron.app → WriteUp.app and patch Info.plist files."""
    dest = app_bundle.parent / "WriteUp.app"
    if dest.exists():
        shutil.rmtree(dest)
    app_bundle.rename(dest)

    patch_plist(
        dest / "Contents" / "Info.plist",
        name="WriteUp",
        bundle_id="com.writeup.assistant",
    )

    frameworks = dest / "Contents" / "Frameworks"
    if frameworks.is_dir():
        for helper in frameworks.glob("*.app"):
            helper_plist = helper / "Contents" / "Info.plist"
            if helper_plist.exists():
                try:
                    data = plistlib.loads(helper_plist.read_bytes())
                    ident = str(data.get("CFBundleIdentifier", ""))
                    if ident.startswith("com.github.Electron"):
                        data["CFBundleIdentifier"] = ident.replace(
                            "com.github.Electron", "com.writeup.assistant", 1
                        )
                        with helper_plist.open("wb") as f:
                            plistlib.dump(data, f, fmt=plistlib.FMT_XML)
                except Exception:
                    pass

    icns = APP / "buildResources" / "icon.icns"
    png = APP / "buildResources" / "icon.png"
    res = dest / "Contents" / "Resources"
    if icns.exists():
        shutil.copy2(icns, res / "electron.icns")
    elif png.exists():
        shutil.copy2(png, res / "icon.png")

    return dest


def zip_add_file(zf: zipfile.ZipFile, path: Path, arcname: str) -> None:
    """Add a file preserving Unix permission bits (critical for macOS launch)."""
    import time as _time

    st = path.stat(follow_symlinks=False)
    mode = stat.S_IFREG | (st.st_mode & 0o7777)
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (mode & 0xFFFF) << 16
    info.create_system = 3  # Unix
    info.date_time = _time.localtime(st.st_mtime)[:6]
    with path.open("rb") as f:
        zf.writestr(info, f.read())


def zip_add_symlink(zf: zipfile.ZipFile, path: Path, arcname: str) -> None:
    """Store a symlink so macOS unzip recreates the .app framework links."""
    import time as _time

    target = os.readlink(path)
    info = zipfile.ZipInfo(arcname)
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o755) << 16
    info.compress_type = zipfile.ZIP_STORED
    info.date_time = _time.localtime(path.lstat().st_mtime)[:6]
    zf.writestr(info, target.encode("utf-8"))


def zip_add_tree(zf: zipfile.ZipFile, root: Path, arc_prefix: str) -> None:
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        arc = f"{arc_prefix}/{rel.as_posix()}"
        if path.is_symlink():
            zip_add_symlink(zf, path, arc)
        elif path.is_file():
            zip_add_file(zf, path, arc)
        elif path.is_dir():
            # directories are implied by file paths; skip
            pass


def adhoc_sign_app(app_bundle: Path, entitlements: Path) -> None:
    """Ad-hoc sign on Linux via rcodesign so Apple Silicon will launch the app."""
    rcodesign = shutil.which("rcodesign") or str(Path.home() / ".cargo" / "bin" / "rcodesign")
    if not Path(rcodesign).is_file():
        raise SystemExit(
            "rcodesign not found. Install with: cargo install apple-codesign\n"
            "Apple Silicon Macs refuse unsigned/modified Electron apps."
        )
    cmd = [rcodesign, "sign"]
    if entitlements.is_file():
        cmd += [
            "--code-signature-flags",
            "runtime",
            "--entitlements-xml-file",
            str(entitlements),
        ]
    cmd.append(str(app_bundle))
    print(f"[WriteUp] Ad-hoc signing with rcodesign…")
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr)
        # Retry without hardened-runtime flag (still ad-hoc)
        cmd2 = [rcodesign, "sign"]
        if entitlements.is_file():
            cmd2 += ["--entitlements-xml-file", str(entitlements)]
        cmd2.append(str(app_bundle))
        print("[WriteUp] Retrying sign without runtime flag…")
        proc2 = subprocess.run(cmd2, capture_output=True, text=True)
        if proc2.returncode != 0:
            print(proc2.stdout)
            print(proc2.stderr)
            raise SystemExit("rcodesign failed — Mac arm64 build would not launch")
        print(proc2.stdout[-500:] if proc2.stdout else "signed (retry ok)")
    else:
        print(proc.stdout[-500:] if proc.stdout else "signed ok")


def pack_arch(arch_label: str, platform_arch: str, version: str) -> Path:
    archive = download_electron(platform_arch)
    work = OUT_ROOT / f"_mac-work-{arch_label}"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    print(f"[WriteUp] Extracting Electron {platform_arch} (preserving symlinks)…")
    extract_zip_with_symlinks(archive, work)
    restore_permissions_from_zip(archive, work)

    electron_app = work / "Electron.app"
    if not electron_app.is_dir():
        raise SystemExit(f"Electron.app missing in {archive}")

    resources = electron_app / "Contents" / "Resources"
    default_asar = resources / "default_app.asar"
    if default_asar.exists():
        default_asar.unlink()

    app_dir = resources / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(APP / "package.json", app_dir / "package.json")
    copytree(APP / "electron", app_dir / "electron")
    copytree(APP / "build", app_dir / "build")

    backend_dst = resources / "backend"
    backend_dst.mkdir(parents=True, exist_ok=True)
    backend_src = ROOT / "backend"
    for name in ("main.py", "models.py", "llm.py", "db.py", "sanitize.py", "requirements.txt"):
        src = backend_src / name
        if src.exists():
            shutil.copy2(src, backend_dst / name)

    writeup_app = brand_app_bundle(electron_app)
    force_macos_executables(writeup_app)

    electron_bin = writeup_app / "Contents" / "MacOS" / "Electron"
    if not electron_bin.is_file():
        raise SystemExit(f"Missing launcher: {electron_bin}")
    if not (electron_bin.stat().st_mode & 0o111):
        raise SystemExit(f"Launcher is not executable: {electron_bin}")

    # Align display version BEFORE signing (signature covers Info.plist)
    entitlements = ROOT / "scripts" / "mac-entitlements.plist"
    try:
        info_plist = writeup_app / "Contents" / "Info.plist"
        data = plistlib.loads(info_plist.read_bytes())
        data["CFBundleShortVersionString"] = version
        data["CFBundleVersion"] = version
        data["LSMinimumSystemVersion"] = "12.0"
        data["LSApplicationCategoryType"] = "public.app-category.productivity"
        # Without this key macOS silently denies the System Events Cmd+C / Cmd+V
        # that capture the selection, so every hotkey shows "No text selected".
        data["NSAppleEventsUsageDescription"] = (
            "WriteUp sends Copy and Paste keystrokes to the app you are "
            "typing in so it can read and replace the selected text."
        )
        with info_plist.open("wb") as f:
            plistlib.dump(data, f, fmt=plistlib.FMT_XML)
    except Exception as exc:
        print(f"[WriteUp] warning: could not bump Info.plist version ({exc})")

    adhoc_sign_app(writeup_app, entitlements)

    # Stage folder users get after: tar -xzf WriteUp-*-mac-arm64.tar.gz
    stage = work / f"WriteUp-{version}-mac-{arch_label}"
    stage.mkdir(parents=True, exist_ok=True)
    staged_app = stage / "WriteUp.app"
    if staged_app.exists():
        shutil.rmtree(staged_app)
    shutil.copytree(writeup_app, staged_app, symlinks=True)
    if entitlements.exists():
        shutil.copy2(entitlements, stage / "mac-entitlements.plist")

    archive_name = f"WriteUp-{version}-mac-{arch_label}.tar.gz"
    folder_name = f"WriteUp-{version}-mac-{arch_label}"

    install_script = stage / "INSTALL-WriteUp.command"
    install_script.write_text(
        "#!/bin/bash\n"
        "set -euo pipefail\n"
        'DIR="$(cd "$(dirname "$0")" && pwd)"\n'
        'APP="$DIR/WriteUp.app"\n'
        'ENT="$DIR/mac-entitlements.plist"\n'
        'DEST="/Applications/WriteUp.app"\n'
        'echo ""\n'
        'echo "========================================"\n'
        'echo " WriteUp installer (Apple Silicon / Intel)"\n'
        'echo "========================================"\n'
        'if [[ ! -d "$APP" ]]; then\n'
        f'  osascript -e \'display dialog "WriteUp.app missing. Extract with:\\n tar -xzf {archive_name}" buttons {{"OK"}} with icon stop\'\n'
        "  exit 1\n"
        "fi\n"
        'FW="$APP/Contents/Frameworks/Electron Framework.framework/Electron Framework"\n'
        'if [[ -f "$FW" && ! -L "$FW" ]]; then\n'
        '  SIZE=$(stat -f%z "$FW" 2>/dev/null || echo 0)\n'
        '  if [[ "$SIZE" -lt 1000 ]]; then\n'
        f'    osascript -e \'display dialog "Broken app copy.\\nDo NOT use Finder unzip.\\nUse Terminal:\\n  tar -xzf {archive_name}\\n  cd {folder_name}\\n  xattr -cr .\\n  ./INSTALL-WriteUp.command" buttons {{"OK"}} with icon stop\'\n'
        "    exit 1\n"
        "  fi\n"
        "fi\n"
        'echo "[1/4] Clearing quarantine…"\n'
        'xattr -cr "$APP" || true\n'
        'xattr -cr "$DIR" || true\n'
        'echo "[2/4] Re-signing on this Mac…"\n'
        'chmod +x "$APP/Contents/MacOS/Electron" || true\n'
        'if [[ -f "$ENT" ]]; then\n'
        '  codesign --force --deep --sign - --timestamp=none --entitlements "$ENT" "$APP"\n'
        "else\n"
        '  codesign --force --deep --sign - --timestamp=none "$APP"\n'
        "fi\n"
        'echo "[3/4] Installing to /Applications…"\n'
        'rm -rf "$DEST"\n'
        'cp -R "$APP" "$DEST"\n'
        'xattr -cr "$DEST" || true\n'
        'if [[ -f "$ENT" ]]; then\n'
        '  codesign --force --deep --sign - --timestamp=none --entitlements "$ENT" "$DEST" || true\n'
        "fi\n"
        '# Re-signing changes the ad-hoc signature, so any old Accessibility /\n'
        '# Automation grant no longer matches (toggle shows ON but copy fails).\n'
        'tccutil reset Accessibility com.writeup.assistant >/dev/null 2>&1 || true\n'
        'tccutil reset AppleEvents com.writeup.assistant >/dev/null 2>&1 || true\n'
        'echo ""\n'
        'echo "When WriteUp opens, allow BOTH prompts:"\n'
        'echo "  - Accessibility: System Settings > Privacy & Security > Accessibility > WriteUp ON"\n'
        'echo "  - Automation: allow WriteUp to control System Events"\n'
        'echo "Then quit WriteUp from the menu-bar icon and open it again."\n'
        'echo ""\n'
        'echo "[4/4] Opening WriteUp…"\n'
        'open "$DEST"\n'
        'osascript -e \'display notification "WriteUp installed. Look for the menu-bar icon." with title "WriteUp"\' || true\n'
        'echo "Done. Select text → Command+Shift+G"\n',
        encoding="utf-8",
    )
    install_script.chmod(0o755)

    (stage / "README-INSTALL.txt").write_text(
        f"WriteUp for macOS ({'Apple Silicon' if arch_label == 'arm64' else 'Intel'})\n"
        "==============================\n\n"
        "Do NOT double-click the .zip or .tar.gz in Finder — that breaks the app,\n"
        "and double-clicking also leaves this whole folder quarantined, which\n"
        "blocks the installer script with a 'cannot be verified' error.\n\n"
        "Run these exact lines in Terminal (paste them together):\n\n"
        "  cd ~/Downloads\n"
        f"  tar -xzf {archive_name}\n"
        f"  cd {folder_name}\n"
        "  xattr -cr .\n"
        "  ./INSTALL-WriteUp.command\n\n"
        "The 'xattr -cr .' line is required — it must run BEFORE the install\n"
        "script, not after. Without it, macOS blocks the script from running\n"
        "at all (even from Terminal), because it was extracted from a\n"
        "downloaded, quarantined archive.\n\n"
        "If it's still blocked afterwards: System Settings → Privacy & Security\n"
        "→ scroll down → Open Anyway.\n",
        encoding="utf-8",
    )

    out_tar = OUT_ROOT / f"WriteUp-{version}-mac-{arch_label}.tar.gz"
    if out_tar.exists():
        out_tar.unlink()
    print(f"[WriteUp] Creating {out_tar.name} (primary for Mac)…")
    with tarfile.open(out_tar, "w:gz") as tf:
        tf.add(stage, arcname=stage.name)

    out_zip = OUT_ROOT / f"WriteUp-{version}-mac-{arch_label}.zip"
    if out_zip.exists():
        out_zip.unlink()
    print(f"[WriteUp] Creating {out_zip.name} (secondary)…")
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(stage.rglob("*")):
            if path.is_dir() and not path.is_symlink():
                continue
            arc = f"{stage.name}/{path.relative_to(stage).as_posix()}"
            if path.is_symlink():
                zip_add_symlink(zf, path, arc)
            elif path.is_file():
                zip_add_file(zf, path, arc)

    shutil.rmtree(work)

    check = OUT_ROOT / f"_mac-verify-{arch_label}"
    if check.exists():
        shutil.rmtree(check)
    check.mkdir()
    with tarfile.open(out_tar, "r:gz") as tf:
        tf.extractall(check)
    fw = next(check.rglob("Electron Framework.framework")) / "Electron Framework"
    if not fw.is_symlink():
        raise SystemExit(f"tar.gz verify failed: {fw} is not a symlink")
    electron = next(check.rglob("Contents/MacOS/Electron"))
    if not (electron.stat().st_mode & 0o111):
        raise SystemExit("tar.gz verify failed: Electron not executable")
    shutil.rmtree(check)

    print(f"[WriteUp] wrote {out_tar} ({out_tar.stat().st_size} bytes) ← USE THIS ON MAC")
    return out_tar


def main() -> None:
    if not (APP / "build" / "index.html").exists():
        raise SystemExit("Run `npm run build` in app/ first.")

    pkg = json.loads((APP / "package.json").read_text())
    version = str(pkg.get("version", "0.1.0"))
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    outputs = []
    for arch_label, platform_arch in ARCHES:
        outputs.append(pack_arch(arch_label, platform_arch, version))

    print("[WriteUp] macOS packages ready:")
    for p in outputs:
        print(f"  - {p}")
    print("[WriteUp] Signed + packaged as .tar.gz (use Terminal extract on Mac).")
    print("[WriteUp] Do NOT double-click .zip in Finder — it breaks the app.")


if __name__ == "__main__":
    main()
