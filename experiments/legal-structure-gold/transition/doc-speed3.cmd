@echo off
rem DOC's reading order and speed on one build: development read by DOC with the successor head's reading, by DOC in
rem the parser's order (LEGALPDF_TRANSITION_DOC_ORDER=off), and by the walker; the headline side by side, each
rem grade's wall time.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc11.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
cd /d %J%
set CUDA_VISIBLE_DEVICES=-1
if not exist %D%\export3\order.onnx C:\Users\elias\beaver-train\venv\Scripts\python.exe -W ignore docparse.py export %D%\model3\docparser.pt %D%\export3 > %G%\doc-export3.out 2>&1
set CUDA_VISIBLE_DEVICES=
set LEGALPDF_TRANSITION_DOC_TIMES=1
set LEGALPDF_TRANSITION_DOC=%D%\export3
%GRADER% grade %S% --split development --out %G%\grade-speed3-order.json > %G%\speed3-order.out 2>&1
set LEGALPDF_TRANSITION_DOC_ORDER=off
%GRADER% grade %S% --split development --out %G%\grade-speed3-noorder.json > %G%\speed3-noorder.out 2>&1
set LEGALPDF_TRANSITION_DOC_ORDER=
set LEGALPDF_TRANSITION_DOC=
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-speed3-walker.json > %G%\speed3-walker.out 2>&1
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe headline.py %G%\grade-speed3-walker.json %G%\grade-speed3-order.json %G%\grade-speed3-noorder.json > %D%\speed3.txt
findstr /C:"documents," %G%\speed3-walker.out %G%\speed3-order.out %G%\speed3-noorder.out >> %D%\speed3.txt
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe doc_times.py %G%\speed3-noorder.out >> %D%\speed3.txt
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe judgments_by_mode.py walker=%G%\grade-speed3-walker.json doc=%G%\grade-speed3-noorder.json doc_order=%G%\grade-speed3-order.json >> %D%\speed3.txt
echo done> %D%\speed3.done
