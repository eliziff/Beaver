@echo off
rem One development document's missed (-) and spurious (+) items per layer as Detect-Order-Construct reads it, the
rem settings doc-grade.cmd grades with. doc-explain.cmd SHA_PREFIX LAYERS(a+b) LIMIT OUT
set GRADER=C:\Users\elias\fable\grader-doc2.exe
set S=C:\Users\elias\gold-store\gold
set LEGALPDF_TRANSITION_GRAMMAR=C:\Users\elias\fable\grammar.json
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set LEGALPDF_TRANSITION_LOCAL=C:\Users\elias\fable\transition4\local\full.txt
set LEGALPDF_TRANSITION_EMIT=1
set LEGALPDF_TRANSITION_DOC=C:\Users\elias\fable\doc\export
set LAYERS=%2
%GRADER% explain %S% %1 --layers %LAYERS:+=,% --limit %3 > %4 2>&1
