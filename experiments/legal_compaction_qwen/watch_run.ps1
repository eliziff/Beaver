param(
    [string]$Progress,
    [switch]$FromStart
)

$fixedProgress = [bool]$Progress
if (-not $Progress) {
    $Progress = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'runs') -Filter '*.progress.jsonl' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if ($Progress -and -not (Test-Path -LiteralPath $Progress)) {
    throw "Progress file not found: $Progress"
}

Write-Host "QWEN RUN WATCHER" -ForegroundColor White
Write-Host ("Following: {0}" -f $(if ($Progress) { Split-Path -Leaf $Progress } else { 'newest progress file' })) -ForegroundColor DarkGray
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

$current = ''
$offset = 0L
while ($true) {
    $candidate = if ($fixedProgress) { (Resolve-Path -LiteralPath $Progress).Path } else {
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'runs') -Filter '*.progress.jsonl' |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if ($candidate -and $candidate -ne $current) {
        $current = $candidate
        $offset = if ($FromStart) { 0L } else { (Get-Item -LiteralPath $current).Length }
        Write-Host ("`nFOLLOWING  {0}" -f (Split-Path -Leaf $current)) -ForegroundColor White
    }
    if ($current -and (Test-Path -LiteralPath $current)) {
        $stream = [IO.File]::Open($current, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -lt $offset) { $offset = 0L }
            if ($stream.Length -gt $offset) {
                $stream.Seek($offset, [IO.SeekOrigin]::Begin) | Out-Null
                $reader = [IO.StreamReader]::new($stream)
                while ($null -ne ($line = $reader.ReadLine())) { Show-Event $line $current }
                $offset = $stream.Position
                $reader.Dispose()
            }
        } finally { $stream.Dispose() }
    }
    Start-Sleep -Milliseconds 700
}
