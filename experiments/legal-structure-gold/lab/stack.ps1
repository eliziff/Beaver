# The stacked arm after the second chain: the tagger's out-of-fold train predictions (five folds),
# then the heading editor trained over them and applied to the tagger's development predictions,
# graded by labels beside the editor's own decoded baseline. $Rows and $Tagger name the rows and the
# development predictions the stack is built on.
param([string]$Rows = 'rows-all-ab1', [string]$Tagger = 'tagger-ab1')
$venv = 'C:\Users\elias\beaver-train\venv\Scripts\python.exe'
$Fable = 'C:\Users\elias\fable'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"; $env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:LEGALPDF_ONNX_RUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:STRUCTURE_GOLD_THREADS = '2'
Remove-Item Env:LEGALPDF_TAGGER_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:LEGALPDF_ABLATE -ErrorAction SilentlyContinue
while (-not (Select-String -Path "$Fable\ml\ablations2.log" -Pattern '^done' -Quiet)) { Start-Sleep -Seconds 120 }
Set-Location "$Fable\ml"
$folds = "$Fable\ml\crossfit-$Tagger"
New-Item -ItemType Directory -Force $folds | Out-Null
foreach ($k in 0..4) {
  if (-not (Test-Path "$folds\crossfit-$k.jsonl")) {
    & $venv train_tagger.py "$Fable\$Rows" --out $folds --hidden 256 --layers 3 --epochs 32 --fold "$k/5" > "$folds\train-$k.log" 2>&1
  }
}
$out = "$Fable\ml\editor-$Tagger"
New-Item -ItemType Directory -Force $out | Out-Null
$inputs = @('b5', 'b6', 'b7', 'b8') | ForEach-Object { "$Fable\$_\inputs" }
& $venv train_heading_edits.py "$Fable\$Rows" --inputs $inputs --out $out --base "$Fable\ml\$Tagger\predictions-development-gru.jsonl" (0..4 | ForEach-Object { "$folds\crossfit-$_.jsonl" }) > "$out\train.log" 2>&1
foreach ($arm in @(@("stack-$Tagger", 'edits-development.jsonl'), @("stackbase-$Tagger", 'parser-development.jsonl'))) {
  foreach ($b in 'b5', 'b6', 'b7', 'b8') {
    $env:STRUCTURE_GOLD_INPUTS = "$Fable\$b\inputs"
    & "$Fable\grader.exe" grade "$Fable\$b\a" "$Fable\$b\cohort-manifest.json" --split development --labels "$out\$($arm[1])" --out "$Fable\$b\a\grade-cf7-$($arm[0])-labels.json" 2>&1 | Select-Object -Last 1
  }
}
'done'
