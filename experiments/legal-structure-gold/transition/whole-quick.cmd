@echo off
rem A quick reading of whether the whole reading does anything at tier 0: its heads fitted on a quarter of train's
rem documents (sha256 opening 0-3), development read whole with them and the prior weights (no whole-document
rem training yet), beside the walker as it stood, on the same store and build.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set J=C:\Users\elias\fable\joint
set Q=C:\Users\elias\fable\whole-quick
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-whole.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
if not exist %Q% mkdir %Q%
cd /d %J%
echo %TIME% rows> %Q%\stages.log
set LEGALPDF_TRANSITION_WHOLE=1
set LEGALPDF_TRANSITION_LOCAL_FOLDS=C:\Users\elias\fable\transition4\local
set LEGALPDF_TRANSITION_GOLD=C:\Users\elias\fable\transition5\gold8.jsonl
rem The transition parser runs where its emit is asked: the whole reading's dump is written as it reads.
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_WHOLE_DUMP=%Q%\rows
%GRADER% grade %S% --split train --runs 0 1 2 3 --out %G%\grade-quick-rows.json > %G%\quick-rows.out 2> %G%\quick-rows.err
set LEGALPDF_TRANSITION_WHOLE_DUMP=
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
echo %TIME% heads>> %Q%\stages.log
%PY% -u fit_whole.py %S% %Q%\heads %Q%\rows > %G%\quick-heads.out 2>&1
echo %TIME% development>> %Q%\stages.log
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_HEADS=%Q%\heads
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_LABELS=%Q%\labels
%GRADER% grade %S% --split development --out %G%\grade-quick-whole.json > %G%\quick-whole.out 2> %G%\quick-whole.err
set LEGALPDF_TRANSITION_LABELS=
rem The judgments' line-opening numbers, each one's role as the whole reading reads it, against the gold (and the walker's).
%PY% number_roles.py C:\Users\elias\fable\transition5\gap-dev %Q%\labels %G%\grade-oracle-dev.json > %Q%\numbers.txt 2>&1
set LEGALPDF_TRANSITION_WHOLE=
set LEGALPDF_TRANSITION_HEADS=
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-quick-walker.json > %G%\quick-walker.out 2> %G%\quick-walker.err
%PY% headline.py %G%\grade-quick-walker.json %G%\grade-quick-whole.json > %Q%\result.txt
%PY% judgments.py walker=%G%\grade-quick-walker.json whole=%G%\grade-quick-whole.json >> %Q%\result.txt
type %Q%\numbers.txt >> %Q%\result.txt
findstr /C:"documents," %G%\quick-rows.out %G%\quick-whole.out %G%\quick-walker.out >> %Q%\result.txt
echo %TIME% done>> %Q%\stages.log
