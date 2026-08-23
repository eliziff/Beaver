<#
.SYNOPSIS
Captures the production N-API instrument derive worker with WPR's CPU profile.

.EXAMPLE
powershell -NoProfile -File .\experiments\instrument_lineation_parity\capture_hotpath.ps1 -Limit 100

Run parity timing separately; this command invokes only the derive worker.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 872)]
    [int]$Limit = 100
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$engine = Join-Path $root 'native\legal-structure-node'
$addon = Join-Path $engine 'target\profiling\legal_structure_node.dll'
$symbols = Join-Path $engine 'target\profiling\legal_structure_node.pdb'
$benchmark = Join-Path $root 'experiments\instrument_lineation_parity\benchmark.ts'
$tsx = Join-Path $root 'backend\node_modules\tsx\dist\cli.mjs'
$traceDir = Join-Path $root '.tmp\instrument-lineation-hotpath'
$trace = Join-Path $traceDir "derive-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$PID.etl"
$node = (Get-Command 'node.exe' -ErrorAction Stop).Source
$wpr = (Get-Command 'wpr.exe' -ErrorAction Stop).Source

if (!(Test-Path -LiteralPath $addon) -or !(Test-Path -LiteralPath $symbols)) {
    throw "Build legal-structure-node with --profile profiling before capturing"
}

New-Item -ItemType Directory -Force -Path $traceDir | Out-Null
$previousAddon = [Environment]::GetEnvironmentVariable('LEGAL_STRUCTURE_NATIVE', 'Process')
$recording = $false
try {
    $env:LEGAL_STRUCTURE_NATIVE = $addon
    & $wpr '-start' 'CPU' '-filemode'
    if ($LASTEXITCODE -ne 0) { throw "WPR start failed with exit code $LASTEXITCODE" }
    $recording = $true

    & $node '--expose-gc' $tsx $benchmark '--worker=derive' "--limit=$Limit"
    if ($LASTEXITCODE -ne 0) { throw "Derive worker failed with exit code $LASTEXITCODE" }

    & $wpr '-stop' $trace 'Instrument N-API derive hot path' '-compress'
    if ($LASTEXITCODE -ne 0) { throw "WPR stop failed with exit code $LASTEXITCODE" }
    $recording = $false
    Write-Output $trace
}
finally {
    if ($recording) { & $wpr '-cancel' | Out-Null }
    [Environment]::SetEnvironmentVariable('LEGAL_STRUCTURE_NATIVE', $previousAddon, 'Process')
}
