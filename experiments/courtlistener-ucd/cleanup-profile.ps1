param([Parameter(Mandatory=$true)][string]$Profile)
$ErrorActionPreference = 'Stop'
$taskWorkspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskScratchRoot = (Join-Path $taskWorkspace '.tmp') + [System.IO.Path]::DirectorySeparatorChar
$taskProfilePath = [System.IO.Path]::GetFullPath($Profile)
if (-not $taskProfilePath.StartsWith($taskScratchRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [System.IO.Path]::GetFileName($taskProfilePath).StartsWith('courtlistener-ucd-')) { throw 'Not an owned corpus profile' }
$taskChromeProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'chrome.exe' -and $_.CommandLine -and $_.CommandLine.Contains($taskProfilePath)
}
foreach ($taskChromeProcess in $taskChromeProcesses) {
    $taskProcess = Get-Process -Id $taskChromeProcess.ProcessId -ErrorAction SilentlyContinue
    if ($taskProcess) { $taskProcess.Kill(); $taskProcess.WaitForExit(5000) | Out-Null }
}
Start-Sleep -Milliseconds 1000
if (Test-Path -LiteralPath $taskProfilePath) { Remove-Item -LiteralPath $taskProfilePath -Recurse -Force }
