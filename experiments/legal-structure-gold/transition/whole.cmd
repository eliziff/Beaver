@echo off
rem The whole reading trained, on the desktop: (1) train's documents read with no heads, their candidates and the gold's
rem answers dumped; (2) the five heads fitted on them, and five fold heads each without its fold; (3) train's documents read
rem again with the fold heads, each document's problem dumped with the gold reading's totals; (4) the parts' weights
rem trained on whole documents (whole-train: each problem solved loss-augmented, the weights moved toward the gold's
rem totals); (5) development read whole with the full heads and the weights, graded natively. Stages go by their outputs.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set J=C:\Users\elias\fable\joint
set W=C:\Users\elias\fable\whole
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-whole.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_WHOLE=1
if not exist %W% mkdir %W%
cd /d %J%
rem (1) The heads' training rows, train's local scores out of fold.
if exist %W%\rows.done goto heads
set LEGALPDF_TRANSITION_LOCAL_FOLDS=C:\Users\elias\fable\transition4\local
set LEGALPDF_TRANSITION_GOLD=%W%\gold.jsonl
set LEGALPDF_TRANSITION_WHOLE_DUMP=%W%\rows
%GRADER% grade %S% --split train --out %G%\grade-whole-rows.json > %G%\whole-rows.out 2> %G%\whole-rows.err
if not exist %W%\rows exit /b 1
echo done> %W%\rows.done
:heads
rem (2) The heads, and their folds.
if exist %W%\heads\fold4\start.txt goto problems
set FOLDS=5
%PY% -u fit_whole.py %S% %W%\heads %W%\rows > %G%\whole-heads.out 2>&1
set FOLDS=
if not exist %W%\heads\fold4\start.txt exit /b 1
:problems
rem (3) The problems, read by the fold heads.
if exist %W%\problems.done goto weights
if exist %W%\problems rmdir /s /q %W%\problems
set LEGALPDF_TRANSITION_LOCAL_FOLDS=C:\Users\elias\fable\transition4\local
set LEGALPDF_TRANSITION_GOLD=%W%\gold.jsonl
set LEGALPDF_TRANSITION_HEADS_FOLDS=%W%\heads
set LEGALPDF_TRANSITION_WHOLE_DUMP=%W%\problems
%GRADER% grade %S% --split train --out %G%\grade-whole-problems.json > %G%\whole-problems.out 2> %G%\whole-problems.err
set LEGALPDF_TRANSITION_HEADS_FOLDS=
set LEGALPDF_TRANSITION_WHOLE_DUMP=
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
echo done> %W%\problems.done
:weights
rem (4) The weights, on whole documents.
if not exist %W%\weights.json %GRADER% whole-train %W%\problems %W%\weights.json 6 > %G%\whole-train.out 2>&1
if not exist %W%\weights.json exit /b 1
rem (5) Development read whole: the full heads, the weights, the product's local forest.
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_HEADS=%W%\heads
set LEGALPDF_TRANSITION_WHOLE_WEIGHTS=%W%\weights.json
set LEGALPDF_TRANSITION_EMIT=1
%GRADER% grade %S% --split development --out %G%\grade-whole-dev.json > %G%\whole-dev.out 2> %G%\whole-dev.err
echo done> %W%\graded.done
