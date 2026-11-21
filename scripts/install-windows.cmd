@echo off
setlocal
rem Install pi-bgwait-bridge into the user or project Pi scope.
rem   scripts\install-windows.cmd           -> user scope (~/.pi/agent/settings.json)
rem   scripts\install-windows.cmd --local -> project scope (.pi/settings.json)
rem
rem Runs `pi install <package dir>` through the managed launcher so the argv reaches Pi
rem without a shell round trip.

rem Resolve the package directory to an absolute path. A bare "%%~dp0.." would be
rem recorded verbatim by Pi, which then resolves it relative to the settings file.
for %%I in ("%~dp0..") do set "PACKAGE_DIR=%%~fI"
set "SCOPE="
if "%~1"=="--local" set "SCOPE=-l"
if "%~1"=="-l" set "SCOPE=-l"

if defined PI_LAUNCHER (
  set "LAUNCHER=%PI_LAUNCHER%"
) else (
  set "LAUNCHER=%USERPROFILE%\.pi\agent\bin\pi-launcher.js"
)

if not exist "%LAUNCHER%" (
  echo pi launcher not found at "%LAUNCHER%". Set PI_LAUNCHER to its path.
  exit /b 1
)

echo Installing %PACKAGE_DIR% %SCOPE%
node "%LAUNCHER%" install "%PACKAGE_DIR%" %SCOPE%
if errorlevel 1 (
  echo pi install failed.
  exit /b 1
)

echo.
echo Installed. Verify with:  pi list ^| findstr pi-bgwait-bridge
echo Reload a running session with /reload.
endlocal
