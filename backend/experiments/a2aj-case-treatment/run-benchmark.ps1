[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CaseFile,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$RunName,

    [string]$Model = 'gpt-5.6-luna',

    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
    [string]$Effort = 'max',

    [ValidateRange(1, 32)]
    [int]$Workers = 10,

    [ValidateSet('one-stage', 'two-stage', 'structure-only')]
    [string]$Mode = 'two-stage',

    [ValidateSet('hypersimple', 'simple', 'self-check')]
    [string]$AnalysisContract = 'self-check',

    [ValidateSet('direct', 'boundary-first', 'vote-first')]
    [string]$StructureStrategy = 'direct',

    [switch]$StructureHints,

    [ValidateRange(0, 2)]
    [int]$AnalysisAudits = 1,

    [ValidateRange(0, 5)]
    [int]$MaxCorrections = 2,

    [ValidateRange(1, 131072)]
    [int]$MaxOutputTokens = 131072,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$StructureRunName,

    [Parameter(Mandatory)]
    [string]$Gold,

    [string]$MechanicalGold,

    [ValidateSet('legacy', 'product')]
    [string]$JudgeContract = 'product',

    [string]$JudgeModel = 'gpt-5.6-sol',

    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
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
$runCompleteFile = Join-Path $runDir 'run-complete.json'
$runInvocationFile = Join-Path $runDir 'benchmark-invocation.json'
$goldSnapshotFile = Join-Path $runDir 'benchmark-gold.jsonl'
$mechanicalGoldSnapshotFile = if ($MechanicalGold) { Join-Path $runDir 'mechanical-gold.jsonl' } else { $null }
$shouldJudge = -not $SkipJudge -and $Mode -ne 'structure-only'

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
$mechanicalGoldPath = if ($MechanicalGold) { Resolve-RepoFile $MechanicalGold } else { $null }
$invocation = [ordered]@{
    run_name = $RunName
    case_file_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $casePath).Hash.ToLowerInvariant()
    gold_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $goldPath).Hash.ToLowerInvariant()
    mechanical_gold_sha256 = if ($mechanicalGoldPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $mechanicalGoldPath).Hash.ToLowerInvariant() } else { $null }
    provider = 'codex'
    model = $Model
    effort = $Effort
    workers = $Workers
    mode = $Mode
    analysis_contract = $AnalysisContract
    structure_strategy = $StructureStrategy
    structure_hints = [bool]$StructureHints
    analysis_audits = $AnalysisAudits
    max_corrections = $MaxCorrections
    max_output_tokens = $MaxOutputTokens
    structure_run_name = if ($StructureRunName) { $StructureRunName } else { $null }
    judge_contract = $JudgeContract
    judge_model = $JudgeModel
    judge_effort = $JudgeEffort
    judge_workers = $Workers
    analysis_examples = [bool]$AnalysisExamples
    skip_judge = [bool]$SkipJudge
    should_judge = $shouldJudge
}
$invocationJson = $invocation | ConvertTo-Json -Depth 4 -Compress

[System.IO.Directory]::CreateDirectory($runDir) | Out-Null
if (Test-Path -LiteralPath $runInvocationFile) {
    $existingInvocation = Get-Content -Raw -LiteralPath $runInvocationFile
    if ($existingInvocation.Trim() -ne $invocationJson) {
        throw "Run '$RunName' already has a different benchmark invocation"
    }
} else {
    [System.IO.File]::WriteAllText($runInvocationFile, "$invocationJson`n")
}
if (Test-Path -LiteralPath $goldSnapshotFile) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $goldSnapshotFile).Hash.ToLowerInvariant() -ne $invocation.gold_sha256) {
        throw "Run '$RunName' already has a different gold snapshot"
    }
} else {
    [System.IO.File]::Copy($goldPath, $goldSnapshotFile)
}
if ($mechanicalGoldSnapshotFile) {
    if (Test-Path -LiteralPath $mechanicalGoldSnapshotFile) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $mechanicalGoldSnapshotFile).Hash.ToLowerInvariant() -ne $invocation.mechanical_gold_sha256) {
            throw "Run '$RunName' already has a different mechanical-gold snapshot"
        }
    } else {
        [System.IO.File]::Copy($mechanicalGoldPath, $mechanicalGoldSnapshotFile)
    }
}

Push-Location $backend
try {
    if (Test-Path -LiteralPath $runCompleteFile) { [System.IO.File]::Delete($runCompleteFile) }
    $runArgs = @(
        $cli, $(if ($shouldJudge) { 'run-and-judge' } else { 'run' }),
        '--case-file', $casePath,
        '--mode', $Mode,
        '--provider', 'codex',
        '--model', $Model,
        '--effort', $Effort,
        '--workers', $Workers,
        '--analysis-contract', $AnalysisContract,
        '--structure-strategy', $StructureStrategy,
        '--analysis-audits', $AnalysisAudits,
        '--max-corrections', $MaxCorrections,
        '--max-output-tokens', $MaxOutputTokens,
        '--out-dir', $runDir
    )
    if ($shouldJudge) {
        $runArgs += @(
            '--gold', $goldSnapshotFile,
            '--judge-model', $JudgeModel,
            '--judge-effort', $JudgeEffort,
            '--judge-workers', $Workers,
            '--judge-contract', $JudgeContract
        )
    }
    if ($structureRunDir) { $runArgs += @('--structure-run-dir', $structureRunDir) }
    if ($StructureHints) { $runArgs += '--structure-hints' }
    if ($AnalysisExamples) { $runArgs += '--analysis-examples' }

    & $tsx @runArgs
    if ($LASTEXITCODE -ne 0) { throw "Inference failed with exit code $LASTEXITCODE" }

    if ($mechanicalGoldSnapshotFile) {
        & $tsx $cli benchmark-structure --gold $mechanicalGoldSnapshotFile --run-dir $runDir
        if ($LASTEXITCODE -ne 0) { throw "Mechanical benchmark failed with exit code $LASTEXITCODE" }
    }

    $judgeSummaryFile = if ($shouldJudge) {
        $judgeFolder = if ($JudgeContract -eq 'product') { 'product-judge' } else { 'judge' }
        Join-Path $runDir "$judgeFolder\summary.json"
    } else { $null }
    $judgeSummary = if ($judgeSummaryFile) { Get-Content -Raw -LiteralPath $judgeSummaryFile | ConvertFrom-Json } else { $null }
    $structureBenchmarkFile = if ($mechanicalGoldSnapshotFile) { Join-Path $runDir 'structure-benchmark.json' } else { $null }
    [System.IO.File]::WriteAllText($runCompleteFile, ([pscustomobject]@{
        completed_utc = [DateTime]::UtcNow.ToString('o')
        invocation = $invocation
        run_manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runDir 'manifest.json')).Hash.ToLowerInvariant()
        judge_summary_sha256 = if ($judgeSummaryFile) { (Get-FileHash -Algorithm SHA256 -LiteralPath $judgeSummaryFile).Hash.ToLowerInvariant() } else { $null }
        structure_benchmark_sha256 = if ($structureBenchmarkFile) { (Get-FileHash -Algorithm SHA256 -LiteralPath $structureBenchmarkFile).Hash.ToLowerInvariant() } else { $null }
        judged = $shouldJudge
        gold_challenges = if ($judgeSummary -and $null -ne $judgeSummary.gold_challenges) { [int]$judgeSummary.gold_challenges } else { $null }
    } | ConvertTo-Json -Compress))
} finally {
    Pop-Location
}
