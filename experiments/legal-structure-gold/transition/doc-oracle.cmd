@echo off
rem What Detect-Order-Construct's decoding can hold: development read by the DOC decoding from the heads' answers read
rem off the gold (LEGALPDF_TRANSITION_DOC_ORACLE), graded natively, beside the walker's ceiling (its oracle's moves).
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc3.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_GOLD=C:\Users\elias\fable\transition5\gold8.jsonl
set LEGALPDF_TRANSITION_DOC_ORACLE=1
cd /d %J%
%GRADER% grade %S% --split development --out %G%\grade-doc-oracle.json > %G%\doc-oracle.out 2> %G%\doc-oracle.err
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe headline.py %G%\grade-oracle8-dev.json %G%\grade-doc-oracle.json %G%\grade-doc-dev.json > %D%\oracle.txt
findstr /C:"documents," %G%\doc-oracle.out >> %D%\oracle.txt
echo done> %D%\oracle.done
