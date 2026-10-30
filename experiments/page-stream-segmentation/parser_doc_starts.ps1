# The parser's own constituent starts for every source in the gold store, read through the grader's
# document layer: `grader explain STORE SHA --layers document` lists the gold starts the parse missed
# and the starts it made that the gold lacks. Runs the already-shipped grader; builds nothing.
# One thread, below-normal priority. The grader reads its structure-stage inputs from
# STRUCTURE_GOLD_INPUTS (else gold-inputs in the data home). Output: <Out>\<sha>.txt, one per source.
param(
  [string]$Grader = 'C:\Users\elias\fable\grader.exe',
  [string]$Store = (Join-Path $PSScriptRoot '..\..\benchmarks\local-data\gold'),
  [string]$Out = 'C:\Users\elias\docsplit2\parser-starts'
)
[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:STRUCTURE_GOLD_THREADS = '1'
$Store = (Resolve-Path $Store).Path
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($source in Get-ChildItem $Store -Directory | Where-Object { $_.Name -match '^[0-9a-f]{64}$' }) {
  # A source with a current gold (run a).
  if (-not (Get-ChildItem "$($source.FullName)\structure" -Directory -Filter '*-a' -ErrorAction SilentlyContinue | Where-Object { Test-Path "$($_.FullName)\gold.json.gz" })) { continue }
  $sha = $source.Name
  $file = "$Out\$sha.txt"
  if (Test-Path $file) { continue }
  $p = Start-Process $Grader -ArgumentList @('explain', $Store, $sha, '--layers', 'document', '--limit', '100000') -WorkingDirectory $Store -NoNewWindow -PassThru -RedirectStandardOutput "$file.tmp" -RedirectStandardError "$file.err"
  try { $p.PriorityClass = 'BelowNormal' } catch {}
  $p.WaitForExit()
  Move-Item -Force "$file.tmp" $file
}
'done' | Set-Content "$Out\done.txt"
