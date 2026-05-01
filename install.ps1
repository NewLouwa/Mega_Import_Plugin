<#
MEGA Import Plugin -- installer for Windows.

Usage:
  .\install.ps1
  .\install.ps1 -Target "C:\path\to\stash\plugins"

The script:
  1. Runs the Python unit tests (no MEGAcmd required for these).
  2. Detects MEGAcmd availability (warns if missing).
  3. Copies plugin files into <target>\mega_import\.
#>

param(
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"

$PluginName = "mega_import"
$Files = @(
    "mega_import.js",
    "mega_import.css",
    "mega_import.py",
    "mega_import.yml",
    "test_mega_import.py",
    "README.md",
    "PROGRESS.md",
    "manifest"
)

$ScriptDir = $PSScriptRoot
Set-Location $ScriptDir

function Write-Info($msg)  { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host $msg -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host $msg -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host $msg -ForegroundColor Red }

# 1. Smoke tests
Write-Info "Running Python unit tests..."
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) {
    Write-Err "Python not found on PATH. Install Python 3.8+."
    exit 1
}
& $python.Path -m unittest test_mega_import
if ($LASTEXITCODE -ne 0) {
    Write-Err "Python tests failed (see output above)."
    exit 1
}
Write-Ok "Tests passed."

# 2. MEGAcmd presence check
$megaVersion = Get-Command mega-version -ErrorAction SilentlyContinue
if (-not $megaVersion) {
    $megaCandidates = @(
        "$env:LOCALAPPDATA\MEGAcmd\mega-version.bat",
        "$env:PROGRAMFILES\MEGAcmd\mega-version.bat"
    )
    $found = $megaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) {
        Write-Ok "MEGAcmd detected at $found (not on PATH -- add its directory to PATH for the plugin to find it)."
    } else {
        Write-Warn "MEGAcmd not found. Plugin will install but MEGA actions will fail."
        Write-Warn "Install MEGAcmd from: https://mega.nz/cmd"
    }
} else {
    Write-Ok "MEGAcmd detected."
}

# 3. Locate target
if (-not $Target) {
    $candidates = @(
        "$env:USERPROFILE\.stash\plugins",
        "$env:LOCALAPPDATA\stash\plugins",
        "$env:APPDATA\stash\plugins"
    )
    $Target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Target) {
        Write-Err "No Stash plugins directory detected. Pass one with -Target:"
        Write-Err "  .\install.ps1 -Target 'C:\path\to\stash\plugins'"
        exit 1
    }
    Write-Info "Found Stash plugins dir: $Target"
}

# 4. Install
$DestDir = Join-Path $Target $PluginName
if (-not (Test-Path $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir | Out-Null
}
Write-Info "Copying plugin files -> $DestDir"
foreach ($f in $Files) {
    $src = Join-Path $ScriptDir $f
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $DestDir $f) -Force
    }
}
Write-Ok "Installed to $DestDir"
Write-Host ""
Write-Host "Next: open Stash -> Settings -> Plugins -> click 'Reload Plugins'."
