# Runs demo.py with TYPESAFE_API_KEY taken from the user-level env var.
param([string[]]$StateArgs)

$env:TYPESAFE_API_KEY = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
if (-not $env:TYPESAFE_API_KEY) {
    Write-Error 'TYPESAFE_API_KEY user env var not found'
    exit 2
}
python (Join-Path $PSScriptRoot 'demo.py') @StateArgs
