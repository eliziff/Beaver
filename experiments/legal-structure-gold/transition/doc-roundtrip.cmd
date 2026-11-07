@echo off
rem Whether DOC can hold every gold state: each train and development gold's labels through DOC's decoding and back out as
rem labels (LEGALPDF_TRANSITION_LABELS), diffed line by line against what went in (doc_roundtrip.py). %1 the grader, %2 the
rem run's name.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store-new\gold
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=4
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_GOLD=%D%\gold6.jsonl
set LEGALPDF_TRANSITION_DOC_ORACLE=1
set LEGALPDF_TRANSITION_LABELS=%D%\roundtrip-%2
cd /d %J%
%1 grade %S% --out %G%\grade-roundtrip-%2.json > %G%\roundtrip-%2.out 2> %G%\roundtrip-%2.err
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe doc_roundtrip.py %D%\gold6.jsonl %D%\roundtrip-%2 > %D%\roundtrip-%2.txt 2>&1
echo done> %D%\roundtrip-%2.done
