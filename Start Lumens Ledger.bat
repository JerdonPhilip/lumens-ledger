@echo off
setlocal

set "APP_DIR=%~dp0"
set "APP_URL=http://127.0.0.1:8000/index.html"

if not exist "%APP_DIR%index.html" (
    echo Lumens Ledger index.html was not found in:
    echo %APP_DIR%
    pause
    exit /b 1
)

cd /d "%APP_DIR%"
if errorlevel 1 (
    echo Could not open the Lumens Ledger folder:
    echo %APP_DIR%
    pause
    exit /b 1
)

where py >nul 2>&1
if not errorlevel 1 (
    start "Lumens Ledger server - close this window to stop" py -3 -m http.server 8000 --bind 127.0.0.1
    goto wait_for_server
)

where python >nul 2>&1
if not errorlevel 1 (
    start "Lumens Ledger server - close this window to stop" python -m http.server 8000 --bind 127.0.0.1
    goto wait_for_server
)

echo Python was not found. Install Python 3, then run this file again.
echo This app does not require Node.js.
pause
exit /b 1

:wait_for_server
set /a ATTEMPTS=0
:check_server
curl --silent --fail "%APP_URL%" | findstr /I /C:"Lumens Ledger" >nul
if not errorlevel 1 goto open_app
set /a ATTEMPTS+=1
if %ATTEMPTS% GEQ 10 goto server_not_ready
timeout /t 1 /nobreak >nul
goto check_server

:open_app
start "" "%APP_URL%"
exit /b 0

:server_not_ready
echo Lumens Ledger did not load from %APP_URL%.
echo Port 8000 may already be used by another server. Close the old server window, then run this launcher again.
echo Check the Lumens Ledger server window for errors or a port conflict.
pause
exit /b 1
