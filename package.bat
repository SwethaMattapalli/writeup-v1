@echo off
setlocal
REM Build WriteUp Windows installers (.exe).
REM After it finishes, run dist\WriteUp-Setup-0.1.0.exe to install.
REM The installed app then creates a Python venv, installs backend packages, and starts the backend.

cd /d "%~dp0"
python "%~dp0scripts\make-icon.py"
cd /d "%~dp0app"

if not exist "node_modules\" (
    echo [WriteUp] Installing npm packages...
    call npm install
    if errorlevel 1 exit /b 1
)

echo [WriteUp] Building Windows installer...
call npm run dist:win
if errorlevel 1 exit /b 1

echo.
echo [WriteUp] Installers are in: %~dp0app\dist
dir /b "%~dp0app\dist\*.exe"
