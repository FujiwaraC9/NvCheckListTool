@echo off
title NvCheckList

setlocal
set "PORT=8765"
set "APP_URL=http://localhost:%PORT%/"
set "PYEXE="
set "PYARGS="

echo ============================================================
echo  Starting NvCheckList ...
echo ============================================================

rem --- Find Python 3 ---
rem py.exe launcher (C:\Windows\py.exe) always selects the latest Python 3
if exist "C:\Windows\py.exe" set "PYEXE=C:\Windows\py.exe" & set "PYARGS=-3" & goto :python_found

rem Try common Python 3 install paths directly (no PATH dependency)
if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python313\python.exe" & set "PYARGS=" & goto :python_found
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe" & set "PYARGS=" & goto :python_found
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe" & set "PYARGS=" & goto :python_found
if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe" & set "PYARGS=" & goto :python_found
if exist "%ProgramFiles%\Python3\python.exe" set "PYEXE=%ProgramFiles%\Python3\python.exe" & set "PYARGS=" & goto :python_found

echo [ERROR] Python 3 not found. Please install Python 3 from https://python.org
echo         (Make sure "py launcher" is checked during installation.)
pause
exit /b 1

:python_found
echo  Python: %PYEXE% %PYARGS%

rem --- Check if server is already running ---
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto :open_browser

rem --- Start local server (static files + SVN proxy) in a separate minimized window ---
rem The server window stays alive; closing it stops the server.
echo  Starting local server on port %PORT% ...
start "NvCheckList Server (port %PORT%)" /d "%~dp0" /min cmd /c ""%PYEXE%" %PYARGS% server.py %PORT%"

rem --- Wait for server (poll up to 15 seconds) ---
set "WAIT=0"
:wait_loop
ping -n 2 127.0.0.1 >nul
set /a WAIT+=1
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 goto :server_ready
if %WAIT% geq 15 goto :poll_failed
echo  Waiting for server ... (%WAIT%/15)
goto :wait_loop

:poll_failed
echo.
echo [ERROR] Server failed to start within 15 seconds.
echo         The minimized "NvCheckList Server" window may show the error.
pause
exit /b 1

:server_ready
echo  Server is ready.

:open_browser
echo  URL: %APP_URL%
echo ============================================================
echo.

rem --- Find Edge or Chrome ---
set "BROWSER="

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" & goto :launch
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" & goto :launch

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe" & goto :launch
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" & goto :launch
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" & goto :launch

echo [WARN] Edge/Chrome not found, using default browser.
start "" "%APP_URL%"
goto :done

:launch
echo  Browser: %BROWSER%
start "" "%BROWSER%" --app="%APP_URL%" --window-size=1100,780

:done
echo.
echo  Done! The server is running in a minimized background window.
echo  To stop: close the "NvCheckList Server" window from the taskbar.
echo  This window will close in 5 seconds.
ping -n 6 127.0.0.1 >nul
exit /b 0
