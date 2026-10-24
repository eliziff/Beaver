# Structure gold conventions

What the gold means, written down once, so the runner's prompts, the post-corrections, the scorer's
groups and the parser all read the same rules. A convention here is a ruling; a model's answer is
evidence that gets read through these rulings, and a post-correction applies a ruling to existing
gold without re-authoring it. Every post-correction is recorded in the gold file under
`postcorrections`, with what it changed, so it can be undone.

## 1. Regions

The lines pass types every printed line. The disputed boundaries, and the ruling for each:

| what the page shows | region | not |
|---|---|---|
| running head or foot repeated across pages, folio numbers | `furniture`, `page_label` | heading |
| a transcript's printed line number, in its own column or printed on the line it numbers | `line_label`, a unit of its own | part of the line's text, a marker |
| court name, docket, "BETWEEN", party and counsel blocks, judge and date lines, form field labels, signature blocks | `caption` | heading |
| catchlines and syllabus lines of a law report ("Evidence.—Public documents.") | `headnote` | heading |
| statute side notes printed in the margin or above a section in smaller type | `marginal_note` | heading |
| a sentence that ends in a colon and introduces what follows ("Your password must include:") | `text` | heading |
| a cell of a table, including header cells | `table` | heading |
| a contents entry with a locator | `contents` | heading |
| a title line: short, set apart by type, position or numbering, naming the part that follows | `heading` | |
| a block quotation, numbered or not (a quoted order's "1." and "(a)") | `quote` | text, list_item |
| a numbered body unit | `text` or `list_item` by section 6, decided for the whole document | decided per page |

A heading is a title. It names the stretch of document that follows it. It is never a sentence of
running prose, never a field label with a value beside it, and never furniture. The same words can
be a heading in one place and a caption in another (a court name on a cover page is caption; a court
name printed as the title of a reasons section is heading); the ruling is about the role on the
page, not the words.

A transcript's line numbers locate its text: a page label and a line label together pinpoint any
line ("p. 451, l. 12"). Each printed line number is its own `line_label` unit, beside the line it
numbers, so the gold and the parser both carry them and a reader can cite by page and line.

## 2. Hierarchy

The gold's hierarchy is deterministic from four things: regions, heading levels, numbering families
and document boundaries. The model decides only heading levels and document boundaries. Everything
else follows by rule, in reading order, within each document:

1. A **heading** of level L falls under the nearest earlier heading of a smaller level, else it is
   a root. Level 1 is the outermost heading of its document; headings of one kind (same type, same
   numbering family) share a level; a numbering family that opens inside another is deeper.
2. **Text**, **table**, **caption** and **headnote** units fall under the nearest earlier heading
   (any level), else root. Ordinary prose paragraphs are peers under their heading; an unnumbered
   paragraph after a numbered one is its sibling, not its child.
3. A **list item** continues an open list of its numbering family (same parent as that family's
   earlier items); a new family falls under the unit before it (the lead-in paragraph, or the outer
   item); an unmarked item continues the innermost open list. A text unit or heading closes all
   open lists.
4. A **quote** falls under the unit before it; a quote after a quote shares its parent.
5. **Notes**, **marginal notes**, **contents**, **furniture**, **page labels** and **line labels**
   are outside the hierarchy.
6. A **document boundary** (a judgment followed by its exhibits, a book of articles) resets the
   stack: the first unit of each document is a root.

The scorer still compares parents, so this is also what the parser must produce. A parser that gets
regions and heading levels right gets the hierarchy right by construction.

## 3. Heading levels

Given by the hierarchy pass as `[row, level]` for heading rows, 1 the outermost in the document.
Guidance to the model, not rules: numbering outranks type (PART > ARTICLE > I. > A. > 1. > (a));
larger, bolder, centred or capitalised type outranks smaller or plainer type at the same numbering;
a title that follows a lead-in is deeper than the lead-in's own heading. For existing gold the
level is read from the gold's heading-to-heading ancestry (one plus the count of heading ancestors)
before parents are rebuilt by section 2.

## 4. Data groups

Each gold source carries these fields in the corpus store (`gold_source_groups`) and in the cohort
manifest, and the scorer reports every layer per group without being asked:

- `language_layout`: `en`, `fr`, `parallel` (English and French each carry a quarter or more of
  the ranked units: bilingual statutes, two-column reports), `mixed` (both present, one dominant).
- `genre_group`: `judgment`, `legislation` (acts, regulations, bylaws, compilations),
  `court-rules` (rules, practice notes and directions), `filing` (affidavits, applications,
  notices, orders, motions, submissions, pleadings, certificates, summonses), `contract`
  (agreements, leases), `transcript`, `publication` (reports, briefing notes, policy documents,
  monographs), `compilation` (books of authorities, case records, exhibits bundles),
  `court-form` (blank or instructional forms: also any document with a blank to fill in on every
  page on average, four or more lines of four underscores, whatever its collection called it),
  `administrative` (agendas, emails, correspondence, presentations), `other`.
- `country`: ISO code from provenance (`ca`, `us`, `au`, …).
- `yardstick`: `main` (Canadian, `language_layout` en or fr, genre_group among judgment,
  legislation, court-rules, filing, contract, transcript, publication, compilation);
  `bilingual` (parallel layout, any country); `forms` (court-form); `foreign` (not Canadian, not
  parallel); `other` (administrative, other, unknown). Headline numbers are `main`; the other
  groups are reported beside it, never pooled into it.

These are assignments from provenance and the gold's own text, recomputed by `groups.py`.

## 5. Post-corrections

| name | ruling | module |
|---|---|---|
| `running_heads` | section 1, furniture | `postcorrect.py` |
| `hierarchy_from_headings` | section 2 and 3; a historical record on golds rebuilt before the writer applied the rule. author.py writes parents with `assemble`, and the grader refuses a gold whose parents differ from it: there is no converter. | `author.py` |
| `numbering` | section 6, on golds authored before the numbering pass: `author.py --renumber` runs the pass alone and rebuilds parents | `numbering.py` |

A post-correction is applied by the runner to new gold and by its module's command to existing
gold; the gold file records `{"name", "module_sha256", "changes"}` per correction.

## 6. Numbering

A **marker** is a printed number, letter, roman numeral or bullet that counts or enumerates. A
speaker label (Q., A., MR. SMITH:), a checkbox and a field label (TO:, cc., RE:) are not markers;
they stay in their unit's text. A transcript's line number is not a marker either: it is a
`line_label` (section 1).

What a numbered unit is depends on the whole document's numbering, never on its page, so the lines
pass only transcribes the marker and the **numbering pass** decides, once per document. A **run** is
the units of one numbering family whose count continues, wherever they fall: paragraph 18 resumes
paragraphs 1 to 17 after a list of its own 1 to 6. Every unit of a run gets the run's kind:

| kind | what it is | region | marker |
|---|---|---|---|
| paragraph | the document's own numbered paragraphs, clauses, sections or recitals, however numbered: an affidavit's "1. I am", a judgment's "[12]", a factum's "23.", a contract's "2.03" and "A." recitals, a statute's "12 (1)" and "(2)", an examination's numbered questions ("62 Q.", cited as "Q. 62" in refusals and undertakings charts) | `text` | kept |
| list | the items of a list inside or after a paragraph: (a), i., bullets, a statute's paragraphs and subparagraphs, issues, the items of a prayer for relief, a count restarting after a lead-in ("the Court refused:" then 1. 2. 3.) | `list_item` | kept |
| plain | not numbering after all (speaker labels, field labels the lines pass marked) | `text` | removed |
| option | a form's checkbox options | `list_item` | removed |

Two kinds are fixed by rule: decimal numbering ("3.1", "11.2") is the document's own addressable
numbering, so a paragraph; a letter, roman or bullet run that a lead-in ending in a colon opens at
its first value is a list. The model decides every other run, seeing all of the document's runs at
once.

What the agreement test showed (2026-10-24, 36 documents authored twice): headings 0.989, numbered
paragraphs 0.987, list items 0.984, notes 0.989, note references 1.000. Two authorings split on
quoted numbered items and on decimal subclauses after a lead-in, the two rulings above. Signature
blocks (table or text), exhibit page stamps (furniture or page label), unmarked notices (text or
note) and affidavit cover lines (headnote or text) also split; they are left unruled, as edge cases
of layers that are not headline.

## 7. Checks

- **Self-check** (`structure-gold selfcheck STORE MANIFEST labels|self`): the scorer reads the gold
  back at 1.0 on every layer. It proves the scorer, not the gold.
- **Consistency census** (`numbered_census.py STORE GROUPS`): no run is labelled both ways inside a
  document, and each pattern of run (family, what introduces it, whether it starts its count) has
  one label across documents. A split pattern is a convention not yet written here.
- **Agreement** (`structure-gold selfcheck STORE_A MANIFEST agree --other STORE_B`): the same
  documents authored twice, independently, scored against each other. Two authorings that disagree
  on a layer mean the convention for that layer is not pinned down, whatever either one scores.
