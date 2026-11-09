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
  [hashtable]$Revisions = @{},
  # What to build and bring back: the addon by default, or a binary of -Package.
  [string]$Binary,
  [string]$Package = 'legal-structure-node',
  # A binary's features, in place of the package's defaults ('opinion' for courtlistener-structure).
  [string]$Features,
  # A folder of files laid over the moment's (a later measuring tool patched into an earlier grader).
  [string]$Overlay,
  # Only check these packages (cargo check, every target), printing the errors: no build, nothing brought back.
  [string[]]$Check
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..").Path

function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

$parts = @(
  @{ Repo = '.'; Paths = @('Cargo.toml', 'Cargo.lock', '.cargo', 'native/legal-structure-node', 'native/a2aj-gold', 'experiments/legal-structure-gold/grade') },
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
  $subject = git -C $repo log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' $revision
  "{0,-18} {1}" -f $part.Repo, $subject.Substring(0, [Math]::Min(60, $subject.Length))
  $target = if ($part.Repo -eq '.') { $stage } else { "$stage\$($part.Repo)" }
  New-Item -ItemType Directory -Force $target | Out-Null
  $existing = @($part.Paths | Where-Object { git -C $repo ls-tree --name-only $revision -- $_ })
  git -C $repo archive --format=tar -o "$stage\part.tar" $revision -- @($existing)
  tar -xf "$stage\part.tar" -C $target
  Remove-Item "$stage\part.tar"
}
# A workspace member the moment did not track (an experiment still untracked then) leaves the list.
if (Test-Path "$stage\Cargo.toml") {
  $manifest = [IO.File]::ReadAllLines("$stage\Cargo.toml") | Where-Object { $_ -notmatch '^\s*"([^"]+)",\s*$' -or (Test-Path "$stage\$($Matches[1])") }
  [IO.File]::WriteAllLines("$stage\Cargo.toml", [string[]]$manifest, (New-Object Text.UTF8Encoding $false))
}
if ($Overlay) { Copy-Item -Recurse -Force "$Overlay\*" $stage }
Push-Location $stage; tar -cf "$env:TEMP\snapshot.tar" --exclude='*/experiments/*' --exclude='*/benchmarks/*' *; Pop-Location
"packed {0:N1} MB" -f ((Get-Item "$env:TEMP\snapshot.tar").Length / 1MB)
scp -q "$env:TEMP\snapshot.tar" "${Desktop}:$($Mirror -replace '\\', '/').tar"
# The remote half as a script of its own: an encoded command line has a length limit the sync passes.
$remote = @"
`$env:Path = "`$env:USERPROFILE\.cargo\bin;`$env:Path"
# The moment's files laid over the mirror where their content differs, stamped now; the rest keep their time, so a
# build rebuilds only the crates a change reaches. A file git stamps with its commit's time would be older than what
# the kept target built from another moment, which cargo would then take as fresh: a changed file is stamped now.
# Files the moment does not have leave the mirror; its build output (target) stays.
`$incoming = '$Mirror-incoming'
if (Test-Path `$incoming) { Remove-Item -Recurse -Force `$incoming }
New-Item -ItemType Directory -Force `$incoming, '$Mirror' | Out-Null
tar -xf '$Mirror.tar' -C `$incoming; Remove-Item '$Mirror.tar'
`$synced = Get-Date
`$changed = 0
`$now = Get-Date
foreach (`$file in [IO.Directory]::EnumerateFiles(`$incoming, '*', 'AllDirectories')) {
  `$relative = `$file.Substring(`$incoming.Length + 1)
  `$target = Join-Path '$Mirror' `$relative
  `$same = [IO.File]::Exists(`$target) -and ((New-Object IO.FileInfo `$target).Length -eq (New-Object IO.FileInfo `$file).Length) -and
    ((Get-FileHash -LiteralPath `$target).Hash -eq (Get-FileHash -LiteralPath `$file).Hash)
  if (-not `$same) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName(`$target)) | Out-Null
    [IO.File]::Copy(`$file, `$target, `$true)
    [IO.File]::SetLastWriteTime(`$target, `$now)
    `$changed++
  }
}
foreach (`$file in [IO.Directory]::EnumerateFiles('$Mirror', '*', 'AllDirectories')) {
  `$relative = `$file.Substring('$Mirror'.Length + 1)
  if (`$relative -notmatch '(^|\\)target\\' -and `$relative -ne 'build.err' -and -not [IO.File]::Exists((Join-Path `$incoming `$relative))) {
    [IO.File]::Delete(`$file)
    `$changed++
  }
}
Remove-Item -Recurse -Force `$incoming
"synced: {0} files changed, {1:N0}s" -f `$changed, ((Get-Date) - `$synced).TotalSeconds
# Before the consumers shared a workspace (2026-10-24) the addon built from its own folder.
`$workspace = (Test-Path '$Mirror\Cargo.toml') -and (Select-String -Path '$Mirror\Cargo.toml' -Pattern '^\[workspace\]' -Quiet)
Set-Location `$(if (`$workspace) { '$Mirror' } else { '$Mirror\native\legal-structure-node' })
`$started = Get-Date
# The addon is the node crate's library built as a cdylib (the crate itself is an rlib since 2026-11-05).
`$build = Start-Process cargo -ArgumentList $(if ($Check) { "'check', '--message-format', 'short', '--all-targets', " + (($Check | ForEach-Object { "'-p', '$_'" }) -join ', ') } elseif ($Binary) { "'build', '--release', '-j', '4', '-p', '$Package', '--bin', '$Binary'$(if ($Features) { ", '--no-default-features', '--features', '$Features'" })" } else { "'rustc', '--release', '-j', '4', '-p', '$Package', '--lib', '--crate-type', 'cdylib'" }) -NoNewWindow -PassThru -RedirectStandardError '$Mirror\build.err'
`$null = `$build.Handle; `$build.WaitForExit()
"snapshot build: exit `$(`$build.ExitCode), {0:N0}s" -f ((Get-Date) - `$started).TotalSeconds
# A failed build leaves no earlier build's artifact to be copied back as this one's.
if (`$build.ExitCode) { Remove-Item -ErrorAction SilentlyContinue '$Mirror\native\legal-structure-node\target\release\$(if ($Binary) { "$Binary.exe" } else { 'legal_structure_node.dll' })'; Get-Content '$Mirror\build.err' | Select-String -Pattern '^error' -Context 0, 10 | ForEach-Object { `$_.Line; `$_.Context.PostContext } | Select-Object -First 30 }
"@
[IO.File]::WriteAllText("$env:TEMP\snapshot-remote.ps1", $remote, (New-Object Text.UTF8Encoding $true))
scp -q "$env:TEMP\snapshot-remote.ps1" "${Desktop}:$($Mirror -replace '\\', '/')-remote.ps1"
ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Mirror-remote.ps1" 2>$null
$artifact = if ($Binary) { "$Binary.exe" } else { 'legal_structure_node.dll' }
if ($Check) { return }
scp -q "${Desktop}:$($Mirror -replace '\\', '/')/native/legal-structure-node/target/release/$artifact" $Out
if (Test-Path $Out) { "addon at $Out" }
