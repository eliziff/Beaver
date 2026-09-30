param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Name,
    [Parameter(Mandatory)][string[]]$NodeArgs,
    [string]$WorkingDirectory = (Get-Location).Path,
    [string]$Executable = 'node'
)
$ErrorActionPreference = 'Stop'
[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
[Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity = [IntPtr]1
$env:RAYON_NUM_THREADS = '1'
$env:OMP_NUM_THREADS = '1'
$env:OPENBLAS_NUM_THREADS = '1'
$env:MKL_NUM_THREADS = '1'
$env:LEGALPDF_KRAKEN_THREADS = '1'
$env:LEGALPDF_KRAKEN_WORKERS = '1'
$env:LEGALPDF_KRAKEN_LAYOUT_WORKERS = '1'
$env:LEGALPDF_PPDOC_THREADS = '1'
$output = Join-Path $PSScriptRoot '../../tmp/pdf-pagination/limited'
New-Item -ItemType Directory -Force $output | Out-Null
$job = Start-Process -FilePath (Get-Command $Executable).Source -ArgumentList $NodeArgs -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $output "$Name.stdout.log") -RedirectStandardError (Join-Path $output "$Name.stderr.log")
$null = $job.Handle
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($job.Id)
$peak = 0L
$started = Get-Date
try {
    do {
        $snapshot = Get-CimInstance Win32_Process
        do {
            $added = $false
            foreach ($item in $snapshot) {
                if ($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $added = $true }
            }
        } while ($added)
        $active = @(foreach ($ownedId in $owned) { Get-Process -Id $ownedId -ErrorAction SilentlyContinue })
        $memory = ($active | Measure-Object WorkingSet64 -Sum).Sum
        $peak = [Math]::Max($peak, $memory)
        if ($memory -gt 1GB) { throw 'Process-tree memory limit reached; stopping this job.' }
        Start-Sleep -Milliseconds 1000
        $job.Refresh()
    } while (!$job.HasExited)
    $job.WaitForExit()
    $code = $job.ExitCode
} finally {
    foreach ($ownedId in $owned) { try { Stop-Process -Id $ownedId -ErrorAction Stop } catch { } }
    [pscustomobject]@{ peakWorkingSetMB = [Math]::Round($peak / 1MB); elapsedSeconds = [Math]::Round(((Get-Date)-$started).TotalSeconds,1) } |
        ConvertTo-Json | Set-Content (Join-Path $output "$Name.resources.json")
}
Get-Content (Join-Path $output "$Name.stdout.log") -Tail 12
Get-Content (Join-Path $output "$Name.stderr.log") -Tail 8
Get-Content (Join-Path $output "$Name.resources.json")
if ($code -ne 0) { throw "Job exited with code $code" }
