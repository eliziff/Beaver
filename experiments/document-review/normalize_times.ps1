param([Parameter(Mandatory=$true)][string]$Root)
$stamp = [DateTime]::Parse('2026-10-20T12:00:00Z').ToUniversalTime()
Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
    $_.CreationTimeUtc = $stamp
    $_.LastWriteTimeUtc = $stamp
    $_.LastAccessTimeUtc = $stamp
}
