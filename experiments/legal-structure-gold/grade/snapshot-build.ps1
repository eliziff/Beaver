# Build the native addon on the desktop from every repo as it stood at a moment (the last commit of
# each before -Before), for bisecting a measured change; the built addon comes back to -Out. The
# snapshot builds in a mirror of its own beside the working-tree one, its target folder kept, so
# nearby moments build incrementally.
#
#   .\snapshot-build.ps1 -Before '2026-10-20 00:00' -Out $env:TEMP\addon-1020.dll
param(
  [Parameter(Mandatory)] [string]$Before,
  [Parameter(Mandatory)] [string]$Out,
  [string]$Desktop = 'oajd-desktop',
  [string]$Mirror = 'C:\Users\elias\build\snapshot',
  # A revision per repo ('.', 'legal-pdf-parser', ...) in place of the one -Before picks.
  [hashtable]$Revisions = @{}
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..").Path

function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

$parts = @(
  @{ Repo = '.'; Paths = @('Cargo.toml', 'Cargo.lock', '.cargo', 'native/legal-structure-node', 'experiments/legal-structure-gold/grade', 'experiments/ocr-structure-attribution', 'legal-structure/tagger') },
  @{ Repo = 'legal-pdf-parser'; Paths = @() },
  @{ Repo = 'legal-structure'; Paths = @() },
  @{ Repo = 'common-law-cite'; Paths = @() }
)
$stage = "$env:TEMP\snapshot-stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
foreach ($part in $parts) {
  $repo = "$root\$($part.Repo)"
  $revision = if ($Revisions.ContainsKey($part.Repo)) { $Revisions[$part.Repo] } else { git -C $repo rev-list -1 "--before=$Before" HEAD }
  "{0,-18} {1}" -f $part.Repo, (git -C $repo log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' $revision).Substring(0, 60)
  $target = if ($part.Repo -eq '.') { $stage } else { "$stage\$($part.Repo)" }
  New-Item -ItemType Directory -Force $target | Out-Null
  $existing = @($part.Paths | Where-Object { git -C $repo ls-tree --name-only $revision -- $_ })
  git -C $repo archive --format=tar -o "$stage\part.tar" $revision -- @($existing)
  tar -xf "$stage\part.tar" -C $target
  Remove-Item "$stage\part.tar"
}
Push-Location $stage; tar -cf "$env:TEMP\snapshot.tar" --exclude='*/experiments/*' --exclude='*/benchmarks/*' *; Pop-Location
"packed {0:N1} MB" -f ((Get-Item "$env:TEMP\snapshot.tar").Length / 1MB)
Remote "New-Item -ItemType Directory -Force '$Mirror' | Out-Null; Get-ChildItem '$Mirror' -Force | Where-Object { `$_.Name -ne 'native' } | Remove-Item -Recurse -Force; Get-ChildItem '$Mirror\native\legal-structure-node' -Force -ErrorAction SilentlyContinue | Where-Object { `$_.Name -ne 'target' } | Remove-Item -Recurse -Force" | Out-Null
scp -q "$env:TEMP\snapshot.tar" "${Desktop}:$($Mirror -replace '\\', '/').tar"
Remote @"
`$env:Path = "`$env:USERPROFILE\.cargo\bin;`$env:Path"
tar -xf '$Mirror.tar' -C '$Mirror'; Remove-Item '$Mirror.tar'
# Before the consumers shared a workspace (2026-10-24) the addon built from its own folder.
`$workspace = (Test-Path '$Mirror\Cargo.toml') -and (Select-String -Path '$Mirror\Cargo.toml' -Pattern '^\[workspace\]' -Quiet)
Set-Location `$(if (`$workspace) { '$Mirror' } else { '$Mirror\native\legal-structure-node' })
`$started = Get-Date
`$build = Start-Process cargo -ArgumentList 'build', '--release', '-p', 'legal-structure-node', '--lib' -NoNewWindow -PassThru -RedirectStandardError '$Mirror\build.err'
`$null = `$build.Handle; `$build.WaitForExit()
"snapshot build: exit `$(`$build.ExitCode), {0:N0}s" -f ((Get-Date) - `$started).TotalSeconds
if (`$build.ExitCode) { Get-Content '$Mirror\build.err' | Select-String -Pattern '^error' -Context 0, 10 | ForEach-Object { `$_.Line; `$_.Context.PostContext } | Select-Object -First 30 }
"@
scp -q "${Desktop}:$($Mirror -replace '\\', '/')/native/legal-structure-node/target/release/legal_structure_node.dll" $Out
if (Test-Path $Out) { "addon at $Out" }
