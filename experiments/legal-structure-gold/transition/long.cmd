@echo off
rem The transition parser's long fit, on the store at the gold's HEAD (the yardstick's documents, the A2AJ
rem judgments, batch 10's authored golds): its rows and the gold's labels (A2AJ's without levels or depths),
rem round 0's dump of every document's line features and five out-of-fold local forests on it, three DAgger
rem rounds of the ranker from the local base, then development graded on the parser's own structure: the
rem frozen yardstick's (as every earlier row), greedily and by a beam of four, and the A2AJ judgments' apart; then
rem tiers 1 and 2 (the document encoders) the same way.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set J=C:\Users\elias\fable\joint
set T=C:\Users\elias\fable\transition3
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store-next\gold
set Y=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-next.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
cd /d %J%
if not exist %T% mkdir %T%
rem A stage whose output stands complete is not run again: round 0's dump (dump0.done), the forests (local\full.txt),
rem each round's ranker; delete them to redo a stage.
rem The rows and the gold's labels.
if not exist C:\Users\elias\gold-rows\n1\rows-train.jsonl %GRADER% rows %S% C:\Users\elias\gold-rows\n1 > %G%\long-rows.out 2> %G%\long-rows.err
%PY% gold_labels.py %T%\gold.jsonl %S% C:\Users\elias\gold-rows\n1\rows-train.jsonl C:\Users\elias\gold-rows\n1\rows-development.jsonl || exit /b 1
rem Round 0 and the local forests.
if exist %T%\dump0.done goto local
if exist %T%\dump0 rmdir /s /q %T%\dump0
set LEGALPDF_TRANSITION_GOLD=%T%\gold.jsonl
set LEGALPDF_TRANSITION_DUMP=%T%\dump0
%GRADER% grade %S% --out %G%\grade-long0.json > %G%\long0.out 2> %G%\long0.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_GOLD=
%PY% check_dump.py %T%\dump0 4000 || exit /b 1
echo done> %T%\dump0.done
:local
set ROUNDS=60
set LEAVES=127
set FOLDS=5
set COMMON_KEEP=0.4
if not exist %T%\local\full.txt %PY% -u fit_transition.py local %T%\dump0 %S% %T%\local || exit /b 1
set ROUNDS=
set LEAVES=
set COMMON_KEEP=
rem DAgger.
set EASY_KEEP=0.2
set OLDER_KEEP=0.3
set LEGALPDF_TRANSITION_LOCAL_FOLDS=%T%\local
set DUMPS=
for %%r in (1 2 3) do call :round %%r || exit /b 1
rem Development, on the parser's own structure, its local scores the full forest's (the product's).
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
set LEGALPDF_TRANSITION_LOCAL=%T%\local\full.txt
set LEGALPDF_TRANSITION_RANKER=%T%\ranker3.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_BEAM=1
%GRADER% grade %Y% --split development --out %G%\grade-long-dev-greedy.json > %G%\long-dev-greedy.out 2> %G%\long-dev-greedy.err
set LEGALPDF_TRANSITION_BEAM=4
%GRADER% grade %Y% --split development --out %G%\grade-long-dev-beam4.json > %G%\long-dev-beam4.out 2> %G%\long-dev-beam4.err
set LEGALPDF_TRANSITION_BEAM=1
%GRADER% grade %S% --split development --group label_source=a2aj-align --out %G%\grade-long-a2aj-dev.json > %G%\long-a2aj-dev.out 2> %G%\long-a2aj-dev.err
rem The same greedy reading through the labels bridge, beside the native grade, to retire the bridge.
set LEGALPDF_TRANSITION_EMIT=
set LEGALPDF_TRANSITION_LABELS=%T%\labels-dev
if exist %T%\labels-dev rmdir /s /q %T%\labels-dev
%GRADER% grade %Y% --split development --out %G%\grade-long-dev-parse.json > %G%\long-dev-parse.out 2> %G%\long-dev-parse.err
set LEGALPDF_TRANSITION_LABELS=
%PY% assemble_labels.py %T%\labels-dev C:\Users\elias\gold-rows\t1\rows-development.jsonl %T%\labels-dev.jsonl || exit /b 1
%GRADER% grade %Y% --split development --labels %T%\labels-dev.jsonl --out %G%\grade-long-dev-labels.json > %G%\long-dev-labels.out 2>&1
rem Tier 1 and tier 2: the document encoders over round 0's dump, each first read on the HTML pages' silver lines,
rem fitted out of fold on train and in full, then the ranker over each tier's scores (two DAgger rounds from the
rem oracle's) and development graded as tier 0's.
set LEGALPDF_TRANSITION_LOCAL=
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_EMIT=
set VPY=C:\Users\elias\beaver-train\venv\Scripts\python.exe
call :tier tier1 small 4 || exit /b 1
call :tier tier2 large 8 || exit /b 1
echo done
exit /b 0

:tier
set N=%1
if exist %T%\%N% rmdir /s /q %T%\%N%
mkdir %T%\%N%
%VPY% -u tier.py pretrain C:\Users\elias\fable\silver-lines.jsonl %T%\dump0 %T%\%N%\pre.pt --size %2 > %G%\long-%N%-pre.out 2>&1 || exit /b 1
%VPY% -u tier.py fit %T%\dump0 %S% %T%\%N% --init %T%\%N%\pre.pt --size %2 > %G%\long-%N%-fit.out 2>&1 || exit /b 1
set LEGALPDF_TRANSITION_LOCAL_SCORES=%T%\%N%\scores
set DUMPS=
for %%r in (1 2) do call :tround %%r || exit /b 1
set LEGALPDF_TRANSITION_RANKER=%T%\%N%\ranker2.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_BEAM=1
%GRADER% grade %Y% --split development --out %G%\grade-long-%N%-dev-greedy.json > %G%\long-%N%-dev-greedy.out 2> %G%\long-%N%-dev-greedy.err
set LEGALPDF_TRANSITION_BEAM=%3
%GRADER% grade %Y% --split development --out %G%\grade-long-%N%-dev-beam%3.json > %G%\long-%N%-dev-beam%3.out 2> %G%\long-%N%-dev-beam%3.err
set LEGALPDF_TRANSITION_BEAM=1
%GRADER% grade %S% --split development --group label_source=a2aj-align --out %G%\grade-long-%N%-a2aj-dev.json > %G%\long-%N%-a2aj-dev.out 2> %G%\long-%N%-a2aj-dev.err
set LEGALPDF_TRANSITION_EMIT=
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_LOCAL_SCORES=
exit /b 0

:tround
set R=%1
set /a P=%R%-1
set LEGALPDF_TRANSITION_GOLD=%T%\gold.jsonl
set LEGALPDF_TRANSITION_RANKER=
if %R% gtr 1 set LEGALPDF_TRANSITION_RANKER=%T%\%N%\ranker%P%.txt
set LEGALPDF_TRANSITION_DUMP=%T%\%N%\dump%R%
%GRADER% grade %S% --split train --out %G%\grade-long-%N%-%R%.json > %G%\long-%N%-%R%.out 2> %G%\long-%N%-%R%.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_RANKER=
%PY% check_dump.py %T%\%N%\dump%R% 3500 || exit /b 1
set DUMPS=%DUMPS% %T%\%N%\dump%R%
%PY% -u fit_transition.py ranker %S% %T%\%N%\ranker%R%.txt %DUMPS% || exit /b 1
exit /b 0

:round
set R=%1
set /a P=%R%-1
set DUMPS=%DUMPS% %T%\dump%R%
if exist %T%\ranker%R%.txt exit /b 0
if exist %T%\dump%R% rmdir /s /q %T%\dump%R%
set LEGALPDF_TRANSITION_GOLD=%T%\gold.jsonl
set LEGALPDF_TRANSITION_RANKER=
if %R% gtr 1 set LEGALPDF_TRANSITION_RANKER=%T%\ranker%P%.txt
set LEGALPDF_TRANSITION_DUMP=%T%\dump%R%
%GRADER% grade %S% --split train --out %G%\grade-long%R%.json > %G%\long%R%.out 2> %G%\long%R%.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_GOLD=
%PY% check_dump.py %T%\dump%R% 3500 || exit /b 1
%PY% -u fit_transition.py ranker %S% %T%\ranker%R%.txt %DUMPS% || exit /b 1
exit /b 0
