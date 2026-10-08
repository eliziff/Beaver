# Journal footnote gold

Corpus-scale footnote scoring of the PDF parser against the Open Access Journals
Database's verified footnote pairing gold.

## Gold

The source is the locked verified goldset in the Open Access Journals Database
checkout (`Text-Fidelity-Project/tools/footnotes/output/goldset/target_1500_20260706_03`):
100 full articles, 1,073 verified pages, 3,370 reference/label pairs, every marker
visually placed on its printed glyph. All 100 PDFs are scanned law-journal articles.
Inputs and their SHA-256:

| File | SHA-256 |
| --- | --- |
| `goldset.sqlite` (article list, verification status) | recorded in `manifest.json` |
| `gold_article_verification_ledger.jsonl` | `a25e8d53f8a108f1c1e0bc0ffe99092edd28acbb23091ebead30aac2926e6ec6` |
| `gold_markers.locked.jsonl` (with the 2026-07-08 anchor corrections) | `239fe18400815ddae3aad1e50b270ee85b9d29b2511aed0e830889a51059c450` |
| `gold_pairs.locked.jsonl` | `ddeb0394211dc74799e5f1d1b84eee8ab5af167f700a82b93987045d6c7db436` |
| `gold_text_copies/gold_lines.markerized.jsonl` | `c2b7620d8378c227e3f369fabb69408e9e06fcc6632608772a363ec969a17fd9` |

The ledger and line hashes are the ones the canonical pairer parity receipt
(`legal-pdf-parser/docs/canonical-pairer-parity-2026-07-30.md`) was measured on.

## Store

`import_olj.py` reads that goldset read-only. Each article's PDF is stored once by
SHA-256 in the shared corpus (collection `journals`, kind `journal-article`) from the
database's `pdf_url`; publisher hosts that refuse automated downloads are supplied
from the database's durable copies (`--pdfs`, see the script). The PDFs are the
bytes the gold was made on: every URL download matched its durable copy. One gold
record per PDF is written to ignored
`benchmarks/local-data/olj-footnote-gold/gold/<sha256>/` (`gold.json`, `receipt.json`)
with `manifest.json` beside them, and the corpus gold catalog registers them as
dataset `olj-footnote-gold.v1` (`gold_records`, `gold_runs`, `gold_artifacts`).
Gold page numbers are physical PDF pages.

```powershell
python experiments/footnote-gold/import_olj.py --pdfs <directory of DATASET_ARTICLE.pdf>
```

## Score

```powershell
python experiments/footnote-gold/score.py [--addon <built addon>] [--save NAME] [--against <summary>] [--show]
```

Each PDF is parsed with the app's own PDF profile through
`experiments/legal-structure-gold/extract.mjs`, one document at a time. `--addon`
loads one built addon instead of the most recent build, so concurrent builds cannot
change the binary mid-run. Recognition is cached per OCR code and carried to the
next binary. Layers, micro-averaged:

- `notes`: note label value on the label's page;
- `references`: a reference to the note value on its page (the note it belongs to, so a misread marker glyph still counts);
- `positions`: references whose one of two preceding words matches the gold line;
- `pairs`: reference page and value with the label page and value.

Matched notes also report whether the body start agrees with the gold label line.
Summaries go to `benchmarks/local-data/olj-footnote-gold/score/`; `--against` prints
precision/recall deltas over the documents both runs scored and how many read the
same recognized lines.
