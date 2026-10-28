# After a grader build whose extraction crate changed: find the build's inputs key with a one-document
# inputs run on b5, then move each batch's existing inputs folder to that key (no re-extraction; the
# post-extraction work is what is measured, and the extraction change is measured on its own).
$Fable = 'C:\Users\elias\fable'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"; $env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:STRUCTURE_GOLD_THREADS = '2'
$old = @(Get-ChildItem "$Fable\b5\inputs" -Directory | Sort-Object LastWriteTime -Descending)[0].Name
"old key: $old"
$m = Get-Content "$Fable\b5\cohort-manifest.json" -Raw | ConvertFrom-Json
$one = $m.documents | Where-Object { $_.split -eq 'development' } | Sort-Object pages | Select-Object -First 1
@{ documents = @($one) } | ConvertTo-Json -Depth 4 | Set-Content "$Fable\probe\rekey-manifest.json" -Encoding ascii
$env:STRUCTURE_GOLD_INPUTS = "$Fable\b5\inputs"
& "$Fable\grader.exe" inputs "$Fable\b5\a" "$Fable\probe\rekey-manifest.json" 2>&1 | Select-Object -Last 1
$new = @(Get-ChildItem "$Fable\b5\inputs" -Directory | Where-Object { $_.Name -ne $old } | Sort-Object LastWriteTime -Descending)[0].Name
"new key: $new"
if (-not $new -or $new -eq $old) { "key unchanged; nothing to move"; exit 0 }
foreach ($b in 'b5', 'b6', 'b7', 'b8') {
  $from = "$Fable\$b\inputs\$old"; $to = "$Fable\$b\inputs\$new"
  if (-not (Test-Path $from)) { "${b}: no $old"; continue }
  New-Item -ItemType Directory -Force $to | Out-Null
  $moved = 0
  foreach ($f in Get-ChildItem $from -File) { $dest = Join-Path $to $f.Name; if (-not (Test-Path $dest)) { Move-Item $f.FullName $dest; $moved++ } }
  foreach ($d in Get-ChildItem $from -Directory) { $dest = Join-Path $to $d.Name; if (-not (Test-Path $dest)) { Move-Item $d.FullName $dest; $moved++ } }
  if (-not (Get-ChildItem $from)) { Remove-Item $from }
  "${b}: moved $moved entries $old -> $new; now $(@(Get-ChildItem $to).Count) entries"
}
