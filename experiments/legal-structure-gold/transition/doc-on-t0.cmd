@echo off
rem DOC on t0's facts, one build's grade (doc-speed4's, on export7): DOC and the walker over the development split of the
rem store doc-speed4 graded (184 documents) and of the store export7 was fitted on, each DOC grade timed by stage. %1 the
rem grader, %2 the run's name. Two runs compare with doc_diff.py.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set OLD=C:\Users\elias\gold-store\gold
set NEW=C:\Users\elias\gold-store-new\gold
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
cd /d %J%
set LEGALPDF_TRANSITION_DOC_TIMES=1
set LEGALPDF_TRANSITION_DOC=%D%\export7
%1 grade %OLD% --split development --out %G%\grade-ot-%2-doc.json > %G%\ot-%2-doc.out 2>&1
%1 grade %NEW% --split development --out %G%\grade-ot-%2-docnew.json > %G%\ot-%2-docnew.out 2>&1
set LEGALPDF_TRANSITION_DOC=
set LEGALPDF_TRANSITION_DOC_TIMES=
set LEGALPDF_TRANSITION_RANKER=C:\Users\elias\fable\transition5\ranker3.txt
%1 grade %OLD% --split development --out %G%\grade-ot-%2-walker.json > %G%\ot-%2-walker.out 2>&1
%PY% headline.py %G%\grade-ot-%2-walker.json %G%\grade-ot-%2-doc.json %G%\grade-ot-%2-docnew.json > %D%\ot-%2.txt
findstr /C:"documents," %G%\ot-%2-walker.out %G%\ot-%2-doc.out %G%\ot-%2-docnew.out >> %D%\ot-%2.txt
%PY% doc_times.py %G%\ot-%2-doc.out >> %D%\ot-%2.txt
%PY% judgments_by_mode.py walker=%G%\grade-ot-%2-walker.json doc=%G%\grade-ot-%2-doc.json >> %D%\ot-%2.txt
echo done> %D%\ot-%2.done
