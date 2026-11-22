@echo off
setlocal
set "BIN_DIR=%~dp0"
for %%I in ("%BIN_DIR%..") do set "RES_DIR=%%~fI"
for %%I in ("%RES_DIR%\..") do set "APP_DIR=%%~fI"
set "MCP_JS=%RES_DIR%\app.asar.unpacked\src\mcp\server.js"
set "APP_EXE=%APP_DIR%\Power Pilot.exe"

where node >nul 2>nul
if errorlevel 1 goto :run_electron
if not exist "%MCP_JS%" goto :run_electron
node "%MCP_JS%" %*
exit /b %ERRORLEVEL%

:run_electron
if not exist "%APP_EXE%" goto :missing_bin
"%APP_EXE%" --mcp %*
exit /b %ERRORLEVEL%

:missing_bin
echo Power Pilot MCP server could not locate runtime binary. 1>&2
exit /b 1
