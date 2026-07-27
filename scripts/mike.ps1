[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'doctor', 'smoke', 'self-test')]
    [string]$Action = 'status',
    [switch]$WithTableOfAuthorities,
    [switch]$NoBrowser,
    [ValidateRange(5, 300)]
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Repo 'backend'
$Frontend = Join-Path $Repo 'frontend'
$Toa = Join-Path $Repo 'TableOfAuthoritiesMaker'
$StateRoot = Join-Path $env:LOCALAPPDATA 'OpenLegalProducts\MikeCanada'
$StateFile = Join-Path $StateRoot 'lifecycle.json'

$Services = @(
    [pscustomobject]@{
        Name = 'backend'
        Port = 3001
        Url = 'http://127.0.0.1:3001/health'
        Build = Join-Path $Backend 'dist\index.js'
    },
    [pscustomobject]@{
        Name = 'frontend'
        Port = 3000
        Url = 'http://127.0.0.1:3000/'
        Build = Join-Path $Frontend '.next\BUILD_ID'
    }
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

function Resolve-Codex {
    $configured = [Environment]::GetEnvironmentVariable('CODEX_EXEC_COMMAND')
    if (-not $configured) {
        $configured = Get-ConfigValue 'CODEX_EXEC_COMMAND'
    }
    if ($configured) {
        if (Test-Path -LiteralPath $configured -PathType Leaf) {
            return (Resolve-Path -LiteralPath $configured).Path
        }
        $resolved = Resolve-Application @($configured)
        if ($resolved) {
            return $resolved
        }
        throw "CODEX_EXEC_COMMAND does not resolve to an executable: $configured"
    }
    $resolved = Resolve-Application @('codex.cmd', 'codex.exe')
    if (-not $resolved) {
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
        throw 'Node.js is missing. Beaver requires Node.js 22 or newer.'
    }
    $version = Get-CommandVersion $node @('--version')
    $match = [regex]::Match([string]$version, '(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success -or [int]$match.Groups[1].Value -lt 22) {
        throw "Unsupported Node.js version '$version'. Install Node.js 22 or newer."
    }
    return $node
}

function Get-Python {
    $python = Resolve-Application @('python.exe', 'python')
    if (-not $python) {
        throw 'Python is missing. Table of Authorities requires Python 3.10 or newer.'
    }
    $version = Get-CommandVersion $python @('--version')
    $match = [regex]::Match([string]$version, '(\d+)\.(\d+)\.(\d+)')
    if (-not $match.Success -or
        [int]$match.Groups[1].Value -lt 3 -or
        ([int]$match.Groups[1].Value -eq 3 -and [int]$match.Groups[2].Value -lt 10)) {
        throw "Unsupported Python version '$version'. Install Python 3.10 or newer."
    }
    return $python
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

function Assert-Builds {
    foreach ($service in $Services) {
        if (-not (Test-Path -LiteralPath $service.Build -PathType Leaf)) {
            $command = if ($service.Name -eq 'backend') {
                'cd backend; npm run build'
            }
            else {
                'cd frontend; npm run build'
            }
            throw "Missing $($service.Name) production build: $($service.Build). Run: $command"
        }
    }
}

function Assert-PortsFree([switch]$IncludeToa) {
    $wanted = @($Services)
    if ($IncludeToa) {
        $wanted += [pscustomobject]@{ Name = 'table-of-authorities'; Port = 8765 }
    }
    foreach ($service in $wanted) {
        $owners = Get-PortOwners $service.Port
        if ($owners) {
            throw "$($service.Name) cannot start: $(Format-PortOwners $service.Port)."
        }
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
            if ($Name -eq 'backend' -and $response.ok -ne $true) {
                throw 'health response did not contain ok=true'
            }
            if ($Name -eq 'table-of-authorities' -and
                ($response.ok -ne $true -or $response.service -ne 'table-of-authorities')) {
                throw 'status response did not identify a healthy Table of Authorities service'
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
    return [pscustomobject]@{
        Process = $process
        Stdout = $stdout
        Stderr = $stderr
    }
}

function Stop-Identity([int]$Id, [string]$StartedAt, [string]$Label) {
    if (-not (Test-ProcessIdentity $Id $StartedAt)) {
        Write-Host "$Label PID $Id is no longer the process Mike started; skipped."
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
        if ([int]$record.listenerPid -ne [int]$record.rootPid) {
            Stop-Identity ([int]$record.listenerPid) ([string]$record.listenerStartedAt) "$($record.name) listener"
        }
        Stop-Identity ([int]$record.rootPid) ([string]$record.rootStartedAt) $record.name
    }
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
}

function Show-Status {
    $state = Read-State
    $owned = Get-OwnedRecords $state
    Write-Host "Launcher state: $(if ($owned) { 'running' } elseif ($state) { 'stale' } else { 'stopped' })"
    foreach ($service in @($Services) + @([pscustomobject]@{ Name = 'table-of-authorities'; Port = 8765 })) {
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
        $codex = Resolve-Codex
        Write-Host "Codex: $(Get-CommandVersion $codex @('--version')) ($codex)"
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        $failed = $true
    }
    foreach ($service in $Services) {
        if (Test-Path -LiteralPath $service.Build -PathType Leaf) {
            Write-Host "$($service.Name) build: present"
        }
        else {
            Write-Host "$($service.Name) build: MISSING ($($service.Build))"
            $failed = $true
        }
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
    if ($WithTableOfAuthorities) {
        try {
            $python = Get-Python
            Write-Host "Python: $(Get-CommandVersion $python @('--version')) ($python)"
            $runtimeReport = & $python (Join-Path $Toa 'bootstrap.py') --check 2>$null |
                Out-String | ConvertFrom-Json
            if ($runtimeReport.managed.ok) {
                Write-Host 'Table of Authorities managed runtime: ready'
            }
            elseif ($runtimeReport.current.ok) {
                Write-Host 'Table of Authorities dependencies: available; managed runtime will be created on first start'
            }
            else {
                Write-Host 'Table of Authorities dependencies: managed runtime will be installed on first start'
            }
        }
        catch {
            Write-Host "ERROR: $($_.Exception.Message)"
            $failed = $true
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Toa 'bootstrap.py') -PathType Leaf)) {
            Write-Host "Table of Authorities: MISSING bootstrap.py"
            $failed = $true
        }
        Write-Host "table-of-authorities: $(Format-PortOwners 8765)"
        $ownedPid = @($state.processes | Where-Object {
            $_.name -eq 'table-of-authorities' -and
            (Test-ProcessIdentity ([int]$_.listenerPid) ([string]$_.listenerStartedAt))
        } | Select-Object -ExpandProperty listenerPid)
        $unexpected = @(Get-PortOwners 8765 | Where-Object { $_.Id -notin $ownedPid })
        if ($unexpected) {
            Write-Host 'ERROR: Table of Authorities port has a listener not owned by this launcher.'
            $failed = $true
        }
    }
    $authMode = Get-ConfigValue 'AUTH_MODE'
    if ($authMode -ne 'anonymous' -and -not (Test-Configured @('SUPABASE_URL'))) {
        Write-Host 'ERROR: AUTH_MODE is not anonymous and Supabase is not configured.'
        $failed = $true
    }
    else {
        Write-Host "Authentication: $(if ($authMode -eq 'anonymous') { 'local anonymous' } else { 'cloud' })"
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
        $status = if (Test-Configured $providers[$provider]) { 'configured' } else { 'not configured (optional)' }
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
    $codex = Resolve-Codex
    $python = if ($WithTableOfAuthorities) { Get-Python } else { $null }
    Assert-PortsFree -IncludeToa:$WithTableOfAuthorities

    $state = [pscustomobject]@{
        version = 1
        startedAt = [DateTime]::UtcNow.ToString('o')
        codex = $codex
        processes = @()
    }
    Write-State $state
    $launched = @()
    $previousCodex = [Environment]::GetEnvironmentVariable('CODEX_EXEC_COMMAND', 'Process')
    try {
        # Pin the resolved executable for the backend child; PATH is untouched.
        [Environment]::SetEnvironmentVariable('CODEX_EXEC_COMMAND', $codex, 'Process')

        $backendStart = Start-LoggedProcess 'backend' $node @('dist/index.js') $Backend $state
        $launched += [pscustomobject]@{
            Id = $backendStart.Process.Id
            StartedAt = Get-ProcessStamp $backendStart.Process.Id
        }
        Add-ProcessRecord $state 'backend' 3001 $backendStart.Process $backendStart.Stdout $backendStart.Stderr
        Wait-Ready 'backend' $Services[0].Url $backendStart.Process $TimeoutSeconds
        Set-ListenerRecord $state 'backend' 3001 $backendStart.Process
        Write-Host "Backend ready: $($Services[0].Url)"

        $frontendStart = Start-LoggedProcess 'frontend' $node @('node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3000') $Frontend $state
        $launched += [pscustomobject]@{
            Id = $frontendStart.Process.Id
            StartedAt = Get-ProcessStamp $frontendStart.Process.Id
        }
        Add-ProcessRecord $state 'frontend' 3000 $frontendStart.Process $frontendStart.Stdout $frontendStart.Stderr
        Wait-Ready 'frontend' $Services[1].Url $frontendStart.Process $TimeoutSeconds
        Set-ListenerRecord $state 'frontend' 3000 $frontendStart.Process
        Write-Host "Frontend ready: $($Services[1].Url)"

        if ($WithTableOfAuthorities) {
            $toaStart = Start-LoggedProcess 'table-of-authorities' $python @('bootstrap.py', '--web', '--port', '8765', '--no-browser') $Toa $state
            $launched += [pscustomobject]@{
                Id = $toaStart.Process.Id
                StartedAt = Get-ProcessStamp $toaStart.Process.Id
            }
            Add-ProcessRecord $state 'table-of-authorities' 8765 $toaStart.Process $toaStart.Stdout $toaStart.Stderr
            Wait-Ready 'table-of-authorities' 'http://127.0.0.1:8765/api/status' $toaStart.Process $TimeoutSeconds
            Set-ListenerRecord $state 'table-of-authorities' 8765 $toaStart.Process
            Write-Host 'Table of Authorities ready: http://127.0.0.1:8765/'
        }
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
        [Environment]::SetEnvironmentVariable('CODEX_EXEC_COMMAND', $previousCodex, 'Process')
    }

    if (-not $NoBrowser) {
        Start-Process 'http://127.0.0.1:3000/'
    }
}

function Invoke-Smoke {
    $checks = @(
        [pscustomobject]@{ Name = 'backend'; Url = 'http://127.0.0.1:3001/health' },
        [pscustomobject]@{ Name = 'frontend'; Url = 'http://127.0.0.1:3000/' },
        [pscustomobject]@{ Name = 'Library'; Url = 'http://127.0.0.1:3001/library/files' },
        [pscustomobject]@{ Name = 'Codex model catalog'; Url = 'http://127.0.0.1:3001/codex/models' }
    )
    if ($WithTableOfAuthorities) {
        $checks += [pscustomobject]@{ Name = 'table-of-authorities'; Url = 'http://127.0.0.1:8765/api/status' }
    }
    foreach ($check in $checks) {
        try {
            $response = Invoke-WebRequest -Uri $check.Url -UseBasicParsing -TimeoutSec 20
            if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
                throw "HTTP $($response.StatusCode)"
            }
            if ($check.Name -ne 'frontend') {
                $payload = $response.Content | ConvertFrom-Json
                if ($check.Name -eq 'backend' -and $payload.ok -ne $true) {
                    throw 'health response did not contain ok=true'
                }
                if ($check.Name -eq 'Library' -and
                    ($null -eq $payload.documents -or $null -eq $payload.folders)) {
                    throw 'Library response was incomplete'
                }
                if ($check.Name -eq 'Codex model catalog' -and
                    ($payload.source -ne 'live' -or @($payload.models).Count -eq 0)) {
                    throw 'Codex did not return a live model catalog'
                }
                if ($check.Name -eq 'table-of-authorities' -and
                    ($payload.ok -ne $true -or $payload.service -ne 'table-of-authorities')) {
                    throw 'Table of Authorities status was unhealthy'
                }
            }
            Write-Host "PASS $($check.Name): $($check.Url)"
        }
        catch {
            throw "FAIL $($check.Name): $($check.Url) - $($_.Exception.Message)"
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
    }
    finally {
        $listener.Stop()
    }
    if (-not (Resolve-Codex)) {
        throw 'Codex resolution check failed.'
    }
    $build = $Services[0].Build
    try {
        $Services[0].Build = Join-Path $Repo 'definitely-missing-build'
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
        $Services[0].Build = $build
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
