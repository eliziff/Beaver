# Court record exhibits benchmark

Real Canadian affidavits taken apart into what a litigator starts with: the
affidavit, plus a pile of unlabelled files. The gold record says which file is
which exhibit, what the affidavit says each one is, and which dated events the
affidavit narrates and supports with which exhibit.

One record serves two tools:

- **Court Records builder** (`score.py exhibits`): given `affidavit.pdf` and
  `files/`, label each file with its exhibit letter.
- **Chronology / Event Strip** (`score.py chronology`): from `files/` alone,
  or with the affidavit (`--with-affidavit`), produce dated events that cite
  their files.

## Layout

PDFs live outside git in
`%LOCALAPPDATA%\OpenLegalData\benchmarks\court-record-exhibits\`:
`raw/` holds downloaded sources and `records/<id>/` holds `affidavit.pdf|txt`,
`files/doc-*.pdf|txt`, `split.json`, `source.json` and `gold.json`. This
directory keeps the scripts and a copy of each record's three JSON files under
`records/<id>/`. `split.py` is deterministic per record id, so
`source.json` (url, sha256, page range) rebuilds the PDFs exactly.

## Recipe

1. **Find a sworn affidavit with at least three exhibits** whose exhibit
   identifications are text ("This is Exhibit "B" referred to in the affidavit
   of … sworn before me …" or "Ceci est la pièce …"). Standalone affidavits and
   affidavits inside motion, application or appeal records all qualify. Record
   the court, level and province, and vary them across records.
2. **Split:** `python split.py <pdf> <id> [--pages a-b] --meta meta.json`.
   For a motion record, use `--pages` for the one affidavit and its exhibits
   (from the record's index). `meta.json` holds `url`, `landing_url`, `court`,
   `court_level`, `jurisdiction`, `court_file`, `document_title` and
   `retrieved`. Check the printout: exhibit letters must run in order with no
   gaps the affidavit doesn't explain. `leak_audit` must be empty; waive only a
   real mention of the exhibit inside its own content, such as a letter that
   says "see Exhibit B".
3. **Look at the stripped files.** For each file, read its `.txt` or render
   page 1 to PNG when the text layer is empty. Confirm that no cover or stamp
   remains and that the content is what the affidavit says it is.
4. **Write `gold.json`** in the shape of
   `records/proto-hiscox/gold.json`:
   - `exhibits[]`: label, file, `kind` (vocabulary in `verify.py`), date,
     author and recipients where apparent, a one-sentence `description` of
     what the affidavit says it is, `references[]` (paragraph number plus an
     exact quote from `affidavit.txt` containing the reference) and a
     `content_check` saying what you saw in the file.
   - `events[]`: every happening the affidavit narrates, dated or not, each
     with a short description, `date` (ISO; `YYYY-MM` or `YYYY` when coarser),
     `precision` (day/month/year/range/approximate/undated), the affidavit
     paragraphs, an exact quote, and `exhibits` naming the labels that
     evidence it. Documents mentioned but not attached go in
     `referenced_not_attached`.
5. **Validate:** `python verify.py <record dir>` must print `ok`.

Quotes are matched after folding quotes, dashes, whitespace and case, so copy
them from `affidavit.txt` as they appear there.

## Verification (2026-09-22)

31 records: 320 exhibits over 4,391 exhibit pages, and 549 events, from
11 courts and tribunals in ON, AB, BC, MB, SK and NS, plus federal ones:
the Federal Court, the Federal Court of Appeal, the Supreme Court of Canada
and the Canadian Human Rights Tribunal. `verify.py --all` passes on every
record.

`audit.py` checks the gold against the original PDFs: each cover page names
its exhibit, the affidavit's exhibit mentions are accounted for, dated
paragraphs are cited by events, exhibit dates appear in their files, and no
jurat text survives stripping. Its 46 leads were adjudicated by an
independent reviewer. 43 were false alarms (OCR artifacts, image-only
files, background paragraphs), 2 were documents deliberately dated
differently from the affidavit's description, and 1 was a missing event,
now added.

- **Blind relabelling:** the same reviewer relabelled 9 records' 67 files
  with only the affidavit and the unlabelled files, and matched the gold on
  67/67.
- **Event read:** a full event read of 4 more records found one wrong
  exhibit link (fixed).
- **Error estimate:** about 1-2% in `events[]`; no exhibit
  identification errors were found.

## Harder variant: a file system with distractors (`haystack.py`)

`python haystack.py <id> [--synthetic synthetic/<id>.json]` builds
`haystack/<id>/files/` and `manifest.json`. The files are the record's stripped
exhibits mixed with:
- real same-matter documents that are not exhibits (`matter_docs.json`);
- exhibits of other records;
- unrelated legal PDFs from the 1,500-file corpus;
- synthetic DMS documents: emails (.eml or PDF), letters, memos, minutes,
  invoices and texts among the same people and companies, in the same
  period, about irrelevant business, including deliberate near misses.

File names give nothing away. Provenance for every file, including each
synthetic document's generator, spec and reason it is irrelevant, lives only
in the manifest. `score.py haystack-exhibits` scores picking each exhibit
from the whole folder. `score.py haystack-chronology` counts rows that cite
only distractors as false positives; rows citing same-matter documents are
neutral.

## Browser-runtime baselines (2026-09-23, 31 records)

| Method | Exhibit id, one-to-one | Time per record |
|---|---|---|
| Random | 0.097 | - |
| TF-IDF only (`baseline.py`) | 0.541 | ms |
| Learned scorer over cheap signals (`fastmatch.py`, leave-one-record-out) | 0.672 | ~0.1-0.2 s (Python) |
| + small embedder (bge-small / arctic-xs / mxbai-xs) | 0.650-0.681 | +0.7-1.9 s native |
| + MiniLM ms-marco on top 3 | 0.672 | +0.7 s native |
| MiniLM cross-encoder fine-tuned for this task (`train_xenc.py`, 2 of 4 folds, 16 records) | 0.603 (cheap signals on the same 16: 0.730) | ~25 ms per pair native |
| Laya (8.5 s per question) | not run at scale | ~4 min for 7 exhibits |
| Frontier LLM reading everything (blind, 9 records) | 1.000 | minutes |

No label leaks: the leak probe finds no file naming its own exhibit label.
About 7.5% of files are image-only and need OCR.

| Chronology, files only | Precision | Recall | Time per record |
|---|---|---|---|
| Event Strip on Laya (7 held-out) | 0.03 | 0.71 | 0.5-58 min |
| One dated entry per document (`chrono_fast.py`, 7 held-out) | 0.79 | 0.71 | 0.1 s |
| Same, all 31 records | 0.51 | 0.55 | 0.2 s |
| Same, Hiscox haystack (29 files, 22 distractors) | 0.23 | 0.63 | 0.1 s |
