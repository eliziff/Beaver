$ErrorActionPreference = 'Stop'
# Load only the receipt functions; never start the FullSweep battery.
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'full-sweep.ps1'), [ref]$null, [ref]$null)
foreach ($definition in $ast.EndBlock.Statements | Where-Object { $_.Name -in @('Save-Receipt', 'Invoke-Step') }) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
$RunDirectory = Join-Path $env:TEMP "beaver-receipts-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $RunDirectory | Out-Null
$ReceiptFile = Join-Path $RunDirectory 'latest.json'
$ReceiptTemporary = "$ReceiptFile.new"
$script:Receipt = [ordered]@{ status = 'running'; steps = @() }
try {
    Invoke-Step 'Pass' { }
    Invoke-Step 'Continue' -KeepGoing { throw 'retryable failure' }
    $failure = $null
    try { Invoke-Step 'Stop' { throw 'terminal failure' } }
    catch { $failure = $_.Exception.Message }
    $saved = Get-Content -LiteralPath $ReceiptFile -Raw | ConvertFrom-Json
    if ($failure -ne 'terminal failure' -or $saved.status -ne 'failed' -or -not $saved.finished_at -or
        ($saved.steps.status -join ',') -ne 'passed,failed,failed' -or
        $saved.steps[1].error -ne 'retryable failure' -or $saved.steps[2].error -ne 'terminal failure' -or
        @($saved.steps | Where-Object { $_.seconds -lt 0 -or -not (Test-Path -LiteralPath $_.log) }).Count -or
        (Get-Content -LiteralPath $ReceiptFile -Raw) -ne (Get-Content -LiteralPath (Join-Path $RunDirectory 'receipt.json') -Raw)) {
        throw 'FullSweep did not persist its step outcomes or terminal failure correctly.'
    }
    Write-Host 'PASS FullSweep receipt outcomes'
}
finally {
    Get-ChildItem -LiteralPath $RunDirectory -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName }
    Remove-Item -LiteralPath $RunDirectory
}
