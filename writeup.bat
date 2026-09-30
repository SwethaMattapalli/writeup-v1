@echo off
setlocal
REM Launch WriteUp in the browser. No custom .exe — uses Python already on this PC.
cd /d "%~dp0"

if not defined OLLAMA_BASE_URL set "OLLAMA_BASE_URL=http://127.0.0.1:11434"
if not defined OLLAMA_MODEL set "OLLAMA_MODEL=qwen3"

where python >nul 2>&1
if errorlevel 1 (
    echo Python 3 is required. Install it from python.org, then run this file again.
    pause
    exit /b 1
)

if not exist "backend\.venv\Scripts\python.exe" (
    echo Creating Python virtual environment...
    python -m venv "backend\.venv"
    if errorlevel 1 ( echo venv failed & pause & exit /b 1 )
)

echo Installing backend packages...
"backend\.venv\Scripts\python.exe" -m pip install -q -r "backend\requirements.txt"
if errorlevel 1 ( echo pip install failed & pause & exit /b 1 )

echo Starting WriteUp at http://127.0.0.1:8090
echo Keep this window open. Keep Ollama running.
start "" "http://127.0.0.1:8090"
cd backend
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8090
pause
