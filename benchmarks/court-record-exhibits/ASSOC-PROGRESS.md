# Stream 1: affidavit to record association (progress log)

Task: label each stripped exhibit file with its exhibit letter, from the affidavit
alone, with something that runs in a browser. Chronology is a separate stream.

Scripts: copied (untracked, not committed) to `benchmarks/court-record-exhibits/assoc/` on
2026-09-24 since v4 beat the README baseline; the scratchpad copy below also holds the caches.
To rebuild there: `exhibit_inputs.py` output -> `assoc/inputs.json`, then `refs.py`, `cache_base.py`,
`feats2.py`, `feats3.py`, `kinds.py`, `models.py base,sim,fs,order,seg,kind --save v4`,
`export.py v4`. `cache_base.py`, `feats5.py` and `timing.py` still point `POTION` at the
scratchpad's `embed-models/potion-8m`.

Working files (experiments):
`%TEMP%\claude\C--Users-elias-Desktop-MikeOSS-Fork\1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c\scratchpad\assoc\`
- `common.py`: data, grouped 5-fold split (records of one family / court file share a fold,
  balanced by file count), one-to-one Hungarian scoring.
- `inputs.json`: `exhibit_inputs.py` output for all 120 records with data (1,428 files).
- `cache_base.py` -> `feats_base.npz`: fastmatch's 19 cheap pair signals (potion-8m for m2v).
- `refs.py` -> `inputs2.json`: new affidavit-side extractor (label lists, ranges,
  "respectively" items, tables, OCR 0/O, 4-letter labels, previous paragraph, definitions).
- `models.py <sets> --model point|list|mlp`: scorers under grouped 5-fold.
- `feats2.py` (sim/fs/order), `feats3.py` (seg), `export.py <oof tag>` (preds json for score.py),
  `timing.py`, `llm_mc.py` (LLM multiple choice, desktop GPU).
- Desktop copy: `C:\Users\elias\beaver-train\assoc\` (created 2026-09-24; the earlier note's
  claim that work lived there was wrong). The GPU was taken by another session's
  `gen_distill.py` (Python312, 12 GB) at 01:14; wait for it.

Evaluation: grouped 5-fold by record, 120 records, 1,428 files, accuracy = files
labelled correctly after one-to-one assignment. Numbers below are all on that.

## Results

| Framing / model | 5-fold acc | Notes |
|---|---|---|
| Random | 0.084 | 1/N |
| TF-IDF + Hungarian (`baseline.py`) | 0.520 | was 0.541 on 31 records |
| fastmatch features, pointwise logistic (old framing) | 0.653 | was 0.672 LORO on 31 |
| same features, listwise bidirectional conditional logit | 0.672 (0.680 after inputs rebuild, 1,427 files) | softmax over files per label + over labels per file |
| `feats2.py` sim (9 ref views x file views, TF-IDF/char-gram + row/col ranks), list | 0.677 | |
| `feats2.py` fs (field-level agreement: dates, amounts, ids, urls, names, kinds, pages) | 0.616 | alone |
| base+sim, list | 0.732 | |
| base+sim+fs, list | 0.751 | |
| base+sim+fs+order (label-order prior as a feature), list | **0.768** | label top-1 0.662; recall@3 0.874, @5 0.924, @10 0.980 (`oof_all_list.npz`) |
| same, one-hidden-layer MLP listwise | 0.672 | overfits (120 records) |
| `feats3.py` seg: text each mention owns (from previous other-exhibit mention to it, and from it to the next), TF-IDF/char-gram + rarity-weighted field agreement (Fellegi-Sunter u-probabilities) | 0.584 alone | `refs.py` now emits `ctx[l]["seg"] = [before, after]` |
| base+sim+fs+order+seg, list | **0.788** | l2 3e-2: 0.793 (sweep flat); recall@5 0.928 (`oof_v3.npz`) |
| + date lists sharing one year ("May 8, June 4 and September 25, 2025"), table-row segments | **0.789** | `fields.list_dates`; `oof_v3.npz` now this |
| `feats4.py` party: author/recipient agreement (from/to in the owned text, "my email" = affiant; file From:/To:/Dear/letterhead) | 0.786 (no gain) | too noisy as written; kept on disk, not in the stack |
| `docdate.py` dd: learned document-date ranker (conditional logit over a file's day-dates, gold exhibit dates, grouped folds) -> probability mass on the label's dates | 0.791 (+0.002, noise) | ranker top-1 0.798 vs first-date rule 0.794: the first date already is the document date; parser misses (OCR, handwriting, dates only in the affidavit) are the ceiling |
| Qwen2.5-0.5B-Instruct zero-shot MC, laptop CPU smoke (2 records, 66 prompts) | l2f 0.24, f2l 0.42 shortlist top-1 (chance 0.2) | 91 tok/s torch fp32 on the loaded laptop, ~1,000 tokens/prompt: ~11 s per prompt. Zero-shot 0.5B is too weak |
| `kinds.py` kind: learned document kind on both sides (hashed-word multinomial logistic, gold kinds, 17 classes, grouped folds) -> P(same kind) | **0.793** (+0.004) | OOF kind accuracy files 0.628, affidavit side 0.479; `oof_v4.npz` = base+sim+fs+order+seg+kind |
| `stack.py`: second stage over first-stage OOF (row/col softmax, margins, ranks, Hungarian pick) | 0.793 (no gain) | cheap features have plateaued near 0.79 |
| `feats5.py` emb: potion-8m cosine, 4 affidavit views x head/full, with ranks | 0.442 alone; 0.791 stacked (no gain) | static embeddings add nothing over TF-IDF/char-grams here |
| Browser cost of an LLM MC step (`wasm_time.mjs`, onnxruntime-web 1.30 WASM as Lens ships it, onnx-community Qwen2.5-0.5B-Instruct `model_q4.onnx` 786 MB, chunked prefill 128) | - | 1 thread **22.6 tok/s** on the loaded laptop; native ORT same model 82.6 tok/s (1 thread), 134 tok/s (4 threads). f2l prompts avg ~1,400 tokens (K=5, 900-char heads): a 13-file record = 18.7k tokens = ~14 min WASM 1-thread, ~8 min at 4 threads. CPU-WASM LLM reranking is minutes per record; only WebGPU or much shorter prompts make it interactive |
| Qwen2.5-0.5B-Instruct zero-shot f2l MC, GPU, all 1,427 files, 5 cyclic rotations averaged, shortlist top-5 of `oof_v4` | shortlist top-1 **0.315**; stacked with v4: 0.791 (no gain) | 6.4M tokens in 390 s on the 3080 Ti (16k tok/s, shared GPU) |
| Qwen2.5-1.5B-Instruct, same (zero-shot f2l, 5 rotations) | shortlist top-1 **0.498**; alone 0.621; stacked 0.782-0.790 (no gain; label top-1 0.671 -> 0.697 but assignment flat) | 2,099 s on the shared GPU. Zero-shot small LLMs see what the features already see |
| Qwen3-1.7B zero-shot | not run to completion | killed to free the GPU for fine-tuning (1.5B already answered the question) |
| `mc_ft.py` LoRA r16 on Qwen2.5-0.5B, both directions, 1 epoch (2,286 prompts, lr 5e-4, 570 optimizer steps), fold 0 only | shortlist top-1 l2f 0.211, f2l 0.208 (chance, below zero-shot 0.315) | **inconclusive**: one run, train loss plateaued at the uniform floor (1.76 -> 1.59, ln 5 = 1.61); a fine-tune ending below its zero-shot start points at the setup, and no overfit test (50 examples, 300 steps, loss -> 0) was run. Stopped after fold 0 (1,043 s); the co-tenant's job shares the GPU |
| `decode.py`: joint decoding with a pairwise label-order/date-order prior (swap local search), nested lam | 0.788 (no gain) | all pairs: lam>0 only hurts (0.02: 0.787, 0.2: 0.746); near-duplicate pairs only (char-gram cos > 0.5/0.7): flat. The order feature already carries it. |

**Best browser-runnable configuration so far (v4):** base+sim+fs+order+seg+kind, listwise linear
(154 weights) + Hungarian. Official scorer (`export.py v4` -> `score.py exhibits`):
1135/1427 = **0.795**. Size: potion-8m 31 MB + two hashed-word kind classifiers 2 x 2.2 MB
(fp32, 32k x 17). CPU per record (`timing.py`, single-core Python, loaded laptop): median
0.21 s, p90 0.61 s, max 2.8 s; the affidavit-side `refs.py` pass adds 0.003 s median (0.03 s max). Zero-shot 0.5B MC smoke showed strong letter-position bias
(argmax on A or C for 32/33 l2f prompts): `llm_mc.py --rot` now averages over cyclic rotations.

Official scorer on `oof_all_list` (`export.py` -> `score.py exhibits`): 1098/1427 = **0.769**
(same-text twins count). L2 sweep 1e-3..1e-1: 0.762-0.772 (flat; keep 1e-2). Row-only softmax 0.748.
Browser-runnable cost of this configuration: potion-8m 31 MB on disk; features per record
median 0.16 s, p90 0.49 s, max 3.7 s (Talebi, 103 files) in single-core Python on the loaded
laptop; the scorer is an 85-weight linear model + Hungarian.


Error read (25 sampled): nearly all residual errors are near-duplicate same-kind files that
differ by one field: date (licence renewal letters), number (Resolution 60/2024 vs 61/2024),
person (retainer agreements of Ivany vs Duval), ordinal ("Second Forbearance Agreement"),
direction ("my email to X" vs X's email to me), or "respectively" order.

## Findings so far
- Calibration of v4 (confidence = min of the pick's row and column softmax): at >= 0.5,
  55.5% of files are confident at 0.938 accuracy (rest 0.611); at >= 0.9, 31% at 0.984.
  A slow reader (LLM) only needs to see the other half, and the UI can say which picks to check.
- Old reference extraction missed 111/1,428 labels (7.8%): 4-letter labels (Talebi has 103
  exhibits), "Exhibit “ A”" with a space, lists and ranges, table rows. `refs.py` finds 98.9%;
  the gold paragraph is among its paragraphs for 91.5%.
- Label order vs gold document date: 77% of label pairs are in chronological order (a usable
  structural prior when a file's date can be read).

## Next
- Overfit test for `mc_ft.py` (50 examples, 300 steps; loss must go to ~0) before judging
  fine-tuned MC; then a fine-tuned reranker only on low-confidence picks.
- Residual errors are same-kind near-duplicates differing by one field (date, number, party,
  ordinal, direction): they need a joint two-text reader, not more cheap features.
- LLM reranking in the browser is WebGPU-only (CPU WASM is minutes per record); not measured on WebGPU.
- Recall@5 of the shortlist is 0.928: the ceiling of any top-5 reranker.
