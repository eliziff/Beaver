@echo off
rem The ceilings apart: the gold's labels carried onto the parser's lines and decoded by the grader's own labels decoder
rem (what any labelling of the parser's lines can hold), and the same labels through the DOC decoding (doc.rs's
rem oracle), on one build; beside the DOC model's grade.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc6.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
cd /d %J%
%GRADER% grade %S% --split development --labels %D%\gold.jsonl --out %G%\grade-doc-carried6.json > %G%\doc-carried6.out 2> %G%\doc-carried6.err
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_GOLD=%D%\gold.jsonl
set LEGALPDF_TRANSITION_DOC_ORACLE=1
%GRADER% grade %S% --split development --out %G%\grade-doc-oracle6.json > %G%\doc-oracle6.out 2> %G%\doc-oracle6.err
C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe headline.py %G%\grade-doc-carried6.json %G%\grade-doc-oracle6.json > %D%\ceilings.txt
echo done> %D%\ceilings.done
