# Build the grader and the addon's binaries on the desktop, from this checkout's working trees: each
# repo the build reads (this one's native consumers, legal-pdf-parser, legal-structure,
# common-law-cite) is packed from its tracked and changed files, unpacked into a mirror on the
# desktop, and built there into a target folder that stays, so each build after the first is
# incremental. The grader lands where prove.ps1 grades with it.
#
#   .\desktop-build.ps1                          # structure-gold, note_pairs
#   .\desktop-build.ps1 -Packages @('-p','structure-gold')
#   .\desktop-build.ps1 -Check                   # cargo check only: nothing built, the grader left as it is
#   .\desktop-build.ps1 -Profile iterate         # the quick-rebuild profile: a grader for score checks, not for timing
#   .\desktop-build.ps1 -Profile profiling       # that Cargo profile (symbols, for a stack sample): the grader left as it is
#   .\desktop-build.ps1 -Committed legal-pdf-parser/legal-pdf-language   # that folder as committed: another's work in
#                                                  progress there left out of this build, its files untouched
param(
  [switch]$Check,
  [string[]]$Packages = @('-p', 'structure-gold', '--bin', 'structure-gold', '-p', 'structure-tools', '--bin', 'note_pairs'),
  [string]$Desktop = 'oajd-desktop',
  [string]$Mirror = 'C:\Users\elias\build\MikeOSS',
  [string]$Fable = 'C:\Users\elias\fable',
  [string[]]$Committed = @(),
  [string]$Profile = 'release'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..").Path

function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

# What each repo contributes: its files git tracks or would track, within the paths the build reads: this repo's
# workspace and its members (as its Cargo.toml names them), the DOC fit's folder, and the repos the members read.
$members = [regex]::Matches((Get-Content "$root\Cargo.toml" -Raw), '(?s)members\s*=\s*\[(.*?)\]')[0].Groups[1].Value |
  Select-String -Pattern '"([^"]+)"' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value }
$parts = @(
  @{ Repo = '.'; Paths = @('Cargo.toml', 'Cargo.lock', '.cargo', 'experiments/legal-structure-gold/doc') + $members },
  @{ Repo = 'legal-pdf-parser'; Paths = @('.') },
  @{ Repo = 'legal-structure'; Paths = @('.') },
  @{ Repo = 'common-law-cite'; Paths = @('.') }
)
$list = "$env:TEMP\desktop-build-files.txt"
$files = foreach ($part in $parts) {
  $prefix = if ($part.Repo -eq '.') { '' } else { "$($part.Repo)/" }
  git -C "$root\$($part.Repo)" ls-files -co --exclude-standard -- @($part.Paths) | Where-Object { $_ -notmatch '^(experiments|benchmarks|\.venv|build|dist|data)/' -or $part.Repo -eq '.' } |
    ForEach-Object { "$prefix$_" } | Where-Object { Test-Path -LiteralPath "$root\$_" -PathType Leaf }
}
# A folder named in -Committed comes from its repo's HEAD, not its working tree.
$inside = { param($file) $Committed | Where-Object { $file -like "$_/*" } }
$files = @($files | Where-Object { -not (& $inside $_) })
$staged = "$env:TEMP\desktop-build-committed"
Remove-Item -Recurse -Force $staged -ErrorAction SilentlyContinue
foreach ($folder in $Committed) {
  $repo = $parts | Where-Object { $_.Repo -ne '.' -and $folder -like "$($_.Repo)/*" } | Select-Object -First 1
  $relative = $folder.Substring($repo.Repo.Length + 1)
  New-Item -ItemType Directory -Force "$staged\$($repo.Repo)" | Out-Null
  git -C "$root\$($repo.Repo)" archive -o "$staged\committed.tar" HEAD -- $relative; tar -xf "$staged\committed.tar" -C "$staged\$($repo.Repo)"; Remove-Item "$staged\committed.tar"
  $files += git -C "$root\$($repo.Repo)" ls-files -- $relative | ForEach-Object { "$($repo.Repo)/$_" }
}
$packed = "$env:TEMP\desktop-build-packed.txt"
[IO.File]::WriteAllLines($packed, @($files | Where-Object { -not (& $inside $_) }))
[IO.File]::WriteAllLines($list, $files)
$tar = "$env:TEMP\desktop-build.tar"
Push-Location $root; tar -cf $tar -T $packed; Pop-Location
if ($Committed) { Push-Location $staged; tar -rf $tar ($Committed); Pop-Location }
"packed {0} files, {1:N1} MB" -f $files.Count, ((Get-Item $tar).Length / 1MB)
Remote "New-Item -ItemType Directory -Force '$Mirror' | Out-Null" | Out-Null
scp -q $tar "${Desktop}:$($Mirror -replace '\\', '/').tar"
scp -q $list "${Desktop}:$($Mirror -replace '\\', '/').list"
# A file the working trees no longer hold leaves the mirror too (a module turned folder would
# otherwise build twice); the build's target folders stay.
Remote @"
New-Item -ItemType Directory -Force '$Mirror' | Out-Null; tar -xf '$Mirror.tar' -C '$Mirror'; Remove-Item '$Mirror.tar'
`$keep = [System.Collections.Generic.HashSet[string]]::new([string[]](Get-Content '$Mirror.list' | ForEach-Object { `$_.Replace('/', '\').ToLowerInvariant() }))
Get-ChildItem '$Mirror' -Recurse -File | Where-Object { `$_.FullName -notmatch '\\target\\' -and `$_.Name -ne 'build.err' } | ForEach-Object {
  if (-not `$keep.Contains(`$_.FullName.Substring('$Mirror'.Length + 1).ToLowerInvariant())) { Remove-Item `$_.FullName -Force }
}
Remove-Item '$Mirror.list'
"@ | Out-Null
$arguments = ($Packages | ForEach-Object { "'$_'" }) -join ','
$built = Remote @"
`$env:Path = "`$env:USERPROFILE\.cargo\bin;`$env:Path"
`# The CPU the addon is built for (scripts/cargo.mjs): x86-64-v2.
`$env:CARGO_ENCODED_RUSTFLAGS = '-Ctarget-cpu=x86-64-v2'
Set-Location '$Mirror'
`$started = Get-Date
`# The desktop runs one job at a time: ten of its twelve cores, at normal priority.
`$build = Start-Process cargo -ArgumentList (@('$(if ($Check) { 'check' } else { 'build' })', '--profile', '$Profile', '-j', '10', '--message-format', 'short') + @($arguments)) -NoNewWindow -PassThru -RedirectStandardError '$Mirror\build.err'
`$null = `$build.Handle
`$build.WaitForExit()
"desktop build: exit `$(`$build.ExitCode), {0:N0}s" -f ((Get-Date) - `$started).TotalSeconds
if (`$build.ExitCode) { Get-Content '$Mirror\build.err' | Select-String -Pattern '^error|: error|^warning: unused|: warning: unused' -Context 0, 12 | ForEach-Object { `$_.Line; `$_.Context.PostContext } }
elseif ('$Check' -ne 'True' -and '$Profile' -ne 'profiling') {
  if (Test-Path '$Fable\grader.exe') { Move-Item -Force '$Fable\grader.exe' '$Fable\grader-prev.exe' }
  Copy-Item '$Mirror\native\legal-structure-node\target\$Profile\structure-gold.exe' '$Fable\grader.exe'
  'grader.exe in place'
}
"@
$built
# A failed build leaves the previous grader in place: stop, so nothing grades with it unawares.
if (-not ($built -match '^desktop build: exit 0,')) { throw 'desktop build failed' }
