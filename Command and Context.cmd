@echo off
rem Command & Context launcher: starts the server in a minimized window and opens the dashboard
rem as a chromeless Edge app window (drag it to your spare monitor, then press F11 for full screen).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
if not exist "node_modules\three" (
  echo First run: installing three.js...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
start "Command & Context server" /min node server\index.js --app %*
