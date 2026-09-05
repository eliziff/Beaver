[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$CaseFile,

    [Parameter(Mandatory)]
    [string]$Gold,

    [string]$MechanicalGold,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$RunPrefix = 'model-effort',

    [ValidateRange(1, 10)]
    [int]$Replicates = 1,

    [ValidateRange(1, 32)]
    [int]$Workers = 10,

    [ValidateRange(1, 12)]
    [int]$ConcurrentRuns = 3,

    [ValidateRange(1, 10)]
    [int]$MaxAttempts = 1,

    [string[]]$Models = @('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'),

    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
    [string[]]$Efforts = @('none', 'low', 'medium', 'high', 'xhigh', 'max'),

    [string[]]$Configurations = @(),

    [ValidateSet('hypersimple', 'simple', 'self-check')]
    [string]$AnalysisContract = 'self-check',

    [ValidateRange(0, 2)]
    [int]$AnalysisAudits = 1,

    [ValidateRange(0, 5)]
    [int]$MaxCorrections = 2,

    [string]$JudgeModel = 'gpt-5.6-sol',

    [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
    [string]$JudgeEffort = 'low',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$experiment = $PSScriptRoot
$launcher = Join-Path $experiment 'run-benchmark.ps1'
$runs = Join-Path $experiment 'runs'
$batteryDir = Join-Path $runs $RunPrefix
$logs = Join-Path $batteryDir 'logs'
$progress = Join-Path $batteryDir 'progress.jsonl'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$caseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Resolve-Path $CaseFile)).Hash.ToLowerInvariant()
$goldHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Resolve-Path $Gold)).Hash.ToLowerInvariant()
$mechanicalGoldHash = if ($MechanicalGold) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath (Resolve-Path $MechanicalGold)).Hash.ToLowerInvariant()
} else { $null }

$configurationItems = @($Configurations | ForEach-Object { $_ -split ',' })
$pairs = if ($configurationItems.Count) {
    foreach ($configuration in $configurationItems) {
        $parts = $configuration -split ':', 2
        if ($parts.Count -ne 2 -or $parts[1] -notin @('none', 'low', 'medium', 'high', 'xhigh', 'max')) {
            throw "Invalid configuration '$configuration'; expected model:effort"
        }
        [pscustomobject]@{ model = $parts[0]; effort = $parts[1] }
    }
} else {
    foreach ($model in $Models) {
        foreach ($effort in $Efforts) {
            [pscustomobject]@{ model = $model; effort = $effort }
        }
    }
}

$configs = foreach ($pair in $pairs) {
    $shortModel = $pair.model -replace '^gpt-5\.6-', ''
    foreach ($replicate in 1..$Replicates) {
        [pscustomobject]@{
            model = $pair.model
            effort = $pair.effort
            replicate = $replicate
            run_name = "$RunPrefix-$shortModel-$($pair.effort)-r$replicate"
        }
    }
}

[pscustomobject]@{
    created_utc = [DateTime]::UtcNow.ToString('o')
    case_file = $CaseFile
    gold = $Gold
    mechanical_gold = $MechanicalGold
    workers_per_run = $Workers
    concurrent_runs = $ConcurrentRuns
    max_attempts = $MaxAttempts
    mode = 'two-stage'
    analysis_contract = $AnalysisContract
    analysis_audits = $AnalysisAudits
    max_corrections = $MaxCorrections
    judge_contract = 'product'
    judge_model = $JudgeModel
    judge_effort = $JudgeEffort
    configurations = @($configs)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $batteryDir 'manifest.json') -Encoding utf8

if ($DryRun) {
    Write-Host "Battery ready: $(@($configs).Count) runs. Manifest: $batteryDir"
    return
}

function Add-Progress([object]$Value) {
    $Value | ConvertTo-Json -Compress | Add-Content -LiteralPath $progress -Encoding utf8
}

function Expected-Invocation([object]$Config) {
    return [ordered]@{
        run_name = $Config.run_name
        case_file_sha256 = $caseHash
        gold_sha256 = $goldHash
        mechanical_gold_sha256 = $mechanicalGoldHash
        provider = 'codex'
        model = $Config.model
        effort = $Config.effort
        workers = $Workers
        mode = 'two-stage'
        analysis_contract = $AnalysisContract
        structure_strategy = 'direct'
        structure_hints = $false
        analysis_audits = $AnalysisAudits
        max_corrections = $MaxCorrections
        max_output_tokens = 131072
        structure_run_name = $null
        judge_contract = 'product'
        judge_model = $JudgeModel
        judge_effort = $JudgeEffort
        judge_workers = $Workers
        analysis_examples = $false
        skip_judge = $false
        should_judge = $true
    }
}

function Is-Complete([object]$Config) {
    $runDirectory = Join-Path $runs $Config.run_name
    $marker = Join-Path $runDirectory 'run-complete.json'
    $manifest = Join-Path $runDirectory 'manifest.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        $receipt = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
        $actualInvocation = $receipt.invocation | ConvertTo-Json -Compress -Depth 5
        $expectedInvocation = Expected-Invocation $Config | ConvertTo-Json -Compress -Depth 5
        if ($actualInvocation -cne $expectedInvocation) { return $false }
        $manifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest).Hash.ToLowerInvariant()
        if ($receipt.run_manifest_sha256 -ne $manifestHash) { return $false }
        $judgeSummary = Join-Path $runDirectory 'product-judge\summary.json'
        if (-not (Test-Path -LiteralPath $judgeSummary -PathType Leaf)) { return $false }
        $judgeSummaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $judgeSummary).Hash.ToLowerInvariant()
        if ($receipt.judge_summary_sha256 -ne $judgeSummaryHash) { return $false }
        $structureBenchmark = Join-Path $runDirectory 'structure-benchmark.json'
        if ($mechanicalGoldHash) {
            if (-not (Test-Path -LiteralPath $structureBenchmark -PathType Leaf)) { return $false }
            $structureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $structureBenchmark).Hash.ToLowerInvariant()
            if ($receipt.structure_benchmark_sha256 -ne $structureHash) { return $false }
        } elseif ($null -ne $receipt.structure_benchmark_sha256) { return $false }
        return $true
    }
    catch { return $false }
}

$active = @{}

function Finish-Job([System.Management.Automation.Job]$Job) {
    $item = $active[$Job.Id]
    $config = $item.config
    Wait-Job -Job $Job | Out-Null
    $reason = $Job.ChildJobs[0].JobStateInfo.Reason
    $received = @(Receive-Job -Job $Job -ErrorAction SilentlyContinue)
    if ($received.Count) { $received | Out-File -LiteralPath $item.log -Encoding utf8 -Append }
    $ok = $Job.State -eq 'Completed' -and (Is-Complete $config)
    Add-Progress ([pscustomobject]@{
        utc = [DateTime]::UtcNow.ToString('o')
        event = if ($ok) { 'completed' } else { 'failed' }
        run_name = $config.run_name
        model = $config.model
        effort = $config.effort
        replicate = $config.replicate
        attempt = $item.attempt
        job_state = $Job.State.ToString()
        error = if ($reason) { $reason.Message } else { $null }
    })
    Remove-Job -Job $Job -Force
    $active.Remove($Job.Id)
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    foreach ($config in $configs) {
        if (Is-Complete $config) {
            if ($attempt -eq 1) {
                Add-Progress ([pscustomobject]@{
                    utc = [DateTime]::UtcNow.ToString('o'); event = 'reused'; run_name = $config.run_name
                    model = $config.model; effort = $config.effort; replicate = $config.replicate
                })
            }
            continue
        }
        while ($active.Count -ge $ConcurrentRuns) {
            Finish-Job (Wait-Job -Job @($active.Keys | ForEach-Object { Get-Job -Id $_ }) -Any)
        }
        $log = Join-Path $logs "$($config.run_name).log"
        $job = Start-Job -ScriptBlock {
            param($Launcher, $CaseFilePath, $GoldPath, $MechanicalGoldPath, $RunName, $Model, $Effort, $WorkerCount, $Contract, $Audits, $Corrections, $JudgeModelName, $JudgeEffortName, $Log)
            $ErrorActionPreference = 'Stop'
            $env:NODE_NO_WARNINGS = '1'
            & $Launcher -CaseFile $CaseFilePath -Gold $GoldPath -MechanicalGold $MechanicalGoldPath -RunName $RunName `
                -Model $Model -Effort $Effort -Workers $WorkerCount -Mode two-stage `
                -AnalysisContract $Contract -AnalysisAudits $Audits -MaxCorrections $Corrections `
                -JudgeContract product -JudgeModel $JudgeModelName -JudgeEffort $JudgeEffortName *>&1 |
                Out-File -LiteralPath $Log -Encoding utf8 -Append
        } -ArgumentList $launcher, $CaseFile, $Gold, $MechanicalGold, $config.run_name, $config.model, $config.effort, $Workers, $AnalysisContract, $AnalysisAudits, $MaxCorrections, $JudgeModel, $JudgeEffort, $log
        $active[$job.Id] = [pscustomobject]@{ config = $config; attempt = $attempt; log = $log }
        Add-Progress ([pscustomobject]@{
            utc = [DateTime]::UtcNow.ToString('o'); event = if ($attempt -eq 1) { 'started' } else { 'retry_started' }
            run_name = $config.run_name; model = $config.model; effort = $config.effort
            replicate = $config.replicate; attempt = $attempt
        })
    }

    while ($active.Count) {
        Finish-Job (Wait-Job -Job @($active.Keys | ForEach-Object { Get-Job -Id $_ }) -Any)
    }
    if (-not @($configs | Where-Object { -not (Is-Complete $_) }).Count) { break }
}

& node (Join-Path $experiment 'summarize-model-battery.mjs') $batteryDir
if ($LASTEXITCODE -ne 0) { throw "Battery summarization failed with exit code $LASTEXITCODE" }
$incomplete = @($configs | Where-Object { -not (Is-Complete $_) })
if ($incomplete.Count) {
    throw "Battery exhausted $MaxAttempts attempts with $($incomplete.Count) incomplete runs. Receipts: $batteryDir"
}
Write-Host "Battery complete: $(@($configs).Count) runs. Receipts: $batteryDir"
