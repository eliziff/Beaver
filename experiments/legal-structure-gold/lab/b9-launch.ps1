$py = 'C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe'
Set-Location 'C:\Users\elias\Desktop\oajd_compute\lsg-v4'
$env:NOTE_PAIRS = 'C:\Users\elias\fable\note_pairs.exe'
New-Item -ItemType Directory -Force 'C:\Users\elias\fable\b9\a', 'C:\Users\elias\fable\b9\logs' | Out-Null
$n = 4
$procs = foreach ($k in 0..($n - 1)) {
  Start-Process -FilePath $py -ArgumentList 'experiments\legal-structure-gold\author.py', '--manifest', 'C:\Users\elias\fable\b9\cohort-manifest.json', '--out', 'C:\Users\elias\fable\b9\a', '--limit', '0', '--shard', "$k/$n" -WindowStyle Hidden -PassThru -RedirectStandardOutput "C:\Users\elias\fable\b9\logs\shard-$k.out" -RedirectStandardError "C:\Users\elias\fable\b9\logs\shard-$k.err"
}
foreach ($p in $procs) { try { $p.PriorityClass = 'BelowNormal' } catch {} }
$procs | Wait-Process
