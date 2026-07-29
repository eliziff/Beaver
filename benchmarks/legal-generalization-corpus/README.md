# Legal generalization corpus

31 real, publicly-available legal documents gathered as an **independent validation set** for deterministic legal-text tooling (typed-anchor extraction and structural skeleton parsing).

The point of the collection is *structural* diversity: different genres, different drafting eras, different jurisdictions, and — most importantly — different numbering conventions. It deliberately includes instruments that break the common assumption that legal documents are `ARTICLE I` / `Section 1.01` trees.

Nothing here has been run through, tuned against, or evaluated with the tooling it is meant to validate. This repository is raw material only.

- **Documents:** 31
- **Raw bytes:** 29,322 KB  |  **Extracted text:** 11,437 KB
- **Genres:** 11
- **Jurisdictions:** United States (federal filings, federal law), Canada (federal statutes and regulations, Supreme Court of Canada)

## Layout

```
raw/            original downloaded bytes, unmodified
text/           plain-text extraction, same basename, .txt
manifest.jsonl  one JSON object per document
README.md       this file
```

Every `text/*.txt` has a matching `raw/*` and exactly one manifest row. `sha256` in the manifest is the hash of the **raw** bytes, so any extraction can be re-derived and checked against the original.

Those four entries are the whole corpus. If other directories are present alongside them they were put there by a different process and are not described by this README or by `manifest.jsonl`.

## Contents

| # | Document | Genre | Text | Structure |
|---|----------|-------|------|-----------|
| 1 | `us-credit-agreement-1996-csk-auto` | credit-agreement | 312 KB | Flat 'SECTION N.' headings, no ARTICLE tier |
| 2 | `us-credit-agreement-1996-nabisco-5yr` | credit-agreement | 251 KB | Flat 'SECTION 1.'-'SECTION 13.' top level with NO ARTICLE tier |
| 3 | `us-credit-agreement-2022-edison-international` | credit-agreement | 199 KB | Term loan agreement with no ARTICLE tier |
| 4 | `us-credit-agreement-2022-rpt-realty` | credit-agreement | 468 KB | ARTICLE roman (36) over Section N.N (152) and N.NN (97) |
| 5 | `us-credit-agreement-2023-netstreit-term-loan` | credit-agreement | 436 KB | ARTICLE roman (26) over Section N.N (345) |
| 6 | `us-merger-agreement-1997-raytheon-he-holdings` | merger-agreement | 165 KB | ARTICLE arabic 1-8 (not roman) over Section N.NN (104) and N.N (209) |
| 7 | `us-merger-agreement-2017-southern-missouri-bancorp` | merger-agreement | 224 KB | ARTICLE roman (17) over Section N.N (72) |
| 8 | `us-merger-agreement-2018-key-technology` | merger-agreement | 270 KB | ARTICLE roman (33) over Section N.N (279) and N.NN (124) |
| 9 | `us-indenture-1996-ak-steel` | indenture | 277 KB | ARTICLE arabic 1-11 over uppercase SECTION N.N single-decimal (150) |
| 10 | `us-indenture-2009-oshkosh` | indenture | 216 KB | ARTICLE arabic (32) over uppercase SECTION N.NN (202) |
| 11 | `us-indenture-2017-kingstone` | indenture | 211 KB | ARTICLE arabic (30) over Section N.NN (356, three-digit 301/302 style) |
| 12 | `us-llc-agreement-2015-qts-richmond` | llc-agreement | 79 KB | Article arabic (7) with lettered/roman ladders (142/67) |
| 13 | `us-partnership-agreement-2023-jones-financial` | llc-agreement | 167 KB | WORD-FORM articles ('Article One'..'Article Twelve', 40 hits) over Section N.N (65) |
| 14 | `us-lease-2020-homestreet-office` | lease | 333 KB | No ARTICLE tier |
| 15 | `us-employment-agreement-2019-tcf-financial` | employment | 81 KB | Numbered paragraph sections, no ARTICLE/Section N.NN scheme |
| 16 | `us-license-agreement-2012-yelp` | license | 126 KB | 143 numbered paragraphs plus Section N.N (25) |
| 17 | `us-supply-agreement-2013-select-comfort` | supply | 156 KB | Arabic (1)/(2) ladders dominant (112) over 24 numbered paragraphs |
| 18 | `ca-regulation-cbca-regulations-2001` | regulation | 96 KB | Canadian regulation: numbered sections with 34 'N (N)' subsections and (a)/(1)/(i) ladders (370/358/111) |
| 19 | `ca-regulation-immigration-refugee-protection` | regulation | 711 KB | Canadian regulation: 187 'N (N)' subsections, 1121 marginal notes, very heavy (a)/(1)/(i) ladders (3113/2512/805) |
| 20 | `us-regulation-12-cfr-1026-regulation-z` | regulation | 3,582 KB | US regulation (Truth in Lending): Subparts over '§ 1026.NN' sections (7634 § symbols, 590 Section N.NN refs) |
| 21 | `us-regulation-16-cfr-803-hsr` | regulation | 59 KB | US regulation (HSR transmittal rules): '§ 803.N' section numbers (88 § symbols) with (a)(1)(i) ladders (171/91/42) |
| 22 | `ca-statute-bank-act` | statute | 1,647 KB | Canadian statute: Parts and Divisions, 620 'N (N)' subsections, 3232 marginal notes, very heavy (1)/(a)/(i) ladders (5803/4870/806) |
| 23 | `ca-statute-canada-business-corporations-act` | statute | 464 KB | Canadian statute: bare section numbers with '5 (1)' subsection form (196), 1059 'Marginal note:' labels, (a)/(i) paragraph ladders (1180/141) |
| 24 | `ca-case-2014-scc-bhasin-v-hrynew` | court-document | 102 KB | Court judgment: 116 bracketed paragraph numbers [1]..[N] as the sole structural spine |
| 25 | `ca-case-2021-scc-wastech-services` | court-document | 289 KB | Court judgment: 331 bracketed paragraphs [1]..[N] spanning majority plus concurring reasons |
| 26 | `us-complaint-2016-doj-florence-ky` | court-document | 27 KB | DOJ ADA complaint, the only HTML complaint here: allegation paragraphs 1-112 plus prayer items exist ONLY as <ol start="N"> markup, not as literal characters, so a naive tag-strip extracts ZERO numbered paragraphs |
| 27 | `us-complaint-2020-sec-honig` | court-document | 196 KB | Federal complaint (pump-and-dump, SDNY): 324 numbered allegation paragraphs (1-304) plus FIRST..SIXTH CLAIM FOR RELIEF headings |
| 28 | `us-complaint-2023-sec-comp25666` | court-document | 13 KB | Federal complaint: 34 numbered allegation paragraphs as the structural spine plus 4 COUNT headings |
| 29 | `us-court-opinion-ilnd-05-cv-03198` | court-document | 20 KB | Federal district court opinion: unnumbered prose under heading tiers, NO paragraph numbering at all (contrast with the SCC judgments) |
| 30 | `us-court-opinion-txsd-10-cv-04728` | court-document | 120 KB | Federal district court opinion (contract dispute): unnumbered prose with lettered/roman heading tiers |
| 31 | `us-court-opinion-txsd-16-cv-01947-westport` | court-document | 135 KB | Federal district court opinion (insurance coverage / breach of contract): Roman 'I.'-'IV.' parts over lettered 'A.'-'C.' over numbered '1.'-'4.' |

Full structure notes, source URLs, hashes and access timestamps are in `manifest.jsonl`.

## Why these documents

| Numbering convention | Where it shows up here |
|---|---|
| `ARTICLE` + roman numerals over `Section N.NN` | modern US credit and merger agreements (RPT Realty, NETSTREIT, Key Technology, Southern Missouri Bancorp) |
| `ARTICLE` + **arabic** numerals | 1990s merger and indenture drafting (Raytheon 1997, AK Steel 1996), Oshkosh and Kingstone indentures |
| **Word-form** articles (`Article One`, `Article Twelve`) | Jones Financial LLLP partnership agreement; Oshkosh / Kingstone indentures |
| **Flat `SECTION N.`** with no article tier at all | 1996 syndicated credit agreements (Nabisco, CSK Auto) |
| Uppercase `SECTION N.N` single-decimal | AK Steel indenture (1996) |
| Bare numbered paragraphs, no section tier | commercial lease, employment agreement, licence agreement, supply agreement |
| Canadian statutory `5 (1)(a)(i)` plus `Marginal note:` labels | Canada Business Corporations Act, Bank Act, and the two federal regulations |
| Bracketed judgment paragraphs `[1]`..`[N]` | Supreme Court of Canada judgments |
| **Unnumbered** judicial prose under heading tiers | US district court opinions — deliberately included as the opposite extreme |
| `§ 803.1(a)(1)(i)` regulatory ladders | 16 CFR 803 and 12 CFR 1026 |
| Numbered allegation paragraphs + `COUNT` headings | SEC and DOJ civil complaints |
| Numbering that exists **only in markup**, not in the characters | DOJ ADA complaint (`<ol start="N">`) — a naive tag-strip sees no numbers at all |

The 1996-97 US instruments matter because none of them use the roman-numeral `ARTICLE I` convention that dominates post-2000 drafting; two of them have no article tier whatsoever. Any parser that assumes that convention will fail on roughly a fifth of this corpus.

## How the corpus was assembled

**US filings (SEC EDGAR).** Candidates were found with EDGAR full-text search (`efts.sec.gov/LATEST/search-index`), which covers 2001 onward. Full-text search matches amendments and base agreements alike, so each candidate was size-screened via the filing's `index.json` (SEC serves these chunked and gzipped, so `HEAD` returns no `Content-Length` and `Range` requests are not honoured — you must read the directory listing for sizes). Every candidate was then downloaded and its opening lines read to confirm it is a base or amended-and-restated instrument rather than a short amendment or waiver. Roughly a third of candidates were rejected at that step and deleted.

**Pre-2001 US filings.** EDGAR full-text search does not reach the 1990s. Those documents were located through the quarterly form indexes (`/Archives/edgar/full-index/YYYY/QTRn/form.idx`), then extracted from the complete-submission `.txt` files, in which each exhibit is one `<DOCUMENT><TYPE>EX-nn ... </DOCUMENT>` block. `raw/` holds the exact sliced block; the manifest records the byte range in `extraction_note`.

**Canadian federal law.** Statutes and regulations come from the Justice Laws website (`laws-lois.justice.gc.ca`) as consolidated full-text HTML. Only the `<main>` element is kept during extraction, which drops the Canada.ca navigation chrome while preserving marginal notes and the section/subsection ladder.

**Canadian case law.** Supreme Court of Canada judgments come from the Court's own site. The `/en/item/<id>/index.do` page is a JavaScript shell; the document itself is served from `/en/<id>/1/document.do` as PDF, which is what `raw/` holds. Text was extracted with `pypdf`; body text is clean, though title-page headings retain some kerning artefacts (`BE TWE E N`). CanLII was not used — it returns 403 to scripted requests.

**Text extraction.** HTML was converted with a small stdlib `HTMLParser` that emits newlines at block-level boundaries, so paragraph and heading structure survives; `<script>`, `<style>`, `<title>` and `<noscript>` content is dropped. Text is NFKC-normalised, curly quotes and dashes are folded to ASCII, non-breaking spaces become spaces, runs of blank lines collapse to one. Raw files are never modified.

**Structure notes.** The `structure_notes` field is measured, not guessed: each text file was scanned with regexes for article/section conventions, `(a)`/`(i)`/`(1)` ladders, quoted defined terms, marginal notes and paragraph numbering, and the counts in the notes come from that scan.

## Polite scraping

- All SEC requests carried a descriptive `User-Agent` with a contact address, per SEC's access policy. Requests were spaced (roughly 0.15-0.7 s apart) and issued serially; no parallel hammering of `www.sec.gov` or `efts.sec.gov`.
- Complete-submission files were cached locally so each 1 MB+ submission was downloaded exactly once even when two exhibits were taken from it.
- The same descriptive `User-Agent` was used for `laws-lois.justice.gc.ca` and `decisions.scc-csc.ca`.
- No paid services, no APIs requiring keys, and no model API calls were used at any point.

## Licence basis

| Basis | Applies to | Count |
|---|---|---|
| `SEC public filing` | Exhibits to filings on SEC EDGAR — public records | 17 |
| `court record` | Court records | 6 |
| `Canadian federal law (Reproduction of Federal Law Order, SI/97-5)` | Canadian federal statutes and regulations; reproduction permitted without permission under SI/97-5 | 4 |
| `court record (Supreme Court of Canada; reproduction permitted)` | SCC judgments; the Court permits reproduction without permission | 2 |
| `US government work` | Works of the US federal government | 2 |

Canadian material is reproduced unofficially and without endorsement or affiliation. It is not the official version; consult the Justice Laws website and the Supreme Court of Canada for authoritative text.
