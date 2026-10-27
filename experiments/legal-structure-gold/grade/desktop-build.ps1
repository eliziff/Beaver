# Build the grader and the addon's binaries on the desktop, from this checkout's working trees: each
# repo the build reads (this one's native consumers, legal-pdf-parser, legal-structure,
# common-law-cite) is packed from its tracked and changed files, unpacked into a mirror on the
# desktop, and built there into a target folder that stays, so each build after the first is
# incremental. The grader lands where prove.ps1 grades with it.
#
#   .\desktop-build.ps1                          # structure-gold, olj_pairing
#   .\desktop-build.ps1 -Packages @('-p','structure-gold')
param(
  [string[]]$Packages = @('-p', 'structure-gold', '--bin', 'structure-gold', '-p', 'legal-structure-node', '--bin', 'olj_pairing'),
  [string]$Desktop = 'oajd-desktop',
  [string]$Mirror = 'C:\Users\elias\build\MikeOSS',
  [string]$Fable = 'C:\Users\elias\fable'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..").Path

function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

# What each repo contributes: its files git tracks or would track, within the paths the build reads.
$parts = @(
  @{ Repo = '.'; Paths = @('Cargo.toml', 'Cargo.lock', '.cargo', 'native/legal-structure-node', 'experiments/legal-structure-gold/grade', 'experiments/ocr-structure-attribution') },
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
[IO.File]::WriteAllLines($list, $files)
$tar = "$env:TEMP\desktop-build.tar"
Push-Location $root; tar -cf $tar -T $list; Pop-Location
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
Remote @"
`$env:Path = "`$env:USERPROFILE\.cargo\bin;`$env:Path"
Set-Location '$Mirror'
`$started = Get-Date
`# Light on the desktop: four jobs, below normal priority.
`$build = Start-Process cargo -ArgumentList (@('build', '--release', '-j', '4') + @($arguments)) -NoNewWindow -PassThru -RedirectStandardError '$Mirror\build.err'
`$null = `$build.Handle; try { `$build.PriorityClass = 'BelowNormal' } catch {}
`$build.WaitForExit()
"desktop build: exit `$(`$build.ExitCode), {0:N0}s" -f ((Get-Date) - `$started).TotalSeconds
if (`$build.ExitCode) { Get-Content '$Mirror\build.err' | Select-String -Pattern '^error' -Context 0, 12 | ForEach-Object { `$_.Line; `$_.Context.PostContext } }
else {
  if (Test-Path '$Fable\grader.exe') { Move-Item -Force '$Fable\grader.exe' '$Fable\grader-prev.exe' }
  Copy-Item '$Mirror\native\legal-structure-node\target\release\structure-gold.exe' '$Fable\grader.exe'
  'grader.exe in place'
}
"@
