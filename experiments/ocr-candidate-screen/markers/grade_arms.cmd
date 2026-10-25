@echo off
rem grade_arms.cmd : grades both arms' candidates per split (yardstick=main) into structure-ab\grade-ARM-SPLIT.json
set STORE=C:\Users\elias\Desktop\oajd_compute\lsg-v4\benchmarks\local-data\legal-structure-gold
set AB=C:\Users\elias\beaver-train\markers\structure-ab
for %%a in (shipped packA) do for %%s in (development train test) do (
  C:\Users\elias\fable\structure-gold-r10.exe grade %STORE% %STORE%\cohort-manifest.json --candidates %AB%\%%a-%%s.inventory.json --split %%s --group yardstick=main --out %AB%\grade-%%a-%%s.json > %AB%\grade-%%a-%%s.log 2>&1
  echo %%a %%s exit %ERRORLEVEL%
)
