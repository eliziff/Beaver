@echo off
rem Tier 0 again on grader-next7 (the parser's own contents links, the joint stylesheet solve), the local forests
rem round 0 fitted (transition4\local: the line features have not changed since): three DAgger rounds of the
rem ranker (a quarter of each round's lines dumped; all of the latest round's drawn lines fitted, a third of an
rem earlier round's), each graded on development; the template prior fitted on the rounds' dumps; then
rem development graded greedily, by a beam of four, and by the joint solve over a grid of its weight and
rem penalty, with and without the prior. Stages go by their outputs and are marked in stages.log.
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set J=C:\Users\elias\fable\joint
set O=C:\Users\elias\fable\transition4
set T=C:\Users\elias\fable\transition5
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store-next\gold
set Y=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-next7.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LINE_KEEP=1.0
set OLDER_KEEP=0.32
cd /d %J%
if not exist %T% mkdir %T%
set LEGALPDF_TRANSITION_LOCAL_FOLDS=%O%\local
set DUMPS=
call :round 1 || exit /b 1
rem The joint solve's first reading, round 1's ranker, no prior: the roles weighed on the reading alone.
setlocal
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
set LEGALPDF_TRANSITION_LOCAL=%O%\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
if not exist %G%\grade-t5-r1-joint-0-3.json call :arm r1-joint-0-3 1 1 "0,3"
if not exist %G%\grade-t5-r1-joint-0-1.json call :arm r1-joint-0-1 1 1 "0,1"
endlocal
for %%r in (2 3) do call :round %%r || exit /b 1
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
rem The template prior, on the rounds' dumps and a development dump's templates.
if exist %T%\prior.txt goto grades
set LEGALPDF_TRANSITION_LOCAL=%O%\local\full.txt
set LEGALPDF_TRANSITION_RANKER=%T%\ranker2.txt
set LEGALPDF_TRANSITION_GOLD=%O%\gold.jsonl
set LEGALPDF_TRANSITION_DUMP=%T%\devdump
set LEGALPDF_TRANSITION_DUMP_LINES=0
if exist %T%\devdump rmdir /s /q %T%\devdump
%GRADER% grade %Y% --split development --out %G%\grade-t5-devdump.json > nul 2> %G%\t5-devdump.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_DUMP_LINES=
set LEGALPDF_TRANSITION_GOLD=
%PY% -u fit_transition.py prior %S% %T%\prior.txt %DUMPS% %T%\devdump > %G%\t5-prior.out 2>&1
if not exist %T%\prior.txt exit /b 1
echo %DATE% %TIME% prior fitted>> %T%\stages.log
:grades
rem Development: round 2's and round 3's rankers greedily and by a beam, then the joint solve on the better.
set LEGALPDF_TRANSITION_LOCAL=%O%\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
for %%r in (2 3) do call :arm r%%r-beam4 %%r 4 ""
call :arm r2-joint-0-1 2 1 "0,1"
call :arm r2-joint-0-3 2 1 "0,3"
set LEGALPDF_TRANSITION_PRIOR=%T%\prior.txt
call :arm r2-joint-1-1 2 1 "1,1"
call :arm r2-joint-1-3 2 1 "1,3"
call :arm r2-joint-0.3-3 2 1 "0.3,3"
call :arm r2-joint-3-3 2 1 "3,3"
call :arm r2-joint-1-10 2 1 "1,10"
set LEGALPDF_TRANSITION_PRIOR=
echo %DATE% %TIME% graded>> %T%\stages.log
exit /b 0

rem One development arm: its name, the round's ranker, the beam's width, the joint solve's weight and penalty.
:arm
setlocal
set LEGALPDF_TRANSITION_RANKER=%T%\ranker%2.txt
set LEGALPDF_TRANSITION_BEAM=%3
if not %4=="" set LEGALPDF_TRANSITION_JOINT=%~4
%GRADER% grade %Y% --split development --out %G%\grade-t5-%1.json > %G%\t5-%1.out 2> %G%\t5-%1.err
echo %1>> %T%\arms.txt
%PY% headline.py %G%\grade-t5-%1.json >> %T%\arms.txt
endlocal
echo %DATE% %TIME% arm %1>> %T%\stages.log
exit /b 0

:round
set R=%1
set /a P=%R%-1
set DUMPS=%DUMPS% %T%\dump%R%
if exist %T%\ranker%R%.txt exit /b 0
if exist %T%\dump%R%.done goto fitround
if exist %T%\dump%R% rmdir /s /q %T%\dump%R%
set LEGALPDF_TRANSITION_GOLD=%O%\gold.jsonl
set LEGALPDF_TRANSITION_RANKER=
if %R% gtr 1 set LEGALPDF_TRANSITION_RANKER=%T%\ranker%P%.txt
set LEGALPDF_TRANSITION_DUMP=%T%\dump%R%
set LEGALPDF_TRANSITION_DUMP_LINES=0.25
echo %DATE% %TIME% round %R% rollouts>> %T%\stages.log
%GRADER% grade %S% --split train --out %G%\grade-t5-%R%.json > %G%\t5-%R%.out 2> %G%\t5-%R%.err
set LEGALPDF_TRANSITION_DUMP=
set LEGALPDF_TRANSITION_DUMP_LINES=
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_RANKER=
%PY% check_dump.py %T%\dump%R% 3500 || exit /b 1
echo done> %T%\dump%R%.done
:fitround
%PY% -u fit_transition.py ranker %S% %T%\ranker%R%.txt %DUMPS% > %G%\t5-ranker%R%.out 2>&1 || exit /b 1
setlocal
set LEGALPDF_TRANSITION_LOCAL_FOLDS=
set LEGALPDF_TRANSITION_LOCAL=%O%\local\full.txt
set LEGALPDF_TRANSITION_RANKER=%T%\ranker%R%.txt
set LEGALPDF_TRANSITION_EMIT=1
%GRADER% grade %Y% --split development --out %G%\grade-t5-round%R%-dev.json > nul 2> %G%\t5-round%R%-dev.err
echo round%R%>> %T%\arms.txt
%PY% headline.py %G%\grade-t5-round%R%-dev.json >> %T%\arms.txt
endlocal
echo %DATE% %TIME% round %R% fitted>> %T%\stages.log
exit /b 0
