# A2AJ style-of-cause fallback

**Question.** A citation that gives a court and a year but no identifier A2AJ carries, such as an
SCC decision cited by its CanLII ID ("Name v Name, 19xx CanLII n (SCC)"), resolves to nothing: A2AJ
files those decisions under their SCR citation, not the CanLII ID. The proposed fallback is to accept an A2AJ record whose name equals the style of
cause exactly (period tolerant), in the same court and the same year, and to abstain on any
ambiguity. How reliable is that?

**Answer.** It is reliable for the SCC. Across every SCC test there are 0 wrong matches from
cited styles of cause: 1,652 CanLII-titled neutral decisions, the ALR gold, and three SCC
CanLII-ID citations from the private document that prompted this experiment. Recall is 99.1% on CanLII titles and about 85–90% on the ALR footnotes. With A2AJ's own names
plus reporter years, 3 of 15,564 matches are wrong, all from A2AJ date anomalies (see below).

Outside the SCC it is much less safe. Courts that issue several rulings a year in one proceeding
(BCSC, FC, NSSC, SST, ONCA) produce wrong matches at 0.1–1.6%. Where A2AJ lacks the cited
decision, the matcher wrongly accepts a same-named sibling ruling for about 7% of citations. Exact
matching cannot detect that case.

This is an experiment, not wired into the product. Nothing outside this directory changed.

## Method

Code: `lib.ts` (matcher), `measure.ts` (facts about A2AJ that the rules rely on), `eval.ts`
(evaluation) and `wrongs.ts` (wrong-match classification). Citations are parsed only by the native
engine: `citationEngineCall("extract")` for style, court, year and format, and
`citationLookupKeys` for direct keys. No TypeScript citation regexes are used. The one pattern here
splits CanLII *case ids* (`2005scc72`).

The citation must give a style of cause, a court that resolves to an A2AJ dataset, and a year.
The matcher then:

1. **Normalises names.** It applies NFKC, unifies quote and dash glyphs, deletes periods and
   collapses whitespace, so "R. v. Smith" becomes "R v Smith" and "H.L." becomes "HL". It indexes
   both `name_en` and `name_fr`. Measured variants:
   - `exact`: only the above, case-sensitive. This is the rule as proposed.
   - `casefold`: also lower-cases.
   - `crown`: casefold, plus a party that is exactly a Crown designation (R, The Queen/King,
     Her/His Majesty the Queen/King, Regina, Rex, La Reine, Le Roi, Sa Majesté…) becomes `r`.
   - `crownUnordered`: crown, plus two parties compared in either order.
2. **Applies the court rule.** The citation's native court id must name the A2AJ dataset. The id
   comes from a CanLII parenthetical "(SCC)", a neutral series, or a court-implying reporter such as
   SCR → `scc`. Measured on A2AJ's own 256,738 court-bearing citations, the id equals the dataset in
   98.2% of cases. The rest are courts that A2AJ files under another dataset, so `measure.ts`
   derives a remap from the data: nssf→NSSC, pslreb/pssrb/psst→FPSLREB, cact→CT, capprt→CIRB. `rpd`
   is left unmapped because RPD is also its own dataset.
3. **Applies the year rule.** A2AJ records carry a decision date. The cited year is compared with
   the decision year as follows:
   - A CanLII id or neutral citation carries the decision year. The A2AJ decision year must equal
     it. CanLII ids are assigned by decision year: 1954 CanLII 3 was decided on 1954-12-09.
   - A reporter year in brackets, such as "[1955] SCR 16", is the volume year. Measured on A2AJ's
     12,791 bracketed SCR citations, report year minus decision year is 0 in 80.7%, +1 in 17.1%,
     +2 in 2.0%, +3 in 0.1% and ≥4 or −1 in 6 cases. The chosen window (`aware2`) is the cited year
     and the two years before it. `aware` is the cited year and the year before. `strict` is the
     cited year only.
   - A reporter year in parentheses, such as "(1918) 59 SCR 670", is the decision year (98.9% equal).
     The window is that year only.
4. **Abstains.** Zero candidates means `zero`; two or more distinct records means `multi`.

Two **ambiguity guards** were also measured as extensions:
- `proceeding`: abstain if the same normalised name names another record of that court in the
  year just outside the window.
- `nearName`: abstain if another record in the window shares at least half its distinctive name
  tokens (Jaccard ≥ 0.5).

### Data-backed decisions on "The Queen" vs "R" and party order

`results/measure.json` counts (court, year, name) groups that hold several records:

| rule | groups with >1 record | new groups this rule creates |
| --- | ---: | --- |
| exact | 23,825 | — |
| casefold | 24,185 | 267, all the same proceeding with different capitalisation ("R. v. LeMay" / "R. v. Lemay") |
| crown | 23,469 | 206, all "Regina v. X" / "R. v. X" rulings of the same proceeding |
| crownUnordered | 23,803 | 1,747, mostly appeal and cross-appeal role reversals ("Saxena v. Thailand" / "Thailand v. Saxena") |

The Crown alias only merges records that A2AJ itself names inconsistently within one proceeding.
On the CanLII titles it lowers wrong matches from 289 to 270, compared with casefold alone, and
raises recall. On the absent target it adds 3 accepts (147 to 150).

The Crown alias is the rule recommended here. The data does not show party-order equivalence to
be safe: it gains 3 ALR items but adds 5 wrong CanLII matches and 6 wrong accepts when the decision
is absent. Keeping party order costs 3 of 133 ALR items, for example "R v Rabey" against A2AJ's
"Rabey v. R."

## Data (all local; network only for the recordings)

- **A2AJ bulk**: `%LOCALAPPDATA%\OpenLegalProducts\LegalData\providers\a2aj\a2aj.sqlite`
  (`MIKE_A2AJ_BULK_DB`). Schema 3, imported 2026-08-07, A2AJ cases revision `54bfeaec…`. It holds
  225,162 case records with names, citations, dataset and decision date. No `lookup.duckdb` exists on
  this machine; the memory note is stale.
- **ALR gold**: `ALR-Quote-Verifier/dev/benchmarks/field_gold_provisional.jsonl` (part text and the
  gold-corrected citation) and `fast_split_gold_all.jsonl` (accepted parts). These are Alberta Law
  Review footnotes, read in place (`ALR_QUOTE_VERIFIER_ROOT`) and not copied, as in
  `benchmarks/authorities-split`.
- **CanLII case metadata**: `%LOCALAPPDATA%\ALR Quote Verifier\data\canlii-186d92f8c0a4.db`
  (`CANLII_CASES_DB`), 3,538,714 rows of databaseId, caseId and title. It gives CanLII's style of
  cause for every neutral-cited decision and for the pre-neutral CanLII-id population.
- **Live A2AJ**: 6 requests in total, made one at a time by hand, recorded verbatim. They concern
  citations from a private document, so they stay local in the ignored `results/recordings/`
  (`requests.json` lists them, `cases.json` the citations); `eval.ts` skips them when absent. The
  evaluation reads the recordings and never the network.

## Evaluation sets

For each test item the record is known from a direct citation key. The fallback runs with that key
hidden, using only style + court + year.

| set | what it tests | n |
| --- | --- | ---: |
| ALR published | footnote citations as published (McGill style), any parallel citation hitting A2AJ by key | 133 |
| ALR corrected | the gold-corrected form; adds CanLII-id and SCR parallels | 59 |
| CanLII title, SCC | CanLII's title + neutral year/court for SCC decisions; record by neutral key | 1,652 |
| CanLII title, all courts | same, every A2AJ court in A2AJ's year range | 160,221 |
| SCC own name + reporter year | every SCC record's own A2AJ name + its SCR year; isolates the year rule | 15,564 |
| absent target | CanLII neutral decisions in an A2AJ court/year range that A2AJ lacks; every accept is wrong | 2,102 |

ALR eligibility: of 296 case citations in published parts, 140 lack a style, a year, or a court
mapping to an A2AJ dataset. Examples are "(1999), 45 OR (3d) 12 (CA)" (no court id) and ABQB (not in
A2AJ).

## Results

Columns: P = precision over accepts, R = recall over n, zero/multi = abstain rates.
**Proposed** = `exact/aware2`. **Recommended** = `crown/aware2`.

| set | config | n | correct | wrong | P | R | zero | multi |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ALR published | proposed | 133 | 112 | 0 | 1 | 0.842 | 0.143 | 0.015 |
| ALR published | recommended | 133 | 113 | 0 | 1 | 0.850 | 0.135 | 0.015 |
| ALR corrected | proposed | 59 | 53 | 0 | 1 | 0.898 | 0.102 | 0 |
| ALR corrected | recommended | 59 | 54 | 0 | 1 | 0.915 | 0.085 | 0 |
| CanLII title, SCC | either | 1,652 | 1,637 | 0 | 1 | 0.991 | 0.001 | 0.008 |
| CanLII title, all courts | proposed | 160,221 | 118,356 | 297 | 0.9975 | 0.739 | 0.047 | 0.213 |
| CanLII title, all courts | recommended | 160,221 | 118,472 | 270 | 0.9977 | 0.739 | 0.044 | 0.215 |
| SCC own name + reporter year | exact/strict | 15,564 | 12,850 | 34 | 0.9974 | 0.826 | 0.158 | 0.014 |
| SCC own name + reporter year | exact/aware | 15,564 | 14,869 | 5 | 0.9997 | 0.955 | 0.020 | 0.025 |
| SCC own name + reporter year | proposed | 15,564 | 15,083 | 3 | 0.9998 | 0.969 | 0.003 | 0.028 |
| SCC own name + reporter year | recommended | 15,564 | 15,053 | 3 | 0.9998 | 0.967 | 0.003 | 0.030 |

**Absent target.** Of 2,102 decisions, the matcher wrongly accepted a namesake for 145 under the
proposed rule (6.9%) and 150 under the recommended rule (7.1%). With the `proceeding` guard this
falls to 111, and with both guards to 77. None of these decisions is SCC: A2AJ has every SCC
neutral decision that CanLII lists.

**Guards (recommended + guard).**

| set | none | proceeding | nearName | both |
| --- | --- | --- | --- | --- |
| CanLII title, all courts (wrong / R) | 270 / 0.739 | 171 / 0.639 | 72 / 0.519 | 42 / 0.453 |
| CanLII title, SCC (wrong / R) | 0 / 0.991 | 0 / 0.967 | 0 / 0.956 | 0 / 0.933 |
| ALR published (wrong / R) | 0 / 0.850 | 0 / 0.805 | 0 / 0.774 | 0 / 0.737 |

The guards remove wrong matches only by giving up recall that the SCC does not need to give up.

**Year handling.** On SCR-year citations, the strict rule (decision year = cited year) loses 15.8%
to zero abstentions. It also makes 34 wrong picks: a same-name SCC decision in the report year when
the cited one was decided the year before. Allowing up to two years before a bracketed year lifts
recall to 96.9% and cuts wrong picks to 3. On ALR, the year window gains one item. On CanLII ids and
neutral citations the window is exact, and 0.33% of A2AJ neutral records carry a decision date in
another year. That accounts for 43 of the all-courts wrong matches.

**Pre-neutral CanLII-id population** (the motivating case; unscored because no record is known):

| court | n | unique | zero | multi |
| --- | ---: | ---: | ---: | ---: |
| SCC | 10,022 | 9,072 | 808 | 142 |
| ONCA | 7,226 | 4,247 | 2,677 | 302 |

Under the recommended rule, 307 of the SCC unique matches and 292 of the ONCA unique matches have
another CanLII decision of the same court and year under the same title. These are an upper bound on
wrong accepts in this population. On ONCA the high zero rate means A2AJ's pre-2007 coverage is
partial, which is exactly where the absent-target failure lives.

### Every wrong match

All 575 wrong matches of `exact/aware` and `crown/aware2` are listed in `wrong-matches.tsv`, with
the cited style, the cited citation, the pick and the known record, each classified by `wrongs.ts`.

- **ALR (both sets): none.** The fallback matched one item that had no direct key: "R. v. Creighton,
  1993 CanLII 61" → [1993] 3 SCR 3. That is consistent with the decision's published parallel
  citation.
- **CanLII title, SCC: none.**
- **SCC own name + reporter year: 3 wrong under the recommended rule.**
  - Corpex (1977) Inc. v. The Queen in right of Canada, [1982] 2 SCR 674, cited in English and in
    French. The matcher picked [1982] 2 SCR 643 from the same proceeding. A2AJ dates 674 to
    1983-05-17, after its own 1982 report year, which is a date anomaly. The `proceeding` guard
    catches it.
  - Magdall v. The King, [1921] 62 SCR 88. The matcher picked (1920) 61 SCR 88. A2AJ dates 62 SCR 88
    to 1914-02-23, a date anomaly.
- **CanLII title, all courts: 270 under the recommended rule** (297 proposed). Each pick is a
  sibling ruling of the same court and year carrying CanLII's exact title. The cited decision is
  named differently in A2AJ:

  | cause | count | example |
  | --- | ---: | --- |
  | variant spelling, typo, punctuation or abbreviation | 172 | "Bhandal v. Khalsa Diwan Soceity of Victoria" |
  | a different style altogether | 50 | "R. v. Jevane Fuller" for CanLII "R. v. Fuller"; anonymised "R. v. T.S.G." vs "R. v. Gilbert" |
  | A2AJ decision date in another year | 43 | |
  | French-only name | 4 | 20 under exact; the Crown alias fixes "c. La Reine" |
  | filed under another dataset | 1 | 2007 BCSC 1280 filed as BCCA |

  By court: BCSC 84, FC 41, NSSC 32, SST 31, ONCA 20, NSCA 18, BCCA 18, TCC 12, NSPC 5, FPSLREB 3,
  FCA 3, NSSM 2, YKCA 1, SCC 0. SST has the highest rate (1.6%) because its styles are anonymised
  ("AS v Canada Employment Insurance Commission").
- **Absent target**: the accepts are listed in `results/canlii-absent-accepts.json` (local). All are
  sibling rulings of one proceeding, for example "R. v. Johal" 2015 BCCA 101 → 2015 BCCA 246.

### What exactness costs (ALR, recommended rule)

The 20 ALR-published abstentions (18 zero, 2 multi) and 5 ALR-corrected abstentions break down as
follows:

- **McGill abbreviations** against A2AJ's full names: "Law Society of BC", "Canada (AG)",
  "Canadian Broadcasting Corporation" vs "Corp.".
- **"Reference re" vs "Re"**.
- **A shortened style**: "R v Eldorado Nuclear Ltd" vs A2AJ's joined "…; R. v. Uranium Canada Ltd.",
  and "Annapolis Railway Co v The Queen".
- **Party order**: "R v Rabey" vs "Rabey v. R."; "Mariner Real Estate" reversed.
- **A companion-case name**: "R v Chan, 2022 SCC 19" vs A2AJ's "R. v. Sullivan".
- **Two genuine multi abstentions**: "A.B. v. C.D." with several rulings in one year.
- **Four hand-written seed footnotes** whose style belongs to a different decision ("R v Example,
  2024 SCC 1", "R v Smith, 2020 SCC 10", "R v Jones, 2019 BCCA 20", "R v Harris, 2016 BCCA 166").
  Abstaining there is correct.

## Three SCC CanLII-ID citations (local recordings)

Three SCC decisions cited only by CanLII ID and court, from the private document that prompted this
experiment, were checked against the live API once each and then offline. A live `/fetch` by the
CanLII citation returned `{}` for all three. A live name search returned the same records as the
local store (name, citation, decision date). The fallback matched each to its SCR record under every
configuration; in one case the year separated two SCC decisions of the same name thirty years
apart. A Crown-designation variant of one style ("v R" for "v The Queen") matched only with the
Crown rule, and a reversed party order only with party order ignored.

## Side finding (not changed here)

The installed `a2aj.sqlite` `citation_lookup` holds legacy keys, for example `1955scr16`. 0 of its
350,872 keys are in the v3 form that `structureNative().citationLookupKey` now returns
(`3:reporter:scr:scr:1955:16`). As a result, `fetchLocalA2AJDocument`, the local first step of
`a2aj.ts` `document()`, cannot hit this store, and every lookup falls through to live `/fetch`.
Re-importing with the current `legal_citations.key_for_text` should fix it. This experiment builds
its own v3 key index from the store's citation fields.

Prior art: Legal Pinpointer's `tools/build-canlii-case-aliases.py` matches in the reverse direction
(A2AJ reporter citation → CanLII id) by court + decision year + a looser name key, and abstains on
ambiguity.

## Run

```powershell
cd backend
npx tsx ../experiments/a2aj-style-of-cause-match/measure.ts   # ~4 min -> results/measure.json
npx tsx ../experiments/a2aj-style-of-cause-match/eval.ts      # ~8 min -> results/summary.json, wrong-matches.json
npx tsx ../experiments/a2aj-style-of-cause-match/wrongs.ts    # -> wrong-matches.tsv
```

`results/` is git-ignored (local artefacts). The durable numbers are in this README and in
`wrong-matches.tsv`.
