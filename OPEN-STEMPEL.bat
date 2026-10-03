@echo off
title Stempel
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

echo Starting Stempel...
echo The app will open in your browser automatically.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node server.mjs

echo.
echo Stempel has stopped. You can close this window.
pause
