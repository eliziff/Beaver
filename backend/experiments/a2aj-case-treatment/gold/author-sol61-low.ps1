[CmdletBinding()]
param(
    [ValidateRange(1, 16)][int]$Workers = 16,
    [ValidateSet(300, 630)][int]$Batch = 300
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$run = Join-Path $repo "benchmarks\local-data\a2aj-case-treatment\sol61-low-expansion-$Batch"
$selectionFile = Join-Path $repo "backend\experiments\a2aj-case-treatment\gold\selection-sol61-low-$Batch.json"
$priorCodexHome = $env:BEAVER_CODEX_HOME
$authHome = if ($priorCodexHome) { $priorCodexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$authSource = Join-Path $authHome 'auth.json'
$isolatedHome = Join-Path $run 'codex'
$isolatedAuth = Join-Path $isolatedHome 'auth.json'

if (-not (Test-Path -LiteralPath $authSource -PathType Leaf)) { throw 'Codex subscription authentication is unavailable.' }
New-Item -ItemType Directory -Force -Path $isolatedHome | Out-Null
Push-Location $repo
try {
    Copy-Item -LiteralPath $authSource -Destination $isolatedAuth
    $env:BEAVER_CODEX_HOME = $isolatedHome
    & .\node_modules\.bin\tsx.cmd backend/experiments/a2aj-case-treatment/author-gold.ts `
        --case-file $selectionFile --run-dir $run --gold (Join-Path $run 'gold.jsonl') `
        --model gpt-6.1-sol --effort low --workers $Workers --audits 2 --max-corrections 5
    if ($LASTEXITCODE -ne 0) { throw 'Gold authoring is incomplete; rerun this script to resume the retained receipts.' }
} finally {
    $env:BEAVER_CODEX_HOME = $priorCodexHome
    if (Test-Path -LiteralPath $isolatedAuth -PathType Leaf) { Remove-Item -LiteralPath $isolatedAuth }
    Pop-Location
}
