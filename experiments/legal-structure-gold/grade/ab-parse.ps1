param([string[]]$Runs = @('0', '1'), [string]$A = 'C:\Users\elias\fable\grader-prev.exe', [string]$B = 'C:\Users\elias\fable\grader.exe', [int]$Rounds = 2)
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:STRUCTURE_GOLD_INPUTS = 'D:\a2aj-inputs'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:STRUCTURE_GOLD_THREADS = '1'
Remove-Item Env:LEGALPDF_PHASE_TIMING -ErrorAction SilentlyContinue
$grade = @('grade', 'C:\Users\elias\gold-store\gold', '--split', 'all', '--runs') + $Runs
$fresh = 'D:\docfit\parse-dump'
# Each binary parses every document (an empty dump), one thread, the two alternated: each run's summed parse time.
$sums = @{ A = @(); B = @() }
for ($r = 1; $r -le $Rounds; $r++) {
  foreach ($side in 'A', 'B') {
    if (Test-Path $fresh) { Remove-Item -Recurse -Force $fresh }
    $env:LEGALPDF_DOC_DUMP = $fresh
    $exe = if ($side -eq 'A') { $A } else { $B }
    $out = "D:\docfit\grades\ab-$side-$r.json"
    & $exe @grade --out $out 2>&1 | Out-Null
    $g = Get-Content $out -Raw | ConvertFrom-Json
    $s = ($g.per_run | Measure-Object parse_ms -Sum).Sum / 1000
    $sums[$side] += $s
    "{0} round {1}: {2:N1}s summed parse, {3:N1} ms per document" -f $side, $r, $s, (1000 * $s / $g.per_run.Count)
  }
}
"A mean {0:N1}s, B mean {1:N1}s: B is {2:N1}% faster" -f ($sums.A | Measure-Object -Average).Average, ($sums.B | Measure-Object -Average).Average, (100 * (1 - ($sums.B | Measure-Object -Average).Average / ($sums.A | Measure-Object -Average).Average))
# The two sides' scores: every total of the grade, compared whole.
$x = Get-Content "D:\docfit\grades\ab-A-1.json" -Raw | ConvertFrom-Json
$y = Get-Content "D:\docfit\grades\ab-B-1.json" -Raw | ConvertFrom-Json
$moved = @($y.totals.PSObject.Properties | Where-Object { ($x.totals.($_.Name) | ConvertTo-Json -Compress -Depth 6) -ne ($_.Value | ConvertTo-Json -Compress -Depth 6) })
"totals moved: $($moved.Count) of $(@($y.totals.PSObject.Properties).Count)"
$moved | Select-Object -First 8 | ForEach-Object { "  $($_.Name): $($x.totals.($_.Name) | ConvertTo-Json -Compress -Depth 6) -> $($_.Value | ConvertTo-Json -Compress -Depth 6)" }
