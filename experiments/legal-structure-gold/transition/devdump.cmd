@echo off
rem Development read by round 2's ranker (tier 0, greedy), its line features and templates dumped without
rem candidate rows and its labels written: what the joint stylesheet solve is measured against.
set T=C:\Users\elias\fable\transition4
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=2
set LEGALPDF_TRANSITION_GOLD=%T%\gold.jsonl
set LEGALPDF_TRANSITION_DUMP=%T%\devdump
set LEGALPDF_TRANSITION_DUMP_LINES=0
if exist %T%\devdump rmdir /s /q %T%\devdump
if exist %T%\labels-dev-r2 rmdir /s /q %T%\labels-dev-r2
C:\Users\elias\fable\grader-next4.exe grade C:\Users\elias\gold-store\gold --split development --out %G%\grade-devdump.json > %G%\devdump.out 2> %G%\devdump.err
echo devdump done> %T%\devdump.done
