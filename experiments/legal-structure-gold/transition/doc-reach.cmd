@echo off
rem Whether every gold state is reachable: train's and development's golds read from the gold's own answers, graded on
rem every layer against the gold. Carried: the labels on the parser's lines through the grader's labels decoder (what any
rem labelling of the parser's lines can hold). Oracle: the same labels through DOC's decoding and moves (doc::oracle). A
rem layer below 1.000 in the first is lost in the labels, one below the first in the second is lost in DOC. %1 the grader,
rem %2 the run's name.
set J=C:\Users\elias\fable\joint
set D=C:\Users\elias\fable\doc
set G=C:\Users\elias\AppData\Local\OpenLegalData\gold-grades
set S=C:\Users\elias\gold-store-new\gold
set LEGALPDF_TRANSITION_CONFUSIONS=C:\Users\elias\fable\confusions.json
set LEGALPDF_INDRA_MODEL_PACK=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\indra
set LEGALPDF_ONNXRUNTIME=C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\runtime\onnx\onnxruntime.dll
set STRUCTURE_GOLD_THREADS=4
cd /d %J%
%1 grade %S% --labels %D%\gold6.jsonl --out %G%\grade-reach-carried-%2.json > %G%\reach-carried-%2.out 2> %G%\reach-carried-%2.err
set LEGALPDF_TRANSITION_GOLD=%D%\gold6.jsonl
set LEGALPDF_TRANSITION_DOC_ORACLE=1
%1 grade %S% --out %G%\grade-reach-oracle-%2.json > %G%\reach-oracle-%2.out 2> %G%\reach-oracle-%2.err
echo done> %D%\reach-%2.done
