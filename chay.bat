@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Chua co Node.js. Cai ban LTS tai https://nodejs.org roi mo PowerShell va chay: npm start
  pause
  exit /b 1
)
node src\index.js
if errorlevel 1 pause
