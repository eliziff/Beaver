# Gold / benchmark survey for deterministic legal-text tooling

Scope: what public ground truth exists to validate (a) typed-anchor extraction
(money, dates, durations, percentages, ratio multiples, statutory citations),
(b) structural parsing (section/article trees, `(a)(i)` enumeration ladders,
defined-term indexes), and (c) tracked-changes / markup deliverable quality
(Word redlines with comments).

Survey date: **2026-07-28**. Selection bias deliberately avoided: the goal is
evaluation that is *independent of* the Harvey LAB benchmark family, so
contract-review benchmarks are ranked next to statutory sources that no
contract-review benchmark draws from.

House rules followed: `MikeOSS Fork/docs/gold-ground-truth-vetting.md` — freeze
source bytes by hash, record provenance, never let a heuristic both create and
score a label, split by work family not by row, and label honestly when
something is `CANDIDATE_GOLD` or `NOT_GOLD`.

---

## 1. Local inventory (read-only)

| Path | Shape | Notes |
| --- | --- | --- |
| `MikeOSS Fork\backend\src\lib\__tests__\fixtures\legalbench\cuad_anti-assignment-mini.json` | 4,870 B; 6 rows (3 `Yes`, 3 `No`) from the LegalBench `cuad_anti-assignment` test split + the verbatim upstream `base_prompt` | Unit fixture only. Yes/No clause classification — **no spans, no structure**. Sibling `abercrombie-mini.json` (1,558 B). |
| `MikeOSS Fork\backend\scripts\legalbench-rag-mini-setup.ts` | Downloads the 90,591,976-byte ZeroEntropy **LegalBench-RAG** Dropbox zip (only when `EVAL_LIVE=1`), derives a 776-test / 69-doc mini subset, pins every derived byte in `benchmarks/legalbench_rag/mini.manifest.json` | Upstream MIT (ZeroEntropy); aggregates ContractNLI + CUAD + MAUD + PrivacyQA, each retaining upstream terms. Gold = `{file_path, span:[start,end]}` char spans for a **retrieval query**, not a typed anchor. |
| `MikeOSS Fork\backend\scripts\legalbench-rag-run.ts` | Scores the product's SQLite FTS5 bm25 retriever with the upstream char precision/recall@k formulas, writes a validated run trace | Offline, no model calls. Reusable span algebra lives in `backend/src/lib/legalbenchRag.ts` (`charPrecisionRecall`, `Span = {filePath,start,end}`). |
| `MikeOSS Fork\backend\benchmarks\legalbench_rag\` | **Does not exist** | Nothing downloaded locally; no pinned manifest on disk yet. |
| `MikeOSS Fork\backend\src\lib\legalbench.ts` | 9 LegalBench tasks, official balanced-accuracy scorer, per-task license registry; deliberately excludes Learned Hands (CC BY-NC-SA) and `rule_qa` | Precedent worth copying: **the repo already refuses non-commercial slices.** |
| `MikeOSS Fork\OpenLegalData\README.md` | Shared local provider store (`providers/<provider>/<provider>.sqlite`), stdlib-only importers for A2AJ (JSONL/Parquet) and CourtListener (CSV/CSV.BZ2), read-only 127.0.0.1 HTTP API | Infrastructure, not gold. Its A2AJ `sections` output is a *product* of structure parsing, so it cannot score structure parsing. |
| `MikeOSS Fork\docs\gold-ground-truth-vetting.md` | `GOLD` / `ORACLE` / `CANDIDATE_GOLD` / `NOT_GOLD` classes; strict admission allow-list; sections/subsections and paragraph hierarchy explicitly `NOT_GOLD` today; no OOXML mutation gold suite exists | Directly relevant. This report closes the first gap (structure) with external data and confirms the second (OOXML/redlines) cannot be closed by downloading anything. |

**Net local position:** everything on disk is Yes/No classification or retrieval
relevance. Zero local gold for typed anchors, zero for structure, zero for
redlines.

---

## 2. External survey

Sizes are the actual bytes of the useful artifact, not the marketing number.

| Dataset | License | Size | (a) typed anchors | (b) structure | (c) redlines |
| --- | --- | --- | --- | --- | --- |
| **CUAD v1** (Atticus) | **CC BY 4.0** | `CUAD_v1.json` **38.3 MB**; full repo w/ 510 PDFs much larger | **STRONG.** 13,823 expert char-exact spans over 26.8M chars, 41 categories. Date/duration: Agreement Date 476, Effective Date 447, Expiration Date 467, Renewal Term 210, Notice Period To Terminate Renewal 122, Warranty Duration 176 (= 1,898). Money/%/multiples inside Cap On Liability 672, Minimum Commitment 424, Revenue/Profit Sharing 418, Volume Restriction 171, Liquidated Damages 121, Price Restrictions 27 (= 1,833). Gold is the **clause containing** the anchor, not the normalized value. | Weak. No tree, no ladder, no defined-term index. Raw text keeps original numbering, so good *input*, not gold. | **None.** |
| **MAUD v1** (Atticus / ABA 2021 study) | **CC BY 4.0** | train 77.5 MB, dev 20.2 MB, **test 19.6 MB**, 152 contracts 33.7 MB | **MODERATE, uniquely good for duration normalization.** 92 deal points over 152 merger agreements. 289 test rows carry expert duration classes that separate business days from calendar days: `3/4/5 business days`, `3/4 calendar days`, `2 business days or less`, `Greater than 5 business days`, `within 6/9/12 months`. `Type of Consideration` pairs money strings with All Cash / All Stock / Mixed. Bucketed value, **not** a char span. | Weak. Excerpts retain `Section 2.1(b)` / `(a)` / `(i)` numbering but no gold parse. | **None.** |
| **ContractNLI** (Stanford) | **CC BY 4.0** (official site + attached LICENSE). *The `kiddothe2b/contract-nli` HF mirror mislabels it `cc-by-nc-sa-4.0` — trust upstream.* | `contract_nli.zip` 0.7 MB / `contract_nli_long.zip` 1.8 MB | Weak. Evidence spans are sentence/list-item indices into a `spans` array of `[start,end]` char pairs, selected per *hypothesis* — not typed anchors. | Partial. Its span segmentation is sentence-or-list-item, adjacent to enumeration splitting, but the spans form no tree and carry no level. | **None.** |
| **LegalBench** (`nguha/legalbench`) | **Per task**, mixed. Card says `cc-by-4.0`; Learned Hands is CC BY-NC-SA | Small TSVs per task | Weak. All `cuad_*` / `maud_*` / `contract_nli_*` configs are Yes/No or A/B **classification** derived from the datasets above with the spans thrown away. `definition_extraction` (open-ended) and `ssla_*` are the only extraction-shaped tasks; `sara_numeric` is money arithmetic scored `numeric_within_1pct`. | `definition_extraction` is the only structure-adjacent gold — one defined term per sentence, no index, no scope. | **None.** |
| **LegalBench-RAG** (ZeroEntropy) | **MIT** wrapper; sources keep own terms | 90.6 MB zip | Weak. `{file_path, span:[start,end]}` gold is retrieval relevance for an NL query. | None. | **None.** |
| **LEDGAR** (Tuggener et al.) | **CC BY-NC 4.0 upstream** (the LexGLUE aggregate card says `cc-by-4.0`; the underlying corpus is NC — treat as NC) | LexGLUE parquet 27.6 MB (train 20.9 / val 3.4 / test 3.3) | None. Provision-level topic labels only. | Structure-*adjacent*: each row is one provision, so it implicitly marks provision boundaries and names the provision type. No hierarchy, no enumerators, no cross-refs. | **None.** |
| **US public laws, GPO USLM XML** (govinfo `PLAW`) | **Public domain** (17 U.S.C. 105; asserted in every file's `dc:rights`) | 10.0 MB for the 79-law slice fetched here | **STRONG for statutory citations**, none for money/date/duration. 5,105 `<ref href>` give the surface string **and** the resolved canonical target (`<ref href="/us/usc/t8/s1226/c">8 U.S.C. 1226(c)</ref>`); 3,455 to U.S. Code, 122 to CFR. Only 79 `<date date="...">` (approval dates), so not a date corpus. | **STRONG — best available anywhere.** 15,199 nested `section > subsection > paragraph > subparagraph > clause > subclause > item` nodes; 8,870 carry a canonical `@identifier` like `/us/pl/119/1/s2/1/E/i`; 15,520 `<num value="a">(a) </num>` give rendered **and** normalized enumerator; 7,712 `<heading>`; 2,440 `<chapeau>` lead-ins; 555 `<term>` defined-term markers. | **Closest public proxy, not gold.** 4,349 `<amendingAction type="insert/delete/redesignate/amend/add">` + 2,566 `<quotedText>` + 647 `<quotedContent>` = typed, addressed edit operations with exact struck/inserted text. Validates edit *semantics*; validates nothing about OOXML `w:ins`/`w:del`/`w:comment`. |
| **eCFR / govinfo ECFR XML** | Public domain | per-title XML, tens of MB | Partial: `<CITA>` and `<SECAUTH>` carry Federal Register and U.S.C. authority citations. | **Weaker than it looks.** Verified: eCFR XML does **not** nest paragraph levels — `(a)`, `(b)`, `(c)` are sibling flat `<P>` elements inside `<DIV8 TYPE="SECTION">`. Good for section trees, useless for the `(a)(i)` ladder. | **None.** |
| **legislation.gov.uk CLML XML** | **OGL v3.0** (commercial use permitted w/ attribution) | e.g. Equality Act 2010 = 3.5 MB | Has `<Citation>` elements with resolved URIs — UK citation forms, not US. | Strong (`P1group`/`P1`/`P2`/`P3` with `<Pnumber>`), but the served XML carries a moving `RestrictStartDate`, so a point-in-time URL must be pinned. | **None.** |
| **ACORD** (Atticus clause retrieval) | **CC BY 4.0** | 3.1 MB zip | None. | Weak — clauses are cut at section/subsection boundaries with cross-referenced sections pulled in, but the boundary itself is not labelled. | **None.** |
| **FiNER-139** (AUEB, XBRL tagging of SEC filings) | **CC BY-SA 4.0** (copyleft) | 103.2 MB zip — over the ~100 MB bar | Real IOB2 token spans over 1.1M sentences for 139 US-GAAP numeric types (monetary, percentage, duration/term). Financial-filing prose, not contract prose. Share-alike is awkward for a frozen internal corpus. | None. | **None.** |
| **LexNLP / ContraxSuite test fixtures** | **AGPL-3.0** | small | Has expected-value fixtures for money, dates, durations, percents, ratios, citations, definitions — closest thing to a *typed-value* oracle anywhere. | Some section/definition fixtures. | **None.** |

### Honest verdict on (c)

**No public gold-annotated corpus exists for tracked-changes / redline
deliverable quality.** Nothing was found that ships (i) a source DOCX,
(ii) an expert redlined DOCX, and (iii) an adjudicated rubric over the revision
marks and comments. Every product in this space evaluates redlines against
proprietary internal sets. This matches `docs/gold-ground-truth-vetting.md`
finding #5 ("There is no OOXML mutation/round-trip gold suite") — that gap
cannot be closed by downloading anything; it has to be built, and the vetting
doc already specifies the contract. The USLM `<amendingAction>`/`<quotedText>`
pairs downloaded here are the only public *semantic* proxy: label them
`CANDIDATE_GOLD` for "typed edit operation with exact target text", `NOT_GOLD`
for anything OOXML.

---

## 3. What was downloaded

Root: `C:\Users\elias\Desktop\legal-generalization-corpus\gold\`
Total on disk: **70.7 MB / 83 files.** Every dataset has a `provenance.json`
with `source_url`, `accessed_utc`, `license`, `sha256_of_archive`,
`what_ground_truth`, per-file `sha256`, and a leakage warning.

| Directory | Files | Bytes | License | Manifest sha256 |
| --- | --- | --- | --- | --- |
| `gold\cuad-v1\` | `CUAD_v1.json`, `CUAD_v1_README.txt` | 40,154,978 | CC BY 4.0 | `35e9673be4e65fa28be0de903f6d0b83386f3fcd99f3ece0fe1b39fdf7db9810` |
| `gold\maud-v1\` | `MAUD_test.csv`, `MAUD_v1_README.pdf` | 20,615,448 | CC BY 4.0 | `1c7a302a83c44a3a51a70bbbc993727b72c2dd83a8e3f34243e31b1a31879e41` |
| `gold\us-public-laws-uslm\` | `xml\PLAW-119publ{1..80}.xml` (79 kept) + `files_manifest.tsv` | 9,959,471 | Public domain | `b4c3c3c6b8525157b32735a08f1e6c2fd545ba6a26bd98cada7b0f4c776e0534` |

Pins and rules:

- CUAD and MAUD were fetched from **pinned HuggingFace revisions**
  (`a3c393f5d103fd0c516374e4fdff676c8176dcb1`,
  `37d5c3b95d18dcd8404cc5ce3fd5069be062392f`), not from `main`.
- **Only MAUD's test split** was fetched (19.6 MB). `MAUD_train.csv` (77.5 MB)
  and `MAUD_dev.csv` (20.2 MB) were deliberately left upstream so this slice
  stays a holdout.
- Public-law selection rule, deterministic and recorded in provenance: N = 1..80
  ascending, drop any file > 8,000,000 B, stop at 30,000,000 B retained. Only
  `PLAW-119publ60` (12,357,201 B) was dropped.
- **Verified oracle on CUAD:** all **13,823 / 13,823** `answer_start` offsets
  satisfy `context[answer_start : answer_start + len(text)] == text`, zero
  mismatches. Under the vetting doc that makes offset integrity an `ORACLE`;
  the span *identity* is human `GOLD` (Atticus attorney annotation) but ships
  without per-row annotator/adjudicator IDs, so record the unfilled provenance
  block in the run trace rather than claiming full compliance.

Not downloaded, on purpose: **LEDGAR** (upstream CC BY-NC; the repo already
excludes NC slices in `backend/src/lib/legalbench.ts`), **FiNER-139** (103.2 MB
over cap, CC BY-SA copyleft), **LegalBench-RAG** (90.6 MB and already covered by
an existing pinned setup script in this repo), **ContractNLI** (CC BY 4.0 and
tiny, but its spans are hypothesis-evidence, not typed anchors).

---

## 4. Recommendation 1 — best held-out evaluation for **anchor extraction**

### CUAD v1, date/duration + money categories

**File:** `C:\Users\elias\Desktop\legal-generalization-corpus\gold\cuad-v1\CUAD_v1.json`
(sha256 `ed0b77d85bdf4014d7495800e8e4a70565b48ee6f8a2e5dca9cf8655dbf10eae`)
**Category glossary:** `C:\Users\elias\Desktop\legal-generalization-corpus\gold\cuad-v1\CUAD_v1_README.txt`

**Why this one.** It is the only public corpus where an attorney marked, at
character precision, *where in a real contract* the effective date, expiration
date, renewal term, notice period, warranty duration, liability cap and
revenue-share live. 1,898 gold spans for date/duration and 1,833 for
money/percentage/multiple across 510 contracts and 26.8M characters of real
prose (OCR artifacts, run-on whitespace and all). CC BY 4.0, offset-verified,
and not a LAB derivative.

**Field names and span format**

```
root.data[i].title                                        # contract id == work_family_id
root.data[i].paragraphs[0].context                        # FULL contract text; the coordinate system
root.data[i].paragraphs[0].qas[j].id                      # "<title>__<Category>"
root.data[i].paragraphs[0].qas[j].question                # category prompt + "Details: ..."
root.data[i].paragraphs[0].qas[j].is_impossible           # true => category absent from this contract
root.data[i].paragraphs[0].qas[j].answers[k].text         # verbatim substring of context
root.data[i].paragraphs[0].qas[j].answers[k].answer_start # 0-based char offset into context
```

Gold span = half-open char interval `[answer_start, answer_start + len(text))`
into that contract's `context`. Exactly one `paragraphs` entry per contract
(510 contracts x 41 categories = 20,910 `qas`; 6,702 answered).

**How to score**

1. **Feed `context` verbatim as the tool's input.** Do not re-extract from the
   PDFs — the offsets are defined against this exact string. Hash it.
2. Restrict to the anchor-bearing categories, keyed off the `id` suffix:
   - date/duration: `Agreement Date`, `Effective Date`, `Expiration Date`,
     `Renewal Term`, `Notice Period To Terminate Renewal`, `Warranty Duration`
   - money/percent/multiple: `Cap On Liability`, `Minimum Commitment`,
     `Revenue/Profit Sharing`, `Volume Restriction`, `Liquidated Damages`,
     `Price Restrictions`
3. **Headline metric — typed containment recall.** For each gold span `G`, score
   a hit iff the extractor emitted at least one anchor of the expected type
   (`date` / `duration` / `money` / `percent` / `ratio`) whose span is contained
   in `G`. Report per category and per type; each gold answer of a multi-answer
   `qas` must be hit independently.
4. **Secondary — char precision/recall.** Reuse `charPrecisionRecall` and the
   `Span = {filePath, start, end}` type already implemented at
   `C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\legalbenchRag.ts`
   (lines ~207-231). Same span algebra, already unit-tested, so the scorer is
   not new code — satisfying the vetting doc's "freeze and independently test
   the mechanical scorer" rule.
5. **Precision caveat, stated up front.** CUAD marks the clauses lawyers care
   about, **not every date in the contract**. Unrestricted precision against
   CUAD is `NOT_GOLD` and must never be reported as accuracy. Report either
   (i) recall alone, or (ii) precision restricted to predictions falling inside
   *some* gold span of any category. Extra anchors outside gold spans are
   unlabelled, not wrong.
6. **Value normalization is out of scope for CUAD.** The gold is the clause, not
   the parsed value. To score `"30 days" -> P30D` or
   `"5 Business Days" -> {5, BUSINESS_DAY}`, use the MAUD companion below.
7. **Holdout / leakage.** Group by `data[].title` (= `document_name` in
   LegalBench rows). Exclude any contract already used in-repo — at minimum the
   6 documents named in
   `backend\src\lib\__tests__\fixtures\legalbench\cuad_anti-assignment-mini.json`,
   and every document in a LegalBench-RAG mini corpus if that ever lands. Never
   split by row: 41 rows share one contract.

**Duration-normalization companion (same recommendation, second file):**
`C:\Users\elias\Desktop\legal-generalization-corpus\gold\maud-v1\MAUD_test.csv`,
rows where `question` is one of
`Initial matching rights period (COR)-Answer`,
`Initial matching rights period (FTR)-Answer`,
`Additional matching rights period for modifications (COR)-Answer`,
`Additional matching rights period for modifications (FTR)-Answer`,
`Tail Period Length-Answer` (289 rows). Feed `text`, expect the extractor's
normalized duration to land in the gold `answer` bucket. This is the only
public gold that punishes conflating **business days with calendar days**.
Columns: `data_type, contract_name, text, answer, label, question, subquestion,
text_type, id, category`. Hold out by `contract_name` (152 agreements).

**Statutory-citation companion:** use the USLM `<ref>` gold below — CUAD
contains almost no statutory citations.

---

## 5. Recommendation 2 — best held-out evaluation for **structure parsing**

### GPO USLM public-law XML

**Files:** `C:\Users\elias\Desktop\legal-generalization-corpus\gold\us-public-laws-uslm\xml\PLAW-119publ*.xml`
(79 files, 9,959,471 B; per-file sha256 in
`C:\Users\elias\Desktop\legal-generalization-corpus\gold\us-public-laws-uslm\files_manifest.tsv`;
manifest digest `b4c3c3c6b8525157b32735a08f1e6c2fd545ba6a26bd98cada7b0f4c776e0534`)

**Why this one.** It is the only public corpus that gives a *publisher-produced*
tree with canonical node identity for `(a)(1)(A)(i)` ladders: 15,199 nested
nodes, 8,870 with a canonical `@identifier` path, every enumerator carrying both
its rendered form `(i) ` and its normalized value `i`, headings tagged
separately from body text and from lead-ins. Public domain, completely disjoint
from CUAD / MAUD / ContractNLI / LegalBench / LegalBench-RAG / Harvey LAB, and —
critically for `docs/gold-ground-truth-vetting.md` rule 5 — produced by GPO's
editorial pipeline, not by the same heuristics being tested. That closes the
vetting doc's "Sections/subsections: `NOT_GOLD`, no scored human labels" finding
with an external, frozen, independently produced label set.

**Namespace and field names.** XML namespace `http://schemas.gpo.gov/xml/uslm`
(schema 2.0.17).

```
<section     identifier="/us/pl/119/1/s2">   <num value="2">SEC. 2. </num> <heading>...</heading>
  <subsection    identifier=".../s3/a">      <num value="a">(a) </num> <heading>...</heading> <chapeau>...</chapeau>
    <paragraph     identifier=".../s2/1">    <num value="1">(1) </num>
      <subparagraph identifier=".../s2/1/E"> <num value="E">(E) </num>
        <clause      identifier=".../s2/1/E/i"> <num value="i">(i) </num> <content>...</content>
```

- node types, outermost to innermost: `section, subsection, paragraph,
  subparagraph, clause, subclause, item`
- `@identifier` — canonical path; its `/`-separated tail after the section is
  the gold enumerator chain (`s2/1/E/i` -> `2 > 1 > E > i`)
- `<num>@value` — normalized enumerator (`a`, `1`, `A`, `i`); `<num>` text —
  rendered enumerator including delimiters and trailing space
- `<heading>` — heading text; `<chapeau>` — lead-in before an enumerated list;
  `<content>` — body text; `<continuation>` — flush text after a list
- `<ref href="/us/usc/t8/s1226/c">8 U.S.C. 1226(c)</ref>` — citation surface +
  resolved target
- `<term>` — defined term at its point of definition
- `<amendingAction type="...">`, `<quotedText>`, `<quotedContent>` — edit ops

**How to score**

1. **Build the parser's input by rendering the XML to plain text**, not by
   feeding it XML: walk the document in order, emit `<num>` text + `<heading>`
   text + `<chapeau>`/`<content>`/`<continuation>` text, drop all other markup,
   newline at node boundaries. Freeze that renderer and hash its output per
   file. The parser under test then sees only text — same situation as a
   contract — and the XML stays a genuinely independent reference.
2. **Build the gold tree from the same XML**, keeping only nodes with a
   non-empty `@identifier` (8,870 of 15,199). That single filter automatically
   excludes every node under `<quotedContent>`/`<quotedText>`: those are
   *proposed* amendment text, part of a sentence, not part of this document's
   own structure, and they carry no identifier.
3. **Metrics** (all deterministic, no model in the loop):
   - **Node P/R/F1 on the enumerator chain.** A predicted node matches gold iff
     its full ancestor chain of normalized enumerators equals gold's
     (`2 > 1 > E > i`). This is the headline number.
   - **Ladder-depth accuracy** — fraction of gold nodes whose predicted depth
     equals gold depth. Catches the classic failure of flattening `(a)(1)(A)(i)`
     into one paragraph. Report a depth confusion matrix.
   - **Enumerator normalization exact match** — predicted normalized enumerator
     vs `<num>@value` (`a` not `(a) `, `i` not `I`).
   - **Heading/body split P/R** — predicted heading text vs `<heading>`, plus
     lead-in detection vs `<chapeau>` (2,440 instances).
   - **Coverage counters, mandatory** per the vetting doc: eligible, scored,
     excluded, missing-prediction, duplicate, invalid. A perfect score over a
     subset must never hide unscored gold.
4. **Two free extra metrics from the same files, same run:**
   - **Statutory-citation anchors.** Gold = every `<ref>` not under
     `<quotedContent>` (5,105 total: 3,455 U.S. Code, 1,082 public law, 186
     Statutes at Large, 178 bills, 122 CFR, 54 FR). Score (i) span recall of the
     surface string and (ii) exact match of the resolved target against `@href`
     — i.e. does the tool recover *title 8, section 1226, subsection (c)* from
     `8 U.S.C. 1226(c)`, not merely highlight it. Strongest citation gold in the
     survey.
   - **Defined-term index.** Gold = 555 `<term>` elements. Partial: it marks
     terms at their definition site but does not index later uses, so report it
     as definition-site recall only and label it `CANDIDATE_GOLD`.
5. **Holdout.** Split by public-law number (`work_family_id` = the PLAW package
   id). Zero overlap with any contract benchmark, so no cross-corpus leakage
   check is needed beyond that.
6. **Re-fetch discipline.** GPO re-runs its converter (`<processedBy>`,
   `<processedDate>` are in every file). Score only against the pinned sha256s
   in `files_manifest.tsv`; a differing re-fetch is a new `dataset_version`,
   never a silent update.

**Known limits, stated plainly.** These are statutes, not contracts: `SEC. 2.`
not `Section 2.1`, no "Article", and defined-term conventions
("the term 'X' means") differ from a contract's `"X" shall mean` /
`(the "Purchaser")`. Treat this as the **generalization** test — a parser that
handles both statutory and contract ladders is doing structure, not
pattern-matching one template. Pair it with, do not replace it by, an in-house
contract-structure set. Note also that the corpus is heavy in *amendment* prose,
so many enumerated items are amendment instructions rather than substantive
provisions.

---

## 6. What still has to be built in-house

1. **(c) tracked changes.** Nothing public. Build per
   `docs/gold-ground-truth-vetting.md`, "Deterministic OOXML mutation": frozen
   package manifest, allowed mutation set, unchanged-entry hashes, relationship
   graph, revision/comment preservation, application round-trip, repeat-run byte
   determinism.
2. **Contract structure gold.** The USLM set covers statutes. A small
   adjudicated set of contract section trees (heading spans, levels, parent ids,
   ambiguous-heading adjudications) is still required; the vetting doc already
   scoped it.
3. **Typed-value normalization gold beyond MAUD's 289 rows.** MAUD is the only
   public source distinguishing business days from calendar days, and it is
   bucketed. A frozen in-house table of `surface -> {value, unit, day_basis}`
   sampled from the CUAD duration spans downloaded here would be an `ORACLE`
   once the normalizer spec is frozen.
