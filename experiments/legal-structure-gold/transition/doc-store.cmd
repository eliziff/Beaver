@echo off
rem Detect-Order-Construct refitted on the whole gold store (train; development read each epoch; test held out; run "a",
rem no holds: the grader's own sources): the gold's labels on the parser's lines (rows, gold_labels.py), each line's
rem features, text, page, marks, reading rank and what t0 decided of it (the dump), then the fit and its export. Every
rem step resumes on what it finds. Inputs: the grader's folder, each PDF read once.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set F=F:\fable-doc
set S=%F%\store\gold
set GRADER=%F%\grader-t0.exe
set PY=C:\Users\elias\AppData\Local\Programs\Python\Python312\python.exe
set TRAIN=C:\Users\elias\beaver-train\venv\Scripts\python.exe
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=4
cd /d %J%
rem The golds that came with the store and have no inputs yet (only.txt: their prefixes, comma-separated).
if not exist %F%\inputs.done (
  for /f "usebackq delims=" %%a in ("%F%\only.txt") do set STRUCTURE_GOLD_INPUTS_ONLY=%%a
  %GRADER% inputs %S% > %F%\inputs.out 2>&1
  set STRUCTURE_GOLD_INPUTS_ONLY=
  echo done> %F%\inputs.done
)
if not exist %D%\rows8\rows-train.jsonl %GRADER% rows %S% %D%\rows8 > %F%\rows8.out 2> %F%\rows8.err
if not exist %D%\gold8.jsonl %PY% gold_labels.py %D%\gold8.jsonl %S% %D%\rows8\rows-train.jsonl %D%\rows8\rows-development.jsonl
set LEGALPDF_TRANSITION_GOLD=%D%\gold8.jsonl
set LEGALPDF_TRANSITION_DUMP=%D%\lines8
set LEGALPDF_TRANSITION_DUMP_LINES=0
if not exist %D%\lines8.done (
  %GRADER% grade %S% --split train --out %F%\lines8-train.json > %F%\lines8-train.out 2>&1
  %GRADER% grade %S% --split development --out %F%\lines8-dev.json > %F%\lines8-dev.out 2>&1
  del /q %D%\lines8\*.moves.f32
  echo done> %D%\lines8.done
)
set LEGALPDF_TRANSITION_GOLD=
set LEGALPDF_TRANSITION_DUMP=
if not exist %D%\model8\fit.done %TRAIN% -u -W ignore docparse.py fit %D%\lines8 %S% %D%\model8 > %F%\fit8.out 2>&1
if not exist %D%\export8 %TRAIN% -u -W ignore docparse.py export %D%\model8\docparser.pt %D%\export8 > %F%\export8.out 2>&1
set LEGALPDF_TRANSITION_DOC=%D%\export8
set STRUCTURE_GOLD_THREADS=6
%GRADER% grade %S% --split development --out %F%\doc8.json > %F%\doc8.out 2>&1
%PY% judgments_by_mode.py t0=%F%\base-t0.json doc=%F%\base-doc.json doc8=%F%\doc8.json > %F%\doc8.txt 2>&1
echo done> %F%\store8.done
