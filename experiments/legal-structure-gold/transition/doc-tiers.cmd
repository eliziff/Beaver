@echo off
rem Tier 0, the walker and DOC on one build of the branch (grader-doc13: transition-parser 3c884cc, legal-structure
rem 775b829), each over the development split: the headline, wall times and judgments by mode.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc13.exe
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=2
cd /d %J%
%GRADER% grade %S% --split development --out %G%\grade-tiers-t0.json > %G%\tiers-t0.out 2>&1
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-tiers-walker.json > %G%\tiers-walker.out 2>&1
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_DOC=%D%\export5
%GRADER% grade %S% --split development --out %G%\grade-tiers-doc.json > %G%\tiers-doc.out 2>&1
%PY% headline.py %G%\grade-tiers-t0.json %G%\grade-tiers-walker.json %G%\grade-tiers-doc.json > %D%\tiers.txt
findstr /C:"documents," %G%\tiers-t0.out %G%\tiers-walker.out %G%\tiers-doc.out >> %D%\tiers.txt
%PY% judgments_by_mode.py t0=%G%\grade-tiers-t0.json walker=%G%\grade-tiers-walker.json doc=%G%\grade-tiers-doc.json >> %D%\tiers.txt
echo done> %D%\tiers.done
