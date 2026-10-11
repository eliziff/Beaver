[CmdletBinding()]
param(
    [ValidateRange(1, 171473)][int]$Count = 50000,
    [ValidateRange(1, 64)][int]$Workers = 64,
    [ValidateSet('run', 'evaluate')][string]$Mode = 'run',
    [string]$Model = 'gpt-6.1-sol',
    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')][string]$Effort = 'low',
    [ValidateRange(1, 600)][int]$TimeoutSeconds = 120,
    [string]$Database = 'benchmarks/local-data/a2aj-opinion-boundaries/50k-sol61-low/boundaries-v2.sqlite'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$databasePath = if ([System.IO.Path]::IsPathRooted($Database)) { [System.IO.Path]::GetFullPath($Database) } else { [System.IO.Path]::GetFullPath((Join-Path $repo $Database)) }
$priorCodexHome = $env:BEAVER_CODEX_HOME
$priorTsconfig = $env:TSX_TSCONFIG_PATH
$authHome = if ($priorCodexHome) { $priorCodexHome } elseif ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$authSource = Join-Path $authHome 'auth.json'
$isolatedHome = Join-Path ([System.IO.Path]::GetDirectoryName($databasePath)) 'codex'
$isolatedAuth = Join-Path $isolatedHome 'auth.json'
if (-not (Test-Path -LiteralPath $authSource -PathType Leaf)) { throw 'Codex subscription authentication is unavailable.' }
New-Item -ItemType Directory -Force -Path $isolatedHome | Out-Null
Push-Location $repo
try {
    Copy-Item -LiteralPath $authSource -Destination $isolatedAuth
    $env:BEAVER_CODEX_HOME = $isolatedHome
    $env:TSX_TSCONFIG_PATH = 'backend/tsconfig.dev.json'
    & node --expose-gc --import ./scripts/background-work.mjs --import tsx `
        backend/experiments/a2aj-case-treatment/opinion-boundaries.ts $Mode `
        --db $databasePath --limit $Count --workers $Workers --model $Model --effort $Effort --timeout-seconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw 'Boundary processing stopped; rerun with the same database to resume.' }
} finally {
    $env:BEAVER_CODEX_HOME = $priorCodexHome
    $env:TSX_TSCONFIG_PATH = $priorTsconfig
    if (Test-Path -LiteralPath $isolatedAuth -PathType Leaf) { Remove-Item -LiteralPath $isolatedAuth }
    Pop-Location
}
