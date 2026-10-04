[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3100
)

$ErrorActionPreference = 'Stop'
# Keep heavy checks serialized while this deliberately long battery runs.
$Repo = Split-Path -Parent $PSScriptRoot
$Mike = Join-Path $PSScriptRoot 'mike.ps1'
$ReceiptDirectory = Join-Path $Repo '.tmp\full-sweep'
$ReceiptFile = Join-Path $ReceiptDirectory 'latest.json'
$ReceiptTemporary = "$ReceiptFile.new"
$RunId = [Guid]::NewGuid().ToString()
$RunDirectory = Join-Path $ReceiptDirectory 'latest-run'
$script:StepLog = $null
$script:SurfaceStarted = $false
$script:Failed = $false
$script:Receipt = [ordered]@{
    started_at = [DateTime]::UtcNow.ToString('o')
    status = 'running'
    model = 'codex:gpt-6-luna'
    reasoning_effort = 'low'
    submission = @{ origin = 'machine_test'; run_id = $RunId; scenario = 'FullSweep' }
    run_directory = $RunDirectory
    steps = @()
}

New-Item -ItemType Directory -Force -Path $ReceiptDirectory | Out-Null
$Mutex = [Threading.Mutex]::new($false, 'Local\BeaverFullSweep')
if (-not $Mutex.WaitOne(0)) {
    $Mutex.Dispose()
    throw 'Another FullSweep is already running.'
}
try {
    if ((Get-Item -LiteralPath $ReceiptDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'FullSweep output must not be a reparse point.'
    }
    if (Test-Path -LiteralPath $RunDirectory) {
        if ((Get-Item -LiteralPath $RunDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'FullSweep output must not be a reparse point.'
        }
        Remove-Item -LiteralPath $RunDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $RunDirectory | Out-Null
} catch {
    $Mutex.ReleaseMutex()
    $Mutex.Dispose()
    throw
}

function Save-Receipt {
    $script:Receipt | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $ReceiptTemporary -Encoding UTF8
    Move-Item -LiteralPath $ReceiptTemporary -Destination $ReceiptFile -Force
    Copy-Item -LiteralPath $ReceiptFile -Destination (Join-Path $RunDirectory 'receipt.json') -Force
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    $preference = $ErrorActionPreference
    $exitCode = -1
    try {
        $ErrorActionPreference = 'Continue'
        & $Command @Arguments 2>&1 | Tee-Object -FilePath $script:StepLog
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $preference
    }
    if ($exitCode -ne 0) {
        Get-Content -LiteralPath $script:StepLog -Tail 80 | Write-Host
        throw "$Command exited with code $exitCode."
    }
}

function Invoke-Step([string]$Name, [scriptblock]$Action, [switch]$KeepGoing) {
    Write-Host "`n==> $Name"
    $slug = $Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-'
    $script:StepLog = Join-Path $RunDirectory "$slug.log"
    Set-Content -LiteralPath $script:StepLog -Value ''
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $step = [ordered]@{ name = $Name; status = 'passed'; seconds = 0; log = $script:StepLog }
    try {
        & $Action
    }
    catch {
        $step.status = 'failed'
        $step.error = $_.Exception.Message
        if ($KeepGoing) {
            Write-Warning "$Name failed: $($_.Exception.Message)"
        }
        else {
            $script:Receipt.status = 'failed'
            $script:Receipt.finished_at = [DateTime]::UtcNow.ToString('o')
            throw
        }
    }
    finally {
        $watch.Stop()
        $step.seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 2)
        $script:Receipt.steps += $step
        Save-Receipt
    }
    if ($step.status -eq 'passed') {
        Write-Host "PASS $Name ($([Math]::Round($watch.Elapsed.TotalSeconds, 1))s)"
    }
}

$PreviousEnvironment = @{}
$CodexAuthHome = if ($env:BEAVER_CODEX_HOME) { $env:BEAVER_CODEX_HOME }
    elseif ($env:CODEX_HOME) { $env:CODEX_HOME }
    else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
$SweepEnvironment = @{
    PORT = [string]$Port
    AUTH_MODE = 'local'
    LIVE_E2E = '0'
    NODE_NO_WARNINGS = '1'
    BEAVER_JEV_TABULAR_MODE = 'off'
    BEAVER_TEST_RUN_ID = $RunId
    BEAVER_TEST_SCENARIO = 'FullSweep'
    BEAVER_CODEX_HOME = (Join-Path $RunDirectory 'codex')
    MIKE_LAUNCHER_STATE_DIR = (Join-Path $RunDirectory 'launcher')
    OPEN_LEGAL_DATA_HOME = (Join-Path $RunDirectory 'legal-data')
    MIKE_LOCAL_DATA_DIR = (Join-Path $RunDirectory 'library')
    MIKE_CITATOR_DB = (Join-Path $RunDirectory 'citator.sqlite')
}
foreach ($name in $SweepEnvironment.Keys) {
    $PreviousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $SweepEnvironment[$name], 'Process')
}

function Invoke-LiveStep([string]$Name, [string]$Pattern) {
    Invoke-Step $Name -KeepGoing {
        $previous = @{}
        $liveEnvironment = @{ LIVE_E2E = '1'; LIVE_MODEL = $script:Receipt.model;
            LIVE_REASONING_EFFORT = $script:Receipt.reasoning_effort; BEAVER_JEV_TABULAR_MODE = 'off' }
        foreach ($name in $liveEnvironment.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $liveEnvironment[$name], 'Process')
        }
        Push-Location (Join-Path $Repo 'backend')
        try {
            $result = [IO.Path]::ChangeExtension($script:StepLog, '.json')
            Invoke-Checked npx.cmd @('vitest', 'run', '--maxWorkers=1',
                '--silent=false',
                '--reporter=default', '--reporter=json', "--outputFile=$result",
                'src/__tests__/integration/liveToolLoop.test.ts', '-t', $Pattern)
        }
        finally {
            Pop-Location
            foreach ($name in $previous.Keys) {
                [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
            }
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $env:BEAVER_CODEX_HOME | Out-Null
    $auth = Join-Path $CodexAuthHome 'auth.json'
    if (Test-Path -LiteralPath $auth -PathType Leaf) {
        Copy-Item -LiteralPath $auth -Destination (Join-Path $env:BEAVER_CODEX_HOME 'auth.json')
    }
    Save-Receipt
    Invoke-Step 'Check isolated port' {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$env:PORT)
        try { $listener.Start() } finally { $listener.Stop() }
    }
    Invoke-Step 'Native release build' {
        Invoke-Checked cargo @(
            'build', '--manifest-path',
            (Join-Path $Repo 'native\legal-structure-node\Cargo.toml'),
            '--release', '--locked', '--offline', '--quiet', '--jobs', '1'
        )
    }
    Invoke-Step 'Shared PDF behavior' {
        Invoke-Checked node @('--test', 'shared/browser-pdf.test.mjs')
    }
    Invoke-Step 'Backend build' { Invoke-Checked npm.cmd @('run', 'build', '--prefix', 'backend') }
    Invoke-Step 'Frontend deployment build' { Invoke-Checked npm.cmd @('run', 'build:deploy', '--prefix', 'frontend') }
    Invoke-Step 'Start isolated production surface' {
        & $Mike start -NoBrowser
        if (-not $?) { throw 'Could not start the production surface.' }
        $script:SurfaceStarted = $true
        $profile = @{ titleModel = $script:Receipt.model; tabularModel = $script:Receipt.model;
            lastSelectedReasoningEffort = $script:Receipt.reasoning_effort;
            lastSelectedChatModel = $script:Receipt.model } | ConvertTo-Json
        Invoke-RestMethod -Method Patch -Uri "http://127.0.0.1:$Port/api/user/profile" `
            -ContentType 'application/json' -Body $profile | Out-Null
        & $Mike smoke
        if (-not $?) { throw 'Production health smoke failed.' }
    }
    Invoke-Step 'Production browser outcomes' -KeepGoing {
        $previousBrowserLive = $env:BEAVER_BROWSER_LIVE
        try {
            $env:BEAVER_BROWSER_LIVE = '1'
            Invoke-Checked (Join-Path $Repo 'node_modules\.bin\playwright.cmd') @('test', '--config=playwright.local-smoke.config.ts')
        }
        finally { $env:BEAVER_BROWSER_LIVE = $previousBrowserLive }
    }
    Invoke-Step 'Stop isolated production surface' {
        if ($script:SurfaceStarted) {
            & $Mike stop
            if (-not $?) { throw 'Could not stop the isolated production surface.' }
        }
        $script:SurfaceStarted = $false
    }
    Invoke-LiveStep 'Live Luna 6 library reading and lint' 'reads an uploaded lease|routes a drafting-errors'
    Invoke-LiveStep 'Live Luna 6 Authorities and Court Records' 'uses the selected parallel|fills only empty Court'
    Invoke-LiveStep 'Live Luna 6 saved research' 'builds one labelled'
    Invoke-LiveStep 'Live Luna 6 Organize revisions and undo' 'organizes research'
    Invoke-LiveStep 'Live Luna 6 Library and project folder organization' 'organizes library folders|organizes project folders'
    Invoke-LiveStep 'Live Luna 6 research table layout' 'creates a suggested research table'
    Invoke-LiveStep 'Live Luna 6 tabular generation and regeneration' 'generates grounded tabular answers'
    Invoke-LiveStep 'Live Luna 6 parallel subagent research' 'delegates parallel source review'
    $script:Failed = @($script:Receipt.steps | Where-Object { $_.status -eq 'failed' }).Count -gt 0
    $script:Receipt.status = if ($script:Failed) { 'failed' } else { 'passed' }
    $script:Receipt.finished_at = [DateTime]::UtcNow.ToString('o')
    Save-Receipt
    Write-Host "`nFullSweep $($script:Receipt.status). Receipt: $ReceiptFile"
}
catch {
    $script:Failed = $true
    Write-Host "FullSweep failed: $($_.Exception.Message) Receipt: $ReceiptFile" -ForegroundColor Red
}
finally {
    try {
        if ($script:SurfaceStarted) {
            & $Mike stop
            if (-not $?) { Write-Warning 'FullSweep could not stop its isolated surface.' }
        }
    }
    finally {
        foreach ($name in $PreviousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $PreviousEnvironment[$name], 'Process')
        }
        $Mutex.ReleaseMutex()
        $Mutex.Dispose()
    }
}

if ($script:Failed) { exit 1 }
