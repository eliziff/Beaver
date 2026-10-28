# The second chain, on the cf7 grader (64-feature rows: col_width, col_centre): first the baseline
# arm `colcentre` (no ablation: the column features' own measure against cf5-tagger), then four reader
# ablations under the tagger (LEGALPDF_ABLATE), each from rows exported, the tagger retrained on them,
# the development split graded through the product hook. Waits for the shipped marker and for the GPU
# (the first chain, wide, doctype and curve arms write 'done' to their logs).
$py12 = 'C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe'
$venv = 'C:\Users\elias\beaver-train\venv\Scripts\python.exe'
$Fable = 'C:\Users\elias\fable'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"; $env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:LEGALPDF_ONNX_RUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:STRUCTURE_GOLD_THREADS = '2'
while (-not (Test-Path "$Fable\grader-cf7.exe")) { Start-Sleep -Seconds 60 }
foreach ($log in 'ablations.log', 'wide.log', 'doctype.log', 'curve.log') {
  while (-not (Select-String -Path "$Fable\ml\$log" -Pattern '^done' -Quiet)) { Start-Sleep -Seconds 120 }
}
# The cf7 grader stands in once every earlier arm has let go of grader.exe.
Move-Item -Force "$Fable\grader.exe" "$Fable\grader-prev.exe"
Copy-Item "$Fable\grader-cf7.exe" "$Fable\grader.exe"
foreach ($arm in 'colcentre', 'furniture', 'captions', 'native', 'sequence') {
  if ($arm -eq 'colcentre') { Remove-Item Env:LEGALPDF_ABLATE -ErrorAction SilentlyContinue } else { $env:LEGALPDF_ABLATE = $arm }
  Remove-Item Env:LEGALPDF_TAGGER_MODEL -ErrorAction SilentlyContinue
  foreach ($b in 'b5', 'b6', 'b7', 'b8') {
    $env:STRUCTURE_GOLD_INPUTS = "$Fable\$b\inputs"
    New-Item -ItemType Directory -Force "$Fable\rows-$arm\$b" | Out-Null
    & "$Fable\grader.exe" rows "$Fable\$b\a" "$Fable\$b\cohort-manifest.json" "$Fable\rows-$arm\$b" 2>&1 | Select-Object -Last 1
    & "$Fable\grader.exe" grade "$Fable\$b\a" "$Fable\$b\cohort-manifest.json" --split development --out "$Fable\$b\a\grade-cf7-$arm-default.json" 2>&1 | Select-Object -Last 1
  }
  & $py12 -I "$Fable\ml\merge_rows.py" "$Fable\rows-$arm" "$Fable\rows-all-$arm" b5 b6 b7 b8
  Copy-Item "$Fable\rows-$arm\b5\features.json" "$Fable\rows-all-$arm\features.json" -Force
  New-Item -ItemType Directory -Force "$Fable\ml\tagger-$arm" | Out-Null
  Set-Location "$Fable\ml"
  & $venv train_tagger.py "$Fable\rows-all-$arm" --out "$Fable\ml\tagger-$arm" --hidden 256 --layers 3 --epochs 32 > "$Fable\ml\tagger-$arm\train.log" 2>&1
  & $venv export_tagger.py "$Fable\rows-all-$arm" "$Fable\ml\tagger-$arm\tagger-gru.pt" "$Fable\ml\tagger-$arm\export" > "$Fable\ml\tagger-$arm\export.log" 2>&1
  $env:LEGALPDF_TAGGER_MODEL = "$Fable\ml\tagger-$arm\export"
  foreach ($b in 'b5', 'b6', 'b7', 'b8') {
    $env:STRUCTURE_GOLD_INPUTS = "$Fable\$b\inputs"
    & "$Fable\grader.exe" grade "$Fable\$b\a" "$Fable\$b\cohort-manifest.json" --split development --out "$Fable\$b\a\grade-cf7-$arm-tagger.json" 2>&1 | Select-Object -Last 1
  }
  "arm $arm done"
}
'done'
