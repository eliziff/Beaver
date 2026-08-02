param(
    [string]$Progress,
    [switch]$FromStart,
    [int]$PollMilliseconds = 500
)

function Resolve-ThinkingPath([string]$ProgressPath) {
    if ($ProgressPath -match '\.progress\.jsonl$') {
        return ($ProgressPath -replace '\.progress\.jsonl$', '.thinking.jsonl')
    }
    return ([IO.Path]::ChangeExtension($ProgressPath, '.thinking.jsonl'))
}

if ($Progress -and -not (Test-Path -LiteralPath $Progress)) {
    throw 'Progress file not found. Pass -Progress <run.progress.jsonl>.'
}

$fixedProgress = [bool]$Progress
$currentProgress = $null
$thinkingPath = $null
$offset = 0L

Write-Host 'QWEN THINKING WATCHER' -ForegroundColor White
Write-Host ("Following: {0}" -f $(if ($fixedProgress) { Split-Path -Leaf $Progress } else { 'newest progress file' })) -ForegroundColor DarkGray
Write-Host 'This shows traces emitted by the local Qwen/Ollama response.' -ForegroundColor DarkGray
Write-Host ('-' * 72) -ForegroundColor DarkGray

while ($true) {
    $candidate = if ($fixedProgress) { (Resolve-Path -LiteralPath $Progress).Path } else {
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'runs') -Filter '*.progress.jsonl' |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if ($candidate -and $candidate -ne $currentProgress) {
        $currentProgress = $candidate
        $thinkingPath = Resolve-ThinkingPath $currentProgress
        # Replay existing traces so a late attachment is useful too.
        $offset = 0L
        Write-Host ("`nFOLLOWING  {0}" -f (Split-Path -Leaf $thinkingPath)) -ForegroundColor White
    }
    if ($thinkingPath -and (Test-Path -LiteralPath $thinkingPath)) {
        $stream = [IO.File]::Open($thinkingPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($stream.Length -lt $offset) { $offset = 0L }
            if ($stream.Length -gt $offset) {
                $stream.Seek($offset, [IO.SeekOrigin]::Begin) | Out-Null
                $reader = [IO.StreamReader]::new($stream)
                while ($null -ne ($line = $reader.ReadLine())) {
                    try { $event = $line | ConvertFrom-Json } catch { continue }
                    $where = if ($event.phase) { [string]$event.phase } else { 'run' }
                    $round = if ($null -ne $event.tool_round) { [string]$event.tool_round } elseif ($null -ne $event.round) { [string]$event.round } else { '-' }
                    $source = if ($event.source) { " | $($event.source)" } else { '' }
                    Write-Host ("`n[{0}] THINK  {1}  round {2}{3}" -f $where, (Get-Date ([datetime]$event.utc) -Format 'HH:mm:ss'), $round, $source) -ForegroundColor Magenta
                    Write-Host ([string]$event.text) -ForegroundColor Gray
                }
                $offset = $stream.Position
                $reader.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
    }
    Start-Sleep -Milliseconds ([Math]::Max(100, $PollMilliseconds))
}
