@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Cai Node.js tu https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)
if not exist node_modules call npm install
start "" http://127.0.0.1:4173
node app\server.js
pause
