# The parser's own constituent starts for every structure-gold source, read through the grader's
# document layer: `grader.exe explain ... --layers document` lists the gold starts the parse missed
# and the starts it made that the gold lacks. Runs the already-shipped grader; builds nothing.
# One thread, below-normal priority. Output: <Out>\<batch>\<sha>.txt, one per source.
param(
  [string]$Fable = 'C:\Users\elias\fable',
  [string]$Out = 'C:\Users\elias\docsplit2\parser-starts'
)
[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:STRUCTURE_GOLD_THREADS = '1'
foreach ($batch in 'b5', 'b6', 'b7') {
  $gold = "$Fable\$batch\a"
  $env:STRUCTURE_GOLD_INPUTS = "$Fable\$batch\inputs"
  New-Item -ItemType Directory -Force "$Out\$batch" | Out-Null
  Set-Location $gold
  foreach ($job in Get-ChildItem "$gold\v4" -Directory) {
    if (-not (Test-Path "$($job.FullName)\gold.json.gz")) { continue }
    $sha = $job.Name
    $file = "$Out\$batch\$sha.txt"
    if (Test-Path $file) { continue }
    $p = Start-Process "$Fable\grader.exe" -ArgumentList @('explain', $gold, "$Fable\$batch\cohort-manifest.json", $sha, '--layers', 'document', '--limit', '100000') -WorkingDirectory $gold -NoNewWindow -PassThru -RedirectStandardOutput "$file.tmp" -RedirectStandardError "$file.err"
    try { $p.PriorityClass = 'BelowNormal' } catch {}
    $p.WaitForExit()
    Move-Item -Force "$file.tmp" $file
  }
}
'done' | Set-Content "$Out\done.txt"
