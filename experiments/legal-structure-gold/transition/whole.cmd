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
rem (0) The gold's labels on the parser's lines, from the store as shipped (desktop-store.ps1 at its commit): the
rem rows export, then gold_labels.py (a line a whole gold leaves untyped no region's).
if exist %W%\gold.jsonl goto rows
%GRADER% rows %S% %W%\gold-rows > %G%\whole-gold-rows.out 2> %G%\whole-gold-rows.err
%PY% gold_labels.py %W%\gold.jsonl %S% %W%\gold-rows\rows-train.jsonl %W%\gold-rows\rows-development.jsonl
if not exist %W%\gold.jsonl exit /b 1
:rows
rem (0b) The local forests (the line roles' evidence) fitted again on these labels over round 0's line dump (its lines
rem unchanged): five out of fold and the product's full one, a line the gold leaves untyped learned as no region's.
if exist %W%\local\full.txt goto dump
set GOLD=%W%\gold.jsonl
set ROUNDS=60
set LEAVES=127
set FOLDS=5
set COMMON_KEEP=0.4
%PY% -u fit_transition.py local C:\Users\elias\fable\transition4\dump0 %S% %W%\local > %G%\whole-local.out 2>&1
set GOLD=
set ROUNDS=
set LEAVES=
set FOLDS=
set COMMON_KEEP=
if not exist %W%\local\full.txt exit /b 1
:dump
rem (1) The heads' training rows, train's local scores out of fold.
if exist %W%\rows.done goto heads
set LEGALPDF_TRANSITION_LOCAL_FOLDS=%W%\local
set LEGALPDF_TRANSITION_GOLD=%W%\gold.jsonl
set LEGALPDF_TRANSITION_WHOLE_DUMP=%W%\rows
%GRADER% grade %S% --split train --out %G%\grade-whole-rows.json > %G%\whole-rows.out 2> %G%\whole-rows.err
if not exist %W%\rows exit /b 1
echo done> %W%\rows.done
:heads
rem (2) The heads, and their folds.
if exist %W%\heads\fold4\bparent.txt goto problems
set FOLDS=5
%PY% -u fit_whole.py %S% %W%\heads %W%\rows > %G%\whole-heads.out 2>&1
set FOLDS=
if not exist %W%\heads\fold4\bparent.txt exit /b 1
:problems
rem (3) The problems, read by the fold heads.
if exist %W%\problems.done goto weights
if exist %W%\problems rmdir /s /q %W%\problems
set LEGALPDF_TRANSITION_LOCAL_FOLDS=%W%\local
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
rem (4) The weights, on whole documents, the reachability check first (whole-train.out's first line).
if not exist %W%\weights.json %GRADER% whole-train %W%\problems %W%\weights.json 6 > %G%\whole-train.out 2>&1
if not exist %W%\weights.json exit /b 1
rem (5) Development read whole: the full heads, the weights, the product's local forest.
set LEGALPDF_TRANSITION_LOCAL=%W%\local\full.txt
set LEGALPDF_TRANSITION_HEADS=%W%\heads
set LEGALPDF_TRANSITION_WHOLE_WEIGHTS=%W%\weights.json
set LEGALPDF_TRANSITION_EMIT=1
%GRADER% grade %S% --split development --out %G%\grade-whole-dev.json > %G%\whole-dev.out 2> %G%\whole-dev.err
rem The same store and build beside it: the walker as it stood (round 3's ranker over the new forests), and the
rem architecture's ceiling (the gold's own moves, the walk's oracle), then the three side by side, and judgments apart.
set LEGALPDF_TRANSITION_WHOLE=
set LEGALPDF_TRANSITION_HEADS=
set LEGALPDF_TRANSITION_WHOLE_WEIGHTS=
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-whole-walker.json > %G%\whole-walker.out 2> %G%\whole-walker.err
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_GOLD=%W%\gold.jsonl
%GRADER% grade %S% --split development --out %G%\grade-whole-ceiling.json > %G%\whole-ceiling.out 2> %G%\whole-ceiling.err
set LEGALPDF_TRANSITION_GOLD=
%PY% headline.py %G%\grade-whole-walker.json %G%\grade-whole-dev.json %G%\grade-whole-ceiling.json > %W%\result.txt
%PY% judgments.py walker=%G%\grade-whole-walker.json whole=%G%\grade-whole-dev.json ceiling=%G%\grade-whole-ceiling.json >> %W%\result.txt
findstr /C:"documents," %G%\whole-dev.out %G%\whole-walker.out >> %W%\result.txt
echo done> %W%\graded.done
