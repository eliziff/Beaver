param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(1, 2, 3)]
    [int]$Wave,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$lab = Join-Path $repo "benchmarks\harvey-labs"
$backend = Join-Path $repo "backend"
$resultsRoot = Join-Path $lab "results"
$registrationRelative = "docs/harvey-labs/protocols/harvey-lab-minimal-architecture-nine-task-preregistration-2026-08-03.json"
$launcherRelative = "benchmarks/harvey-labs/scripts/run_minimal_architecture_nine_task.ps1"
$registrationPath = Join-Path $repo ($registrationRelative -replace "/", "\")
$registration = Get-Content -Raw -LiteralPath $registrationPath | ConvertFrom-Json
$node = (Get-Command node).Source
$tsx = Join-Path $backend "node_modules\tsx\dist\cli.mjs"
$armRunner = Join-Path $backend "scripts\lab-beaver-arm.ts"
$stamp = [string]$registration.execution.run_stamp
$logRoot = Join-Path $repo ".tmp\harvey-minimal-architecture-nine-task-logs\$stamp\wave-$Wave"
$expectedArms = @("upstream", "upstream_terminal_v1", "mike_grep_v1", "mike_structure_paths_v1")
$expectedTasks = @($registration.task_selection.tasks)
$allRuns = @($registration.runs)

if ($registration.experiment_id -ne "harvey-lab-minimal-architecture-nine-task-v1") {
    throw "Unexpected registration: $($registration.experiment_id)"
}
if ($registration.status -ne $registration.prelaunch_commit_gate.required_status) {
    throw "Registration is not launch-ready: $($registration.status)"
}
if ($allRuns.Count -ne 36) {
    throw "Registration must contain exactly 36 runs."
}
if (@($allRuns.run_id | Sort-Object -Unique).Count -ne 36) {
    throw "Registration contains duplicate run IDs."
}
if (@($expectedTasks | Sort-Object -Unique).Count -ne 9) {
    throw "Registration must contain exactly nine unique tasks."
}
if (@($allRuns.arm | Sort-Object -Unique).Count -ne 4 -or
    @(Compare-Object ($allRuns.arm | Sort-Object -Unique) ($expectedArms | Sort-Object)).Count -ne 0) {
    throw "Registration arm set does not match the four frozen arms."
}
foreach ($task in $expectedTasks) {
    $taskRuns = @($allRuns | Where-Object { $_.task -eq $task })
    if ($taskRuns.Count -ne 4 -or
        @(Compare-Object ($taskRuns.arm | Sort-Object) ($expectedArms | Sort-Object)).Count -ne 0) {
        throw "Task does not contain exactly one run per arm: $task"
    }
}

$waveRuns = @($allRuns | Where-Object { [int]$_.wave -eq $Wave })
if ($waveRuns.Count -ne 12) {
    throw "Wave $Wave must contain exactly 12 runs."
}
$waveTasks = @($waveRuns.task | Sort-Object -Unique)
if ($waveTasks.Count -ne 3) {
    throw "Wave $Wave must contain exactly three tasks."
}
foreach ($task in $waveTasks) {
    $taskRuns = @($waveRuns | Where-Object { $_.task -eq $task })
    if ($taskRuns.Count -ne 4 -or
        @(Compare-Object ($taskRuns.arm | Sort-Object) ($expectedArms | Sort-Object)).Count -ne 0) {
        throw "Wave $Wave is not arm-balanced for task: $task"
    }
}

if ($Wave -gt 1) {
    $incompletePriorRuns = @($allRuns | Where-Object { [int]$_.wave -lt $Wave } | Where-Object {
        $runDir = Join-Path $resultsRoot ([string]$_.run_id -replace "/", "\")
        $requiredFiles = @("config.json", "metrics.json", "transcript.jsonl", "beaver-receipts.json")
        $missingArtifact = @($requiredFiles | Where-Object {
            $artifact = Join-Path $runDir $_
            -not (Test-Path -LiteralPath $artifact -PathType Leaf) -or (Get-Item -LiteralPath $artifact).Length -eq 0
        }).Count -gt 0
        if ($missingArtifact) { return $true }
        try {
            $metrics = Get-Content -Raw -LiteralPath (Join-Path $runDir "metrics.json") | ConvertFrom-Json
            $mapping = @($metrics.required_deliverable_mapping.PSObject.Properties)
            if ($metrics.finished_cleanly -ne $true -or $mapping.Count -eq 0) { return $true }
            return @($mapping | Where-Object {
                $deliverable = Join-Path (Join-Path $runDir "output") ([string]$_.Value)
                -not (Test-Path -LiteralPath $deliverable -PathType Leaf) -or (Get-Item -LiteralPath $deliverable).Length -eq 0
            }).Count -gt 0
        } catch {
            return $true
        }
    })
    if ($incompletePriorRuns.Count -gt 0) {
        throw "Wave $Wave cannot start before every earlier run has a clean metrics receipt, trace, receipts, and mapped deliverables."
    }
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
if ($scopedPaths.Count -eq 0 -or @($scopedPaths | Where-Object { $_ -like "*__FILL_AFTER_IMPLEMENTATION__*" }).Count -gt 0) {
    throw "Experiment-scoped path list still contains implementation placeholders."
}
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
    $expected = [string]$fingerprint.Value
    if ($expected -like "*__FILL_AFTER_IMPLEMENTATION__*") {
        throw "Source fingerprint is unresolved for $($fingerprint.Name)."
    }
    $sourcePath = Join-Path $repo ($fingerprint.Name -replace "/", "\")
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Source fingerprint mismatch for $($fingerprint.Name): expected $expected, got $actual"
    }
    $verifiedHashes[$fingerprint.Name] = $actual
}

$verifiedRunFingerprints = @()
foreach ($run in $waveRuns) {
    $probeArgs = @(
        $tsx, $armRunner,
        "--task", [string]$run.task,
        "--arm", [string]$run.arm,
        "--model", "codex:gpt-5.6-luna",
        "--effort", "high",
        "--retrieval-prompt", "neutral",
        "--run-id", "preflight-only",
        "--preflight-only"
    )
    $probeOutput = @(& $node @probeArgs 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Fingerprint probe failed for $($run.run_id): $($probeOutput -join [Environment]::NewLine)"
    }
    $probeLine = @($probeOutput | Where-Object { [string]$_ -match '^\{.*\}$' } | Select-Object -Last 1)
    if ($probeLine.Count -ne 1) {
        throw "Fingerprint probe returned no JSON for $($run.run_id)."
    }
    $probe = [string]$probeLine[0] | ConvertFrom-Json
    $taskFingerprint = $registration.task_fingerprints.PSObject.Properties[[string]$run.task].Value
    foreach ($field in @("split_sha256", "task_config_sha256", "instructions_sha256", "source_bundle_sha256", "source_count", "source_bytes")) {
        if ([string]$probe.$field -ne [string]$taskFingerprint.$field) {
            throw "Task fingerprint mismatch for $($run.task) field ${field}: expected $($taskFingerprint.$field), got $($probe.$field)"
        }
    }
    if ([string]$probe.system_prompt_sha256 -ne [string]$run.system_prompt_sha256 -or
        [string]$probe.tool_schema_sha256 -ne [string]$run.tool_schema_sha256) {
        throw "Prompt/tool fingerprint mismatch for $($run.run_id)."
    }
    $verifiedRunFingerprints += $probe
}

foreach ($run in $waveRuns) {
    $resultPath = Join-Path $resultsRoot ($run.run_id -replace "/", "\")
    if (Test-Path -LiteralPath $resultPath) {
        throw "Refusing to overwrite existing run: $($run.run_id)"
    }
}

$env:LAB_SANDBOX_ENGINE = "docker"
$env:PYTHONDONTWRITEBYTECODE = "1"
if (-not $DryRun) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $logRoot) -Force | Out-Null
    if (Test-Path -LiteralPath $logRoot) {
        throw "Refusing to reuse wave log/claim directory: $logRoot"
    }
    New-Item -ItemType Directory -Path $logRoot | Out-Null
    $claim = [pscustomobject]@{
        experiment_id = $registration.experiment_id
        wave = $Wave
        implementation_commit = $head
        claimed_at = [DateTimeOffset]::UtcNow.ToString("o")
        run_ids = @($waveRuns.run_id)
    }
    [IO.File]::WriteAllText(
        (Join-Path $logRoot "launch-claim.json"),
        ($claim | ConvertTo-Json -Depth 5),
        [Text.UTF8Encoding]::new($false)
    )
}
$jobs = @()

foreach ($run in $waveRuns) {
    $taskLabel = (([string]$run.task -split "/")[-1])
    $name = "$($run.arm)-$taskLabel"
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
        wave = $Wave
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
    wave = $Wave
    registration_path = $registrationRelative
    registration_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $registrationPath).Hash.ToLowerInvariant()
    implementation_commit = $head
    scoped_files_clean_at_launch = $true
    verified_source_fingerprints = $verifiedHashes
    verified_run_fingerprints = $verifiedRunFingerprints
    dry_run = [bool]$DryRun
    run_count = $jobs.Count
    launched_at = [DateTimeOffset]::UtcNow.ToString("o")
    jobs = $jobs
}
$receiptPath = Join-Path $logRoot "launch-receipt.json"
if (-not $DryRun) {
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
$receipt | ConvertTo-Json -Depth 8
