@echo off
cd /d "%~dp0"
node src\index.js
if errorlevel 1 pause
