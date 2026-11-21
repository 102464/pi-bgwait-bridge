@echo off
setlocal
rem Remove pi-bgwait-bridge from the user or project Pi scope.
rem   scripts\uninstall-windows.cmd           -> user scope
rem   scripts\uninstall-windows.cmd --local   -> project scope

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

echo Removing %PACKAGE_DIR% %SCOPE%
node "%LAUNCHER%" remove "%PACKAGE_DIR%" %SCOPE%
if errorlevel 1 (
  echo pi remove failed. If the package was installed from npm or git, use that source instead.
  exit /b 1
)

echo.
echo Removed. The extension also unregisters itself on session_shutdown.
endlocal
