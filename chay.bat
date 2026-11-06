@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Can cai Node.js: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules call npm install --ignore-scripts
node src/follow-alert.js
echo.
echo Tool da dung.
pause
