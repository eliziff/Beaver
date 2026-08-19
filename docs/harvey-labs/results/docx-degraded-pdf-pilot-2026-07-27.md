# DOCX-grounded degraded-PDF pilot — 2026-07-27

## Outcome

Six structurally diverse, upstream-only DOCX sources were selected from the
canonical 24-row private manifest, copied by hashed filename, exported to four
PDF profiles, and scored with the existing local DOCX-grounded benchmark.

- Sources: 6 unique SHA-256 values; no aliases or duplicate bytes.
- Cases: 24/24 completed (6 sources × 4 profiles).
- Pages: 125 per profile; 500 generated PDF pages total.
- Export failures: 0 benchmark cases.
- Parse crashes or missing results: 0.
- Model calls: 0 (`mode=local`; every result reports `codex.calls=0`).
- Exact edit-distance backend: `rapidfuzz/rapidfuzz`.
- Engine revision: `22db40ceebecc5d274da17f6d7206679eac14d59`.

All source copies, gold, PDFs, manifests, parser cache, and raw results are
under `legal-pdf-parser/_temp/docx_upstream_pilot`. This report
contains no source title or document text.

## Deterministic selection

The input manifest had 24 rows, 24 unique SHA-256 values, and zero
`source_aliases`. Selection was sequential, without replacement, in the order
below. Each maximization used the listed tuple followed by the full SHA-256 as
a deterministic lexical tie-breaker.

1. Footnote/link stress: maximize
   `(footnote_references + hyperlinks + external_relationships,
   footnote_references, hyperlinks)`.
2. Images/content controls: maximize
   `(media_parts + content_controls, media_parts, content_controls, drawings)`.
3. Comments/revisions: maximize
   `(comments_references + revision_elements, deleted_text_chars)`.
4. Table/template: maximize
   `(tables, abstract_numbering_definitions, styles)`.
5. Header/footer: maximize
   `(header_parts + footer_parts, footer_parts, header_parts)`.
6. Ordinary manuscript: require at least one footnote, at least 30,000 visible
   characters, and zero media parts, content controls, comment references,
   revision elements, tables, header parts, and footer parts; then maximize
   `(visible_text_chars, footnote_references)`.

| Stratum | Source SHA-256 | Decisive manifest features | Pages/profile |
| --- | --- | --- | ---: |
| Footnote/link stress | `313926923eab458ecb6e6d862044c8295dd54e02ca70bf7da91d89a625171c25` | 261 footnote refs; 46 hyperlinks; 36 external relationships | 34 |
| Images/content controls | `9222572d2a48d9e1a115d6fc305fe79ea4498f99de4a624700b86b594e15a43e` | 1 media part; 13 content controls; 1 drawing | 27 |
| Comments/revisions | `e0a0aea53715312f38238587da017c2b97bb49d2ab7a392e6e59236950b99223` | 25 comment refs; 2,181 revision elements; 4,946 deleted-text chars | 9 |
| Table/template | `f5968d5ae12966e3e79c025aa7616f3b2baddd754015c77a5e42a85f2e1f4bc3` | 8 tables; 22 abstract-numbering definitions; 92 styles | 18 |
| Header/footer | `91e3dbfa28d62a1e88029d460c0195a6cb27dbccc5d6d203548bf2fb0b5da7aa` | 3 header parts; 3 footer parts; 1 section-properties element | 24 |
| Ordinary manuscript | `576a04f6a1786bdb2a75cb65b69147b78cd65cd19b90ca7cfdc0f97338dcd6c4` | 39,930 visible chars; 71 footnote refs; all seven exclusion features zero | 13 |

The six copied files were re-hashed after staging and matched these full
manifest hashes.

## Export

The benchmark produced `native`, `print`, `flattened`, and `rasterized`
profiles for every source. Every export-manifest row records the actual
exporter as:

`LibreOffice 26.2.4.2 0229ac93fcf0d7cbc6376066c6f35021cef002dc`

| Profile | PDFs | Pages | Bytes | Construction |
| --- | ---: | ---: | ---: | --- |
| Native | 6 | 125 | 3,068,249 | Exporter-default PDF |
| Print | 6 | 125 | 1,724,685 | Tags, bookmarks, form fields, and notes disabled |
| Flattened | 6 | 125 | 1,420,826 | Print PDF re-emitted with PyMuPDF page forms |
| Rasterized | 6 | 125 | 38,941,705 | Print PDF rendered to 144-DPI page images |

Microsoft Word 16.0.20131.20154 was installed and detected, but COM startup
failed with HRESULT `0x80070520`: “A specified logon session does not exist.”
The benchmark's existing LibreOffice fallback then completed all 24 exports.
Thus the Word path failed, but no benchmark profile failed.

The existing `build-docx-corpus` command cannot consume the required staging
directory because it deliberately excludes every resolved path containing
`_temp`; the attempted call therefore created a zero-row manifest without
attempting any export. A 2.9 KB retained driver calls the benchmark's existing
`extract_docx_gold` and `export_docx_matrix` functions directly and asserts six
sources and all four profiles. No engine source was changed.

## Aggregate accuracy

CER and WER are micro-averages (summed edits divided by summed gold units).
Order values are macro-means over the six cases with non-null values, shown as
pairwise/adjacent/exact-position. Footnote precision, recall, and F1 are
micro-aggregated. Body and proposition similarities are weighted by matched
footnote count. Citation recall is micro-aggregated.

Each profile has 297,646 normalized gold characters, 46,197 gold words, 797
gold footnotes, and 440 gold citations.

| Profile | Result status | CER | WER | Order P/A/E | Footnote P/R/F1 | Body sim. | Sentence sim. | Passage sim. | Citation recall |
| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: |
| Native | 2 ready; 4 degraded | 0.1824 | 0.1938 | 0.9792 / 0.9669 / 0.0982 | 0.9919 / 0.6161 / 0.7601 | 0.8284 | 0.8263 | 0.8079 | 0.8432 |
| Print | 2 ready; 4 degraded | 0.1936 | 0.2117 | 0.9792 / 0.9669 / 0.0963 | 0.9919 / 0.6161 / 0.7601 | 0.8284 | 0.8196 | 0.8076 | 0.8432 |
| Flattened | 2 ready; 4 degraded | 0.1936 | 0.2117 | 0.9792 / 0.9669 / 0.0963 | 0.9919 / 0.6161 / 0.7601 | 0.8284 | 0.8196 | 0.8076 | 0.8432 |
| Rasterized | 6 `ocr_required` | 1.0000 | 1.0000 | — | 0 / 0 / 0 | — | — | — | 0 |

The searchable profiles each matched 491 of 797 gold footnotes and emitted
495 candidates; they recovered 371 of 440 gold citations. Print and flattened
were metrically identical, as expected when flattening preserves the print
profile's searchable page content.

## Latency and RSS

The parser cache directory was empty at run start. `wall_seconds` is the
benchmark's per-case interval through local parsing and gold loading; scoring
and result serialization occur afterward. Peak RSS is sampled around parsing
only.

| Profile | Cases | Case seconds total | Median | Maximum | Median peak RSS (MiB) | Maximum peak RSS (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native | 6 | 6.8672 | 1.1001 | 1.7915 | 320.6 | 328.7 |
| Print | 6 | 5.9038 | 0.9275 | 1.5715 | 319.6 | 330.4 |
| Flattened | 6 | 6.0039 | 1.0458 | 1.5518 | 318.3 | 330.4 |
| Rasterized | 6 | 9.3040 | 1.2705 | 2.9400 | 327.2 | 335.1 |

The complete export command took 88.4 seconds wall-clock. The complete local
runner command took 39.8 seconds wall-clock; summed benchmark case intervals
were 28.079 seconds.

`psutil` was not installed, so the benchmark used its built-in Windows
`K32GetProcessMemoryInfo` working-set sampler at 50 ms rather than treating
RSS as unavailable. These are process-wide sequential-run peaks, not isolated
per-case deltas; retained allocator/cache memory explains the rise after the
first case.

## Diagnostics and failures

- `corpus-errors.jsonl` is empty.
- All 24 expected case IDs have exactly one result.
- All 24 PDF hashes re-match the export manifest.
- All 24 results use `mode=local`, with null model and effort values.
- Native, print, and flattened each produced 10 warnings across four degraded
  cases: 4 `FOOTNOTE_UNMATCHED_LABEL`, 3
  `FOOTNOTE_REGION_UNCERTAIN`, and 3 `COLUMN_ORDER_UNCERTAIN`.
- Rasterized produced one `OCR_REQUIRED` warning for each of its 125 pages.
  All six documents returned the explicit `ocr_required` status. This is the
  intended no-OCR-provider boundary, not a parser crash.

## Exact material commands

Commands ran from the workspace root in Windows PowerShell 5.1.

```powershell
$pilot = 'legal-pdf-parser\_temp\docx_upstream_pilot'
$sources = Join-Path $pilot 'sources'
New-Item -ItemType Directory -Path $sources -Force | Out-Null
$files = @(
  'docx-313926923eab458e.docx',
  'docx-9222572d2a48d9e1.docx',
  'docx-e0a0aea53715312f.docx',
  'docx-f5968d5ae12966e3.docx',
  'docx-91e3dbfa28d62a1e.docx',
  'docx-576a04f6a1786bdb.docx'
)
foreach ($name in $files) {
  Copy-Item -LiteralPath (
    Join-Path 'benchmarks\docx_corpus\private_sources' $name
  ) -Destination (Join-Path $sources $name)
}
```

The incompatible corpus-builder attempt, retained here so the zero-row result
is reproducible:

```powershell
& 'legal-pdf-parser\.venv\Scripts\legalpdf-benchmark.exe' `
  build-docx-corpus `
  --input 'legal-pdf-parser\_temp\docx_upstream_pilot\sources' `
  --output 'legal-pdf-parser\_temp\docx_upstream_pilot\suite'
```

Actual gold/export build and local run:

```powershell
& 'legal-pdf-parser\.venv\Scripts\python.exe' -X utf8 `
  'legal-pdf-parser\_temp\docx_upstream_pilot\build_pilot.py'

& 'legal-pdf-parser\.venv\Scripts\legalpdf-benchmark.exe' run `
  'legal-pdf-parser\_temp\docx_upstream_pilot\suite\benchmark-manifest.jsonl' `
  --output 'legal-pdf-parser\_temp\docx_upstream_pilot\local-results.jsonl' `
  --mode local `
  --cache-dir 'legal-pdf-parser\_temp\docx_upstream_pilot\cache'
```

## Artifact integrity

| Artifact | SHA-256 |
| --- | --- |
| `_temp/docx_upstream_pilot/build_pilot.py` | `1f41e731e3399f63fc5cc0733102ab7fc574dba4b4ecf42916330e68d91570a9` |
| `_temp/docx_upstream_pilot/suite/benchmark-manifest.jsonl` | `c55cfa0913db8c4fa7a1a818ae63644d09800c36c726c92391b7d3f8c5bd0a77` |
| `_temp/docx_upstream_pilot/suite/corpus-errors.jsonl` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `_temp/docx_upstream_pilot/local-results.jsonl` | `c2ae88b1bae245247e3ffa327519f11da46889937e4c6660c0a94bb551356d84` |

## Limits

- This is a deterministic six-source stress pilot, not a random or
  population-representative estimate.
- The DOCX gold extractor scores text, order, footnotes, propositions, and
  citations. These gold files have no hand-labelled PDF regions, so region
  type/boundary metrics are absent.
- The actual exporter was LibreOffice, not Microsoft Word or a physical
  Windows print driver. Native-versus-print differences therefore measure the
  benchmark's LibreOffice settings on this machine.
- No OCR provider was supplied and no model calls were permitted, so the
  rasterized profile measures correct OCR-boundary detection rather than OCR
  quality.
- Latency is one cold-cache sequential run without repetition or machine
  isolation. RSS is process-wide and order-sensitive.
- Raw gold and results contain private document-derived text and remain under
  the ignored `_temp` tree; only hashes and aggregate counts are reported here.
