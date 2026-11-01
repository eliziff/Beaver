@echo off
rem Tier 1 and tier 2 of the transition parser over the long run's round 0 dump (transition4\dump0): each
rem encoder first read on the HTML pages' silver lines, the full encoder fitted first and compared at once with
rem the forest on development's lines (compare-<tier>.txt), then the out-of-fold encoders, two DAgger rounds of the
rem ranker over the tier's scores (a quarter of each round's lines dumped, 8% of an earlier round's fitted), and
rem development graded natively greedily, by a beam, and on A2AJ's judgments. Stages go by their outputs (a GPU
rem process with no console ends 0xC0000409 after writing everything) and are marked in stages.log.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set VPY=C:\Users\elias\beaver-train\venv\Scripts\python.exe
set J=C:\Users\elias\fable\joint
set T=C:\Users\elias\fable\transition4
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store-next\gold
set Y=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-next6.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set TIER_EPOCHS=3
set LINE_KEEP=1.0
set OLDER_KEEP=0.32
cd /d %J%
call :tier tier1 small 4 || exit /b 1
call :tier tier2 large 8 || exit /b 1
echo tiers done>> %T%\stages.log
exit /b 0

:tier
set N=%1
if exist %T%\%N%\full.done goto tierfolds
if exist %T%\%N% rmdir /s /q %T%\%N%
mkdir %T%\%N%
echo %DATE% %TIME% %N% pretrain>> %T%\stages.log
%VPY% -u tier.py pretrain C:\Users\elias\fable\silver-lines.jsonl %T%\dump0 %T%\%N%\pre.pt --size %2 > %G%\long-%N%-pre.out 2>&1
if not exist %T%\%N%\pre.pt exit /b 1
echo %DATE% %TIME% %N% full encoder>> %T%\stages.log
%VPY% -u tier.py fit %T%\dump0 %S% %T%\%N% --init %T%\%N%\pre.pt --size %2 --part full > %G%\long-%N%-fit.out 2>&1
if not exist %T%\%N%\full.done exit /b 1
%PY% compare_local.py %T%\dump0 %S% %T%\local\full.txt %T%\%N%\scores > %T%\compare-%N%.txt 2>&1
echo %DATE% %TIME% %N% full encoder compared (compare-%N%.txt)>> %T%\stages.log
:tierfolds
if exist %T%\%N%\folds.done goto tierrounds
%VPY% -u tier.py fit %T%\dump0 %S% %T%\%N% --init %T%\%N%\pre.pt --size %2 --part folds > %G%\long-%N%-folds.out 2>&1
if not exist %T%\%N%\folds.done exit /b 1
echo %DATE% %TIME% %N% folds>> %T%\stages.log
:tierrounds
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
%PY% headline.py %G%\grade-long-%N%-dev-greedy.json %G%\grade-long-%N%-dev-beam%3.json >> %T%\rounds.txt
set LEGALPDF_TRANSITION_EMIT=
set LEGALPDF_TRANSITION_RANKER=
set LEGALPDF_TRANSITION_LOCAL_SCORES=
echo %DATE% %TIME% %N% graded>> %T%\stages.log
exit /b 0

:tround
set R=%1
set /a P=%R%-1
set DUMPS=%DUMPS% %T%\%N%\dump%R%
if exist %T%\%N%\ranker%R%.txt exit /b 0
if exist %T%\%N%\dump%R%.done goto tfit
if exist %T%\%N%\dump%R% rmdir /s /q %T%\%N%\dump%R%
set LEGALPDF_TRANSITION_GOLD=%T%\gold.jsonl
set LEGALPDF_TRANSITION_RANKER=
if %R% gtr 1 set LEGALPDF_TRANSITION_RANKER=%T%\%N%\ranker%P%.txt
set LEGALPDF_TRANSITION_DUMP=%T%\%N%\dump%R%
set LEGALPDF_TRANSITION_DUMP_LINES=0.25
echo %DATE% %TIME% %N% round %R% rollouts>> %T%\stages.log
%GRADER% grade %S% --split train --out %G%\grade-long-%N%-%R%.json > %G%\long-%N%-%R%.out 2> %G%\long-%N%-%R%.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_DUMP_LINES=
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_RANKER=
%PY% check_dump.py %T%\%N%\dump%R% 3500 || exit /b 1
echo done> %T%\%N%\dump%R%.done
:tfit
%PY% -u fit_transition.py ranker %S% %T%\%N%\ranker%R%.txt %DUMPS% > %G%\long-%N%-ranker%R%.out 2>&1 || exit /b 1
setlocal
set LEGALPDF_TRANSITION_RANKER=%T%\%N%\ranker%R%.txt
set LEGALPDF_TRANSITION_EMIT=1
%GRADER% grade %Y% --split development --out %G%\grade-long-%N%-round%R%-dev.json > nul 2> %G%\long-%N%-round%R%-dev.err
%PY% headline.py %G%\grade-long-%N%-round%R%-dev.json >> %T%\rounds.txt
endlocal
echo %DATE% %TIME% %N% round %R% fitted>> %T%\stages.log
exit /b 0
