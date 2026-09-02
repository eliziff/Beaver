[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'doctor', 'smoke', 'self-test')]
    [string]$Action = 'status',
    [switch]$Full,
    [switch]$WithTableOfAuthorities,
    [switch]$WithAssistantDock,
    [switch]$NoBrowser,
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Repo 'backend'
$Frontend = Join-Path $Repo 'frontend'
$StateRoot = Join-Path $env:LOCALAPPDATA 'OpenLegalProducts\MikeCanada'
$StateFile = Join-Path $StateRoot 'lifecycle.json'
$SupervisorStateFile = Join-Path $StateRoot 'supervisor.json'

$Services = @(
    [pscustomobject]@{
        Name = 'beaver'
        Port = 3000
        Url = 'http://127.0.0.1:3000/api/health'
    }
)
$Builds = @(
    [pscustomobject]@{ Name = 'backend'; Path = Join-Path $Backend 'dist\supervisor.js'; Command = 'cd backend; npm run build' },
    [pscustomobject]@{ Name = 'frontend'; Path = Join-Path $Frontend 'dist\index.html'; Command = 'cd frontend; npm run build' }
)

function Get-ProcessStamp([int]$Id) {
    try {
        return (Get-Process -Id $Id -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    }
    catch {
        return $null
    }
}

function Test-ProcessIdentity([int]$Id, [string]$StartedAt) {
    $actual = Get-ProcessStamp $Id
    return $null -ne $actual -and $actual -eq $StartedAt
}

function Get-PortOwners([int]$Port) {
    $ids = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $ids) {
        $ids = @(netstat.exe -ano -p tcp 2>$null | ForEach-Object {
            if ($_ -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                [int]$Matches[1]
            }
        } | Select-Object -Unique)
    }
    @($ids |
        ForEach-Object {
            $id = [int]$_
            $process = Get-Process -Id $id -ErrorAction SilentlyContinue
            [pscustomobject]@{
                Id = $id
                Name = if ($process) { $process.ProcessName } else { 'unknown' }
            }
        })
}

function Format-PortOwners([int]$Port) {
    $owners = Get-PortOwners $Port
    if (-not $owners) {
        return "port $Port is free"
    }
    return "port $Port is owned by " + (($owners | ForEach-Object {
        "PID $($_.Id) ($($_.Name))"
    }) -join ', ')
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    }
    catch {
        throw "Lifecycle state is unreadable: $StateFile. $($_.Exception.Message)"
    }
}

function Write-State($State) {
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $temporary = "$StateFile.new"
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

function Get-OwnedRecords($State) {
    if (-not $State) {
        return @()
    }
    @($State.processes | Where-Object {
        (Test-ProcessIdentity ([int]$_.rootPid) ([string]$_.rootStartedAt)) -or
        (Test-ProcessIdentity ([int]$_.listenerPid) ([string]$_.listenerStartedAt))
    })
}

function Test-LauncherOwnedListener($State, [string]$Name, [int]$Port) {
    if (-not $State) {
        return $false
    }
    $records = @($State.processes | Where-Object {
        $_.name -eq $Name -and [int]$_.port -eq $Port
    })
    $owners = @(Get-PortOwners $Port)
    if ($records.Count -ne 1 -or $owners.Count -ne 1) {
        return $false
    }
    $record = $records[0]
    if ((Test-ProcessIdentity ([int]$record.listenerPid) ([string]$record.listenerStartedAt)) -and
        [int]$owners[0].Id -eq [int]$record.listenerPid) {
        return $true
    }
    if (-not (Test-ProcessIdentity ([int]$record.rootPid) ([string]$record.rootStartedAt))) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $SupervisorStateFile -PathType Leaf)) { return $false }
    try { $supervisor = Get-Content -LiteralPath $SupervisorStateFile -Raw | ConvertFrom-Json }
    catch { return $false }
    return [int]$supervisor.rootPid -eq [int]$record.rootPid -and
        [int]$supervisor.listenerPid -eq [int]$owners[0].Id
}

function Resolve-Application([string[]]$Names) {
    foreach ($name in $Names) {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($command) {
            return $command.Source
        }
    }
    return $null
}

function Resolve-Codex([switch]$Optional) {
    $configured = [Environment]::GetEnvironmentVariable('CODEX_COMMAND')
    if (-not $configured) {
        $configured = Get-ConfigValue 'CODEX_COMMAND'
    }
    if ($configured) {
        if (Test-Path -LiteralPath $configured -PathType Leaf) {
            return (Resolve-Path -LiteralPath $configured).Path
        }
        $resolved = Resolve-Application @($configured)
        if ($resolved) {
            return $resolved
        }
        throw "CODEX_COMMAND does not resolve to an executable: $configured"
    }
    $resolved = Resolve-Application @('codex.cmd', 'codex.exe')
    if (-not $resolved) {
        if ($Optional) {
            return $null
        }
        throw 'Codex CLI was not found. Install/update Codex so codex.cmd is available.'
    }
    return $resolved
}

function Get-CommandVersion([string]$Executable, [string[]]$Arguments) {
    try {
        return (& $Executable @Arguments 2>&1 | Select-Object -First 1).ToString().Trim()
    }
    catch {
        return $null
    }
}

function Get-Node {
    $node = Resolve-Application @('node.exe', 'node')
    if (-not $node) {
        throw 'Node.js is missing. Beaver requires Node.js 22.13 or newer.'
    }
    $version = Get-CommandVersion $node @('--version')
    $match = [regex]::Match([string]$version, '(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success -or
        [int]$match.Groups[1].Value -lt 22 -or
        ([int]$match.Groups[1].Value -eq 22 -and [int]$match.Groups[2].Value -lt 13)) {
        throw "Unsupported Node.js version '$version'. Install Node.js 22.13 or newer."
    }
    return $node
}

function Resolve-LegalStructureNative {
    $configured = Get-ConfigValue 'LEGAL_STRUCTURE_NATIVE'
    if ($configured) {
        if (Test-Path -LiteralPath $configured -PathType Leaf) {
            return (Resolve-Path -LiteralPath $configured).Path
        }
        throw "LEGAL_STRUCTURE_NATIVE does not resolve to a library: $configured"
    }
    $filename = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        'legal_structure_node.dll'
    } elseif ($IsMacOS) {
        'liblegal_structure_node.dylib'
    } else {
        'liblegal_structure_node.so'
    }
    $managed = Join-Path $Repo "native\legal-structure-node\target\release\$filename"
    if (Test-Path -LiteralPath $managed -PathType Leaf) {
        return (Resolve-Path -LiteralPath $managed).Path
    }
    throw 'Legal structure native module is missing. Build native/legal-structure-node once for this platform.'
}

function Get-ConfigValue([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -ne $value -and $value.Trim()) {
        return $value.Trim()
    }
    $envFile = Join-Path $Backend '.env'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return $null
    }
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*([^#=\s]+)\s*=(.*)$' -and $Matches[1] -eq $Name) {
            return $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

function Test-Configured([string[]]$Names) {
    foreach ($name in $Names) {
        $value = Get-ConfigValue $name
        if ($value -and $value -notmatch '^(your-|replace-with-|https://your-)') {
            return $true
        }
    }
    return $false
}

function Get-CredentialStatus([string[]]$Names) {
    if (Test-Configured $Names) {
        return 'configured'
    }
    return 'not configured (optional)'
}

function Assert-Builds {
    foreach ($build in $Builds) {
        if (-not (Test-Path -LiteralPath $build.Path -PathType Leaf)) {
            throw "Missing $($build.Name) production build: $($build.Path). Run: $($build.Command)"
        }
    }
}

function Assert-PortFree([string]$Name, [int]$Port) {
    $owners = Get-PortOwners $Port
    if ($owners) {
        throw "$Name cannot start: $(Format-PortOwners $Port)."
    }
}

function Assert-PortsFree {
    foreach ($service in $Services) {
        Assert-PortFree $service.Name $service.Port
    }
}

function Wait-Ready(
    [string]$Name,
    [string]$Url,
    [System.Diagnostics.Process]$Process,
    [int]$Seconds
) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    $lastError = 'no response'
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "$Name exited during startup with code $($Process.ExitCode)."
        }
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($Name -eq 'beaver' -and $response.ok -ne $true) {
                throw 'health response did not contain ok=true'
            }
            return
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name did not become ready at $Url within $Seconds seconds. Last error: $lastError"
}

function Add-ProcessRecord($State, [string]$Name, [int]$Port, $Process, [string]$Stdout, [string]$Stderr) {
    $startedAt = Get-ProcessStamp $Process.Id
    $State.processes += [pscustomobject]@{
        name = $Name
        port = $Port
        rootPid = $Process.Id
        rootStartedAt = $startedAt
        listenerPid = $Process.Id
        listenerStartedAt = $startedAt
        stdout = $Stdout
        stderr = $Stderr
    }
    Write-State $State
}

function Set-ListenerRecord($State, [string]$Name, [int]$Port, $Process) {
    $owners = @(Get-PortOwners $Port)
    if ($owners.Count -ne 1) {
        throw "$Name became reachable but $(Format-PortOwners $Port)."
    }
    $listenerPid = [int]$owners[0].Id
    $record = @($State.processes | Where-Object {
        $_.name -eq $Name -and [int]$_.rootPid -eq $Process.Id
    })[-1]
    $record.listenerPid = $listenerPid
    $record.listenerStartedAt = Get-ProcessStamp $listenerPid
    Write-State $State
}

function Start-LoggedProcess(
    [string]$Name,
    [string]$Executable,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    $State
) {
    $logRoot = Join-Path $StateRoot 'logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $logRoot "$stamp-$Name.stdout.log"
    $stderr = Join-Path $logRoot "$stamp-$Name.stderr.log"
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $process.PriorityClass = 'BelowNormal'
    return [pscustomobject]@{
        Process = $process
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Stop-Identity([int]$Id, [string]$StartedAt, [string]$Label) {
    if (-not (Test-ProcessIdentity $Id $StartedAt)) {
        Write-Host "$Label PID $Id is no longer the process Beaver started; skipped."
        return
    }
    Stop-Process -Id $Id -Force
    Write-Host "Stopped $Label PID $Id."
}

function Stop-Stack([switch]$Quiet) {
    $state = Read-State
    if (-not $state) {
        if (-not $Quiet) {
            Write-Host "Beaver has no launcher-owned processes."
        }
        return
    }
    foreach ($record in @($state.processes) | Select-Object -Last 100 | Sort-Object { $_.name }) {
        Stop-Identity ([int]$record.rootPid) ([string]$record.rootStartedAt) $record.name
        if ([int]$record.listenerPid -ne [int]$record.rootPid) {
            Start-Sleep -Milliseconds 250
            Stop-Identity ([int]$record.listenerPid) ([string]$record.listenerStartedAt) "$($record.name) listener"
        }
    }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $SupervisorStateFile -Force -ErrorAction SilentlyContinue
}

function Show-Status {
    $state = Read-State
    $owned = Get-OwnedRecords $state
    Write-Host "Launcher state: $(if ($owned) { 'running' } elseif ($state) { 'stale' } else { 'stopped' })"
    foreach ($service in $Services) {
        Write-Host ("{0}: {1}" -f $service.Name, (Format-PortOwners $service.Port))
    }
}

function Invoke-Doctor {
    $failed = $false
    $state = Read-State
    Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
    try {
        $node = Get-Node
        Write-Host "Node: $(Get-CommandVersion $node @('--version')) ($node)"
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        $failed = $true
    }
    try {
        $codex = Resolve-Codex -Optional
        if ($codex) {
            Write-Host "Codex: $(Get-CommandVersion $codex @('--version')) ($codex)"
        }
        else {
            Write-Host 'Codex: not installed (optional when another provider is used)'
        }
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        $failed = $true
    }
    try {
        $legalStructureNative = Resolve-LegalStructureNative
        Write-Host "Legal structure native module: $legalStructureNative"
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        $failed = $true
    }
    foreach ($build in $Builds) {
        if (Test-Path -LiteralPath $build.Path -PathType Leaf) {
            Write-Host "$($build.Name) build: present"
        }
        else {
            Write-Host "$($build.Name) build: MISSING ($($build.Path))"
            $failed = $true
        }
    }
    foreach ($service in $Services) {
        Write-Host "$($service.Name): $(Format-PortOwners $service.Port)"
        $ownedPid = @($state.processes | Where-Object {
            $_.name -eq $service.Name -and
            (Test-ProcessIdentity ([int]$_.listenerPid) ([string]$_.listenerStartedAt))
        } | Select-Object -ExpandProperty listenerPid)
        $unexpected = @(Get-PortOwners $service.Port | Where-Object { $_.Id -notin $ownedPid })
        if ($unexpected) {
            Write-Host "ERROR: $($service.Name) port has a listener not owned by this launcher."
            $failed = $true
        }
    }
    $authMode = Get-ConfigValue 'AUTH_MODE'
    $missingSupabase = @(
        'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'DATABASE_URL' |
            Where-Object { -not (Test-Configured @($_)) }
    )
    if ($authMode -notin @('local', 'cloud')) {
        Write-Host 'ERROR: AUTH_MODE must be local or cloud.'
        $failed = $true
    }
    elseif ($authMode -eq 'cloud' -and $missingSupabase) {
        Write-Host "ERROR: Cloud mode is missing: $($missingSupabase -join ', ')."
        $failed = $true
    }
    else {
        Write-Host "Authentication: $(if ($authMode -eq 'local') { 'account-free local' } else { 'cloud' })"
    }
    $providers = [ordered]@{
        Anthropic = @('ANTHROPIC_API_KEY', 'CLAUDE_API_KEY')
        Gemini = @('GEMINI_API_KEY')
        OpenAI = @('OPENAI_API_KEY')
        DeepSeek = @('DEEPSEEK_API_KEY', 'DEEPSEEK_OCR_KEY')
        OpenRouter = @('OPENROUTER_API_KEY')
        CourtListener = @('COURTLISTENER_API_TOKEN')
        GovInfo = @('GOVINFO_API_KEY')
    }
    foreach ($provider in $providers.Keys) {
        $status = Get-CredentialStatus $providers[$provider]
        Write-Host "$provider credential: $status"
    }
    if ($failed) {
        throw 'Doctor found required startup problems.'
    }
}

function Start-Stack {
    $existing = Read-State
    if (Get-OwnedRecords $existing) {
        throw "Beaver is already running from $StateFile. Run status or stop first."
    }
    if ($existing) {
        Remove-Item -LiteralPath $StateFile -Force
    }
    Assert-Builds
    $node = Get-Node
    $codex = Resolve-Codex -Optional
    $legalStructureNative = Resolve-LegalStructureNative
    Assert-PortsFree

    $state = [pscustomobject]@{
        version = 1
        startedAt = [DateTime]::UtcNow.ToString('o')
        codex = $codex
        processes = @()
    }
    Write-State $state
    $launched = @()
    $previousCodex = [Environment]::GetEnvironmentVariable('CODEX_COMMAND', 'Process')
    $previousLegalStructureNative = [Environment]::GetEnvironmentVariable('LEGAL_STRUCTURE_NATIVE', 'Process')
    $previousNodeEnvironment = [Environment]::GetEnvironmentVariable('NODE_ENV', 'Process')
    $previousSupervisorState = [Environment]::GetEnvironmentVariable('MIKE_SUPERVISOR_STATE_FILE', 'Process')
    try {
        # Pin resolved executables for the Beaver child; PATH is untouched.
        if ($codex) {
            [Environment]::SetEnvironmentVariable('CODEX_COMMAND', $codex, 'Process')
        }
        [Environment]::SetEnvironmentVariable('LEGAL_STRUCTURE_NATIVE', $legalStructureNative, 'Process')
        Remove-Item -LiteralPath $SupervisorStateFile -Force -ErrorAction SilentlyContinue
        [Environment]::SetEnvironmentVariable('MIKE_SUPERVISOR_STATE_FILE', $SupervisorStateFile, 'Process')

        $previousPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
        [Environment]::SetEnvironmentVariable('PORT', '3000', 'Process')
        [Environment]::SetEnvironmentVariable('NODE_ENV', 'production', 'Process')
        $backendStart = Start-LoggedProcess 'beaver' $node @('--env-file=.env', 'dist/supervisor.js') $Backend $state
        $launched += [pscustomobject]@{
            Id = $backendStart.Process.Id
            StartedAt = Get-ProcessStamp $backendStart.Process.Id
        }
        Add-ProcessRecord $state 'beaver' 3000 $backendStart.Process $backendStart.Stdout $backendStart.Stderr
        Wait-Ready 'beaver' $Services[0].Url $backendStart.Process $TimeoutSeconds
        Set-ListenerRecord $state 'beaver' 3000 $backendStart.Process
        Write-Host "Beaver ready: $($Services[0].Url)"

    }
    catch {
        $message = $_.Exception.Message
        Stop-Stack -Quiet
        foreach ($item in $launched) {
            if (Test-ProcessIdentity ([int]$item.Id) ([string]$item.StartedAt)) {
                Stop-Process -Id ([int]$item.Id) -Force -ErrorAction SilentlyContinue
            }
        }
        throw "$message Logs: $(Join-Path $StateRoot 'logs')"
    }
    finally {
        [Environment]::SetEnvironmentVariable('CODEX_COMMAND', $previousCodex, 'Process')
        [Environment]::SetEnvironmentVariable('LEGAL_STRUCTURE_NATIVE', $previousLegalStructureNative, 'Process')
        [Environment]::SetEnvironmentVariable('PORT', $previousPort, 'Process')
        [Environment]::SetEnvironmentVariable('NODE_ENV', $previousNodeEnvironment, 'Process')
        [Environment]::SetEnvironmentVariable('MIKE_SUPERVISOR_STATE_FILE', $previousSupervisorState, 'Process')
    }

    if (-not $NoBrowser) {
        Start-Process 'http://127.0.0.1:3000/'
    }
}

function Invoke-Smoke {
    $state = Read-State
    foreach ($service in $Services) {
        if (-not (Test-LauncherOwnedListener $state $service.Name $service.Port)) {
            throw "Smoke requires launcher-owned $($service.Name); $(Format-PortOwners $service.Port). Run: .\scripts\mike.ps1 start"
        }
    }
    $checks = @(
        [pscustomobject]@{ Name = 'beaver'; Url = 'http://127.0.0.1:3000/api/health' },
        [pscustomobject]@{ Name = 'app'; Url = 'http://127.0.0.1:3000/' },
        [pscustomobject]@{ Name = 'Authorities'; Url = 'http://127.0.0.1:3000/table-of-authorities' },
        [pscustomobject]@{ Name = 'Authorities drafts'; Url = 'http://127.0.0.1:3000/api/authorities' },
        [pscustomobject]@{ Name = 'Library'; Url = 'http://127.0.0.1:3000/api/library/files' }
    )
    if ($state.codex) {
        $checks += [pscustomobject]@{ Name = 'Model catalog'; Url = 'http://127.0.0.1:3000/api/models' }
    }
    elseif ($Full) {
        throw 'Full smoke requires an installed and authenticated Codex CLI.'
    }
    else {
        Write-Host 'SKIP Codex model catalog: Codex is not installed; another provider may be used.'
    }
    foreach ($check in $checks) {
        try {
            $response = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec 20
            if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
                throw "HTTP $($response.StatusCode)"
            }
            if ($check.Name -notin @('app', 'Authorities')) {
                $payload = $response.Content | ConvertFrom-Json
                if ($check.Name -eq 'beaver' -and $payload.ok -ne $true) {
                    throw 'health response did not contain ok=true'
                }
                if ($check.Name -eq 'Library' -and
                    ($null -eq $payload.items -or
                     'next_cursor' -notin $payload.PSObject.Properties.Name)) {
                    throw 'Library response was incomplete'
                }
                # 'Model catalog' has no payload gate: the endpoint degrades
                # honestly to source 'unavailable' with an empty list, which the
                # UI already handles. Reaching valid JSON proves auth and the route.
            }
            Write-Host "PASS $($check.Name): $($check.Url)"
        }
        catch {
            throw "FAIL $($check.Name): $($check.Url) - $($_.Exception.Message)"
        }
    }
    if ($WithTableOfAuthorities) {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) {
            throw 'Authorities smoke requires Python and ChromeDriver.'
        }
        & $python.Source (Join-Path $Repo 'scripts\test-authorities-browser.py') `
            '--url' 'http://127.0.0.1:3000/table-of-authorities'
        if ($LASTEXITCODE -ne 0) {
            throw "Authorities browser smoke failed with exit code $LASTEXITCODE."
        }
    }
    if ($Full -or $WithAssistantDock) {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) {
            throw 'Assistant dock smoke requires Python and ChromeDriver.'
        }
        & $python.Source (Join-Path $Repo 'scripts\test-sources-dock-browser.py') `
            '--url' 'http://127.0.0.1:3000/'
        if ($LASTEXITCODE -ne 0) {
            throw "Assistant dock browser smoke failed with exit code $LASTEXITCODE."
        }
    }
    if ($Full) {
        $playwright = Join-Path $Repo 'node_modules\.bin\playwright.cmd'
        if (-not (Test-Path -LiteralPath $playwright -PathType Leaf)) {
            throw 'Full smoke requires root test dependencies. Run npm ci in the repository root.'
        }
        Push-Location $Repo
        try {
            & $playwright test '--config=playwright.local-smoke.config.ts'
            if ($LASTEXITCODE -ne 0) {
                throw "Full local production smoke failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
}

function Invoke-SelfTest {
    if (-not (Test-ProcessIdentity $PID (Get-ProcessStamp $PID))) {
        throw 'Process identity check failed.'
    }
    if (Test-ProcessIdentity $PID ([DateTime]::UtcNow.AddDays(-1).ToString('o'))) {
        throw 'Process identity accepted a stale PID.'
    }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $owners = @(Get-PortOwners $port)
            if ($owners) { break }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not ($owners | Where-Object { $_.Id -eq $PID })) {
            throw "Port ownership check did not report this process on port $port."
        }
        $ownedState = [pscustomobject]@{
            processes = @([pscustomobject]@{
                name = 'self-test'
                port = $port
                listenerPid = $PID
                listenerStartedAt = Get-ProcessStamp $PID
            })
        }
        if (-not (Test-LauncherOwnedListener $ownedState 'self-test' $port)) {
            throw 'Launcher-owned listener check rejected a matching process.'
        }
        try {
            Assert-PortFree 'self-test' $port
            throw 'Occupied port check did not fail.'
        }
        catch {
            if ($_.Exception.Message -notmatch "^self-test cannot start: port $port is owned by PID $PID \(.+\)\.$") {
                throw
            }
        }
        $ownedState.processes[0].listenerStartedAt = [DateTime]::UtcNow.AddDays(-1).ToString('o')
        if (Test-LauncherOwnedListener $ownedState 'self-test' $port) {
            throw 'Launcher-owned listener check accepted a stale process.'
        }
    }
    finally {
        $listener.Stop()
    }
    $resolvedCodex = Resolve-Codex -Optional
    if ($resolvedCodex -and -not (Test-Path -LiteralPath $resolvedCodex -PathType Leaf)) {
        throw 'Codex resolution check failed.'
    }
    if ((Get-CredentialStatus @("MIKE_SELF_TEST_MISSING_OPTIONAL_KEY_$PID")) -ne 'not configured (optional)') {
        throw 'Missing optional credential check failed.'
    }
    $node = Get-Node
    $failedProcess = Start-Process -FilePath $node -ArgumentList @('-e', 'process.exit(23)') `
        -WindowStyle Hidden -PassThru
    $failedProcess.WaitForExit()
    try {
        Wait-Ready 'backend' 'http://127.0.0.1:1/' $failedProcess 1
        throw 'Failed backend check did not fail.'
    }
    catch {
        if ($_.Exception.Message -ne 'backend exited during startup with code 23.') {
            throw
        }
    }
    $build = $Builds[0].Path
    try {
        $Builds[0].Path = Join-Path $Repo 'definitely-missing-build'
        try {
            Assert-Builds
            throw 'Missing build check did not fail.'
        }
        catch {
            if ($_.Exception.Message -notmatch '^Missing backend production build:') {
                throw
            }
        }
    }
    finally {
        $Builds[0].Path = $build
    }
    Write-Host 'PASS lifecycle self-test'
}

try {
    switch ($Action) {
        'start' { Start-Stack }
        'stop' { Stop-Stack }
        'status' { Show-Status }
        'doctor' { Invoke-Doctor }
        'smoke' { Invoke-Smoke }
        'self-test' { Invoke-SelfTest }
    }
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
