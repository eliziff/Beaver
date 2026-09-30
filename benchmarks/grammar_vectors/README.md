# Grammar vectors (harvested)
Citation-grammar test vectors harvested from two READ-ONLY reference repos:
`ALR-Quote-Verifier` (test_deterministic_splitter, test_pure_ref_prefilter,
test_pinpoint_kind_guards, test_quote_fragments) and `AuthoritiesHelper`
(test_toa_maker). One JSON object per line of `harvested.jsonl`: `source`
(file:line), `kind` (splitter-io | pure-ref | guard-negative | raw-string |
toa-io), `input` literal, structured `expect` (or null), `note` (test name).
AuthoritiesHelper input is read from Git revision
`f6ed2216fb4565f0126262b03013fa7b87150006`, which retains the retired Python
tests; it does not require the Python product in the working tree. `--toa-ref`
selects a different historical oracle explicitly.

AST-extracted (exact multi-line/implicit-concat strings, parametrized loops
expanded), deduped on (kind, input). Never edit the references; regenerate with
`python -X utf8 harvest.py [ALR_ROOT] [TOA_ROOT]` (exits nonzero on missing sources).
