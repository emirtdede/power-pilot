@echo off
setlocal EnableExtensions
set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..") do set "RES_DIR=%%~fI"
for %%I in ("%RES_DIR%\..") do set "APP_DIR=%%~fI"
set "CLI_JS=%RES_DIR%\app.asar.unpacked\src\cli\powerpilot.js"
set "APP_EXE=%APP_DIR%\Power Pilot.exe"

REM Local SQLite/DPAPI commands (`init`, `daemon`) MUST run inside Electron (`Power Pilot.exe`)
REM so Electron-ABI better-sqlite3, app.asar, and Windows DPAPI safeStorage always work.
if /I "%~1"=="init" goto :run_electron_oneshot
if /I "%~1"=="daemon" goto :run_electron_daemon

REM Pure HTTP CLI commands & `mcp`: prefer system Node.js for fast <50ms console TTY output.
REM Keep `node` outside any parenthesized block so %ERRORLEVEL% propagates accurately.
where node >nul 2>nul
if errorlevel 1 goto :run_electron_oneshot
if not exist "%CLI_JS%" goto :run_electron_oneshot
node "%CLI_JS%" %*
exit /b %ERRORLEVEL%

:run_electron_daemon
if not exist "%APP_EXE%" goto :missing_bin
if /I "%~2"=="start" goto :run_electron_oneshot
if /I "%~2"=="stop" goto :run_electron_oneshot
if /I "%~2"=="status" goto :run_electron_oneshot
REM Foreground daemon stays attached directly
"%APP_EXE%" --cli %*
exit /b %ERRORLEVEL%

:run_electron_oneshot
if not exist "%APP_EXE%" goto :missing_bin
REM Relay stdout/stderr via temp file so GUI-subsystem Power Pilot.exe prints visibly
REM even inside an unredirected interactive Windows cmd.exe console without Node.js.
set "TMP_OUT=%TEMP%\pp_cli_%RANDOM%_%RANDOM%.out"
"%APP_EXE%" --cli %* > "%TMP_OUT%" 2>&1
set "RC=%ERRORLEVEL%"
if exist "%TMP_OUT%" (
  type "%TMP_OUT%"
  del /q "%TMP_OUT%" >nul 2>nul
)
exit /b %RC%

:missing_bin
echo Power Pilot CLI could not locate runtime binary. 1>&2
exit /b 1
