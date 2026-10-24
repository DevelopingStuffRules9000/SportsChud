@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SportsChud Setup

rem Usage:
rem   Setup-SportsChud.bat           install/verify Node.js and dependencies
rem   Setup-SportsChud.bat repair    delete node_modules and reinstall from scratch
rem   Setup-SportsChud.bat auto      same as no argument, but never pauses (used by Start-SportsChud.bat)

set "NODE_MIN=18"
set "MODE=%~1"

rem ---------- 1. Node.js ----------
call :refresh_path
call :check_node
if not errorlevel 1 goto have_node

echo Node.js %NODE_MIN%+ was not found. Installing it now, this takes a minute or two...
call :install_node
call :refresh_path
call :check_node
if errorlevel 1 goto node_failed

:have_node
where npm >nul 2>nul
if errorlevel 1 call :refresh_path
where npm >nul 2>nul
if errorlevel 1 goto node_failed

rem ---------- 2. Dependencies ----------
if /i "%MODE%"=="repair" (
  echo Removing node_modules...
  if exist node_modules rmdir /s /q node_modules
)

set "NEED_INSTALL=0"
if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="0" (
  call npm ls electron --depth=0 >nul 2>nul
  if errorlevel 1 set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
  echo Installing SportsChud dependencies. This can take a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto deps_failed
)

rem Electron downloads its own binary after install. If that step was skipped or interrupted, redo it.
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron runtime...
  node node_modules\electron\install.js
)
if not exist "node_modules\electron\dist\electron.exe" goto deps_failed

echo.
echo Setup complete.
if /i not "%MODE%"=="auto" pause
exit /b 0


rem ================= helpers =================

:check_node
where node >nul 2>nul
if errorlevel 1 exit /b 1
set "NODE_MAJOR="
for /f %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR exit /b 1
if %NODE_MAJOR% LSS %NODE_MIN% exit /b 1
exit /b 0

:install_node
rem 1st choice: winget (not present on Windows LTSC / editions without the Store).
where winget >nul 2>nul
if not errorlevel 1 (
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if not errorlevel 1 exit /b 0
)
rem 2nd choice: portable Node.js zip unpacked into this folder (.node). No installer, no admin rights.
echo winget is unavailable or failed. Downloading portable Node.js into this folder, no admin needed...
call :install_node_portable
if not errorlevel 1 exit /b 0
rem Last resort: the regular Node.js installer (needs admin / a UAC click).
echo Portable download failed. Trying the Node.js installer instead...
call :install_node_msi
exit /b %errorlevel%

:install_node_portable
set "NODE_DIR=%~dp0.node"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; $v=(Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version; $zip=Join-Path $env:TEMP 'sportschud-node.zip'; $tmp=Join-Path $env:TEMP 'sportschud-node-unpack'; Invoke-WebRequest \"https://nodejs.org/dist/$v/node-$v-win-x64.zip\" -OutFile $zip; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -Path $zip -DestinationPath $tmp -Force; if (Test-Path $env:NODE_DIR) { Remove-Item $env:NODE_DIR -Recurse -Force }; Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $env:NODE_DIR; Remove-Item $zip -Force"
if errorlevel 1 exit /b 1
if not exist "%NODE_DIR%\node.exe" exit /b 1
exit /b 0

:install_node_msi
set "NODE_MSI=%TEMP%\sportschud-node-lts.msi"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; $v=(Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version; Invoke-WebRequest \"https://nodejs.org/dist/$v/node-$v-x64.msi\" -OutFile $env:NODE_MSI"
if errorlevel 1 exit /b 1
echo Running the Node.js installer. Click Yes if Windows asks for permission.
msiexec /i "%NODE_MSI%" /passive /norestart
exit /b %errorlevel%

:refresh_path
rem A fresh install isn't on this window's PATH yet, so add the usual locations.
if exist "%~dp0.node\node.exe" set "PATH=%~dp0.node;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
if exist "%APPDATA%\npm" set "PATH=%APPDATA%\npm;%PATH%"
exit /b 0


rem ================= errors =================

:node_failed
echo.
echo Could not install Node.js automatically.
echo Please install the LTS version from https://nodejs.org, then run this file again.
if /i not "%MODE%"=="auto" pause
exit /b 1

:deps_failed
echo.
echo Setup failed. Check your internet connection and run this file again.
echo If it keeps failing, run: Setup-SportsChud.bat repair
if /i not "%MODE%"=="auto" pause
exit /b 1
