@echo off
rem Detect-Order-Construct trained on the gold, on the desktop: (1) train's and development's documents read once, each
rem line's features, text, page and reference marks dumped with the gold's labels (no candidate rows); (2) docparse.py
rem fits the three stages on train's and reports each head on development's. Stages go by their outputs.
set PY=C:\Users\elias\beaver-train\venv\Scripts\python.exe
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
if not exist %D% mkdir %D%
cd /d %J%
if exist %D%\lines.done goto fit
echo %TIME% lines> %D%\stages.log
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_GOLD=C:\Users\elias\fable\transition5\gold8.jsonl
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_DUMP=%D%\lines
set LEGALPDF_TRANSITION_DUMP_LINES=0
%GRADER% grade %S% --split train --out %G%\grade-doc-lines-train.json > %G%\doc-lines-train.out 2> %G%\doc-lines-train.err
%GRADER% grade %S% --split development --out %G%\grade-doc-lines-dev.json > %G%\doc-lines-dev.out 2> %G%\doc-lines-dev.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_DUMP_LINES=
set LEGALPDF_TRANSITION_GOLD=
if not exist %D%\lines exit /b 1
del /q %D%\lines\*.moves.f32
echo done> %D%\lines.done
:fit
echo %TIME% fit>> %D%\stages.log
%PY% -u docparse.py fit %D%\lines %S% %D%\model > %G%\doc-fit.out 2>&1
echo %TIME% done>> %D%\stages.log
