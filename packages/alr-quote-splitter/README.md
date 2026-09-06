# ALR deterministic quotation citation splitter

`deterministic_splitter.py` is an unmodified Apache-2.0 source snapshot from
https://github.com/AlbertaLawReview/ALR-Quote-Verifier at commit
`e27f683932be9f67c67635474c780f901206f168`, path
`verifier_core/deterministic_splitter.py`.

SHA-256: `6fd2abf4d7e9d4eaeba779832bfa149001b893355f4e27a0d7efc5722198154e`.

Beaver calls the free mode's `split_footnote_recall_first`, preserving every
part and delimiter, and `extract_fields`. `run.py` only supplies a JSON boundary
and converts Python character offsets to JavaScript UTF-16 offsets. Ingestion
and source resolution remain Beaver operations. This package does not run AI.
It requires Python 3.10+ (`BEAVER_PYTHON`, otherwise the system Python).

Run `python packages/alr-quote-splitter/test_parity.py` for the pinned upstream
digest, lossless reconstruction, and representative free-mode splitting cases.
