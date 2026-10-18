# Text-fragment lessons

This is a ledger of what has been tried for text-fragment links, what held, what failed and why. Each entry has
its commit or result reference. Read it before changing the planner, the link builder or the gates. Don't repeat a
failed experiment without a new reason. Raw outputs live under `results/` (gitignored). Older outputs are archived at
`E:\MikeOSS-archive\2026-08-29\experiment-outputs\MikeOSS Fork\experiments\text-fragment-fidelity\results`.

## Standing rulings (the user's words, not findings)

- Get as many real hits as possible, on CanLII or another provider. Never revert the planner to the Python app's
  links; make the planner better (2026-10-16, transcript 60d2d41f L3409).
- "Never *just* emit #par and expect it to work … belt and suspenders": the anchor stays beside the fragment
  (memory python-alr-is-the-spec).
- Building from A2AJ text and opening a page whose text differs is the premise of the system, not a finding
  (60d2d41f L3980-3992). The Pinpointer gate plans from CanLII's own page text, so it is a perfect oracle and not a
  test of real links; most host apps don't have CanLII's page (L4150).
- Quote links and paragraph/section links are two APIs over one backend path (L4795-4804).
- Harvest more CanLII and provider pages; never give up on providers (L4706, L5036). CanLII pages are never read
  live: they come from the caches only (memory canlii-links-and-pdf-only). Never fetch LégisQuébec (licensing).
- 2026-10-17: maximize hits on CanLII links planned blind from A2AJ text, and on each A2AJ-derived provider's page.
  The link API offers CanLII or the provider. Where a fragment is built, prefer the provider. Fragments never land on
  XML pages.
- These are known ground, not discoveries:
  - slight underpaint, omission or overpaint is acceptable when logged as its own category;
  - certain characters break matching (listed below);
  - paint on the wrong place is unacceptable, is tracked, and must never rise;
  - planning needs the whole document's text for uniqueness, never a snippet.

## Browser facts (Chromium's text-fragment finder)

These were proved against installed Chrome by `quirk-check.mjs` here and by the Pinpointer fixture
`Desktop/Legal Pinpointer/tools/fragment-quirks.cjs` (85 cases; the model is `text-fragments.js`, commit 7546d30).
The planner's `BrowserReplay` and `browser_key` in legal-structure `text_fragment.rs` encode them.

- **Folded (match each other):**
  - case, accents, ligatures and eszett (`ﬁ`, `ß`, `æ`);
  - full-width and superscript forms;
  - the ellipsis character and three dots;
  - dotless i;
  - Unicode case.
- **Ignored inside words:** soft hyphen (U+00AD), zero-width space, `<wbr>`, comments, and script, style and meta
  elements between letters. An `<img>` between letters also joins the words around it.
- **Not folded (each breaks a match):**
  - en dash, em dash and U+2010/U+2011 against `-`;
  - prime and double prime against `'` and `"`;
  - low and reversed quotes and guillemets against straight quotes;
  - curly quotes against straight ones. Curly against straight is the corpus "curly quotes" class (RESULTS
    2026-08-22).
- **Whitespace:**
  - NBSP plus a space is two spaces, never one;
  - a `<pre>` tab is a tab, not a space;
  - whitespace runs never collapse across element boundaries (17e92b67f4: SCC Decisia's `s.<NBSP>17<NBSP>`).
- **Block boundaries split terms:**
  - `<br>`, block elements, table cells, list items and flex items;
  - inline-block, inline-flex, floated and absolutely positioned elements.

  Inline elements join. A range's start and end may lie in different blocks; a single term may not.
- **Matches are whole words.** Prefix and suffix context must sit next to the target, with only whitespace between.
  A suffix past a full stop is never found (legal-structure c23d924, "Charter.\n[13]").
- **A range's end is searched only after its start.** A short paragraph whose closing words begin inside its opening
  words matches nothing; such a paragraph targets its own words (9be385e). A failed suffix restarts the exact search.
- **What is searched:**
  - hidden, `display:none` and `content-visibility:hidden` text is skipped, as are `select`, svg titles and img
    alt text;
  - aria-hidden, offscreen, `hidden=until-found`, closed `details`, `input` values, `textarea` and buttons are
    searched.
- **Every directive that matches paints;** one that matches nothing is silently ignored. Sibling spellings are
  safe only when the passage is unique. Bare and context-qualified spellings of a repeated phrase must never be
  sent together: qualification replaces, never joins (docs/roadmap/external-pinpoint-robustness.md @17e92b67f4).
- **Navigation:** a same-document `location.hash` change does not process `:~:text=`, so each link needs a real
  navigation (`probe-hash-nav.mjs`). The PDF viewer handles fragments only in the active tab (`gate-replay.mjs`
  serializes PDFs). `::target-text` is not exposed by `getSelection()`; paint is measured from screenshot pixels.

## Provider facts

- **Decisia/Lexum (14 hosts):**
  - The bare `/item/N/index.do` is an iframe shell with no text. `iframe=true` serves the text (0c35faf359).
  - `site_preference=mobile` is load-bearing: without it, the desktop viewport locks after a fragment jump
    (78228bc2a1). Removing it restored 0/17 v25 fallbacks and failed to render quotes (RESULTS v26). Never remove
    either flag (AGENTS.md).
  - Decisia injects the text after load, so a crawl settles for 4 s. Shells cached too early were the first replay
    bug (`purge-decisia-cache.mjs`, `purge-shells.mjs`).
  - Lexum (Norma) hosts block with a captcha after about 130 pages at 4 workers. Crawl with 1 worker in small
    batches and never bypass the captcha.
  - Its pink paragraph markers, about (255,219,242), are not paint: the replay detector requires blue >= red.
- **A2AJ Law Web (law.a2aj.ca, open source, run locally):**
  - It draws a document only after its `/fetch` answers: cases as one pre-wrapped text node, legislation line by line
    as `<p>`/`<h*>` blocks with `#` marks and `*emphasis*` stars dropped; only the first 200,001 characters until
    "load more". Links are planned on that page text (`law_web_page_text`, legal-structure passage_links.rs).
  - Chrome does not find a fragment in text that arrives late. Through a real local server
    (`law-web-server.mjs --delay-ms`, the cache tier's `--law-web-server`), 120 links that paint at 0 ms: 300 ms
    API latency, 99 on target and 20 nothing painted; 1,500 ms, 2 on target (2026-10-18). The in-browser replay
    answers `/fetch` at once, so its Law Web rates are an upper bound. Never measure against the live site.
- **Competition Tribunal (decisions.ct-tc.gc.ca):**
  - Older items are pdf-cards whose only text is a PDF; modern items render inline (RESULTS addendum 2026-08-23).
  - The 2026-10 crawl got HTTP 403 for 125 targets.
- **Dead pages:** 50 of 115 early misses were dead pages (bccourts "File Not Found", Decisia "Validation", tribunal
  errors). FCA 2026 FC 103 item 521765 is a real 404, excluded.
- **Detached punctuation:** bccourts renders `</i> :` and CITT renders `60. (1)`, where A2AJ has `Freedoms: s. 1`
  and `60.(1)`.
- **Cross-block merges:** A2AJ merges numbered lead-ins and list or quote continuations into one block, so a
  directive spans the publisher's `</p><p>` seam (BCCA 79 `[63] …ground that:</p><p>The Chambers…`).
- **Linkified citation clusters:** `s.<NBSP>11(d)` and `para.<NBSP>33`.
- **Front matter:** A2AJ case text includes the publisher's front matter (the SCC headnote and Cases Cited), so
  counting duplicates in the source sees what the page sees (5=5 on Colucci). A2AJ statute text starts at s 1, but
  CanLII's page shows the title and preamble. SC 2023 c 9 quote links therefore paint "Supply Chains Act" in the
  title. That is open: there is no general fix that proves uniqueness against text the engine doesn't have.
- **CanLII pages:**
  - a label is followed by an NBSP run (`[85]&nbsp;&nbsp;`);
  - Alberta legislation prints U+2011 where A2AJ has `-`;
  - statute anchors are `sec2` and `sec2subsec1`;
  - CanLII bot-blocks after about 2 fast loads, and relaunching the undetected-Chrome fetcher got the IP blocked on
    2026-10-16;
  - the F-7 and C-50 "pages" in the ALR cache are markdown, not CanLII HTML.
- **Legislation addresses:**
  - A2AJ gives XML feeds, API endpoints or PDFs: laws-lois `/eng/XML/*.xml`, bclaws `…/xml`, ontario.ca
    `/laws/api/v2/…`.
  - `crawl-pages.mjs` caches their HTML pages (`FullText.html`, bclaws without `/xml`, `/laws/statute/…`) via
    `builder-candidate.ts` `sourceUrl`.
  - Production dropped those rewrites when legislation started linking to CanLII (d2f020f48d), so a publisher-form
    legislation target still names the XML or API address.

## Planner history (legal-structure `query/src/document_query/text_fragment.rs`)

- **Full-document uniqueness is mandatory (faf7681bf1).**
  - Without `documentText`, the standalone path scored 29/40 with 11 mispaints, against 40/40 with the document.
    The standalone branch is deleted.
  - Grouped citations fed sibling receipts' quotes into the builder: 39/40. Grouped quotes are now filtered to their
    own block.
  - `b1b29b6f` (a long start/end range shortcut) caused early wrong matches and was removed (robustness doc).
- **Label trimming.**
  - Leading paragraph markers are omitted (b008053, 2026-09-12). `leading_label_length` handles bracket and dot
    forms. Bare SCC numbers (`44   At…`) were not trimmed (memory beaver-text-fragment-heading-bleed).
  - The 2026-10-14 range path (`range_fragment_plan`, df1247a/3226055a41) skipped the edge trim, so 460 workbook
    links started with `[85]`/`(a)` and painted nothing on CanLII.
  - Fixed by one shared `trimmed_selection` for the quote and range paths (72783b0). It required zero quote-plan
    differences on the equivalence corpus; a first merge that trimmed after locating changed 2 of 53,677 rows and
    was revised.
- **Heading bleed:** a case paragraph block ended at the next marker, so it held the following heading line, and
  ranges ended on a heading in another HTML block. The fix belongs in the block (Rust inference), not in the link
  builder.
- **Chromium context rule:** context only where whitespace alone parts it from the target (c23d924).
- **Short paragraphs** are linked by their own words, not by a range whose end starts inside its start (9be385e).
- **Hyphens (7c18088):**
  - Where the shortest range has a hyphen in a term or its context, the planner searches for a hyphen-free one,
    cutting a hyphenated endpoint at the hyphen. Hyphens are `-`, U+2010 and U+2011.
  - The exact-precedence check is read from the whole-endpoint range; a variant flipping it changed 2 plans and
    picked up a " - ".
  - 772 of 53,677 equivalence rows changed, every one a row that had a hyphen. 683 paint the same words; 665 are now
    hyphen-free.
  - Cache gate on the 28 changed CanLII seeds: 3 anchor-only became hits (Kennedy-44/45), with none lost.
- **Hard seams (2026-10-18), measured on the cached pages:**
  - No term holds a sentence end or a hyphen; seams fall only between terms, where Chrome takes any whitespace
    (a sentence end between prefix and start painted 22/23 on publisher pages, 7/7 on CanLII).
  - A term across a sentence end painted nothing on 36% of CanLII and 50% of publisher links (no-seam: 3%, 2%).
    Quotation marks, apostrophes and dashes inside terms failed ~1 in 10, so terms may hold them.
  - Abbreviation stops ("Mr.", "s.", "v.", "R.") are not sentence ends: of ~36,000 on cached SCC and CanLII pages
    none had a no-break space and a space; sentence ends had it 43-46% of the time.
  - A printed label is context only alone ("[101]-,In determining…"); a trimmed label's piece takes context back to
    its line's start. This tells apart a paragraph a headnote repeats.
  - Where no single directive selects a piece: an exact directive of it read to its sentence's edge, then a cover of
    its parts between seams. Seam-free pieces take an exact directive before a range.
- **Miss-class round (2026-10-18, r15-r18, every cached page, the fixed gate c515ed24e9):**
  - Kept: a passage opening its paragraph always takes its printed label as prefix (A/B over 3,690 links: elsewhere
    10 -> 3, on target +8, none worse); the paragraph read-back reads its start in order (a headnote repeating the
    passage no longer blocks it); "at para." / "at p.", "15 (1)" / "11 (e)" and "[101] In" are seams; statute names
    end a term on annotating hosts (legal-citations reference_names: A2AJ's statute titles, the Charter, the text's
    own cited titles and short forms). Net against r14 on the same links: +40 on target, 7 lost, no new wrong place.
  - Rejected: a note reference glued to a word ("interests.[1]") as a seam. Its lone number became a piece no
    directive selects, so whole passages lost their fragment (29, then 37 links), against 2 it was meant to fix.
  - Rejected: offering a spaced label whole ("45 (1)") beside its last part. The planner then paired it with shorter
    endpoints and failed wherever CanLII closes the label up ("9(1)"): 61 links lost against 4 won.
- **Speed (plans identical unless noted):**
  - 917615b: about 900 ms became about 60 ms on a long SCC paragraph.
  - 7d87ece and 2f8088a (2026-09-11): the Write stall, `range_directive_for` synchronous on the worker's main thread
    (memory beaver-write-stall-fragment-planner).
  - 122ea6a: replays start from a term's rarest word and the index is built in one pass. 6,574 plans took 14 s
    instead of 187 s.
  - 16f2d3a: per-plan memos. par47 went from 444 ms to about 50 ms; the 53,677-row equivalence is byte-identical.
  - 1a0151dab8: workbook plans run off-thread.
  - 113a8d81d2: plan cache, which 3226055a41 bypassed.
- **Sibling spellings (17e92b67f4):** plain plus padded directives for citation clusters. Unmatched siblings are
  harmless only for unique passages (see the browser facts).
- **Long passages:** the de7b195f restore deleted the range machinery, and whole-quote targets with labels
  regressed. c7fd0bb129 rebuilt start,end ranges.

## Corpus experiment (this folder), A2AJ text to publisher pages

- **2026-08-22 live gate:** 1,624/1,739 painted (93.4%) over 19 hosts. The 115 misses were 50 dead pages, 19
  pdf-cards and 46 projection gaps (detached punctuation, 25 cross-block merges, 3 NBSP clusters, 1 curly quote,
  14 unexplained).
- **Doctext key bug (RESULTS 2026-08-23):** labels with a locator silently fell back to block text. Fixed with the
  shared `seed-document-key.mjs`, which fails closed (2,371/2,371 full documents).
- **2026-08-24 headed strict gate:** 1,959/2,370 exact.
  - HTML: 1,886/2,149. The misses were mostly initial-viewport landings plus duplicates.
  - PDF: 73/221. Blind PDF was not reliable; the false `same_line` uniqueness constraint was removed (175/196 exact
    or safe-core).
- **v24 no-oracle router:** 612 Law Web rows, of which 446 were unnecessary switchovers.
- **v25** (word-count facts): exactly the 166 failures were selected, with 0 successes.
- **v26:**
  - Publisher PDF directive ordering (longest-first, rarity-first) by signature restored 68.
  - The final result was 2,369 strict exact plus 1 documented Saskatchewan PDF geometry limit (`RESULTS.md`).
  - The signatures in `legalSourceLinks.ts` are categorical facts, not per-seed identities.
- **Tried and rejected:** removing HTML anchors restored 0/74; removing Decisia mobile restored 0/17 and failed to
  render.
- **The 2026-10-07 opening/closing-words directive** is a reference row only; it is not to be restored (benchmarks
  PLAN).
- **Replay tier:**
  - `gate-replay.mjs` with `calibrate.mjs` certify replay against live verdicts.
  - Its placement check (quote's opening words within 60/200 px of the paint band) is coarse.
  - The cache tier's `paintInTarget` share is the stricter measure.

## CanLII links planned from A2AJ text (ALR workbooks, cache tier)

- **Gate:** `benchmarks/text_fragment_fidelity/run.mjs --tier cache`.
  - It serves the Pinpointer corpus (497 CanLII pages) and the ALR `cache/canlii_html` (507); there are 510 distinct
    pages.
  - Seeds come from the workbook arm via scratchpad 60d2d41f `wb_seeds2.py`.
  - Verdicts come from `wb_verdicts2.py`:
    - hit: at least 90% of paint inside the intended words' box;
    - straddles: 50-90%;
    - painted elsewhere: under 50%;
    - also front matter, anchor only, and painted nothing off target.
  - `wb_verdicts2` keys rows by URL and undercounts seeds that share a URL. Use scratchpad 63fdd553
    `stat/verdict_by_id.py`, which keys by seed id.
- **2026-10-16 baseline:** 428 links, 362 cached, about 67% hit.
- **56471ec6cc** (a reference shows its own pinpointed passage): 469/546 cached links hit (86%).
- **6d3b6a46d4** (a provision link paints the pinpointed part, s 650(2)(a), not the section's opening): statute
  citations went from 59 to 83 hits, and painted elsewhere from 25 to 3. 46 cells changed; no hit was lost.
- **e5628b9bf2** (fragment guard): a link whose page is not the document the passage was read from keeps its anchor
  and drops the fragment. Kennedy-57/58 went from painted elsewhere to anchor only; 14 links changed, all real
  mismatches.
- **ef24b67fa7** (references resolved once at import): 3 new quote links. Wright fn77's two-quote link paints
  elsewhere, because the first phrase sits in s 241.2(2).
- **The Pinpointer oracle** (`paint-gate-full-v3.jsonl`, planned from CanLII's own text): 3,496/3,582 exact. 86
  planned no directive: planner gaps.

## Harness facts

- **Tools:**
  - The planner equivalence tier is `planner-equivalence.mts` plus `compare-equivalence.mjs` (53,677 rows). A pure
    speed change must be byte-identical. Equivalence result folders live in `results/equivalence`.
  - `build-targets.mts` materializes production targets from the full documents; `results/targets.jsonl` holds 7,797.
  - `crawl-pages.mjs` caches each page once (`results/page-html`, `page-html-manifest.jsonl`).
- **Cost:** run one release native build per round, in place. Never use scratch Cargo targets (memory
  beaver-native-addon-locked-rebuild).
- **Paint colours:** the replay gates look for lavender (231,209,252). The cache tier forces magenta
  (255,0,255) through `::target-text`.
- **Cache-tier measurement errors fixed (2026-10-18, the r14 miss analysis):**
  - Seeds split a block at every `[N] `, so a citation's `[2017] 1 S.C.R.` cut `within` short and the gate measured
    another occurrence. Pieces now split only at labels printed like the block's own, after a sentence end, numbering
    a later paragraph (the next one where the document holds the block in one run). Passage targets are the
    pinpoint's own piece. Seeds carry the source words around each quotation (`contexts`, from the planner's
    `sourceWordIntervals`); the gate uses them only to choose among occurrences inside the cited block, which is kept
    to the anchor's passage where the page has one.
  - Law Web pages are gated one at a time after the rest: at `--workers 4` their text arrived late and 80 links
    painted nothing that paint one at a time.
  - `excluded: "bad page"` (a cached error page, by its short title or heading) and `"no target"` (under a quarter
    of the block's six-word runs are in its document, and nothing painted) leave the denominator.
  - Screenshot names replace `:`, so `--no-shots` is no longer needed on Windows.
  - Re-gate of r14's 216 failures: 80 Law Web nothing-painted and 22 of 26 wrong-target rows now paint on target
    (paint inside the cited block); 6 W2 rows too, whose blocks join non-adjacent cited paragraphs (65 + 69) rather
    than run on; 7 rows "no target", 1 "bad page". 300 earlier hits stayed on target; 3 became straddles because the
    box is now the quoted occurrence, not the whole block, so long-range overpaint shows.
- **2026-10-18 rounds d22–d24 (combined corpus: brief-derived links, 521 real quotations, 2,080 provider parts; 17,721
  links, ~13,900 judged):** 95.8% on target / 97.2% on target or at the anchor → 97.8% / 98.6%.
  - Planner (legal-structure 3985063, then the shed/glued/seamed commit): a prefix or suffix stays inside the
    passage's sentence (a page prints the sentence end otherwise: −255 → −59 wrong place); markdown marks adjoin a
    label; a citation's pinpoint part is painted or nothing is; a term's outer punctuation is shed where the shed
    term still selects (a page prints "(Emphasis added)" for the document's "[Emphasis added.]"; +36 links, −10
    where the mark was what told "In this Act:" from a table of contents); New Brunswick glues "57An application"
    (`publisher_glues_section_labels`, +16 of 29 section openings); a context across a sentence end is read where
    none other tells a headnote-repeated sentence apart.
  - Gate: CanLII sets `sec12` after `sec12subsec1`, so the anchor's passage ended before it began (target null);
    words found outside the anchor's passage (a header's copy) are now the passage's. 18 verdicts changed.
  - Reuse keys carry the link: a verdict rekeyed from a seed whose link changed is wrong (one round was re-run).
  - Residue by cause (read off the cached pages, not guessed): pages holding another version of the text (Alberta
    "Board"→"Regulator", SOR/2005-99 dropped from Justice Laws) ~38; pages without anchors where the words alone
    cannot settle it (bccourts 1999–2001 `.txt` wraps lines, so a term cannot straddle one; Alberta KP and Nova
    Scotia print no ids); SCR judgments before 1995 are numbered by no publisher (A2AJ, Lexum and CanLII alike), so
    a bare paragraph pinpoint into them has nothing to land on. Lexum pages before 2016 print no `par` anchors.
  - Routing (3,904 labels judged on both a publisher's page and CanLII's): publisher always 99.08 / 99.28; CanLII
    always 98.13 / 99.46; CanLII only where the engine can print no anchor on the publisher's page 99.15 / 99.54;
    oracle 99.46 / 99.97. The anchor is the fallback guarantee; its absence is the failure mode.
