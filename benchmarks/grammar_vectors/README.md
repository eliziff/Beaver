# Grammar vectors (harvested)
Citation-grammar test vectors harvested from two READ-ONLY reference repos:
`ALR-Quote-Verifier` (test_deterministic_splitter, test_pure_ref_prefilter,
test_pinpoint_kind_guards, test_quote_fragments) and `TableOfAuthoritiesMaker`
(test_toa_maker). One JSON object per line of `harvested.jsonl`: `source`
(file:line), `kind` (splitter-io | pure-ref | guard-negative | raw-string |
toa-io), `input` literal, structured `expect` (or null), `note` (test name).
AST-extracted (exact multi-line/implicit-concat strings, parametrized loops
expanded), deduped on (kind, input). Never edit the references; regenerate with
`python -X utf8 harvest.py [ALR_ROOT] [TOA_ROOT]` (exits nonzero on missing sources).
