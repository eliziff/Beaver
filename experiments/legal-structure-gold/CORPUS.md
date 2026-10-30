# Structural gold source collections

## Canadian contract additions

`python experiments/legal-structure-gold/contracts.py --target 100 --sources 30 --parallel 2`
finds complete 1–120 page agreements within existing public Canadian legal records in
the canonical corpus. It uses the shared runner to propose physical page ranges and
review opening, ending and neighbouring page images. Short agreements are shown in
full. The instrument itself must have a printed Canadian connection. Review scope
decisions before treating the model's proposals as a completed collection.

The private `contracts/manifest.json` under the gold data directory records source
URLs, parent hashes, physical page ranges, agreement identities, review receipts and
exclusions. Resume the command to inspect more sources; `--recheck` updates boundary
decisions made under an older review policy. Excerpts retain whole original pages,
and materialization checks every page's text and rendered pixels against the parent.
The canonical corpus stores each excerpt once and records its parent membership.

Run `python experiments/legal-structure-gold/author.py --manifest benchmarks/local-data/legal-structure-gold/contracts/manifest.json --limit 0`
with the recorded parser binary to author gold through the existing image-based
runner. Completed source hashes are reused. A source's partition is its `source.json` in
the gold store (`experiments/legal_pdf_corpus/gold_store.py`), decided before authoring;
these additions do not establish human-reviewed gold or parser accuracy scores.

Retain valid agreements whose gold runs reject unusable extraction. A scan with a
damaged embedded text layer can still be exported as native text, leaving too few
characters to anchor the image-based transcription. Preserve that failed receipt
and answer for extraction investigation; repeating the same extraction does not
resolve `UnusableExtraction`.

When native extraction cannot anchor the printed text, the author also accepts
`--extraction <witness.json.gz>` with `--pdf`, or `extraction_witness` per manifest
row. A `legal-structure-gold.extraction.v1` witness records the original PDF SHA,
every physical page in order, unique extracted line IDs and text, and the actual
OCR method and asset identity. Generate it from the original page images before
authoring; model answers must never supply the extraction witness. Use `ocr` mode
for OCR-based matching. Source/page binding and the existing alignment threshold
still apply. Gold records the witness hash and method with no claimed parser
binary identity. Retain the original failed receipt and validate the witness hash,
source binding, line text, typed spans and scorer ingestion when auditing repairs.

`--revisit` inspects productive parent filings again for additional agreements,
including larger instruments. Preserve the original cohort membership before
extending a selection. If an excerpt changes native text or page pixels, retain
the original filing and record the rejected range in `materialization_failures`;
it does not count toward the target.

## Canadian questioning transcripts

`python experiments/legal-structure-gold/questioning.py --target 100 --sources 100`
reviews the private `questioning/local-candidates.json` source list under the gold
data directory. Start with local corpus text and saved related-matter metadata.
Require actual verbatim discovery or affidavit questioning; exclude trials and
public-inquiry testimony. Prefer complete sessions or identified filed volumes.
Genuine court-filed excerpts may be retained with `transcript_extent=filed_excerpt`,
without inventing new cuts or counting overlapping excerpts as new examinations.
Separately filed continuations of the same examination count once; retain and
link their canonical PDFs as companion volumes. Reviewed duplicate and preservation
exclusions remain excluded when a source is revisited.
References to testimony and arbitrary quotations do not qualify.
The shared runner checks proposed boundaries against opening, ending and adjacent
page images. Oversized source indexes retain every page with shorter text windows.

Accepted transcripts are stored once in the canonical corpus with collection
`canadian-questioning-transcripts`. SQLite provenance records the public source
URL (including document locators), parent hash, exact physical page range, review evidence and machine-test run
ID. Parent memberships use `canadian-questioning.v1`; sources remain unassigned
pending family and exposure review. Selection review is not independent human gold.
Record the underlying dispute type and printed commercial evidence, rather than
inferring it from a corporate party or publisher. The 100-record selection reserves
at least 70 slots for commercial disputes. Review interior testimony and reporter
certification pages, which can precede a long word index.
