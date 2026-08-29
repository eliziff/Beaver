[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CaseFile,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$RunName,

    [string]$Model = 'gpt-5.6-luna',

    [ValidateSet('low', 'medium', 'high', 'max')]
    [string]$Effort = 'max',

    [ValidateRange(1, 32)]
    [int]$Workers = 10,

    [ValidateSet('one-stage', 'two-stage')]
    [string]$Mode = 'two-stage',

    [ValidateSet('simple', 'self-check')]
    [string]$AnalysisContract = 'self-check',

    [ValidateRange(1, 131072)]
    [int]$MaxOutputTokens = 131072,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$StructureRunName,

    [Parameter(Mandatory)]
    [string]$Gold,

    [string]$JudgeModel = 'gpt-5.6-sol',

    [ValidateSet('low', 'medium', 'high', 'max')]
    [string]$JudgeEffort = 'low',

    [switch]$AnalysisExamples,

    [switch]$SkipJudge
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$backend = Join-Path $repoRoot 'backend'
$tsx = Join-Path $backend 'node_modules\.bin\tsx.cmd'
$cli = Join-Path $PSScriptRoot 'cli.ts'
$runDir = Join-Path $PSScriptRoot "runs\$RunName"
$structureRunDir = if ($StructureRunName) { Join-Path $PSScriptRoot "runs\$StructureRunName" } else { $null }

if ($structureRunDir -and $Mode -ne 'two-stage') { throw '-StructureRunName requires -Mode two-stage' }
if ($StructureRunName -eq $RunName) { throw '-StructureRunName must identify a different run' }
if ($structureRunDir -and -not (Test-Path -LiteralPath $structureRunDir -PathType Container)) {
    throw "Structure run does not exist: $structureRunDir"
}

function Resolve-RepoFile([string]$Path) {
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $repoRoot $Path }
    return (Resolve-Path $candidate).Path
}

$casePath = Resolve-RepoFile $CaseFile
$goldPath = Resolve-RepoFile $Gold

Push-Location $backend
try {
    $runArgs = @(
        $cli, 'run',
        '--case-file', $casePath,
        '--mode', $Mode,
        '--provider', 'codex',
        '--model', $Model,
        '--effort', $Effort,
        '--workers', $Workers,
        '--analysis-contract', $AnalysisContract,
        '--max-output-tokens', $MaxOutputTokens,
        '--out-dir', $runDir
    )
    if ($structureRunDir) { $runArgs += @('--structure-run-dir', $structureRunDir) }
    if ($AnalysisExamples) { $runArgs += '--analysis-examples' }
    & $tsx @runArgs
    if ($LASTEXITCODE -ne 0) { throw "Inference failed with exit code $LASTEXITCODE" }

    & $tsx $cli benchmark --gold $goldPath --run-dir $runDir
    if ($LASTEXITCODE -ne 0) { throw "Mechanical benchmark failed with exit code $LASTEXITCODE" }

    if (-not $SkipJudge) {
        & $tsx $cli judge `
            --gold $goldPath `
            --run-dir $runDir `
            --provider codex `
            --model $JudgeModel `
            --effort $JudgeEffort `
            --workers $Workers
        if ($LASTEXITCODE -ne 0) { throw "Semantic judge failed with exit code $LASTEXITCODE" }
    }
} finally {
    Pop-Location
}
