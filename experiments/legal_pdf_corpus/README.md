# Public legal PDF corpus acquisition

The corpus contains 3,000 accepted PDFs under
`pdfs/<jurisdiction>/<generation>/<kind>/<source>/`. The append-only
`ledger.jsonl` records attempted candidates, including rejected, duplicate,
quota-discarded, and failed leads. `state/source_inventory.json` records source
URLs, terms notes, pool sizes, untried leads, and landing-page examples.

## Measured corpus

- 3,000 PDFs across 9 jurisdictions and 104 source lanes.
- 1,500 digital-born PDFs and 1,500 non-digital PDFs (scanned, image-dominant,
  OCR, or mixed).
- 92 semantic kinds across 14 coarse document types.
- 191,393 physical pages and 10,030,759,591 bytes (10.03 GB / 9.34 GiB).
- Median length 12 pages; 90th percentile 149 pages; maximum 1,672 pages.
- Digital-born documents account for 63,526 pages; non-digital documents for
  127,867 pages. Of the non-digital set, 1,308 PDFs are image-dominant/OCR,
  186 are scanned or mixed, and 6 are image/low-text.

Jurisdiction targets are met exactly:

| Jurisdiction | PDFs | Jurisdiction | PDFs |
| --- | ---: | --- | ---: |
| Canada | 1,225 | United States | 435 |
| United Kingdom | 260 | Australia | 150 |
| New Zealand | 190 | India | 78 |
| Ireland | 235 | South Africa | 255 |
| Singapore | 172 | | |

## Layout and typography profile

All 191,393 pages were profiled from the PDFs. There are 187,881 portrait,
3,494 landscape, and 18 square pages; 152 documents contain more than one
orientation. Page boxes span 12,488 distinct width/height pairs when rounded to
the nearest point. Common formats include A4, US Letter, and Legal, alongside
many historical and archive-specific page sizes. The PDFs expose 1,019 distinct
font-face names after removing embedded subset prefixes, present in 2,607
documents. These are measured resource names, not a normalized count of type
families.

The source and document mix includes court forms, pleadings, affidavits,
judgments, orders, briefs, submissions, transcripts, exhibits, inquiry and
commission records, procurement documents, contracts, municipal bylaws,
statutes, regulations, law reports, historical monographs, and treatises.
The corpus includes U.S. Reports case granules spanning 1781–1875, Canadian
inquiry and court archives, Irish legal publications and archive scans, and
South African statutes. The expanded UK archive search includes historical
English, Scottish, and Welsh legal material.

New source lanes include the [official South African Acts index](https://www.gov.za/documents/acts),
[GovInfo U.S. Reports](https://www.govinfo.gov/help/usreports), and public
Internet Archive collections for [Scottish law](https://archive.org/advancedsearch.php?q=subject%3A%22Law%20--%20Scotland%22%20AND%20mediatype%3Atexts%20AND%20year%3A%5B*%20TO%201935%5D),
[Welsh law](https://archive.org/advancedsearch.php?q=subject%3A%22Law%20--%20Wales%22%20AND%20mediatype%3Atexts%20AND%20year%3A%5B*%20TO%201935%5D),
and [Irish legal history](https://archive.org/advancedsearch.php?q=subject%3A%22Law%20--%20Ireland%22%20AND%20mediatype%3Atexts%20AND%20year%3A%5B*%20TO%201935%5D).
Other primary source indexes include [India Code](https://indiacode.gov.in/),
the [Supreme Court of India](https://www.sci.gov.in/reports/), the
[Constitutional Court of South Africa](https://collections.concourt.org.za/handle/20.500.12144/1),
[Irish Courts](https://www2.courts.ie/Judgments), the [Irish Law Reform
Commission](https://www.lawreform.ie/project-publication-by-year/),
[Singapore eLitigation](https://www.elitigation.sg/gd/Home/Index?Filter=HC),
and the [U.S. Supreme Court slip-opinion archive](https://www.supremecourt.gov/opinions/slipopinion).

The downloader enforces jurisdiction, generation, source, and kind ceilings.
The final verifier passed with `requirements_met: true`: all 3,000 paths exist
inside the corpus root; every PDF opens with a nonzero page count matching its
ledger record; no file needs MuPDF structural repair; PDF signatures, recorded
sizes, and SHA-256 hashes match; no accepted hashes are duplicated; all
jurisdiction and generation targets are exact; and no source/kind cap is
exceeded.

Useful commands:

```powershell
python experiments/legal_pdf_corpus/harvest.py self-test
python experiments/legal_pdf_corpus/harvest.py inventory
python experiments/legal_pdf_corpus/harvest.py verify
```

Only public links are used. A public link does not imply unrestricted
republication rights; consult the originating body and item-level terms where
applicable.

## Where the data lives

The PDFs, `ledger.jsonl` and `state/` live outside the repository in the shared
corpus root, `%LOCALAPPDATA%/OpenLegalData/corpus/legal-pdf/` (paths in the
ledger are relative to it). `corpus_store.py` keeps every real-world document
gathered for this project once by sha256 under that root, laid out
`<collection>/<jurisdiction>/<kind>/`, and indexes it in `corpus.sqlite` with its
source URL, fetch times, provenance and per-page text (FTS5):

```powershell
python experiments/legal_pdf_corpus/corpus_store.py add <url|file> --kind legislation --jurisdiction mb --label "CCSM c C280"
python experiments/legal_pdf_corpus/corpus_store.py path <url|sha prefix>
python experiments/legal_pdf_corpus/corpus_store.py search "\"physical tab\"" --court federal-court
python experiments/legal_pdf_corpus/corpus_store.py sync    # court_practice.json
python experiments/legal_pdf_corpus/corpus_store.py index   # this corpus and court-record-exhibits, in place
```

`court_practice.json` lists, for each court an Authorities preset targets, where
its filing rules live (direct URLs, or a landing page plus a link pattern so a
reissued practice direction is found on the next run) and real filed books of
authorities with the brief filed alongside each. Adding a court means adding a
registry entry. Documents, their text and the index stay out of Git.

The same `corpus.sqlite` owns the structure-gold catalog: `gold_records` links
dataset/source hashes to current status, `gold_runs` indexes run receipts, and
`gold_artifacts` indexes completed product paths and hashes. `gold_memberships`
locates each current record owner and its companion sources; it stores no answers.
Completed products can contain record layers alone when text, structure and OCR
have not been annotated. Receipt artifact mappings list only products that exist.
The
[gold runner](../legal-structure-gold/PLAN.md) registers the saved corpus before
generation and verifies completed products before reusing them. PDFs remain in
this shared corpus; generated gold and receipts live in the private benchmark
suite.

Multipurpose packages reuse those gold tables and PDF hashes. Their receipt-relative
artifact locators reference existing evidence/baselines without copying them.
One canonical line table supports parser and OCR exports; independently owned
classification, extraction, chronology and association annotations stay distinct.
Gold retains the fixed source-anchored answers and is scored directly against
candidate facts. Materialized graphs and repeated offsets are omitted. New records
save the gold itself, without a separate historical representation. Consumer views
derive from that file; replay reuses the existing accepted-response records.
Older originals and pilot history artifacts stay indexed while the format is
validated, but are not dependencies of new gold or its exports.
Packages reference the dated form-observation keys and metadata hashes in this
index rather than creating another authority catalogue.
The annotation workflow is automated and has no human review queue.
The current package dataset selects one gold per source for scoring. Failed or
unfinished enrichment retains its last completed selection. Structure and OCR
can be authored together or measured in separate passes; the same gold keeps
their distinct annotations. Classification, standard fields and newly observed
form kinds still need their own annotation coverage. Packaging references the
existing form catalogue and cannot establish missing answers or authority links.

## Canadian proceeding forms

The same index now collates form kinds in `legal_forms` and their source
observations in `legal_form_observations`. An observation points to an existing
source SHA-256 and page/section locator; it does not duplicate the PDF, harvest
ledger or source catalogue. `documents` continues to own source URLs and
acquisition dates. Blank templates and completed examples can belong to the
same form kind, while different courts or rule families using the same form
number have separate identities.

```powershell
python experiments/legal_pdf_corpus/corpus_store.py forms "affidavit" --jurisdiction yt
python experiments/legal_pdf_corpus/corpus_store.py forms "87/88" --jurisdiction mb
python experiments/legal_pdf_corpus/corpus_store.py forms --limit 1000
```

Results include canonical file paths, source provenance, observed headings,
page selections, available PDF field inventories, and authority links with
their supporting source hashes and locators. Printed template version dates,
document execution dates, authority consolidation dates and acquisition dates
are recorded separately. An undated template stays undated; a filename or
download date is not evidence of its version. Index/body numbering conflicts
and printed aliases are retained in observation metadata.

Add reviewed observations through `register_legal_forms(rows)` after adding or
locating their sources with `corpus_store.py`. The initial review reuses the
Canadian court-form lanes of the existing 3,000-PDF harvest. Its private review
inventory lives in `legal-pdf/state/canadian-forms-review.json`; accepted harvest
quotas and ledger history remain intact. Affidavit-association work adds form
observations from its canonical original filings to this same index.

Reviewed affidavit gold can also carry `document_segments` with document-type
labels, exact source/output page spans and source-located `standard_information`
values. Observations link to those segments through `related_gold_record` and
`gold_pointer`, so extraction values remain owned by the gold. Embedded
components, completed forms, blank templates and narrative-only references keep
distinct roles. A form's printed execution date, template edition, later
admission into another proceeding and acquisition date remain separate.
