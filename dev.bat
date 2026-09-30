@echo off
setlocal enabledelayedexpansion

REM Single launcher: sets up deps then starts backend + frontend.
REM Usage: dev.bat [backend-port]

set "APP_DIR=%~dp0app"
set "BACKEND_DIR=%~dp0backend"
set PORT=%1
if "!PORT!"=="" set PORT=8090

REM ── Frontend: install node_modules if missing ─────────────────────────────
if not exist "!APP_DIR!\node_modules\" (
    echo [WriteUp] Installing frontend dependencies...
    pushd "!APP_DIR!"
    npm install
    popd
    if errorlevel 1 ( echo [WriteUp] npm install failed & exit /b 1 )
)

REM ── Backend: create .venv if missing (check python.exe as health signal) ──
if not exist "!BACKEND_DIR!\.venv\Scripts\python.exe" (
    echo [WriteUp] Creating Python virtual environment...
    python -m venv "!BACKEND_DIR!\.venv"
    if errorlevel 1 ( echo [WriteUp] venv creation failed & exit /b 1 )
)

REM ── Backend: install requirements (python -m pip works without pip.exe) ───
echo [WriteUp] Installing backend dependencies...
"!BACKEND_DIR!\.venv\Scripts\python.exe" -m pip install -q -r "!BACKEND_DIR!\requirements.txt"
if errorlevel 1 ( echo [WriteUp] pip install failed & exit /b 1 )

REM ── Load .env so the backend window inherits these vars ───────────────────
if exist "!BACKEND_DIR!\.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("!BACKEND_DIR!\.env") do (
        if not "%%A:~0,1%"=="#" if not "%%A"=="" set "%%A=%%B"
    )
)

REM ── Start backend in a new console (inherits env from this process) ───────
echo [WriteUp] Starting backend on http://localhost:!PORT!...
start "WriteUp Backend" /d "!BACKEND_DIR!" "!BACKEND_DIR!\.venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port !PORT!"

REM ── Start frontend (blocks until closed) ─────────────────────────────────
echo [WriteUp] Starting frontend...
pushd "!APP_DIR!"
npm run dev
popd
