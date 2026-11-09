@echo off
rem DOC (block-local Order, the parser's reading order) beside the walker on one build: the headline, each grade's
rem wall time, DOC's stage times per document, and judgments by mode.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc13.exe
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
cd /d %J%
set CUDA_VISIBLE_DEVICES=-1
if not exist %D%\export5\order.onnx C:\Users\elias\beaver-train\venv\Scripts\python.exe -W ignore docparse.py export %D%\model5\docparser.pt %D%\export5 > %G%\doc-export5.out 2>&1
set CUDA_VISIBLE_DEVICES=
set LEGALPDF_TRANSITION_DOC_TIMES=1
set LEGALPDF_TRANSITION_DOC=%D%\export5
%GRADER% grade %S% --split development --out %G%\grade-speed4-doc.json > %G%\speed4-doc.out 2>&1
set LEGALPDF_TRANSITION_DOC=
%GRADER% grade %S% --split development --out %G%\grade-speed4-walker.json > %G%\speed4-walker.out 2>&1
%PY% headline.py %G%\grade-speed4-walker.json %G%\grade-speed4-doc.json > %D%\speed4.txt
findstr /C:"documents," %G%\speed4-walker.out %G%\speed4-doc.out >> %D%\speed4.txt
%PY% doc_times.py %G%\speed4-doc.out >> %D%\speed4.txt
%PY% judgments_by_mode.py walker=%G%\grade-speed4-walker.json doc=%G%\grade-speed4-doc.json >> %D%\speed4.txt
echo done> %D%\speed4.done
