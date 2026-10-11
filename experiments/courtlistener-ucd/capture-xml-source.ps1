param(
    [Parameter(Mandatory=$true)][string]$Manifest,
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$CorpusHome = (Join-Path $env:LOCALAPPDATA 'OpenLegalData')
)
$ErrorActionPreference = 'Stop'

# Independent source inventory: .NET XML parsing, never native engine output.
function Add-SourceElement($Element, $ParentIndex, $Elements) {
    $index = $Elements.Count
    $attributes = [ordered]@{}
    foreach ($attribute in $Element.Attributes) { $attributes[$attribute.Name] = $attribute.Value }
    $anchor = if ($Element.HasAttribute('id')) { $Element.GetAttribute('id') } else { $null }
    $Elements.Add([ordered]@{
        source_index=$index; parent_index=$ParentIndex; tag=$Element.Name
        anchor=$anchor; namespace=$Element.NamespaceURI; attributes=$attributes
        text_content=$Element.InnerText; inner_text=$null
        row_span=1; column_span=1
    })
    foreach ($child in $Element.ChildNodes) {
        if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element) {
            Add-SourceElement $child $index $Elements
        }
    }
}

$writer = [System.IO.StreamWriter]::new($Output, $false, [System.Text.UTF8Encoding]::new($false))
$writer.NewLine = "`n"
$sources = 0
$elementCount = 0
try {
    foreach ($line in [System.IO.File]::ReadLines((Resolve-Path -LiteralPath $Manifest))) {
        $capture = $line | ConvertFrom-Json
        if ($capture.format -ne 'cap-json') { continue }
        $path = Join-Path $CorpusHome $capture.corpus_path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $capture.sha256) {
            throw 'Retained source digest changed'
        }
        $source = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
        $settings = [System.Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
        $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($source.casebody.data), $settings)
        try {
            $document = [System.Xml.XmlDocument]::new()
            $document.PreserveWhitespace = $true
            $document.Load($reader)
        } finally { $reader.Dispose() }
        $elements = [System.Collections.Generic.List[object]]::new()
        Add-SourceElement $document.DocumentElement $null $elements
        $writer.WriteLine(([ordered]@{
            html_sha256=$capture.sha256; body_index=0; ancestors=@(); elements=$elements
        } | ConvertTo-Json -Depth 16 -Compress))
        $sources++
        $elementCount += $elements.Count
    }
} finally { $writer.Dispose() }
[ordered]@{
    schema='courtlistener.xml-source-gold.v1'; bodies=$sources; elements=$elementCount
    all_elements=$true; visible_text=$false
    scope='Independent XML source names, namespaces, attributes, order, parents and textContent; no browser rendering or navigation claim'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $Output) 'xml-source-gold-summary.json') -Encoding UTF8
Write-Output "Inventoried $sources original XML sources and $elementCount elements"
