# The parser against the structure gold, start to finish: build the grader (release, root
# workspace, below normal priority), ship it to the desktop that holds the gold, wait until the
# desktop runs nothing else, grade batches 5-7 for each arm (with -Parts, each again by part), and print
# every layer that moved against a tagged earlier grade.
#
#   .\prove.ps1 -Tag pdfi -Before contents4
#   .\prove.ps1 -Tag pdfi -Before contents4 -Arms @{ default = @{}; own_columns = @{ LEGALPDF_OWN_COLUMNS = '1' } }
#   .\prove.ps1 -Tag pdfi -Before contents4 -NoBuild        # grade the grader already shipped
#
# The grader reads each PDF as a parse of this build reads it (extraction, recognition through the
# product's recognition cache, layout), into inputs keyed by the build's identity, and aligns the
# gold to whatever lines that reading has; so every arm measures the whole pipeline, extraction
# included. Each batch prints how many pages the recognition cache held and how many it read.
#
# An arm is a set of environment variables the parser reads (LEGALPDF_*); its grades are
# grade-<Tag>-<arm>.json beside each batch's gold on the desktop. The previous grader is kept as
# grader-prev.exe, and no other copy.
param(
  [Parameter(Mandatory)] [string]$Tag,
  [string]$Before,
  [hashtable]$Arms = @{ default = @{} },
  [switch]$NoBuild,
  # Every batch again by part (each document of a packet parsed alone): the measure of document starts.
  [switch]$Parts,
  # The gold batches graded (b8: the 1,466 sources authored 2026-10-27).
  [string[]]$Batches = @('b5', 'b6', 'b7'),
  [string]$Desktop = 'oajd-desktop',
  [string]$Fable = 'C:\Users\elias\fable'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\..\.."
$built = "$root\native\legal-structure-node\target\release\structure-gold.exe"

# Run a PowerShell script on the desktop, its output streamed back.
function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

if (-not $NoBuild) {
  $log = "$env:TEMP\prove-build.err"
  $started = Get-Date
  $build = Start-Process cargo -ArgumentList 'build', '--release', '-p', 'structure-gold' -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardError $log
  $null = $build.Handle  # held, so the exit code can be read after the process ends
  Start-Sleep 2; try { $build.PriorityClass = 'BelowNormal' } catch {}
  $build.WaitForExit()
  $lines = Get-Content $log
  $ours = @($lines | Select-String -Pattern '^\s*Compiling \S+ v\S+ \(').Count
  $third = @($lines | Select-String -Pattern '^\s*Compiling \S+ v\S+$').Count
  "build: exit $($build.ExitCode), {0:N0}s, compiled {1} of ours and {2} third-party" -f ((Get-Date) - $started).TotalSeconds, $ours, $third
  if ($build.ExitCode) {
    $lines | Select-String -Pattern '^error' -Context 0, 14 | ForEach-Object { $_.Line; $_.Context.PostContext }
    exit 1
  }
  Remote "if (Test-Path '$Fable\grader.exe') { Move-Item -Force '$Fable\grader.exe' '$Fable\grader-prev.exe' }" | Out-Null
  scp -q $built "${Desktop}:$($Fable -replace '\\', '/')/grader.exe"
  'shipped grader.exe'
}

# One desktop job at a time: wait while any other build, grader or Python job runs there.
$busy = "@(Get-Process cargo, python, structure-gold*, grader* -ErrorAction SilentlyContinue).Count"
while ([int](Remote $busy | Select-Object -Last 1) -gt 0) {
  "desktop busy: " + ((Remote "Get-CimInstance Win32_Process | Where-Object { `$_.Name -match '^(cargo|python|structure-gold|grader)' } | ForEach-Object { `$_.CommandLine.Substring(0, [Math]::Min(100, `$_.CommandLine.Length)) }") -join ' | ')
  Start-Sleep 300
}

# Grade each arm: inputs, then the grade, per batch.
$grade = @'
param($Fable, $Tag, $Arm, $Variables, $Parts, $Batches)
$store = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\benchmarks\local-data\legal-structure-gold'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:STRUCTURE_GOLD_THREADS = '2'
$env:LEGALPDF_RECOGNITION_TRACE = '1'
foreach ($name in $Variables.Keys) { Set-Item "env:$name" $Variables[$name] }
# The layout model's OpenVINO runtime loads its libraries from beside it.
if ($env:LEGALPDF_OPENVINO_RUNTIME) { $env:Path = "$(Split-Path $env:LEGALPDF_OPENVINO_RUNTIME);$env:Path" }
$runs = @($Batches -split ',' | ForEach-Object { @{ Batch = $_ } }) + @(if ($Parts -eq 'True') { $Batches -split ',' | ForEach-Object { @{ Batch = $_; Parts = $true } } })
foreach ($run in $runs) {
  $batch = $run.Batch
  $gold = "$Fable\$batch\a"
  $env:STRUCTURE_GOLD_INPUTS = "$Fable\$batch\inputs"
  if (-not (Test-Path "$gold\parsed")) { cmd /c mklink /J "$gold\parsed" "$store\parsed" | Out-Null }
  $manifest = "$Fable\$batch\cohort-manifest.json"
  $out = if ($run.Parts) { "$gold\grade-parts-$Tag-$Arm.json" } else { "$gold\grade-$Tag-$Arm.json" }
  $grading = @('grade', $gold, $manifest)
  if ($run.Parts) { $grading += '--parts' }
  $grading += @('--out', $out)
  foreach ($arguments in @(, @('inputs', $gold, $manifest)) + @(, $grading)) {
    $p = Start-Process "$Fable\grader.exe" -ArgumentList $arguments -WorkingDirectory $gold -NoNewWindow -PassThru -RedirectStandardOutput "$gold\$($arguments[0]).txt" -RedirectStandardError "$gold\$($arguments[0]).err"
    $p.WaitForExit()
  }
  if (-not $run.Parts) {
    $read = Get-Content "$gold\inputs.err" | Where-Object { $_ -match '^recognition' } | ForEach-Object { $f = $_ -split "`t"; [pscustomobject]@{ Held = [int]($f[1] -split ' ')[0]; Read = [int]($f[2] -split ' ')[0] } }
    "$batch inputs ($Arm): " + (Get-Content "$gold\inputs.err" -Tail 1) + "; recognition cache held $(($read | Measure-Object Held -Sum).Sum) pages, read $(($read | Measure-Object Read -Sum).Sum)"
  }
  "$batch$(if ($run.Parts) { ' by part' }) ($Arm): " + (Get-Content "$gold\grade.err" -Tail 1)
}
'@
foreach ($arm in $Arms.Keys) {
  $variables = ($Arms[$arm].GetEnumerator() | ForEach-Object { "'$($_.Key)' = '$($_.Value)'" }) -join '; '
  Remote "& { $grade } -Fable '$Fable' -Tag '$Tag' -Arm '$arm' -Variables @{ $variables } -Parts '$Parts' -Batches '$($Batches -join ',')'"
}

# Every pooled layer (train split) that moved against the earlier grade.
if ($Before) {
  $compare = @'
param($Fable, $Before, $After, $Batches)
function Pooled($Path) {
  $grade = Get-Content $Path -Raw | ConvertFrom-Json
  $totals = @{}
  foreach ($row in $grade.per_run | Where-Object split -eq 'train') {
    foreach ($metric in $row.metrics.PSObject.Properties) {
      if (-not $totals[$metric.Name]) { $totals[$metric.Name] = @(0, 0, 0) }
      $t = $totals[$metric.Name]; $m = $metric.Value
      $t[0] += $m.expected; $t[1] += $m.predicted; $t[2] += $m.correct
    }
  }
  $f1 = @{}
  foreach ($name in $totals.Keys) {
    $e, $p, $c = $totals[$name]
    $precision = if ($p) { $c / $p } else { 1 }; $recall = if ($e) { $c / $e } else { 1 }
    $f1[$name] = if ($precision + $recall) { 2 * $precision * $recall / ($precision + $recall) } else { 0 }
  }
  $f1
}
foreach ($batch in $Batches -split ',') {
  $earlier = "$Fable\$batch\a\grade-$Before.json"
  if (-not (Test-Path $earlier)) { "$batch has no grade-$Before.json"; continue }
  $a = Pooled $earlier; $b = Pooled "$Fable\$batch\a\grade-$After.json"
  "== $batch $Before -> $After"
  foreach ($name in $b.Keys | Sort-Object) {
    if ($a.ContainsKey($name) -and [Math]::Abs($b[$name] - $a[$name]) -ge 0.002) { "  {0,-22} {1:N3} -> {2:N3}  {3:+0.000;-0.000}" -f $name, $a[$name], $b[$name], ($b[$name] - $a[$name]) }
    elseif (-not $a.ContainsKey($name)) { "  {0,-22} (new) {1:N3}" -f $name, $b[$name] }
  }
}
'@
  foreach ($arm in $Arms.Keys) {
    Remote "& { $compare } -Fable '$Fable' -Before '$Before' -After '$Tag-$arm' -Batches '$($Batches -join ',')'"
  }
}
