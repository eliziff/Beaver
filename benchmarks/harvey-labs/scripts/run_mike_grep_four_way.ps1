param(
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$lab = Join-Path $repo "benchmarks\harvey-labs"
$backend = Join-Path $repo "backend"
$resultsRoot = Join-Path $lab "results"
$registrationRelative = "docs/harvey-lab-mike-grep-four-way-preregistration-2026-08-03.json"
$launcherRelative = "benchmarks/harvey-labs/scripts/run_mike_grep_four_way.ps1"
$registrationPath = Join-Path $repo ($registrationRelative -replace "/", "\")
$registration = Get-Content -Raw -LiteralPath $registrationPath | ConvertFrom-Json
$node = (Get-Command node).Source
$stamp = (($registration.runs[0].run_id -split "/")[-1])
$logRoot = Join-Path $repo ".tmp\harvey-mike-grep-four-way-logs\$stamp"

if ($registration.experiment_id -ne "harvey-lab-mike-grep-four-way-v1") {
    throw "Unexpected registration: $($registration.experiment_id)"
}
if (@($registration.runs).Count -ne 12) {
    throw "Registration must contain exactly 12 runs."
}
if (@($registration.runs.run_id | Sort-Object -Unique).Count -ne 12) {
    throw "Registration contains duplicate run IDs."
}

$head = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not resolve repository HEAD."
}
$registrationCommit = (& git -C $repo log -1 --format=%H -- $registrationRelative).Trim()
if ($LASTEXITCODE -ne 0 -or -not $registrationCommit) {
    throw "The registration must be committed before launch."
}
if ($head -ne $registrationCommit) {
    throw "HEAD $head is not the preregistered implementation commit $registrationCommit."
}

foreach ($selfPath in @($registrationRelative, $launcherRelative)) {
    & git -C $repo ls-files --error-unmatch -- $selfPath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Experiment control file is not committed: $selfPath"
    }
}
& git -C $repo diff --quiet HEAD -- $registrationRelative $launcherRelative
if ($LASTEXITCODE -ne 0) {
    throw "The registration or launcher differs from committed HEAD."
}

$scopedPaths = @($registration.prelaunch_commit_gate.commit_clean_paths)
foreach ($relativePath in $scopedPaths) {
    & git -C $repo ls-files --error-unmatch -- $relativePath 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Experiment-scoped path is not committed: $relativePath"
    }
}
& git -C $repo diff --quiet HEAD -- $scopedPaths
if ($LASTEXITCODE -eq 1) {
    throw "An experiment-scoped file differs from committed HEAD."
}
if ($LASTEXITCODE -ne 0) {
    throw "Could not verify experiment-scoped files against HEAD."
}

$verifiedHashes = [ordered]@{}
foreach ($fingerprint in $registration.source_fingerprints.PSObject.Properties) {
    $sourcePath = Join-Path $repo ($fingerprint.Name -replace "/", "\")
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
    $expected = [string]$fingerprint.Value
    if ($actual -ne $expected) {
        throw "Source fingerprint mismatch for $($fingerprint.Name): expected $expected, got $actual"
    }
    $verifiedHashes[$fingerprint.Name] = $actual
}

$env:LAB_SANDBOX_ENGINE = "docker"
$env:PYTHONDONTWRITEBYTECODE = "1"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$jobs = @()

foreach ($run in $registration.runs) {
    $resultPath = Join-Path $resultsRoot ($run.run_id -replace "/", "\")
    if (Test-Path -LiteralPath $resultPath) {
        throw "Refusing to overwrite existing run: $($run.run_id)"
    }

    $leaf = ($run.task -split "/")[-1]
    $name = "$($run.arm)-$leaf"
    $stdout = Join-Path $logRoot "$name.stdout.log"
    $stderr = Join-Path $logRoot "$name.stderr.log"
    $argv = @(
        "node_modules/tsx/dist/cli.mjs", "scripts/lab-beaver-arm.ts",
        "--task", [string]$run.task,
        "--arm", [string]$run.arm,
        "--model", "codex:gpt-5.6-luna",
        "--effort", "high",
        "--retrieval-prompt", "neutral",
        "--run-id", [string]$run.run_id
    )
    $pidValue = $null
    if (-not $DryRun) {
        $process = Start-Process -FilePath $node -ArgumentList $argv `
            -WorkingDirectory $backend -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        $process.PriorityClass = "BelowNormal"
        $pidValue = $process.Id
    }
    $jobs += [pscustomobject]@{
        task = $run.task
        arm = $run.arm
        run_id = $run.run_id
        executable = $node
        argv = $argv
        working_directory = $backend
        pid = $pidValue
        local_process_priority = "BelowNormal"
        provider_service_tier_requested = $null
        started_at = [DateTimeOffset]::UtcNow.ToString("o")
        stdout = $stdout
        stderr = $stderr
        status = if ($DryRun) { "dry_run" } else { "launched" }
    }
}

$receipt = [pscustomobject]@{
    experiment_id = $registration.experiment_id
    registration_path = $registrationRelative
    registration_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $registrationPath).Hash.ToLowerInvariant()
    implementation_commit = $head
    scoped_files_clean_at_launch = $true
    verified_source_fingerprints = $verifiedHashes
    dry_run = [bool]$DryRun
    run_count = $jobs.Count
    launched_at = [DateTimeOffset]::UtcNow.ToString("o")
    jobs = $jobs
}
$receiptPath = Join-Path $logRoot "launch-receipt.json"
[IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
