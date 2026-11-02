@echo off
rem DOC's reading order and speed on one build: development read by DOC with the successor head's reading, by DOC in
rem the parser's order (LEGALPDF_TRANSITION_DOC_ORDER=off), and by the walker; the headline side by side, each
rem grade's wall time.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc9.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
cd /d %J%
set LEGALPDF_TRANSITION_DOC=%D%\export2
%GRADER% grade %S% --split development --out %G%\grade-speed-order.json > %G%\speed-order.out 2>&1
set LEGALPDF_TRANSITION_DOC_ORDER=off
%GRADER% grade %S% --split development --out %G%\grade-speed-noorder.json > %G%\speed-noorder.out 2>&1
set LEGALPDF_TRANSITION_DOC_ORDER=
set LEGALPDF_TRANSITION_DOC=
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-speed-walker.json > %G%\speed-walker.out 2>&1
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe headline.py %G%\grade-speed-walker.json %G%\grade-speed-order.json %G%\grade-speed-noorder.json > %D%\speed.txt
findstr /C:"documents," %G%\speed-walker.out %G%\speed-order.out %G%\speed-noorder.out >> %D%\speed.txt
echo done> %D%\speed.done
