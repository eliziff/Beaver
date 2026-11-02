@echo off
rem The line dump for Detect-Order-Construct: train's and development's documents read once, each line's features,
rem text, page, reference marks and reading rank in the gold dumped with the gold's labels (the regenerated
rem doc\gold.jsonl), no candidate rows; the text embeddings of the earlier dump kept (the same lines).
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store\gold
set GRADER=C:\Users\elias\fable\grader-doc7.exe
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=6
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_GOLD=%D%\gold.jsonl
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_DUMP=%D%\lines2
set LEGALPDF_TRANSITION_DUMP_LINES=0
cd /d C:\Users\elias\fable\joint
%GRADER% grade %S% --split train --out %G%\grade-doc-lines2-train.json > %G%\doc-lines2-train.out 2> %G%\doc-lines2-train.err
%GRADER% grade %S% --split development --out %G%\grade-doc-lines2-dev.json > %G%\doc-lines2-dev.out 2> %G%\doc-lines2-dev.err
del /q %D%\lines2\*.moves.f32
copy /y %D%\lines\*.npy %D%\lines2\ > nul
echo done> %D%\lines2.done
