[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CaseFile,

    [Parameter(Mandatory)]
    [string]$Gold,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$RunPrefix,

    [string]$Model = 'gpt-5.6-luna',

    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
    [string[]]$Efforts = @('low', 'medium', 'high'),

    [ValidateSet('direct', 'boundary-first', 'vote-first')]
    [string[]]$Strategies = @('direct', 'boundary-first', 'vote-first'),

    [switch]$NoHints,

    [ValidateRange(1, 20)]
    [int]$Members = 10,

    [ValidateRange(1, 32)]
    [int]$WorkersPerRun = 5,

    [ValidateRange(1, 10)]
    [int]$ConcurrentRuns = 2,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$experiment = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $experiment '..\..\..')).Path
$backend = Join-Path $repoRoot 'backend'
$tsx = Join-Path $backend 'node_modules\.bin\tsx.cmd'
$cli = Join-Path $experiment 'cli.ts'
$ensembleDir = Join-Path $experiment "runs\$RunPrefix"

function Resolve-RepoFile([string]$Path) {
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $repoRoot $Path }
    return (Resolve-Path $candidate).Path
}

$casePath = Resolve-RepoFile $CaseFile
$goldPath = Resolve-RepoFile $Gold
$cliArgs = @(
    $cli, 'structure-ensemble',
    '--case-file', $casePath,
    '--gold', $goldPath,
    '--out-dir', $ensembleDir,
    '--model', $Model,
    '--members', $Members,
    '--workers-per-member', $WorkersPerRun,
    '--concurrent-members', $ConcurrentRuns,
    '--efforts', ($Efforts -join ','),
    '--strategies', ($Strategies -join ',')
)
if ($NoHints) { $cliArgs += '--no-hints' }
if ($DryRun) { $cliArgs += '--dry-run' }

Push-Location $backend
try {
    & $tsx @cliArgs
    if ($LASTEXITCODE -ne 0) { throw "Structure ensemble failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
