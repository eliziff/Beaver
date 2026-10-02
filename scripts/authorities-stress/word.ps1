# Opens each Word document in invisible Word, as a reader would open it: read-only, no field
# updated, nothing saved. Reports what Word shows (pages, the table of authorities' text as stored,
# citation fields, tab references) and exports each as Word lays it out to PDF, only when Word
# would not update fields to export. One JSON line per document is appended to the results file
# as it is done, and Word's process id is written first, so the caller can stop a Word that hangs.
# Word is quit afterwards; only the instance started here.
param([Parameter(Mandatory = $true)][string]$Manifest, [Parameter(Mandatory = $true)][string]$Results,
  [Parameter(Mandatory = $true)][string]$PidFile)
$ErrorActionPreference = 'Stop'
$items = Get-Content -Raw -Encoding UTF8 $Manifest | ConvertFrom-Json
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$started = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
Set-Content -Encoding ascii -Path $PidFile -Value ($started -join ',')
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $updatesAtPrint = [bool]$word.Options.UpdateFieldsAtPrint
  foreach ($item in $items) {
    $result = [ordered]@{ file = $item.file; opened = $false; error = $null; updatesFieldsAtPrint = $updatesAtPrint }
    $doc = $null
    try {
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles; Word does not repair a file unless asked.
      $doc = $word.Documents.Open($item.file, $false, $true, $false)
      $result.opened = $true
      $result.pages = $doc.ComputeStatistics(2)
      $codes = @(); $toa = @()
      foreach ($story in $doc.StoryRanges) {
        for ($range = $story; $range -ne $null; $range = $range.NextStoryRange) {
          foreach ($field in $range.Fields) {
            $code = $field.Code.Text.Trim()
            $codes += $code
            if ($code -match '^TOA\b') { $toa += $field.Result.Text }
          }
        }
      }
      $result.taFields = @($codes | Where-Object { $_ -match '^TA\b' }).Count
      $result.toaFields = @($codes | Where-Object { $_ -match '^TOA\b' }).Count
      $result.toaText = ($toa -join "`n")
      $text = $doc.Content.Text
      foreach ($note in $doc.Footnotes) { $text += "`n" + $note.Range.Text }
      $result.tabReferences = ([regex]::Matches($text, '\[[^\]\r\n]{0,80}Tab [0-9A-Z]+\]')).Count
      $result.errors = @([regex]::Matches(($text + $result.toaText), 'Error! [^\r\n]{0,80}') | ForEach-Object { $_.Value })
      $result.text = $text.Substring(0, [Math]::Min(4000, $text.Length))
      if ($item.pdf -and -not $updatesAtPrint) {
        $doc.ExportAsFixedFormat($item.pdf, 17)
        $result.pdf = $item.pdf
      }
    } catch {
      $result.error = $_.Exception.Message
    } finally {
      if ($doc -ne $null) {
        try { $doc.Close([ref]0) } catch { $result.error = "$($result.error) Close: $($_.Exception.Message)".Trim() }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)
      }
    }
    Add-Content -Encoding utf8 -Path $Results -Value (ConvertTo-Json -InputObject ([pscustomobject]$result) -Depth 4 -Compress)
  }
} finally {
  try { $word.Quit([ref]0) } catch { }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  Start-Sleep -Milliseconds 500
  foreach ($id in $started) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
