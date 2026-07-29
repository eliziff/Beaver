# Canadian Semantic LegalBench (CSLB) — setup report

Benchmark by **Marty (Martin Rudolf)**; data basis **A2AJ** (Access to Algorithmic
Justice), 500 sampled documents. CanLII is not involved; no CanLII terms attach.
Set up 2026-07-28 by the Beaver corpus agent; usable per owner confirmation
(status `usable-collaborator-confirmed` in `canadian/registry.jsonl`, which
supersedes — without editing — the earlier `BLOCKED-PENDING-LICENSE` line).

## Origin

- Repo: https://github.com/martinwrudolf/Canadian-Semantic-LegalBench ("For A2AJ.")
- Pinned commit: `e10e23c929c16b5cc3e442c92f885eddb0412171` (2026-05-30)
- Clone: `cslb/repo/`. No LICENSE file / SPDX as of 2026-07-28 (recorded as a
  formality; per-document upstream terms travel with each row — King's Printer
  BC/ON notices, OGL-Canada, court reproduction notices; several rows are
  non-commercial-restricted and **91/400 ordinary rows have an empty
  `upstream_license`** (terms-unrecorded, not unrestricted).

## Inventory

`data/a2aj_benchmark.jsonl` — 500 rows (sha256 `24b34492…`): `pss-` 200
(pinpoint summarization), `sce-` 200 (sentence completion), `adv-` 100
(adversarial: false premises / reversed holdings / non-existent pinpoints;
`expected = refuse_or_note_no_source`). case_law 325 / legislation 75 across 22
A2AJ corpora. Runner `semantic_legalbench.py` makes no LLM calls itself but its
default scorer demands a ≥3-model sentence-transformers ensemble; `selftest`
passes offline on the `hash` backend.

**Trust the JSONL, not the README**: README and summary JSON both misreport the
split (actual test = 58 rows, not 60; `sce` train 153/test 23/test-adv 5/
val-adv 7). `adversarial_kind` is unnormalized free text (79 distinct values,
both `reversed_holding` and `reversed holding`).

## Deterministic vs model split

- **(a) `normalized/cslb_deterministic.jsonl` — 1,400 rows, zero model calls, 0 unparsed.**
  Primary slices: `pinpoint_citation_parse` (400; gold `metadata.anchor_kind` +
  `metadata.anchor_id`; 400/400 internally consistent, corroborated 200/200 by
  `prompt_anchor_resolution`) and `anchor_quote_verification` (gold
  `metadata.anchor_sha256`; **317/400 reconstruct byte-exactly** from fixtures —
  the other 83 are curator-edited, so the hash pins upstream A2AJ bytes; fetch,
  hash raw UTF-8, compare). Also: neutral_citation_parse 290,
  statute_citation_parse 75, tribunal_file_parse 34, reported_citation_parse 1.
- **(b) `normalized/cslb_model_required.jsonl` — 500 rows** (pss/sce ordinary +
  100 adversarial; refusal scoring after generation is regex-cheap).

## Scoring rules that matter

1. Exact string match, no normalization; `anchor_id` stays a string ("16.8").
2. Quote verification is **byte-exact** — every Unicode/whitespace normalization
   tested reduced the match rate.
3. Fixture-text regression only against `self_verified == true` (317).
4. The `*_matches_*` booleans are diagnostics, not gold (the 8 court misses are
   legitimate division aliases: SSTADIS→SST, CAF→FCA, FCT→FC, NSPCF→NSPC).
5. Never split statute titles on the first comma ("Ontario Loan Act, 2026");
   title = everything before the series token (59/75 → 75/75).

Headline: per-kind exact match, macro-averaged; `pinpoint_citation_parse` (400)
and `anchor_quote_verification` (317) reported as the two primaries.

## Adapter

`adapter/cslb_adapter.py` — Python 3 stdlib only, no network.
Run: `python -X utf8 cslb_adapter.py --verify`
(emits `{task_id, kind, input_text_or_ref, gold, source_provenance}`; provenance
propagates `upstream_license` verbatim plus pinned commit and attribution).
