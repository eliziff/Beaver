# One arm after the ablation chain: the ab1 tagger recipe with --text wide (a 5-wide conv beside the
# 3-wide, and each piece's words hashed), seed 7, graded on the development split by labels, per batch.
$venv = 'C:\Users\elias\beaver-train\venv\Scripts\python.exe'
$Fable = 'C:\Users\elias\fable'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"; $env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:LEGALPDF_ONNX_RUNTIME = "$runtime\onnx\onnxruntime.dll"; $env:STRUCTURE_GOLD_THREADS = '2'
Remove-Item Env:LEGALPDF_TAGGER_MODEL -ErrorAction SilentlyContinue
Remove-Item Env:LEGALPDF_ABLATE -ErrorAction SilentlyContinue
while (-not (Select-String -Path "$Fable\ml\ablations.log" -Pattern '^done' -Quiet)) { Start-Sleep -Seconds 120 }
New-Item -ItemType Directory -Force "$Fable\ml\tagger-wide" | Out-Null
Set-Location "$Fable\ml"
& $venv train_tagger.py "$Fable\rows-all-ab1" --out "$Fable\ml\tagger-wide" --hidden 256 --layers 3 --epochs 32 --text wide > "$Fable\ml\tagger-wide\train.log" 2>&1
foreach ($b in 'b5', 'b6', 'b7', 'b8') {
  $env:STRUCTURE_GOLD_INPUTS = "$Fable\$b\inputs"
  & "$Fable\grader.exe" grade "$Fable\$b\a" "$Fable\$b\cohort-manifest.json" --split development --labels "$Fable\ml\tagger-wide\predictions-development-gru.jsonl" --out "$Fable\$b\a\grade-cf6-wide-labels.json" 2>&1 | Select-Object -Last 1
}
'done'
