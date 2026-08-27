[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$env:NODE_NO_WARNINGS = '1'
$Repo = Split-Path -Parent $PSScriptRoot
$Mike = Join-Path $PSScriptRoot 'mike.ps1'
$ReceiptDirectory = Join-Path $Repo '.tmp\full-sweep'
$ReceiptFile = Join-Path $ReceiptDirectory 'latest.json'
$script:StepLog = $null
$script:Receipt = [ordered]@{
    started_at = [DateTime]::UtcNow.ToString('o')
    status = 'running'
    steps = @()
}

New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null

function Save-Receipt {
    $script:Receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReceiptFile
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments 2>&1 | Tee-Object -FilePath $script:StepLog -Append
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $preference
    }
    if ($exitCode -ne 0) {
        throw "$Command exited with code $exitCode."
    }
}

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    Write-Host "`n==> $Name"
    $slug = $Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    $script:StepLog = Join-Path $ReceiptDirectory "latest-$slug.log"
    Set-Content -LiteralPath $script:StepLog -Value ''
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        $watch.Stop()
        $script:Receipt.steps += [ordered]@{
            name = $Name
            status = 'passed'
            seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
            log = Split-Path -Leaf $script:StepLog
        }
        Save-Receipt
        Write-Host "PASS $Name ($([Math]::Round($watch.Elapsed.TotalSeconds, 1))s)"
    }
    catch {
        $watch.Stop()
        $script:Receipt.steps += [ordered]@{
            name = $Name
            status = 'failed'
            seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
            error = $_.Exception.Message
            log = Split-Path -Leaf $script:StepLog
        }
        $script:Receipt.status = 'failed'
        $script:Receipt.finished_at = [DateTime]::UtcNow.ToString('o')
        Save-Receipt
        throw
    }
}

try {
    Invoke-Step 'Stop launcher-owned surface' {
        & $Mike stop
        if (-not $?) { throw 'Could not stop the local surface.' }
    }
    Invoke-Step 'Native adapter check' {
        Invoke-Checked cargo @(
            'check', '--manifest-path',
            (Join-Path $Repo 'native\legal-structure-node\Cargo.toml'), '--offline', '--quiet'
        )
    }
    Invoke-Step 'Native release build' {
        Invoke-Checked cargo @(
            'build', '--manifest-path',
            (Join-Path $Repo 'native\legal-structure-node\Cargo.toml'),
            '--release', '--offline', '--quiet'
        )
    }
    Invoke-Step 'Backend tests' { Invoke-Checked npm.cmd @('test', '--prefix', 'backend') }
    Invoke-Step 'Frontend tests' { Invoke-Checked npm.cmd @('test', '--prefix', 'frontend') }
    Invoke-Step 'Backend build' { Invoke-Checked npm.cmd @('run', 'build', '--prefix', 'backend') }
    Invoke-Step 'Frontend build' { Invoke-Checked npm.cmd @('run', 'build', '--prefix', 'frontend') }
    Invoke-Step 'Production browser smoke' {
        & $Mike start -WithTableOfAuthorities -NoBrowser
        if (-not $?) { throw 'Could not start the production surface.' }
        & $Mike smoke -Full -WithTableOfAuthorities
        if (-not $?) { throw 'Production browser smoke failed.' }
    }
    Invoke-Step 'Live Luna low tool loop' {
        $previousLive = $env:LIVE_E2E
        $previousModel = $env:LIVE_MODEL
        $previousEffort = $env:LIVE_REASONING_EFFORT
        try {
            $env:LIVE_E2E = '1'
            $env:LIVE_MODEL = 'codex:gpt-5.6-luna'
            $env:LIVE_REASONING_EFFORT = 'low'
            Push-Location (Join-Path $Repo 'backend')
            try {
                Invoke-Checked npx.cmd @(
                    'vitest', 'run', 'src/__tests__/integration/liveToolLoop.test.ts'
                )
            }
            finally { Pop-Location }
        }
        finally {
            $env:LIVE_E2E = $previousLive
            $env:LIVE_MODEL = $previousModel
            $env:LIVE_REASONING_EFFORT = $previousEffort
        }
    }
    $script:Receipt.status = 'passed'
    $script:Receipt.finished_at = [DateTime]::UtcNow.ToString('o')
    Save-Receipt
    Write-Host "`nFullSweep passed. Receipt: $ReceiptFile"
}
catch {
    Write-Error "FullSweep failed: $($_.Exception.Message) Receipt: $ReceiptFile"
    exit 1
}
