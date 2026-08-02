param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$lab = Join-Path $repo "benchmarks\harvey-labs"
$backend = Join-Path $repo "backend"
$python = Join-Path $lab ".venv\Scripts\python.exe"
$node = (Get-Command node).Source
$stamp = "2026-08-02T22-10-00Z-r1"
$logRoot = Join-Path $repo ".tmp\harvey-five-way-logs\$stamp"
$resultsRoot = Join-Path $lab "results"
$env:LAB_SANDBOX_ENGINE = "docker"
$env:PYTHONDONTWRITEBYTECODE = "1"

$tasks = @(
    "corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts",
    "tax/draft-transfer-pricing-documentation",
    "capital-markets/draft-indenture-for-senior-secured-notes-offering"
)
$jobs = @()
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Start-LabRun {
    param(
        [string]$Surface,
        [string]$Task,
        [string]$RunId,
        [string]$FilePath,
        [string]$WorkingDirectory,
        [string[]]$ArgumentList
    )
    $resultPath = Join-Path $resultsRoot ($RunId -replace "/", "\")
    if (Test-Path -LiteralPath $resultPath) {
        throw "Refusing to overwrite existing run: $RunId"
    }
    $leaf = ($Task -split "/")[-1]
    $name = "$Surface-$leaf"
    $stdout = Join-Path $logRoot "$name.stdout.log"
    $stderr = Join-Path $logRoot "$name.stderr.log"
    $started = [DateTimeOffset]::UtcNow.ToString("o")
    $pidValue = $null
    if (-not $DryRun) {
        $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
            -WorkingDirectory $WorkingDirectory -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        $process.PriorityClass = "BelowNormal"
        $pidValue = $process.Id
    }
    $script:jobs += [pscustomobject]@{
        surface = $Surface
        task = $Task
        run_id = $RunId
        executable = $FilePath
        argv = $ArgumentList
        working_directory = $WorkingDirectory
        pid = $pidValue
        priority = "BelowNormal"
        provider_service_tier_requested = $null
        started_at = $started
        stdout = $stdout
        stderr = $stderr
        status = if ($DryRun) { "dry_run" } else { "launched" }
    }
}

foreach ($task in $tasks) {
    $adaptiveRun = "$task/adaptive-mike-v1-codex-gpt-5-6-luna/$stamp"
    Start-LabRun "adaptive_mike_v1" $task $adaptiveRun $node $backend @(
        "node_modules/tsx/dist/cli.mjs", "scripts/lab-beaver-arm.ts",
        "--task", $task,
        "--arm", "adaptive_mike_v1",
        "--model", "codex:gpt-5.6-luna",
        "--effort", "high",
        "--retrieval-prompt", "neutral",
        "--run-id", $adaptiveRun
    )

    foreach ($surface in @("coding_plain_v1", "coding_legal_v1")) {
        $slug = $surface -replace "_", "-"
        $runId = "$task/$slug-codex-gpt-5-6-luna/$stamp"
        Start-LabRun $surface $task $runId $python $lab @(
            "-m", "harness.run",
            "--model", "codex/gpt-5.6-luna",
            "--task", $task,
            "--run-id", $runId,
            "--max-turns", "10",
            "--reasoning-effort", "high",
            "--skills", "docx",
            "--surface", $surface,
            "--sandbox-image", "lab-sandbox:latest"
        )
    }

    $nativeRun = "$task/codex-native-v1-gpt-5-6-luna/$stamp"
    Start-LabRun "codex_native_v1" $task $nativeRun $python $lab @(
        "-m", "harness.native_codex",
        "--task", $task,
        "--run-id", $nativeRun,
        "--model", "gpt-5.6-luna",
        "--effort", "high",
        "--image", "lab-codex-native:0.146.0"
    )
}

$receipt = [pscustomobject]@{
    experiment_id = "harvey-lab-coding-context-five-way-v1"
    implementation_commit = (git -C $repo rev-parse HEAD).Trim()
    dry_run = [bool]$DryRun
    run_count = $jobs.Count
    launched_at = [DateTimeOffset]::UtcNow.ToString("o")
    jobs = $jobs
}
$receiptPath = Join-Path $logRoot "launch-receipt.json"
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
