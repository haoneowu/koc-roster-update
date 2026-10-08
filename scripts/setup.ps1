# KOC Roster Update setup. Uses the current PowerShell execution policy.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 26.x is required. Install it from https://nodejs.org/ and reopen your terminal.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'setup.mjs') @args
exit $LASTEXITCODE
