# Put the gold store on the desktop as the private repository holds it: the committed gold/ folder at
# its HEAD (without batches/, which is provenance), unpacked whole into the desktop's store folder,
# with the commit in COMMIT. A desktop store already at that commit is left as it is. Uncommitted
# changes to the store are refused: the desktop grades and trains on what the repository holds.
#
#   .\desktop-store.ps1        # prints the store's path on the desktop and its commit
param(
  [string]$Desktop = 'oajd-desktop',
  [string]$Store = 'C:\Users\elias\gold-store'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot\..\..\..\benchmarks\local-data").Path

function Remote([string]$Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded" 2>$null
}

if (git -C $repo status --porcelain -- gold) { throw "the gold store has uncommitted changes: commit them first" }
$commit = git -C $repo rev-parse HEAD
$there = Remote "if (Test-Path '$Store\COMMIT') { Get-Content '$Store\COMMIT' }"
if ($there -ne $commit) {
  $tar = "$env:TEMP\gold-store.tar"
  git -C $repo archive --format=tar -o $tar HEAD -- gold ':(exclude)gold/batches'
  "packed gold/ at {0}: {1:N1} MB" -f $commit.Substring(0, 9), ((Get-Item $tar).Length / 1MB)
  Remote "if (Test-Path '$Store') { Remove-Item -Recurse -Force '$Store' }; New-Item -ItemType Directory -Force '$Store' | Out-Null" | Out-Null
  scp -q $tar "${Desktop}:$($Store -replace '\\', '/')/gold.tar"
  Remote "Set-Location '$Store'; tar -xf gold.tar; Remove-Item gold.tar; Set-Content -Path COMMIT -Value '$commit' -Encoding ascii" | Out-Null
  Remove-Item $tar
}
"$Store\gold at $($commit.Substring(0, 9))"
