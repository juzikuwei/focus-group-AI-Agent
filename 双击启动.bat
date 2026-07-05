@echo off
cd /d "%~dp0"

if "%HOST%"=="" set "HOST=127.0.0.1"
if "%PORT%"=="" set "PORT=5173"

echo Starting Focus Lab at http://%HOST%:%PORT%
echo Keep this window open while using the app.
echo Press Ctrl+C to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://%HOST%:%PORT%'"
python run_backend.py

if %ERRORLEVEL% neq 0 (
  echo.
  echo Failed to start server. Make sure Python dependencies are installed:
  echo pip install -r requirements.txt
  pause
)
