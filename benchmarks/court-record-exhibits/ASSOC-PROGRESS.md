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
| `xenc.py` overfit gate: ms-marco-MiniLM-L6-v2 cross-encoder, (mention text, file opening) pairs, listwise softmax over v4 top-5, 20 groups, 200 steps, lr 3e-5, bs 4 | probe loss 1.75 -> 0.035, top-1 0.95 (19/20; the miss is a tie between identical texts, ln2/20 = 0.035) | training works; 1.45 GB peak on the shared GPU, 31 s |
| `xenc.py` xr1: same cross-encoder, 5-fold (4 epochs, lr 3e-5, bs 4 mentions), row listwise over v4 top-5; `xcomb.py` blends v4 + lam x (row + col shortlist log-softmax), lam nested per fold | alone: row shortlist top-1 0.53-0.63 per fold vs v4 0.69-0.73. Low-confidence files (635/1,427): file->top-5 labels v4 0.378, CE 0.332, cap 0.868. End to end nested 0.793 all / 0.794 low-only (sweep peak lam 0.1: 0.800) | no gain: the plain fine-tuned MiniLM does not separate the near-duplicates better than the features; 135 s per fold on the shared GPU |
| xs1: xr1 + `--synth` (each training mention also gets a one-field copy of its gold file: a number, month, ordinal or name it shares with the mention swapped; 93% of mentions get one) | alone 0.50-0.61 per fold; low-conf file->top-5 CE 0.326 (v4 0.378); end to end nested 0.796 all / 0.793 low | no gain. Run-to-run noise: xf0 (xr1's exact recipe, fold 0 only) gave 0.536 vs xr1's 0.556, so +-0.02 per-fold differences between CE variants and int8 vs torch are noise. Training top-1 only ~0.47 after 4 epochs (loss 1.2): the model underfits the training folds, it is not overfitting them |
| xq1: `--resid` (pair logit = v4 score + CE output, so the CE is trained only on what v4 misses), 8 epochs, lr 5e-5; `xcomb.py xq1 --raw` | training top-1 (with v4) 0.86-0.93, loss 0.24-0.45: it fits. Held out: end to end nested 0.786 all / 0.790 low; lam 1 (the trained combination) 0.755 | fits the training folds and does not generalize: with 1,100 training mentions the pair reader memorises instead of learning field agreement. The CE line is closed for this data size |
| `xstruct.py`: what no pair reader can fix | of the 247 wrong low-confidence v4 picks, 51 have a gold mention inside a list group with no item of its own (every sibling letter gets the same affidavit text) and 15 have an identical-text twin file | ~27% of the residual errors are unreadable pairwise; only order priors or better list-item extraction can reach them, so the 0.868 low-confidence top-5 cap is not reachable by reading |
| `xonnx.py`: fold-0 xr1-recipe model (xf0, held-out top-1 0.536 vs v4 0.693) exported with torch.onnx (TorchScript path, eager attention), dynamic int8 | fp32 91.0 MB (max diff vs torch 0.0000), int8 **23.0 MB** (max diff 0.13 logits on random ids) | the exported graph takes **int32** inputs (traced from numpy's Windows-default int32; `xonnx.py` now casts to int64 for the next export). The reference must be computed before the export: the exporter leaves the module in training mode (dropout), which first looked like a 2-logit export error. CPU timing: `xtime.py` (below) |
| `xtime.py`: int8 cross-encoder CPU cost (Python onnxruntime 1.27 as the onnxruntime-node proxy, which is not installed; laptop loaded, IDLE priority via heavy.py; length-sorted batches of 16, 512-token pairs) | "low" pair set (low-confidence labels' top-5 files + files' top-5 labels): 4,791 pairs; per record median 2.2 s / 1.7 s, p90 8.2 s / 7.0 s, max 43 s / 35 s (Talebi) at 2 / 4 threads. All pairs (8,685): median 4.4 s / 3.5 s, max 64 s / 51 s. Fold-0 held-out top-1 int8 0.513 vs torch (bf16) 0.536 | ~90 ms per pair at 2 threads: affordable for the flagged half, but the model adds no accuracy, so not shipped |

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
