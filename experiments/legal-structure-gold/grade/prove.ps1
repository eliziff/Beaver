# The parser against the structure gold, start to finish: build the grader on the desktop (desktop-build.ps1), put the committed gold store there
# (desktop-store.ps1), wait until the desktop runs nothing else, grade the whole store for each arm
# (with -Parts, again by part), and print every layer that moved against a tagged earlier grade.
#
#   .\prove.ps1 -Tag pdfi -Before contents4
#   .\prove.ps1 -Tag pdfi -Before contents4 -Arms @{ default = @{}; own_columns = @{ LEGALPDF_OWN_COLUMNS = '1' } }
#   .\prove.ps1 -Tag pdfi -Before contents4 -NoBuild        # grade the grader already shipped
#
# The grader reads each PDF as a parse of this build reads it (extraction, recognition through the
# product's recognition cache, layout), into inputs keyed by the build's identity, and aligns the
# gold to whatever lines that reading has; so every arm measures the whole pipeline, extraction
# included. The inputs print how many pages the recognition cache held and how many it read.
#
# An arm is a set of environment variables the parser reads (LEGALPDF_*); its grades are
# gold-grades\grade-<Tag>-<arm>.json in the desktop's data home. The previous grader is kept as
# grader-prev.exe, and no other copy.
param(
  [Parameter(Mandatory)] [string]$Tag,
  [string]$Before,
  [hashtable]$Arms = @{ default = @{} },
  [switch]$NoBuild,
  # Grade while the desktop runs other jobs (an authoring run that lasts days).
  [switch]$Force,
  # The store again by part (each document of a packet parsed alone): the measure of document starts.
  [switch]$Parts,
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

# Built on the desktop from this checkout's working trees (`desktop-build.ps1`), the grader put in place there.
if (-not $NoBuild) {
  & "$PSScriptRoot\desktop-build.ps1" -Packages @('-p', 'structure-gold', '--bin', 'structure-gold') -Desktop $Desktop -Fable $Fable
}
$store = (& "$PSScriptRoot\desktop-store.ps1" -Desktop $Desktop | Select-Object -Last 1) -replace ' at \w+$', ''
"store: $store"

# One desktop job at a time: wait while any other build, grader or Python job runs there.
$busy = "@(Get-Process cargo, python, structure-gold*, grader* -ErrorAction SilentlyContinue).Count"
while (-not $Force -and [int](Remote $busy | Select-Object -Last 1) -gt 0) {
  "desktop busy: " + ((Remote "Get-CimInstance Win32_Process | Where-Object { `$_.Name -match '^(cargo|python|structure-gold|grader)' } | ForEach-Object { `$_.CommandLine.Substring(0, [Math]::Min(100, `$_.CommandLine.Length)) }") -join ' | ')
  Start-Sleep 300
}

# Grade each arm: inputs, then the grade (and by part).
$grade = @'
param($Fable, $Store, $Tag, $Arm, $Variables, $Parts, $Before)
# The one inputs folder the desktop's grades and training read.
$env:STRUCTURE_GOLD_INPUTS = 'D:\a2aj-inputs'
$runtime = 'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime'
$env:LEGALPDF_INDRA_MODEL_PACK = "$runtime\indra"
$env:LEGALPDF_ONNXRUNTIME = "$runtime\onnx\onnxruntime.dll"
$env:LEGALPDF_RECOGNITION_TRACE = '1'
foreach ($name in $Variables.Keys) { Set-Item "env:$name" $Variables[$name] }
# The layout model's OpenVINO runtime loads its libraries from beside it.
if ($env:LEGALPDF_OPENVINO_RUNTIME) { $env:Path = "$(Split-Path $env:LEGALPDF_OPENVINO_RUNTIME);$env:Path" }
$grades = "$env:LOCALAPPDATA\OpenLegalData\gold-grades"
New-Item -ItemType Directory -Force $grades | Out-Null
$runs = @(@{ Name = "grade-$Tag-$Arm" }) + @(if ($Parts -eq 'True') { @{ Name = "grade-parts-$Tag-$Arm"; Parts = $true } })
$p = Start-Process "$Fable\grader.exe" -ArgumentList 'inputs', $Store -WorkingDirectory $grades -NoNewWindow -PassThru -RedirectStandardOutput "$grades\inputs.txt" -RedirectStandardError "$grades\inputs.err"
$p.WaitForExit()
$read = Get-Content "$grades\inputs.err" | Where-Object { $_ -match '^recognition' } | ForEach-Object { $f = $_ -split "`t"; [pscustomobject]@{ Held = [int]($f[1] -split ' ')[0]; Read = [int]($f[2] -split ' ')[0] } }
"inputs ($Arm): " + (Get-Content "$grades\inputs.err" -Tail 1) + "; recognition cache held $(($read | Measure-Object Held -Sum).Sum) pages, read $(($read | Measure-Object Read -Sum).Sum)"
foreach ($run in $runs) {
  $earlier = if ($Before) { "$grades\grade-$(if ($run.Parts) { 'parts-' })$Before.json" }
  $grading = @('grade', $Store) + @(if ($run.Parts) { '--parts' }) + @('--out', "$grades\$($run.Name).json") + @(if ($earlier -and (Test-Path $earlier)) { '--against', $earlier })
  $p = Start-Process "$Fable\grader.exe" -ArgumentList $grading -WorkingDirectory $grades -NoNewWindow -PassThru -RedirectStandardOutput "$grades\grade.txt" -RedirectStandardError "$grades\grade.err"
  $p.WaitForExit()
  "$($run.Name): " + (Get-Content "$grades\grade.err" -Tail 1)
  Get-Content "$grades\grade.txt"
}
'@
foreach ($arm in $Arms.Keys) {
  $variables = ($Arms[$arm].GetEnumerator() | ForEach-Object { "'$($_.Key)' = '$($_.Value)'" }) -join '; '
  Remote "& { $grade } -Fable '$Fable' -Store '$store' -Tag '$Tag' -Arm '$arm' -Variables @{ $variables } -Parts '$Parts' -Before '$Before'"
}
