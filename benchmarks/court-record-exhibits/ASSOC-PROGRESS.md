# Stream 1: affidavit to record association (progress log)

Task: label each stripped exhibit file with its exhibit letter, from the affidavit
alone, with something that runs in a browser. Chronology is a separate stream.

Scripts: copied (untracked, not committed) to `benchmarks/court-record-exhibits/assoc/` on
2026-09-24 since v4 beat the README baseline; the scratchpad copy below also holds the caches.
To rebuild there: `exhibit_inputs.py` output -> `assoc/inputs.json`, then `refs.py`, `cache_base.py`,
`feats2.py`, `feats3.py`, `kinds.py`, `feats6.py`, `models.py base,sim,fs,order,seg,kind,dir --save v6`,
`export.py v6` (v6 = the recommended composition; drop `feats6.py`/`dir` for v5). `refs.py` writes
`ctx.item` as "own item | the sentence with the sibling items cut out" and `ctx.sib` (the sibling
items' literal text), which `feats2.drop_sibs` removes from the shared context views. `cache_base.py`, `feats5.py` and `timing.py` still point `POTION` at the
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
| `xenc.py` overfit gate: ms-marco-MiniLM-L6-v2 cross-encoder, (mention text, file opening) pairs, listwise softmax over v4 top-5, 20 groups, 200 steps, lr 3e-5, bs 4 | probe loss 1.75 -> 0.035, top-1 0.95 (19/20; the miss is a tie between identical texts, ln2/20 = 0.035) | training works; 1.45 GB peak on the shared GPU, 31 s |
| `xenc.py` xr1: same cross-encoder, 5-fold (4 epochs, lr 3e-5, bs 4 mentions), row listwise over v4 top-5; `xcomb.py` blends v4 + lam x (row + col shortlist log-softmax), lam nested per fold | alone: row shortlist top-1 0.53-0.63 per fold vs v4 0.69-0.73. Low-confidence files (635/1,427): file->top-5 labels v4 0.378, CE 0.332, cap 0.868. End to end nested 0.793 all / 0.794 low-only (sweep peak lam 0.1: 0.800) | no gain: the plain fine-tuned MiniLM does not separate the near-duplicates better than the features; 135 s per fold on the shared GPU |
| xs1: xr1 + `--synth` (each training mention also gets a one-field copy of its gold file: a number, month, ordinal or name it shares with the mention swapped; 93% of mentions get one) | alone 0.50-0.61 per fold; low-conf file->top-5 CE 0.326 (v4 0.378); end to end nested 0.796 all / 0.793 low | no gain. Run-to-run noise: xf0 (xr1's exact recipe, fold 0 only) gave 0.536 vs xr1's 0.556, so +-0.02 per-fold differences between CE variants and int8 vs torch are noise. Training top-1 only ~0.47 after 4 epochs (loss 1.2): the model underfits the training folds, it is not overfitting them |
| xq1: `--resid` (pair logit = v4 score + CE output, so the CE is trained only on what v4 misses), 8 epochs, lr 5e-5; `xcomb.py xq1 --raw` | training top-1 (with v4) 0.86-0.93, loss 0.24-0.45: it fits. Held out: end to end nested 0.786 all / 0.790 low; lam 1 (the trained combination) 0.755 | fits the training folds and does not generalize: with 1,100 training mentions the pair reader memorises instead of learning field agreement. The CE line is closed for this data size |
| `xstruct.py`: what no pair reader can fix | of the 247 wrong low-confidence v4 picks, 51 have a gold mention inside a list group with no item of its own (every sibling letter gets the same affidavit text) and 15 have an identical-text twin file | ~27% of the residual errors are unreadable pairwise; only order priors or better list-item extraction can reach them, so the 0.868 low-confidence top-5 cap is not reachable by reading |
| `xonnx.py`: fold-0 xr1-recipe model (xf0, held-out top-1 0.536 vs v4 0.693) exported with torch.onnx (TorchScript path, eager attention), dynamic int8 | fp32 91.0 MB (max diff vs torch 0.0000), int8 **23.0 MB** (max diff 0.13 logits on random ids) | the exported graph takes **int32** inputs (traced from numpy's Windows-default int32; `xonnx.py` now casts to int64 for the next export). The reference must be computed before the export: the exporter leaves the module in training mode (dropout), which first looked like a 2-logit export error. CPU timing: `xtime.py` (below) |
| `xtime.py`: int8 cross-encoder CPU cost (Python onnxruntime 1.27 as the onnxruntime-node proxy, which is not installed; laptop loaded, IDLE priority via heavy.py; length-sorted batches of 16, 512-token pairs) | "low" pair set (low-confidence labels' top-5 files + files' top-5 labels): 4,791 pairs; per record median 2.2 s / 1.7 s, p90 8.2 s / 7.0 s, max 43 s / 35 s (Talebi) at 2 / 4 threads. All pairs (8,685): median 4.4 s / 3.5 s, max 64 s / 51 s. Fold-0 held-out top-1 int8 0.513 vs torch (bf16) 0.536 | ~90 ms per pair at 2 threads: affordable for the flagged half, but the model adds no accuracy, so not shipped |

| **v5** `refs.py` list items (2026-09-24): each label of a list mention gets its own reference text = its item + the sentence with the sibling items cut out (`ctx.item`, `ctx.sib`). Items come from, in order: enumerators "(1) ... (2)", a date list ("dated April 15, April 17 and April 21, 2020") or number list ("Resolutions Nos. 88/2024, 89/2024, and 90/2024", "Directives #3 and #5") of exactly n values, then separators from ";" to ", and"/"as well as" to "," to " and" (modifier pieces "dated ...", "from ..." join the piece before), on the object side (after "are copies of") or the subject side ("Copies of X and Y are attached"). A table row is its label's item; a single label sharing a sentence with other mentions owns its clause ("A copy of X is attached as Exhibit G, and a copy of Y ... Exhibit H"); a label used as a heading ('(a) Exhibit "A": a loan agreement ...') owns the text after it and wins over a range header ("Exhibits A to T"). Fixes on the way: unquoted lower-case words were read as labels ("Exhibit G, and a copy" gave A a mention; "exhibits:" gave S), page breaks with their printed page number ("-8-") split sentences, "Drs." and "(e)" sentence bounds, "Exhibit 12 Exhibit 13" lists. `feats2.py`: an item's own dates replace the sentence's (siblings' dates, ids, amounts dropped from the context views); duplicate dates kept for the k-th-date feature | **0.817** (official **1172/1427 = 0.821**, v4 1135) | labels with an item 55 -> 278 (117 of 139 list labels). Of the 51 wrong low-confidence picks whose gold sat in an itemless list: 41 now have an item of their own, 30 of those items point at the right file among the siblings' files (TF-IDF), **27 are now assigned correctly**. The 10 still itemless are truly so ("the Retainer Agreements", "the Commitment Letters", "those email threads", "Copies of the orders", a footnote-split list). Churn: +86 / -54 files vs v4, most losses in records whose inputs did not change (linear model reweighting). Ablations: item text without the shared sentence 0.813; no heading-over-range switch 0.816; sibling items also cut from the segment views 0.811. refs.py per record: median 0.004 s, max 0.04 s |
| **v6** = v5 + `feats6.py` dir: the affiant's name (`affiant.py`: "I, NAME,", "AFFIDAVIT OF NAME", jurat signature; shares a token with the gold deponent in 141/149 records, surname found in 115/120 of the scored ones) resolves "my email", "I wrote", "from me" (affiant sends) and "to me", "I received", "X wrote to me", "a letter to <surname>" (affiant receives) in the label's own text and in the 400 characters before the mention; file side: surname in the first From: line (or the sign-off when there is none) vs the To:/Cc: lines and salutation; 14 features incl. agree/conflict | **0.819** (official **1174/1427 = 0.823**, +2 files over v5; +3/-1) | mention side is precise (send: gold author is the affiant in 33/37; receive: gold recipient in 16/22) but the scope is tiny: only **4 of v5's 261 wrong files** confuse two exhibits of opposite affiant direction (by gold author/recipient), and none of the 4 is a letter pair the feature can see (approval letter vs exemption request, a chart vs a criminal record, an inspection report vs an email). Kept: cheap (regexes), weights in the expected directions (agree +0.11) |
| `refs.py --look-back`: an itemless list takes its items from the 600 characters before it (an "a) ... b)" enumeration, a date or number list, or a comma/and list of names, of exactly n) | 0.819 (official 1173, -1 vs v6) | gives items to 8 labels (Retainer Agreements -> "June 30, 2007"/"March 20, 2008", "both orders" -> April 2/April 3, "those articles" -> the a)/b) items) but flips none of their files; off by default |
| `mc_peft.py` overfit gate (Qwen2.5-0.5B-Instruct, peft LoRA r16 alpha 32 on all projections, fp32 adapters, lr 1e-4, batch 1, 50 f2l prompts from fold 0's training records, v6 top-5) | start loss 1.620 top-1 0.26 -> step 300 probe loss **0.000**, top-1 **1.00** (step 250: 0.044 / 0.98) | the setup learns: 8.8M trainable params, 2.0 GB peak, 180 s. ft05's collapse to ln 5 was the hand-made LoRA (bf16 adapters, lr 5e-4, scale 2), not the framing |
| `mc_peft.py` ftp fold 0: same recipe, 2 epochs over 1,143 f2l training prompts (571 steps, batch 4), held-out f2l over the v6 top-5 in label order | held-out shortlist top-1 0.641 (v6 argmax 0.676 on the same 287 files). **Low-confidence files (130 in fold 0): v6 0.408, LLM 0.408, cap 0.885** (the LLM agrees with v6's top pick on 65%). Blend v6 + lam x LLM f2l log-softmax, fold 0 only: lam 0 0.728, 0.1 0.742, 0.2 0.732, >= 0.35 lower (not nested yet) | training loss 1.49 -> 0.68 (top-1 0.37 -> 0.75): it learns and does not collapse; 1,193 s on the 3080 Ti, 1.5 GB. Folds 1-4 running |
| ftp folds 0+1 (574 files; fold 1 held-out shortlist top-1 0.699) | **low-confidence files (242): v6 0.417, LLM 0.471, cap 0.909**. End to end (`xcomb.py ftp --base v6 --folds 0,1`), v6 alone 0.798 on these folds: nested all-pairs 0.810, low-only 0.808 (sweep peak 0.815 at lam 0.1/0.5); after the low blend 28.9% flagged (v6 ~45% on these folds) | first sign of a real LLM gain (+0.012 nested, ~7 files of 574). The first folds 1-4 run died silently after fold 1 (ssh session end); folds 2-4 relaunched as `ftp24.log` |

**v6 cost** (`timing.py`, now incl. the `refs.py` pass and `feats6.py`; single-core Python, loaded laptop):
per record median 0.22 s, p90 0.58 s, max 2.9 s; size unchanged (potion-8m 31 MB + 2 x 2.2 MB kind
classifiers + 168 linear weights). v6 calibration: 547/1427 files below the 0.5 confidence gate
(v4: 635); their file -> top-5 labels top-1 0.377, cap 0.881 (v4 0.378 / 0.868).
Step 3 (LLM fine-tune) is `mc_peft.py` (peft LoraConfig r16 alpha 32 on all projections, fp32
adapters, lr 1e-4, batch 4, f2l listwise over the v6 top-5, `--overfit 50 --steps 300` gate) run on
the desktop through `run_peft.cmd`; waiting for the GPU (`gen6`).

**Best browser-runnable configuration (v6, 2026-09-24):** v5's list-item references + base+sim+fs+order+seg+kind+dir,
listwise linear (168 weights) + Hungarian: official 1174/1427 = **0.823**; potion-8m 31 MB + 2 x 2.2 MB kind
classifiers; per record median 0.22 s, p90 0.58 s, max 2.9 s (single-core Python incl. the `refs.py` pass);
547/1427 files (38%) fall below the 0.5 confidence flag.

Previous best (v4): base+sim+fs+order+seg+kind, listwise linear
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
- Shipping composition: v6 + Hungarian + the >= 0.5 confidence flag. Under v6, of the 220 wrong
  low-confidence picks only 12 still have an itemless list-group gold mention and 12 an identical-text
  twin file (`BASE=v6 python xstruct.py`); the rest are readable near-duplicates.
- Items still missing: truly itemless lists ("the Retainer Agreements" of two named clients, "Copies of
  the orders" after two sentences each naming one O. Reg.): a look-back to the preceding sentences'
  n distinct values would reach a few; footnotes that split a sentence (Talebi UUUU-YYYY).
- (Superseded 2026-09-24 by v5/v6, kept for history:)
- Pair-reading cross-encoder (2026-09-24, `xenc.py`/`xcomb.py`/`xonnx.py`/`xtime.py`): trains (overfit gate
  passed; residual mode reaches 0.92 training top-1) but does not generalise from 1,100 training mentions:
  every blend is within noise of v4 (0.786-0.796 vs 0.793 on the common scorer). Not recommended.
  Shipping composition stays v4 + Hungarian + the >= 0.5 confidence flag (44.5% of files flagged).
- ~27% of the wrong low-confidence picks are unreadable pairwise (list-group siblings with no item of
  their own, identical-text twin files): they need better list-item extraction in `refs.py`, not a reader.
- "my email to X" vs "X's email to me" needs the affiant's name (from `ctx.before`, "I am ...") given to
  whatever reads the pair; not built.
- LLM multiple choice fine-tune (step 3) is gated on the desktop GPU (`gen6`, 11 GB, logged a recovered
  OOM warning at 05:48 while xq1 shared the card). Recipe when it frees: `peft.LoraConfig`, lr 1e-4
  (ft05's hand-rolled LoRA at lr 5e-4 / scale 2 collapsed to the uniform ln 5 floor), and an
  `--overfit 50 --steps 300` gate in `mc_ft.py` before any fold run.
- LLM reranking in the browser is WebGPU-only (CPU WASM is minutes per record); not measured on WebGPU.
- Recall@5 of the shortlist is 0.928: the ceiling of any top-5 reranker.

## Evaluation on the doubled benchmark (2026-09-24)

v6 as shipped (no script changes), rebuilt over all **243 records with data, 2,687 files** (120 old records,
1,427 files; 123 new, 1,260 files). Steps, all in the scratchpad `assoc/`: `exhibit_inputs.py` -> `inputs.json`
(243), `folds.json` regenerated from `common.folds` (grouped by family / court file, 536-539 files per fold;
`kinds.py` reads it), `refs.py`, `cache_base.py`, `feats2.py`, `feats3.py`, `feats6.py`, `kinds.py`,
`models.py base,sim,fs,order,seg,kind,dir --save v6_243`, `export.py v6_243`, `score.py exhibits`. The caches have
no per-record extend mode, so every one was recomputed (about 3 minutes in all). Evaluation helpers
(scratchpad only): `old120.json` (the old record ids), `gen.py` (train-old/test-new, below), `report243.py`
(tables from score.py's per-record lines, so twins count as in the official score), `timing_new.py`.

**Overall, grouped 5-fold by record: 2227/2687 = 0.829** (official; `common.accuracy` 0.825, label top-1 0.737).

**Train on the old 120, test on the new 123:** the kind classifiers (the only supervised feature) get their own
cache `feats_kindgen`: old records out of fold within the old records' own grouped folds, new records from
classifiers trained on all old records; the listwise model is fitted on the old records only.

| split | records | files | 5-fold (243) | train-old/test-new | 5-fold within old 120 only |
|---|---|---|---|---|---|
| old 120 | 120 | 1,427 | 1198/1427 = 0.840 | - | 1193/1427 = 0.836 |
| new | 123 | 1,260 | 1029/1260 = 0.817 | **1032/1260 = 0.819** | - |
| new, group shared with an old record | 22 | 212 | 188/212 = 0.887 | 184/212 = 0.868 | - |
| new, unseen proceeding | 101 | 1,048 | 841/1048 = 0.802 | 848/1048 = 0.809 | - |

The new half scores what the 5-fold gives it (0.819 vs 0.817): doubling the training data does not move the
168-weight linear model, and the true generalization number sits 0.02 below the old records. 22 new records share
a family / court file with an old record (sibling affidavits); on the 101 in unseen proceedings the test-new number
is 0.809. The old-120 number re-run on today's inputs (0.836) is above the 0.823 logged for v6: 139 exhibit texts in
23 old records were OCR'd after the 2026-09-23 `inputs.json` (e.g. onsc-trinity-hodge 10/18 -> 18/18,
onca-roe-caldwell 2/4 -> 4/4), and the refit reweights the rest (+/- a few files per record).

By area of law, court level and jurisdiction (values with < 40 files pooled as "other"):

| subject | records old/new | files old/new | 5-fold, all | 5-fold, new only | train-old/test-new |
|---|---|---|---|---|---|
| insolvency | 63/25 | 742/244 | 0.837 | 0.852 | 0.824 |
| charter | 29/8 | 397/38 | 0.857 | 0.895 | 0.947 |
| class_action | 16/18 | 153/151 | 0.845 | 0.874 | 0.874 |
| other (9 subjects: tax, planning, real property, pensions, ...) | 0/17 | 0/166 | 0.747 | 0.747 | 0.783 |
| administrative | 5/7 | 44/93 | 0.854 | 0.839 | 0.817 |
| indigenous_rights | 1/11 | 9/111 | 0.692 | 0.685 | 0.721 |
| environmental | 0/6 | 0/108 | 0.889 | 0.889 | 0.917 |
| human_rights | 5/3 | 75/31 | 0.943 | 1.000 | 0.935 |
| municipal | 0/9 | 0/102 | 0.706 | 0.706 | 0.706 |
| regulatory | 0/7 | 0/92 | 0.870 | 0.870 | 0.891 |
| securities | 0/6 | 0/66 | 0.848 | 0.848 | 0.848 |
| employment | 1/6 | 7/58 | 0.677 | 0.724 | 0.672 |

| court_level | records old/new | files old/new | 5-fold, all | 5-fold, new only | train-old/test-new |
|---|---|---|---|---|---|
| superior_trial | 93/66 | 1,114/650 | 0.822 | 0.800 | 0.806 |
| administrative_tribunal | 5/34 | 75/336 | 0.830 | 0.810 | 0.792 |
| federal_trial | 14/18 | 178/211 | 0.859 | 0.882 | 0.905 |
| superior_divisional | 2/2 | 12/48 | 0.817 | 0.812 | 0.812 |
| appellate | 4/3 | 40/15 | 0.818 | 0.800 | 0.800 |
| apex_appellate | 2/0 | 8/0 | 1.000 | - | - |

| jurisdiction | records old/new | files old/new | 5-fold, all | 5-fold, new only | train-old/test-new |
|---|---|---|---|---|---|
| ON | 40/51 | 482/528 | 0.837 | 0.820 | 0.814 |
| federal | 22/37 | 264/363 | 0.837 | 0.818 | 0.824 |
| AB | 20/4 | 252/89 | 0.824 | 0.843 | 0.865 |
| BC | 15/6 | 156/71 | 0.762 | 0.746 | 0.789 |
| MB | 7/7 | 98/97 | 0.862 | 0.825 | 0.773 |
| NS | 7/7 | 48/65 | 0.850 | 0.815 | 0.846 |
| SK | 4/3 | 58/13 | 0.775 | 0.615 | 0.615 |
| NL | 2/5 | 41/20 | 0.820 | 1.000 | 1.000 |
| other (NB, PE) | 3/3 | 28/14 | 0.810 | 0.714 | 0.857 |

Areas with no old record at all (environmental, regulatory, securities: 0.85-0.92 train-old/test-new) score like
the trained-on areas, so the method carries across areas of law. The weak areas trace to a few records and to
the energy-regulator (CER/NEB) written-evidence format rather than to subject: municipal (0.706; 30 wrong) is 20
wrong in neb-vmep-graziosi 1/10, ondc-wpd-mcfarlane 1/7 and bcsc-oppenheimer-chow 2/7; indigenous_rights (0.692;
37 wrong) is 12 in cer-poucecoupe-general 2/14, 10 in abkb-odl-palandjian 22/32, 5 in cer-northriver-general 3/8,
4 in neb-tmx-planes 8/12; real property is one record, onsc-9448-lasry (9/30).

**Confidence gate** (5-fold scores; min of row and column softmax at the Hungarian pick, twin-aware correctness):

| part | files >= 0.5 | their accuracy | files < 0.5 | their accuracy |
|---|---|---|---|---|
| all 243 | 1,678/2,687 (62.4%) | 0.948 | 1,009 (37.6%) | 0.631 |
| old 120 | 887/1,427 (62.2%) | 0.957 | 540 (37.8%) | 0.646 |
| new 123 | 791/1,260 (62.8%) | 0.937 | 469 (37.2%) | 0.614 |

The gate holds its calibration on new records (the same 37% flagged, confident picks still ~94% right).

**Cost on the new records** (`timing_new.py` = `timing.py` restricted to them; single-core Python, loaded laptop,
IDLE priority): per record median 0.22 s, mean 0.32 s, p90 0.61 s, max 1.9 s (bccomm-cullen-wenezenkiyolland,
37 files); unchanged from the old records.

**What the pipeline could not read.** Every record under the data root ran end to end; none failed. The 8 ct-*
records (ct-8x-fraser, ct-ccc-robles, ct-cippic-kleinbrodt, ct-jamp-juneja, ct-jamp-seaby, ct-rave-gamble,
ct-rave-pazaratz, ct-whitecap-wicks) exist only as JSON in the repo's `records/` (gold, source, split, matter docs;
no affidavit or files) and are not under the data root, so `exhibit_inputs.py` never sees them. But `refs.py` finds no affidavit
mention for 55 of 2,687 labels (26 records), concentrated in label formats its mention pattern does not know:
onsc-9448-lasry's O1-O7 (13 labels unmentioned; the affidavit is also a noisy OCR scan with a missing paragraph
start), neb-vmep-graziosi's dotted numbers 8.1, 8.2.A-8.2.D, 15.1 (10 of 10 unmentioned), and cer-poucecoupe-general,
whose written evidence cites its exhibits as a list of references rather than "Exhibit X" (3 unmentioned; A-N).
`affiant.py` finds no affiant name in 11 records (abqb-bdc-singh2018, bcca-bctf-tinney, bccomm-cullen-bamra,
bcsc-1281805-mann, cer-poucecoupe-general, neb-vaughan-sioui, nssc-bluelobster-dunning, nssc-chesterbasin-santimaw,
onsc-clc-pps-policy, onsc-clc-pps-research, onsc-uoft-encampment-delorenzi), so the direction feature is off there.
28 exhibit texts are near-empty (image-only, under 50 characters: 24 old, 4 new).

Next, from this read: dotted and letter-digit labels ("8.2.A", "O1") in the mention pattern, and the tribunal
"written evidence" citation style, are the extraction gaps the new records exposed.
