@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SportsChud

rem Fast path: if Electron is installed, just launch.
if exist "node_modules\electron\dist\electron.exe" goto launch

echo First run, setting things up. This takes a few minutes, only once...
call "%~dp0Setup-SportsChud.bat" auto
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Setup did not finish. Run Setup-SportsChud.bat to see what went wrong.
  pause
  exit /b 1
)

:launch
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
