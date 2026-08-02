param(
    [string]$Progress,
    [switch]$FromStart,
    [switch]$Thinking
)

$fixedProgress = [bool]$Progress
if ($Progress -and -not (Test-Path -LiteralPath $Progress)) {
    throw "Progress file not found: $Progress"
}
$runDirectory = Join-Path $PSScriptRoot 'runs'

Write-Host "QWEN RUN WATCHER" -ForegroundColor White
Write-Host ("Following: {0}" -f $(if ($fixedProgress) { Split-Path -Leaf $Progress } else { 'runs as they arrive' })) -ForegroundColor DarkGray
Write-Host ("Thinking:  {0}" -f $(if ($Thinking) { 'shown' } else { 'hidden' })) -ForegroundColor DarkGray
Write-Host ("Started:   {0}" -f (Get-Date)) -ForegroundColor DarkGray
Write-Host (('-' * 72)) -ForegroundColor DarkGray

$script:lastModel = $null
$script:repeatCount = 0

function Show-FinalAnswer([string]$ProgressPath) {
    $receiptPath = $ProgressPath -replace '\.progress\.jsonl$', '.json'
    for ($attempt = 0; $attempt -lt 40 -and -not (Test-Path -LiteralPath $receiptPath); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $receiptPath)) {
        Write-Host "FINAL OUTPUT  receipt not found: $receiptPath" -ForegroundColor Red
        return
    }
    try { $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json }
    catch {
        Write-Host "FINAL OUTPUT  receipt was not valid JSON" -ForegroundColor Red
        return
    }
    if ($receipt.final_answer) {
        if ($receipt.overflow) {
            Write-Host ("`nPARTIAL FINAL SYNTHESIS | harness gate: " + $receipt.overflow.message) -ForegroundColor Yellow
        } else {
            Write-Host "`n================ FINAL ANSWER ================`n" -ForegroundColor White
        }
        Write-Host ([string]$receipt.final_answer) -ForegroundColor White
    } elseif ($receipt.overflow) {
        Write-Host ("NO FINAL SYNTHESIS | harness run failed: " + $receipt.overflow.message) -ForegroundColor Red
    } else {
        Write-Host "No final answer was recorded." -ForegroundColor Yellow
    }
    Write-Host "`n================================================`n" -ForegroundColor White
}

function Show-Event([string]$Line, [string]$ProgressPath) {
    try { $e = $Line | ConvertFrom-Json } catch { return }
    $round = $e.tool_round
    if ($null -eq $round) { $round = $e.round }
    $tools = [string]($e.tool_calls -join ',')
    switch ($e.kind) {
        'run_started' {
            Write-Host ("START  | {0} | model {1} | context {2} | effort {3}" -f $e.arm, $e.model, $e.num_ctx, $e.effort) -ForegroundColor White
        }
        'discovery_call' {
            $activity = if ([string]::IsNullOrWhiteSpace($tools)) { 'thinking' } else { $tools }
            Write-Host ("FIND   | round {0} | {1}" -f $e.round, $activity) -ForegroundColor Blue
        }
        'discovery_tool_result' {
            $value = [string]$e.result_preview
            try { $j = $value | ConvertFrom-Json } catch { $j = $null }
            if ($e.tool -eq 'search_a2aj_cases' -and $j) {
                Write-Host ("SEARCH | {0} | {1} hits" -f [string]$e.arguments.q, @($j.hits).Count) -ForegroundColor DarkCyan
            } elseif ($e.tool -eq 'select_a2aj_documents' -and $j -and $j.ok -eq $true) {
                Write-Host ("SELECT | {0} cases selected" -f @($j.selected_document_ids).Count) -ForegroundColor Green
            } elseif ($e.tool -eq 'select_a2aj_documents') {
                Write-Host ("SELECT | rejected | {0}" -f ($(if ($j -and $j.error) { $j.error } else { 'invalid selection' }))) -ForegroundColor Yellow
            }
        }
        'host_read' {
            Write-Host ("SOURCE | packet loaded | case {0}" -f $e.document) -ForegroundColor DarkCyan
        }
        'model_call' {
            if ($script:lastModel -eq [string]$e.assistant_text_preview -and $script:lastModel) {
                $script:repeatCount++
                Write-Host ("MODEL  repeated x{0} | phase={1} round={2}" -f ($script:repeatCount + 1), $e.phase, $round) -ForegroundColor DarkCyan
                return
            }
            $script:lastModel = [string]$e.assistant_text_preview
            $script:repeatCount = 0
            $activity = if ([string]::IsNullOrWhiteSpace($tools)) { 'thinking' } else { $tools }
            Write-Host ("`n[{0}] MODEL  {1}  round {2}  -> {3}" -f $e.phase, (Get-Date ([datetime]$e.utc) -Format 'HH:mm:ss'), $round, $activity) -ForegroundColor Cyan
            $value = [string]$e.assistant_text_preview
            if ($value.Length -gt 600) { $value = $value.Substring(0, 600) + " ..." }
            if ($value) { Write-Host ($value -replace "`r?`n", ' ') -ForegroundColor DarkGray }
        }
        'tool_result' {
            $value = [string]$e.result_preview
            try { $j = $value | ConvertFrom-Json } catch { $j = $null }
            if ($j -and $e.tool -eq 'p') {
                Write-Host ("PATCH  | field {0} saved | {1} chars" -f $j.field, $j.saved) -ForegroundColor DarkCyan
            } elseif ($j -and $e.tool -eq 'card_done') {
                if ($j.ok -eq $true) {
                    Write-Host ("CARD   accepted | case {0}" -f $j.document_id) -ForegroundColor Green
                } else {
                    $detail = switch ([string]$j.error) {
                        'card_too_short' { "too short ($($j.length)/$($j.minimum_chars) chars)"; break }
                        'card_fields_missing' { "missing $(@($j.missing_fields) -join ', ')"; break }
                        'evidence_spans_invalid' { 'invalid evidence span' ; break }
                        default { if ($j.error) { [string]$j.error } else { 'repair required' } }
                    }
                    Write-Host ("CARD   rejected | {0}" -f $detail) -ForegroundColor Yellow
                }
            } elseif ($j -and $e.tool -eq 'read_document') {
                Write-Host 'SOURCE | host returned active packet' -ForegroundColor DarkCyan
            } elseif ($j -and $e.tool -eq 'rehydrate_evidence') {
                Write-Host ("EVIDENCE | rehydrated | " + $j.locator) -ForegroundColor DarkCyan
            } elseif ($j -and $e.tool -eq 'submit_quote_spans') {
                if ($j.ok -eq $true -and $j.terminal -eq $true) {
                    Write-Host ("QUOTES | accepted | {0} verified" -f @($j.verified_claims).Count) -ForegroundColor Green
                } elseif ($j.ok -eq $true) {
                    Write-Host ("QUOTES | partial | {0} verified" -f @($j.verified_claims).Count) -ForegroundColor DarkCyan
                } else {
                    Write-Host 'QUOTES | rejected | repair required' -ForegroundColor Yellow
                }
            } elseif ($j -and $j.error) {
                Write-Host ("TOOL   | {0} | error: {1}" -f $e.tool, $j.error) -ForegroundColor Red
            } else {
                Write-Host ("TOOL   | {0} | completed" -f $e.tool) -ForegroundColor DarkGray
            }
        }
        'state_compaction' {
            Write-Host ("COMPACT | phase {0} | transcript replaced by compact state" -f $e.phase) -ForegroundColor Magenta
        }
        'stop_rejected' { Write-Host ("RETRY  | {0}" -f $e.reason) -ForegroundColor DarkYellow }
        'post_gate_answer' { Write-Host 'ANSWER | post-verification synthesis generated' -ForegroundColor Green }
        'run_finished' {
            $script:runFinished = $true
            if ($e.overflow -and $e.overflow.message) {
                Write-Host ("`nRUN FAILED | {0}" -f $e.overflow.message) -ForegroundColor Red
            } else {
                Write-Host "`nRUN FINISHED | success" -ForegroundColor Green
            }
            Show-FinalAnswer $ProgressPath
        }
        default { }
    }
}

function Show-ThinkingEvent([string]$Line) {
    try { $e = $Line | ConvertFrom-Json } catch { return }
    if ($e.kind -ne 'thinking') { return }
    $where = if ($e.phase) { [string]$e.phase } else { 'run' }
    $round = if ($null -ne $e.tool_round) { [string]$e.tool_round } elseif ($null -ne $e.round) { [string]$e.round } else { '-' }
    $source = if ($e.source) { " | $($e.source)" } else { '' }
    $stamp = if ($e.utc) { Get-Date ([datetime]$e.utc) -Format 'HH:mm:ss' } else { '--:--:--' }
    Write-Host ("`n[{0}] THINK  {1}  round {2}{3}" -f $where, $stamp, $round, $source) -ForegroundColor Magenta
    if ($e.text) { Write-Host ([string]$e.text) -ForegroundColor Gray }
}

function Get-ProgressPaths {
    if ($fixedProgress) {
        if (Test-Path -LiteralPath $Progress) { return @((Resolve-Path -LiteralPath $Progress).Path) }
        return @()
    }
    if (-not (Test-Path -LiteralPath $runDirectory)) { return @() }
    return @(Get-ChildItem -LiteralPath $runDirectory -Filter '*.progress.jsonl' |
        Sort-Object -Property CreationTimeUtc, LastWriteTimeUtc, Name |
        Select-Object -ExpandProperty FullName)
}

function Get-CompanionPath([string]$ProgressPath, [string]$Suffix) {
    return ($ProgressPath -replace '\.progress\.jsonl$', $Suffix)
}

function Test-RunProcessAlive([string]$ProgressPath) {
    $lockPath = Get-CompanionPath $ProgressPath '.lock'
    if (-not (Test-Path -LiteralPath $lockPath)) { return $false }
    try {
        $pidText = (Get-Content -LiteralPath $lockPath -Raw).Trim()
        $process = Get-Process -Id ([int]$pidText) -ErrorAction Stop
        return $process.ProcessName -match '^python(\.exe)?$'
    } catch {
        return $false
    }
}

function Test-CurrentRunAbandoned {
    if (-not $script:current -or $script:runFinished) { return $false }
    if (Test-RunProcessAlive $script:current) { return $false }
    $item = Get-Item -LiteralPath $script:current -ErrorAction SilentlyContinue
    if (-not $item) { return $false }
    # Give a just-started process a moment to create its lock and append its
    # first event. A missing/dead lock after that means the run was stopped or
    # crashed without emitting run_finished.
    return $item.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddSeconds(-2)
}

$seen = @{}
$pending = [System.Collections.Queue]::new()
$script:initialized = $false
$script:fixedQueued = $false
$script:current = $null
$script:offset = 0L
$script:thinkingPath = $null
$script:thinkingOffset = 0L
$script:runFinished = $false
$script:waiting = $false

function Discover-Progress {
    $paths = @(Get-ProgressPaths)
    if ($fixedProgress) {
        if ($paths.Count -gt 0 -and -not $script:fixedQueued) {
            $pending.Enqueue($paths[0])
            $script:fixedQueued = $true
        }
        return
    }
    if (-not $script:initialized) {
        $script:initialized = $true
        if ($paths.Count -gt 0) {
            # Attach to the newest existing run; older receipts are history.
            foreach ($path in $paths) { $seen[$path] = $true }
            $pending.Enqueue($paths[-1])
        }
        return
    }
    foreach ($path in $paths) {
        if (-not $seen.ContainsKey($path)) {
            $seen[$path] = $true
            $pending.Enqueue($path)
            Write-Host ("QUEUED  {0}" -f (Split-Path -Leaf $path)) -ForegroundColor DarkYellow
        }
    }
}

function Start-NextProgress {
    if ($pending.Count -eq 0) { return $false }
    $script:current = [string]$pending.Dequeue()
    $script:offset = 0L
    $script:thinkingPath = $script:current -replace '\.progress\.jsonl$', '.thinking.jsonl'
    $script:thinkingOffset = 0L
    $script:runFinished = $false
    $script:waiting = $false
    $script:lastModel = $null
    $script:repeatCount = 0
    Write-Host ("`nFOLLOWING  {0}" -f (Split-Path -Leaf $script:current)) -ForegroundColor White
    return $true
}

while ($true) {
    Discover-Progress
    if (-not $script:current) { Start-NextProgress | Out-Null }
    if ($script:current -and (Test-Path -LiteralPath $script:current)) {
        $stream = [IO.File]::Open($script:current, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -lt $script:offset) { $script:offset = 0L }
            if ($stream.Length -gt $script:offset) {
                $stream.Seek($script:offset, [IO.SeekOrigin]::Begin) | Out-Null
                $reader = [IO.StreamReader]::new($stream)
                while ($null -ne ($line = $reader.ReadLine())) { Show-Event $line $script:current }
                $script:offset = $stream.Position
                $reader.Dispose()
            }
        } finally { $stream.Dispose() }
    }
    if ($Thinking -and $script:thinkingPath -and (Test-Path -LiteralPath $script:thinkingPath)) {
        $stream = [IO.File]::Open($script:thinkingPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -lt $script:thinkingOffset) { $script:thinkingOffset = 0L }
            if ($stream.Length -gt $script:thinkingOffset) {
                $stream.Seek($script:thinkingOffset, [IO.SeekOrigin]::Begin) | Out-Null
                $reader = [IO.StreamReader]::new($stream)
                while ($null -ne ($line = $reader.ReadLine())) { Show-ThinkingEvent $line }
                $script:thinkingOffset = $stream.Position
                $reader.Dispose()
            }
        } finally { $stream.Dispose() }
    }
    if (Test-CurrentRunAbandoned) {
        Write-Host ("`nRUN ABORTED | no live harness process for {0}" -f (Split-Path -Leaf $script:current)) -ForegroundColor Yellow
        $script:runFinished = $true
    }
    if ($script:runFinished -and $pending.Count -gt 0) { Start-NextProgress | Out-Null }
    if (-not $script:current -and -not $script:waiting) {
        Write-Host "WAITING  next Qwen run..." -ForegroundColor DarkGray
        $script:waiting = $true
    }
    Start-Sleep -Milliseconds 700
}
