@echo off
rem Tier 0, the walker and DOC with the paragraph spine (grader-spine: transition-parser 14ede90, legal-structure
rem paragraph-spine 4befe41), each over the development split: the headline, wall times and judgments by mode.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-spine.exe
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=2
cd /d %J%
%GRADER% grade %S% --split development --out %G%\grade-spine-t0.json > %G%\spine-t0.out 2>&1
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-spine-walker.json > %G%\spine-walker.out 2>&1
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_DOC=%D%\export5
%GRADER% grade %S% --split development --out %G%\grade-spine-doc.json > %G%\spine-doc.out 2>&1
%PY% headline.py %G%\grade-spine-t0.json %G%\grade-spine-walker.json %G%\grade-spine-doc.json > %D%\spine.txt
findstr /C:"documents," %G%\spine-t0.out %G%\spine-walker.out %G%\spine-doc.out >> %D%\spine.txt
%PY% judgments_by_mode.py t0=%G%\grade-spine-t0.json walker=%G%\grade-spine-walker.json doc=%G%\grade-spine-doc.json >> %D%\spine.txt
echo done> %D%\spine.done
