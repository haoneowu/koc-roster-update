@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 26.x is required. Install it from https://nodejs.org/ and reopen your terminal.
  pause
  exit /b 1
)
node "%~dp0scripts\setup.mjs" %*
set "KOC_SETUP_RESULT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %KOC_SETUP_RESULT%
