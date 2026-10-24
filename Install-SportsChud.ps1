<#
.SYNOPSIS
  Downloads the latest SportsChud installer from GitHub and installs it silently
  to C:\Program Files\SportsChud. No Node.js, npm or winget needed.

.USAGE
  Right-click -> Run with PowerShell, or:
    powershell -ExecutionPolicy Bypass -File .\Install-SportsChud.ps1

  It asks for administrator permission itself (needed to write to Program Files).

  Options:
    -NoLaunch    don't start SportsChud when the install finishes
#>
param(
    [switch]$NoLaunch
)

# >>> Set this to your GitHub "username/repository" (the repository must be public). <<<
$Repo = "YOUR-GITHUB-USERNAME/SportsChud"

$ErrorActionPreference = "Stop"

if ($Repo -like "YOUR-GITHUB-USERNAME/*") {
    Write-Host "Open this script and set `$Repo near the top to your GitHub username/repository." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# Elevate if needed
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Asking for administrator permission..."
    $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($NoLaunch) { $argList += "-NoLaunch" }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = "SilentlyContinue"

    $url  = "https://github.com/$Repo/releases/latest/download/SportsChud-Setup.exe"
    $file = Join-Path $env:TEMP "SportsChud-Setup.exe"

    Write-Host "Downloading $url ..."
    Invoke-WebRequest -Uri $url -OutFile $file

    # Close a running copy so files can be replaced
    Get-Process -Name "SportsChud" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1

    Write-Host "Installing (silent)..."
    $p = Start-Process -FilePath $file -ArgumentList "/S" -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Installer exited with code $($p.ExitCode)." }
    Remove-Item $file -Force -ErrorAction SilentlyContinue

    $exe = Join-Path $env:ProgramFiles "SportsChud\SportsChud.exe"
    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Host "Installed, but SportsChud.exe wasn't found at $exe (a different install folder may have been used)." -ForegroundColor Yellow
    } else {
        Write-Host "Installed to $(Split-Path $exe)" -ForegroundColor Green
        if (-not $NoLaunch) { Start-Process -FilePath $exe }
    }
}
catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Check the repository name, that it is public, and that a release with SportsChud-Setup.exe exists." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}
