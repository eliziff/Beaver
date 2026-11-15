# One DOC round, from the laptop, on the desktop's gold store: this checkout built there (`grade\desktop-build.ps1`:
# every tracked and changed file of the repos the build reads, into the desktop's mirror, built there), then the round
# itself started on the desktop from that mirror (`desktop-round.ps1`: the training data, the fit, the export's grade
# against the last), apart from this session: its progress in D:\docfit\round.log, its end in D:\docfit\round.done, the
# grade's comparison in D:\docfit\grade.out. The store is the desktop's own copy: the committed store as shipped
# (`grade\desktop-store.ps1`) and every gold written there since.
#
#   .\round.ps1                                            # from the last fit's checkpoint
#   .\round.ps1 -Fresh                                     # from nothing
#   .\round.ps1 -Init D:\docfit\last-allgold\docparser.pt  # from a named checkpoint
param([switch]$Fresh, [string]$Init = '', [string]$Store = 'C:\Users\elias\gold-store\gold', [string]$Desktop = 'oajd-desktop',
  [string]$Mirror = 'C:\Users\elias\build\MikeOSS')
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\..\grade\desktop-build.ps1" -Packages @('-p', 'structure-gold', '--bin', 'structure-gold') -Desktop $Desktop -Mirror $Mirror
$script = "$Mirror\experiments\legal-structure-gold\doc\desktop-round.ps1"
$line = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Store `"$Store`"" + $(if ($Fresh) { ' -Fresh' } else { '' }) + $(if ($Init) { " -Init `"$Init`"" } else { '' })
$start = "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '$line' } | Select-Object -ExpandProperty ProcessId"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($start))
$id = ssh -o BatchMode=yes $Desktop "powershell -NoProfile -NonInteractive -EncodedCommand $encoded"
"round started on $Desktop (process $id): D:\docfit\round.log"
