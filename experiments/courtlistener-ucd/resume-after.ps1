param(
    [Parameter(Mandatory=$true)][int]$CollectorId,
    [Parameter(Mandatory=$true)][long]$CollectorStartTicks,
    [switch]$PublisherPilot
)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $taskWorkspace
$taskCollector = Get-Process -Id $CollectorId -ErrorAction SilentlyContinue
if ($taskCollector -and $taskCollector.StartTime.ToUniversalTime().Ticks -eq $CollectorStartTicks) {
    Wait-Process -Id $CollectorId -ErrorAction SilentlyContinue
}
$taskRequest = Get-Content -LiteralPath 'benchmarks/local-data/courtlistener-ucd/acquisition-request.json' -Raw | ConvertFrom-Json
$taskTarget = [int]$taskRequest.target
if ($taskTarget -lt 1000 -or $taskTarget -gt [int]$taskRequest.candidate_count) { throw 'Invalid saved acquisition target' }
$taskSummary = Get-Content -LiteralPath 'benchmarks/local-data/courtlistener-ucd/summary.json' -Raw | ConvertFrom-Json
if ([int]$taskSummary.valid_distinct_clusters -ge $taskTarget) { exit 0 }
if ($PublisherPilot) {
    cmd /d /c "python -u -X utf8 experiments\courtlistener-ucd\verify-cached-anchors.py benchmarks\local-data\courtlistener-renditions\web-source-context --live --limit-targets 42 --workers 1 2>&1" |
        Tee-Object -FilePath 'benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live.log'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $taskPilot = Get-Content -LiteralPath 'benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live/publisher-anchor-summary.json' -Raw | ConvertFrom-Json
    if ([int]$taskPilot.targets -ne 42 -or [int]$taskPilot.pages -ne 40 -or
        [int]$taskPilot.workers -ne 1 -or [int]$taskPilot.fresh_distinct_captures -lt 1 -or
        [long]$taskPilot.shared_budget_bytes -ne [long]$taskRequest.storage_cap_bytes) {
        throw 'Publisher corpus did not finish its prepared serial scope and guarded capture'
    }
    $taskPilotSources = @{
        inputs = 'benchmarks/local-data/courtlistener-renditions/web-source-context/publisher-live-inputs.jsonl'
        runner = 'experiments/courtlistener-ucd/verify-cached-anchors.py'
        collector = 'experiments/courtlistener-ucd/collect.py'
        copied_browser = 'experiments/courtlistener-ucd/courtlistener_browser.py'
        budget = 'experiments/courtlistener-renditions/budget.py'
    }
    foreach ($taskSource in $taskPilotSources.GetEnumerator()) {
        $taskDigest = (Get-FileHash -LiteralPath $taskSource.Value -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($taskPilot.source_hashes.($taskSource.Key) -ne $taskDigest) { throw "Publisher corpus source changed: $($taskSource.Key)" }
    }
}
cmd /d /c "python -u -X utf8 experiments\courtlistener-ucd\collect.py --candidates benchmarks\local-data\courtlistener-renditions\browser-candidates.json --count $taskTarget 2>&1" |
    Tee-Object -FilePath 'benchmarks/local-data/courtlistener-ucd/collection.log' -Append
exit $LASTEXITCODE
