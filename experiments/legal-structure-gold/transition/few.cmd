@echo off
rem The new grader on a few documents before the long run: the parser's own structure (no fitted tables yet),
rem and round 0's dump with the gold's labels, checked.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set GRADER=C:\Users\elias\fable\grader-next2.exe
set T=C:\Users\elias\fable\few
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
if exist %T% rmdir /s /q %T%
mkdir %T%
set LEGALPDF_TRANSITION_EMIT=1
%GRADER% grade C:\Users\elias\gold-store\gold --split development --runs fe3dd6ee 75a18bf1 d1c4e0e5 5071f63a ad990164 --out %T%\emit.json > %T%\emit.out 2> %T%\emit.err
set LEGALPDF_TRANSITION_EMIT=
set LEGALPDF_TRANSITION_GOLD=C:\Users\elias\fable\transition\gold.jsonl
set LEGALPDF_TRANSITION_DUMP=%T%\dump
%GRADER% grade C:\Users\elias\gold-store\gold --split development --runs fe3dd6ee 75a18bf1 d1c4e0e5 5071f63a ad990164 --out %T%\dump.json > %T%\dump.out 2> %T%\dump.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_GOLD=
%PY% C:\Users\elias\fable\joint\check_dump.py %T%\dump 5
echo few done
