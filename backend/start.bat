@echo off
setlocal enabledelayedexpansion

REM Start the WriteUp backend on Windows.
REM Usage: start.bat [port]
REM Example: start.bat 8000

set SCRIPT_DIR=%~dp0
set PORT=%1
if "!PORT!"=="" set PORT=8000

REM Load .env if present
if exist "!SCRIPT_DIR!.env" (
    for /f "usebackq tokens=1,* delims==" %%A in ("!SCRIPT_DIR!.env") do (
        if not "%%A:~0,1%"=="#" if not "%%A"=="" set "%%A=%%B"
    )
)

cd /d "!SCRIPT_DIR!"

REM Create venv if missing
if not exist "venv" (
    echo Creating Python virtual environment...
    python -m venv venv
)

REM Activate venv and install requirements
call venv\Scripts\activate.bat
pip install -q -r requirements.txt

echo Starting WriteUp backend on http://localhost:!PORT!
uvicorn main:app --host 127.0.0.1 --port !PORT!
