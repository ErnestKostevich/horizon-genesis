# One-line installer for the Horizon CLI on Windows (PowerShell).
#
# Usage (in PowerShell):
#   iwr https://raw.githubusercontent.com/ErnestKostevich/horizon-genesis/main/scripts/install-cli.ps1 | iex
#
# What it does:
#   1. Verifies Node 22+ is installed.
#   2. Clones the repo into $env:USERPROFILE\.horizon-cli.
#   3. Runs `npm ci --omit=dev` (skips Electron deps).
#   4. Creates horizon.cmd / horizon-tui.cmd / horizon-serve.cmd shims
#      inside $env:USERPROFILE\.horizon-cli\bin-shims and adds that
#      folder to the user-scope PATH so the commands are global.

$ErrorActionPreference = 'Stop'

function Write-Ok    { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Info  { param($m) Write-Host "  ℹ $m" -ForegroundColor Cyan }
function Write-Warn  { param($m) Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

$RepoUrl = 'https://github.com/ErnestKostevich/horizon-genesis.git'
$InstallDir = if ($env:HORIZON_INSTALL_DIR) { $env:HORIZON_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.horizon-cli' }
$ShimDir = Join-Path $InstallDir 'bin-shims'

Write-Host ""
Write-Host "Horizon CLI installer" -ForegroundColor Magenta
Write-Host ""

# 1. Node check
try {
    $nodeVersion = (node --version) 2>$null
} catch {
    Write-Err "Node.js not installed."
    Write-Host "Install Node 22 LTS first:"
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    Write-Host "  or download from https://nodejs.org/"
    exit 1
}

$nodeMajor = [int]($nodeVersion -replace 'v(\d+).*', '$1')
if ($nodeMajor -lt 20) {
    Write-Err "Node $nodeVersion is too old. Horizon CLI needs Node 20+ (22 LTS recommended)."
    exit 1
}
Write-Ok "Node $nodeVersion"

# 2. Git check
try {
    git --version > $null 2>&1
} catch {
    Write-Err "git is not installed. Install it from https://git-scm.com/ or via winget install Git.Git"
    exit 1
}

# 3. Clone or pull
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Info "Updating existing install at $InstallDir"
    Push-Location $InstallDir
    git fetch --quiet origin
    git reset --hard --quiet origin/main
    Pop-Location
} else {
    Write-Info "Cloning into $InstallDir"
    git clone --depth 1 $RepoUrl $InstallDir | Out-Null
}
$commit = (git -C $InstallDir rev-parse --short HEAD).Trim()
Write-Ok "repo @ $commit"

# 4. Install deps
Write-Info "Installing dependencies (~30s, skips Electron)…"
Push-Location $InstallDir
npm ci --omit=dev --silent | Out-Null
Pop-Location
Write-Ok "dependencies installed"

# 5. Create .cmd shims
if (!(Test-Path $ShimDir)) {
    New-Item -ItemType Directory -Path $ShimDir | Out-Null
}
foreach ($cmd in @('horizon', 'horizon-tui', 'horizon-serve')) {
    $shimPath = Join-Path $ShimDir "$cmd.cmd"
    $script = Join-Path $InstallDir "bin\$cmd.js"
    @"
@echo off
node "$script" %*
"@ | Out-File -FilePath $shimPath -Encoding ASCII -Force
}
Write-Ok "shims in $ShimDir"

# 6. PATH (user scope)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$ShimDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $ShimDir } else { "$ShimDir;$userPath" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Ok "PATH updated (user scope)"
    Write-Warn "Restart your terminal for the change to take effect"
} else {
    Write-Ok "PATH already contains $ShimDir"
}

Write-Host ""
Write-Host "  Horizon CLI ready" -ForegroundColor Green
Write-Host ""
Write-Host "  Try:" -ForegroundColor White
Write-Host "    horizon version             " -NoNewline -ForegroundColor Cyan
Write-Host "— print runtime status" -ForegroundColor DarkGray
Write-Host "    horizon                      " -NoNewline -ForegroundColor Cyan
Write-Host "— launch the TUI" -ForegroundColor DarkGray
Write-Host "    horizon chat `"hi`"           " -NoNewline -ForegroundColor Cyan
Write-Host "— single-turn chat" -ForegroundColor DarkGray
Write-Host "    horizon serve --port 18789   " -NoNewline -ForegroundColor Cyan
Write-Host "— HTTP API" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Docs:   $InstallDir\docs\cli.md" -ForegroundColor DarkGray
Write-Host "  Server: $InstallDir\docs\deploy.md" -ForegroundColor DarkGray
Write-Host ""
