# One DOC round on the desktop, as `round.ps1` starts it: the training data from the gold store (`structure-gold
# training`: each source's inputs where missing, a source parsed only where what its parse is made of changed, the
# packs and their manifest), the fit on them (which exports its best checkpoint), then the export graded on the store
# against the last round's grade (`grade --against`: every layer before and after, by split, mode and yardstick). A fit
# starts from the last fit's checkpoint where there is one (3 epochs), from nothing with -Fresh (10). Each step's time
# and last line to the log; the comparison to D:\docfit\grade.out.
param([Parameter(Mandatory)] [string]$Store, [switch]$Fresh, [string]$Init = '', [string]$Dump = 'C:\docdata\dump', [string]$Packs = 'C:\docdata\packs',
  [string]$Out = 'D:\docfit\last', [string]$Text = 'C:\docdata\text', [string]$Grades = 'D:\docfit\grades', [string[]]$Fit = @())
$ErrorActionPreference = 'Continue'
$log = 'D:\docfit\round.log'
function Stamp([string]$what) { "$(Get-Date -Format 'HH:mm:ss') $what" | Add-Content $log }
function Run([string]$exe, [string[]]$arguments, [string]$name) {
  $started = Get-Date
  $p = Start-Process $exe -ArgumentList $arguments -NoNewWindow -PassThru -RedirectStandardOutput "D:\docfit\$name.out" -RedirectStandardError "D:\docfit\$name.err"
  $null = $p.Handle; $p.WaitForExit()
  Stamp ("$name rc=$($p.ExitCode) in {0:N0}s: " -f ((Get-Date) - $started).TotalSeconds + ((Get-Content "D:\docfit\$name.err" -Tail 1 -ErrorAction SilentlyContinue) -join ''))
  $p.ExitCode
}
function Done([string]$what, [int]$code) { $what | Set-Content D:\docfit\round.done; exit $code }
Remove-Item D:\docfit\round.done -ErrorAction SilentlyContinue
$grader = 'C:\Users\elias\fable\grader.exe'
$from = if ($Init) { $Init } else { "$Out\docparser.pt" }
$init = -not $Fresh -and (Test-Path $from)
Stamp ("round on $Store from " + $(if ($init) { "$from, 3 epochs" } else { 'nothing, 10 epochs' }))
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:STRUCTURE_GOLD_THREADS = '8'; $env:MIMALLOC_PURGE_DELAY = '0'
$env:STRUCTURE_GOLD_INPUTS = 'D:\a2aj-inputs'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
if (Run $grader @('training', $Store, $Dump, $Packs, '--text', $Text, '--epochs', $(if ($init) { '3' } else { '10' })) 'training') { Done 'training data failed' 1 }
# The fit: no clock ramping between its bursts of launches (the High Performance plan, put back after); the GPU's
# clocks are never locked.
$plan = ((powercfg /getactivescheme) -replace '.*GUID:\s*([0-9a-f-]+).*', '$1').Trim()
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
$env:PYTHONUTF8 = '1'
$arguments = @('-u', "$PSScriptRoot\docparse.py", 'fit', $Packs, $Out) + $(if ($init) { @('--init', $from) } else { @() }) + $Fit
$rc = Run 'C:\Users\elias\beaver-train\venv-tw\Scripts\python.exe' $arguments 'fit'
powercfg /setactive $plan
# The packs are the dump's arrays laid out for the fit, written anew from the dump in seconds: not kept beside it.
Remove-Item -Recurse -Force $Packs -ErrorAction SilentlyContinue
Stamp ((Get-Content D:\docfit\fit.out | Select-String 'development ' | Select-Object -Last 1) -join '')
if ($rc -or -not (Test-Path "$Out\export\docparse.json")) { Done 'fit failed' 1 }
# The export graded on the store (train and development, every document the dump holds) against the last round's grade.
New-Item -ItemType Directory -Force $Grades | Out-Null
$earlier = Get-ChildItem "$Grades\grade-*.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
$grade = "$Grades\grade-$(Get-Date -Format 'yyyyMMdd-HHmm').json"
# Each stage's time over the grade (LEGALPDF_PHASE_TIMING): what of a parse is tier 0's, repeated each grade, and what DOC's.
$env:LEGALPDF_PHASE_TIMING = '1'
# Each source's parse resumed from the dump the training data was made from (tier 0 as it left it), the text model
# keyed as it was there.
$env:LEGALPDF_DOC_DUMP = $Dump
$env:LEGALPDF_DOC_TEXT = $Text
$env:LEGALPDF_DOC = "$Out\export"
$env:LEGALPDF_ONNX_RUNTIME = $env:LEGALPDF_ONNXRUNTIME
$rc = Run $grader (@('grade', $Store, '--out', $grade) + $(if ($earlier) { @('--against', $earlier.FullName) } else { @() })) 'grade'
Done $(if ($rc) { 'grade failed' } else { "done: $grade" }) $rc
