# Stream 1: affidavit to record association (progress log)

Task: label each stripped exhibit file with its exhibit letter, from the affidavit
alone, with something that runs in a browser. Chronology is a separate stream.

Working files (experiments, not yet in the benchmark folder):
`%TEMP%\claude\C--Users-elias-Desktop-MikeOSS-Fork\1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c\scratchpad\assoc\`
- `common.py`: data, grouped 5-fold split (records of one family / court file share a fold,
  balanced by file count), one-to-one Hungarian scoring.
- `inputs.json`: `exhibit_inputs.py` output for all 120 records with data (1,428 files).
- `cache_base.py` -> `feats_base.npz`: fastmatch's 19 cheap pair signals (potion-8m for m2v).
- `refs.py` -> `inputs2.json`: new affidavit-side extractor (label lists, ranges,
  "respectively" items, tables, OCR 0/O, 4-letter labels, previous paragraph, definitions).
- `models.py <sets> --model point|list|mlp`: scorers under grouped 5-fold.

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

## Findings so far
- Old reference extraction missed 111/1,428 labels (7.8%): 4-letter labels (Talebi has 103
  exhibits), "Exhibit “ A”" with a space, lists and ranges, table rows. `refs.py` finds 98.9%;
  the gold paragraph is among its paragraphs for 91.5%.
- Label order vs gold document date: 77% of label pairs are in chronological order (a usable
  structural prior when a file's date can be read).

## Next
- Features from `inputs2.json` (better references + previous paragraph), field-level
  (Fellegi-Sunter style) agreement features, label-order prior.
- Neural scorers on the desktop GPU (listwise cross-encoder), small LLM multiple choice.
