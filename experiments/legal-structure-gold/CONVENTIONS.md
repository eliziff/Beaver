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
| court name, docket, "BETWEEN", party and counsel blocks, judge and date lines, form field labels, signature blocks | `caption` | heading |
| catchlines and syllabus lines of a law report ("Evidence.—Public documents.") | `headnote` | heading |
| statute side notes printed in the margin or above a section in smaller type | `marginal_note` | heading |
| a sentence that ends in a colon and introduces what follows ("Your password must include:") | `text` | heading |
| a numbered or lettered item whose body follows on the same line or below it | `list_item` | heading |
| a cell of a table, including header cells | `table` | heading |
| a contents entry with a locator | `contents` | heading |
| a title line: short, set apart by type, position or numbering, naming the part that follows | `heading` | |
| an enumerated clause or item: "1.", "2.1", "(3)", "(a)", "iv.", a bullet | `list_item` | text |
| a bracketed paragraph number "[12]", or a statute section's bare number before "(1)" | `text` with a marker | list_item |

A heading is a title. It names the stretch of document that follows it. It is never a sentence of
running prose, never a field label with a value beside it, and never furniture. The same words can
be a heading in one place and a caption in another (a court name on a cover page is caption; a court
name printed as the title of a reasons section is heading); the ruling is about the role on the
page, not the words.

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
5. **Notes**, **marginal notes**, **contents**, **furniture** and **page labels** are outside the
   hierarchy.
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
| `hierarchy_from_headings` | section 2 and 3 | `hierarchy.py` |

A post-correction is applied by the runner to new gold and by its module's command to existing
gold; the gold file records `{"name", "module_sha256", "changes"}` per correction.
