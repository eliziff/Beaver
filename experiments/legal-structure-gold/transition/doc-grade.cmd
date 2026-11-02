@echo off
rem Detect-Order-Construct graded on development, on the desktop: the best checkpoint exported (docparse.py export), the
rem documents read by it in the engine (LEGALPDF_TRANSITION_DOC) and graded natively, beside the walker as it stood
rem (round 3's ranker over the local forest) on the same store and build; the headline side by side, judgments apart,
rem and the judgments' line-opening numbers, each one's role as DOC reads it against the gold.
set PY=C:\Users\elias\beaver-train\venv\Scripts\python.exe
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc8.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
cd /d %J%
echo %TIME% export> %D%\grade-stages.log
if exist %D%\export2\exported.done goto read
set CUDA_VISIBLE_DEVICES=-1
%PY% -W ignore docparse.py export %D%\model2\docparser.pt %D%\export2 > %G%\doc-export2.out 2>&1
set CUDA_VISIBLE_DEVICES=
if not exist %D%\export2\order.onnx exit /b 1
echo done> %D%\export2\exported.done
:read
echo %TIME% doc>> %D%\grade-stages.log
if exist %D%\labels2 rmdir /s /q %D%\labels2
set LEGALPDF_TRANSITION_DOC=%D%\export2
set LEGALPDF_TRANSITION_LABELS=%D%\labels2
%GRADER% grade %S% --split development --out %G%\grade-doc2-dev.json > %G%\doc2-dev.out 2> %G%\doc2-dev.err
set LEGALPDF_TRANSITION_DOC=
set LEGALPDF_TRANSITION_LABELS=
echo %TIME% walker>> %D%\grade-stages.log
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%GRADER% grade %S% --split development --out %G%\grade-doc2-walker.json > %G%\doc2-walker.out 2> %G%\doc2-walker.err
set LEGALPDF_TRANSITION_RANKER=
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe headline.py %G%\grade-doc2-walker.json %G%\grade-doc2-dev.json > %D%\result2.txt
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe judgments.py walker=%G%\grade-doc2-walker.json doc=%G%\grade-doc2-dev.json >> %D%\result2.txt
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe number_roles.py C:\Users\elias\fable\transition5\gap-dev %D%\labels2 %G%\grade-oracle-dev.json >> %D%\result2.txt 2>&1
findstr /C:"documents," %G%\doc2-dev.out %G%\doc2-walker.out >> %D%\result2.txt
echo %TIME% done>> %D%\grade-stages.log
