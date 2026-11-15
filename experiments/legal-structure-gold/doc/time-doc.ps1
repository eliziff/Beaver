param([string[]]$Runs = @('0', '1'), [string]$Model = 'D:\docfit\w128b\export')
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:STRUCTURE_GOLD_INPUTS = 'D:\a2aj-inputs'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:LEGALPDF_ONNX_RUNTIME = $env:LEGALPDF_ONNXRUNTIME
$env:STRUCTURE_GOLD_THREADS = '1'
if (-not (Test-Path "$Model\docparse.json")) { $Model = Get-ChildItem D:\docfit -Directory | ForEach-Object { "$($_.FullName)\export" } | Where-Object { Test-Path "$_\docparse.json" } | Sort-Object { (Get-Item "$_\docparse.json").LastWriteTime } | Select-Object -Last 1 }
"model: $Model"
$env:LEGALPDF_DOC = $Model
$env:LEGALPDF_DOC_TIMES = '1'
Remove-Item Env:LEGALPDF_PHASE_TIMING -ErrorAction SilentlyContinue
# Every document parsed and read by DOC: an empty dump.
$fresh = 'D:\docfit\doc-dump'
if (Test-Path $fresh) { Remove-Item -Recurse -Force $fresh }
$env:LEGALPDF_DOC_DUMP = $fresh
$p = Start-Process -FilePath C:\Users\elias\fable\grader.exe -ArgumentList (@('grade', 'C:\Users\elias\gold-store\gold', '--split', 'all', '--runs') + $Runs + @('--out', 'D:\docfit\grades\doc-timed.json')) -RedirectStandardError D:\docfit\doc-times.txt -RedirectStandardOutput D:\docfit\doc-out.txt -NoNewWindow -Wait -PassThru
Get-Content D:\docfit\doc-times.txt | Where-Object { $_ -match 'documents, ' }
$g = Get-Content D:\docfit\grades\doc-timed.json -Raw | ConvertFrom-Json
$s = ($g.per_run | Measure-Object parse_ms -Sum).Sum
"parse with DOC: {0:N1}s summed, {1:N1} ms per document" -f ($s / 1000), ($s / $g.per_run.Count)
# Each stage summed over the documents: the group's (texts, context, detect, stylesheet, heads) and each document's.
$group = @{}; $each = @{}; $lines = 0; $pairs = 0; $big = @()
foreach ($line in [IO.File]::ReadLines('D:\docfit\doc-times.txt')) {
  if ($line -match '^group times: \d+ documents (\d+) lines; (.*)$') { $lines += [int]$Matches[1]; foreach ($m in [regex]::Matches($Matches[2], '(\w+) ([\d.]+)s')) { $group[$m.Groups[1].Value] += [double]$m.Groups[2].Value } }
  elseif ($line -match '^doc times: (\d+) lines (\d+) regions (\d+) pairs; (.*)$') { $pairs += [int]$Matches[3]; $t = 0; foreach ($m in [regex]::Matches($Matches[4], '(\w+) ([\d.]+)s')) { $each[$m.Groups[1].Value] += [double]$m.Groups[2].Value; $t += [double]$m.Groups[2].Value }; $big += ,@([int]$Matches[1], $t) }
}
"lines {0:N0}, pairs {1:N0}" -f $lines, $pairs
"group stages: " + (($group.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { '{0} {1:N1}s' -f $_.Key, $_.Value }) -join ', ')
"document stages: " + (($each.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { '{0} {1:N1}s' -f $_.Key, $_.Value }) -join ', ')
"largest documents' document stages (lines, seconds): " + (($big | Sort-Object { $_[1] } -Descending | Select-Object -First 6 | ForEach-Object { '{0}:{1:N2}' -f $_[0], $_[1] }) -join ' ')
