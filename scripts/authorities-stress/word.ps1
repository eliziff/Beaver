# Opens each Word document in invisible Word, as a reader would open it: read-only, no field
# updated, nothing saved. Reports what Word shows (pages, each table of authorities' entries as
# stored, each paragraph of a table delivered on its own, the italic and coloured text of each,
# citation fields, tab references)
# and saves each as Word lays it out to PDF, only when Word would not update fields to do so. A
# document with citation fields is then opened again as a copy, where References > Insert Table of
# Authorities builds Word's own table from them, reported the same way and saved to PDF beside it.
# One JSON line per document is appended to the results file as it is done, and Word's process id
# is written first, so the caller can stop a Word that hangs. Word is quit afterwards; only the
# instance started here.
param([Parameter(Mandatory = $true)][string]$Manifest, [Parameter(Mandatory = $true)][string]$Results,
  [Parameter(Mandatory = $true)][string]$PidFile)
$ErrorActionPreference = 'Stop'
$items = Get-Content -Raw -Encoding UTF8 $Manifest | ConvertFrom-Json
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = New-Object -ComObject Word.Application
$started = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
Set-Content -Encoding ascii -Path $PidFile -Value ($started -join ',')
# A range's text, the italic text in it and any text not in black, word by word as Word formats it:
# character by character in a word only partly italic, where a field's first visible character carries
# its hidden code with it.
function Styled($range) {
  $italic = ''; $colored = ''
  foreach ($word in $range.Words) {
    # 0 is black and -16777216 the automatic colour.
    if (@(0, -16777216) -notcontains $word.Font.Color) { $colored += $word.Text }
    if ($word.Italic -eq -1) { $italic += $word.Text }
    elseif ($word.Italic -ne 0) {
      foreach ($character in $word.Characters) {
        $shown = $range.Document.Range($character.End - 1, $character.End)
        if ($shown.Italic -eq -1) { $italic += $shown.Text }
      }
    }
  }
  [ordered]@{ text = $range.Text.Trim([char[]]"`r`a`n "); italic = $italic.Trim(); colored = $colored.Trim() }
}
# The entries of each table of authorities from the `$from`th on: one per paragraph of its result.
function TableEntries($doc, $from = 1) {
  $entries = @()
  for ($index = $from; $index -le $doc.TablesOfAuthorities.Count; $index++) {
    $toa = $doc.TablesOfAuthorities.Item($index)
    foreach ($paragraph in $toa.Range.Paragraphs) {
      $entry = Styled $paragraph.Range
      if ($entry.text) { $entries += [pscustomobject]$entry }
    }
  }
  , $entries
}
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
      $result.toaEntries = TableEntries $doc
      # A table delivered as its own document: each of its paragraphs.
      if (-not $result.taFields) { $result.entries = @(foreach ($paragraph in $doc.Paragraphs) {
        $entry = Styled $paragraph.Range; if ($entry.text) { [pscustomobject]$entry } }) }
      $text = $doc.Content.Text
      foreach ($note in $doc.Footnotes) { $text += "`n" + $note.Range.Text }
      $result.tabReferences = ([regex]::Matches($text, '\[[^\]\r\n]{0,80}Tab [0-9A-Z]+\]')).Count
      $result.errors = @([regex]::Matches(($text + $result.toaText), 'Error! [^\r\n]{0,80}') | ForEach-Object { $_.Value })
      $result.text = $text.Substring(0, [Math]::Min(4000, $text.Length))
      if ($item.pdf -and -not $updatesAtPrint) {
        Remove-Item -LiteralPath $item.pdf -ErrorAction SilentlyContinue
        $doc.SaveAs2($item.pdf, 17)
        $result.pdf = $item.pdf
      }
      if ($result.taFields -and $item.pdf) {
        $doc.Close([ref]0); $doc = $null
        $copy = [IO.Path]::ChangeExtension($item.pdf, '.marked-copy.docx')
        Copy-Item -LiteralPath $item.file -Destination $copy -Force
        $doc = $word.Documents.Open($copy, $false, $false, $false)
        $end = $doc.Content; $end.Collapse(0); $end.InsertBreak(7)
        $end = $doc.Content; $end.Collapse(0)
        # Category 0: every category, as the dialog's "All" inserts it, one table per category.
        $from = $doc.TablesOfAuthorities.Count + 1
        [void]$doc.TablesOfAuthorities.Add($end, 0)
        for ($index = $from; $index -le $doc.TablesOfAuthorities.Count; $index++) { $doc.TablesOfAuthorities.Item($index).Update() }
        $result.insertedEntries = TableEntries $doc $from
        $result.insertedPdf = [IO.Path]::ChangeExtension($item.pdf, '.inserted-table.pdf')
        $doc.SaveAs2($result.insertedPdf, 17)
        $doc.Close([ref]0); $doc = $null
        Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
      }
    } catch {
      $result.error = $_.Exception.Message
    } finally {
      if ($doc -ne $null) {
        try { $doc.Close([ref]0) } catch { $result.error = "$($result.error) Close: $($_.Exception.Message)".Trim() }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)
      }
    }
    Add-Content -Encoding utf8 -Path $Results -Value (ConvertTo-Json -InputObject ([pscustomobject]$result) -Depth 6 -Compress)
  }
} finally {
  try { $word.Quit([ref]0) } catch { }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  Start-Sleep -Milliseconds 500
  foreach ($id in $started) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
