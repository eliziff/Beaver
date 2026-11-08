# The parser's consolidation and decoupling: the plan

One implementation per concept, tier 0 read once and fed to tier 1, one writer, and the stages decoupled hub-and-spoke
(`docs/structure-decoupling-plan.md`'s architecture). Built from the duplication map (112 claims, each checked by two
readers of the code, 2026-11-07).

## Rules every unit keeps

1. **Byte-identical.** Every unit leaves the parse output identical, DOC off and on. Anything that would shift a byte is
   not a unit; it goes to `CONSOLIDATION-LATER.md`.
2. **Identical by design.** Two implementations of one concept become one, and their real difference is an input each
   caller passes (a tie-break, a context key, a precedence), so each caller gets exactly today's output. A merge is "held
   for later" only where no such input can reproduce both.
3. **Proof.** `structure-gold digest STORE OUT` (no grading) before and after, then `fc /b` on the two files. With DOC on,
   identical means differing only on the 42 documents DOC already reads differently from run to run (LATER item 5).
4. **Other sessions** edit `decide/`, `transition/`, `legal-pdf-support` and `native/a2aj-gold`. Before a unit moves or
   rewrites one of their files, check `ListAgents`. Land each stage's move in one commit.

## Done (uncommitted, proven or being proven)

| Unit | What | Proof |
|---|---|---|
| 1 | Tier 0 decides once; the walk (`over_tier0`) takes its Notes and Decision; `doc_moves`, `tier0::decided` and `structure.rs`'s separate walk gone | identical, DOC off and on, every split |
| 2 | One graph writer: `Settled` required in `emit::structure_graph`; every `!written` branch, `gap_cells`, `COLUMN_TOLERANCE`, the unit-note footnote builder, `paired`, `apart` and the provision retain gone (emit.rs 758 -> 465 lines) | identical, DOC off and on |
| 3 | `LineTable::read` built on `LineTable::plain`; `views_of` built on `tier0::line_views` | identical DOC off; DOC on only the 42 |
| 5 | The decision's stage-parser claim mode where it cannot run: `read`'s `hearing` parameter (always true; its `named` and anchor fallbacks), `read_runs`' first-come guard, the residual's direct writer and its `hearing &&` (`weigh` and `read_runs` run only inside `read`). `claim`/`fill`/`open`'s first-come arms stay: `finish` runs with `hearing` off. | pending |
| 6 | emit's six `page_indexes` writes: `outline_contexts` sets every node's from its lines, and nothing reads them before | pending |
| 4 | One opening-reading choice (`LineView::opening`, the tie-break an input); DOC uses the machine's `Open::opens`/`Open::count`, `counted` private; each node's marker range and label set once in one precedence; emit's dead `heading_range` write gone; one region table (`machine::region_of`) with the page's region names derived from it (`machine::page_region`) for `write.rs` and `runs.rs`; `whole.rs`'s dead `chain_of` and `SLOTS` gone | to hash |

## The crates (2026-11-07)

`legal-pdf-structure` was one crate of 23,000 lines. Its module cycles are cut (`ladder_levels` into the heading rules,
`grammar_rank` into the rules, the text index and line numbers out of the graph, the region vocabulary out of the
machine), and it is now a 225-line orchestrator over these crates under `legal-pdf-parser`, each depending on the
contract and on crates below it, never on one above:

| Crate | What | Lines |
|---|---|---|
| `legal-pdf-structure-model` | the contract, data only: slots and page views, roles, rules, edges, the regions, the evidence (`Evidence`, its flags, `Rows`, `NoteLabel`, `MarkerReading`), the numbered paragraphs, the runs, the decision by line id (`Decided`), `StructureIdentity` | ~950 |
| `legal-pdf-text` | a paragraph's measure, the heading ladder, the words of text and labels, joining, the text index, line numbers | ~1,700 |
| `legal-pdf-layout` | regions, columns, tables, reading order, language, note-band lines, each page's `Geometry` | ~1,270 |
| `legal-pdf-headings` | headings, contents lists, captions | ~1,580 |
| `legal-pdf-notes` | the note band and lanes, note context, the pairer | ~2,400 |
| `legal-pdf-furniture` | running heads and feet, folios, frame rows | ~870 |
| `legal-pdf-constituents` | the documents a PDF holds | ~410 |
| `legal-pdf-evidence` | the pages normalized and every line measured (`Measure` for `Evidence`) | ~730 |
| `legal-pdf-fences` | the lines fenced and ordered (`Fences` and its readers), the judgment's numbered paragraphs | ~2,300 |
| `legal-pdf-runs` | the numbering runs read and resolved (`Numbering` for `Runs`) | ~620 |
| `legal-pdf-decide` | the decision: every rule heard, the residual, the levels, the notes read, the lines written, the trace | ~2,650 |
| `legal-pdf-graph` | the structure graph's writers | ~810 |
| `legal-pdf-diagnostics` | the parse's diagnostics and checks | ~350 |
| `legal-pdf-machine` | the machine's types every tier reads: line views, moves, the state, the line table, the grammar | ~1,440 |
| `legal-pdf-tier0` | tier 0: every rule heard on every line, one decision per line, the moves of the written lines | ~520 |
| `legal-pdf-transition` | the walk over tier 0's reading and DOC (`encoder`), with the walker's readers | ~3,900 |
| `legal-pdf-emit` | the one writer of the structure graph | ~460 |
| `legal-pdf-structure` | the orchestrator: tier 0, then the walk and DOC over its reading, then the writer | ~225 |

A stage's logic over a contract type stays with the stage as a trait the type implements (`Measure` for `Evidence`,
`Numbering` for `Runs`), so no caller changed. Every moved crate imports each constant it names: an unimported constant
in a match arm binds a variable instead and matches anything.

Build time (desktop, an incremental release build of the grader after a real one-line edit; was 3 min 15 s for one
file anywhere in the stage): orchestrator 14 s, tier 0 6 s, the writer 6 s, DOC 14 s, the machine 14 s, the decision
13 s, the notes 9 s, the graph 7 s, the text crate 8 s.

Proof: identical, DOC off and on, on every document of the gold store, for everything through legal-pdf-parser 761bc0b
(the split up to here but evidence, fences and runs, which are being hashed).

## Units to do, in order

Order: the decoupling first (units 9-12), because its measure is build time (a one-stage edit rebuilds that crate and
relinks in seconds, where today a one-file edit rebuilds 22,000 lines and everything above them in minutes) and every
later unit then builds in seconds; then the merges (units 5-8) and the walker (13). Build times are timed before
(`scripts/build-times.ps1`) and after, per crate, the addon and each tool.

### 5. Dead mode and dead branches (delete; identical by construction)
- `decide/rules.rs`: the stage parser's claim mode. Delete the `hearing` field and `read`'s `hearing` parameter, the
  non-hearing arm of `claim` (175-184) and `open` (205), `read`'s `named` else, the `!self.hearing` guard in `read_runs`
  (539), and `residual.rs`'s non-hearing writer (456-460) and `|| hearing` (256). `finish` keeps a plain first-come fill
  of open lines as its own function (it relies on that behaviour). Claims 17, 72, 105.
- `diagnostics.rs` `validate_pdf_components` 298-311: one rule, every Section needs a locator unless it is a
  constituent (no producer writes `heading_section`; the origin branch can't fire). Claim 13.
- The dead detached-reference branches in `evidence.rs`, `notes/lines.rs`, `note_context.rs`, `graph/line_numbers.rs`
  (107, 125), and `NoteWalk::fenced` with its `LastNote` updates and `set_apart`'s `Role::Note` arm. Claims 44, 45.
- Stale docs on two readers (`tier0.rs` 1-3, `mod.rs` 13-17, emit's header) and the dead reader setting. Claims 14, 33, 111.

### 6. Fields set and then overwritten (delete the first write)
- emit sets `page_indexes` and the range envelope that `graph/contexts.rs` `outline_contexts` recomputes for every node;
  emit keeps what the pass reads (`ranges`, `line_ids`) and drops what it overwrites. Same check as the dead
  `heading_range` (nothing reads them in between). Claim 3.
- `legal-pdf-support` `projection/document.rs`: `project` builds `recognized_pages` and the caller replaces them at once;
  build them once (claim 84). Another session is editing `legal-pdf-support` (`page_map.rs`): coordinate first.

### 7. One function per small concept (identical by design)
- A note line's number: one `note_number` (DOC's is the most complete, the others a subset); the pairer's label keeps
  precedence where it paired, as today. Claim 29.
- Raised/small and glued reference-mark tests: one function each, used by the pairer's finder and by `evidence`. Claim 40.
- The recognizer's confusion table: one table, read by `numbering_repair` and the pairer's repairs. Claim 39.
- The structure engine handed to the parsers through two globals: one channel (one global in `legal-structure-model`
  that `legal_pdf_core` reads, or `&dyn StructureAnalysis` passed explicitly). Claim 94.
- ONNX session loading, runtime discovery and softmax/argmax: one helper beside `legal_pdf_core::init_ort_runtime`, and
  the grader calls it. Claim 108.
- The gold's region, stream, level-step and depth-step vocabulary, copied in `machine.rs` and the tagger's `labels.rs`:
  one definition in the contract crate (unit 10). Claims 73, 78, 106.

### 8. Every reading of a line's opening marker read once (checked: not identical; held, LATER item 7)
`candidates::marker_readings` is the grammar. `Evidence` reads each line's readings once (with end and `only`);
`opening_marker` becomes the first of them, and `LineTable` takes evidence's readings instead of reading again. Before
writing it, check that every reader asks the grammar the same question (text, word-division flag); where one passes a
different text (the recognized-before-repair text, a variant), that text is the input. Claim 50.

### 9. Break the module cycles (decoupling plan step 2)
`ladder_levels` from `decide` into `heading_ladder`; `PdfTextIndex` and `grammar_rank`/`split_line_numbers` from `graph`
to the module that owns the data they read. These three are only what stands between the modules and a crate split;
the decoupling itself is units 10-12, and it reaches past the stage modules:
- **The tiers apart.** Tier 0 (`tier0.rs`, `machine.rs`, `lines.rs`'s plain table) is a crate; DOC (`doc.rs`, `encoder.rs`,
  `stylesheet.rs`, `grammar.rs`, `lines.rs`'s features) is a crate over the contract, taking tier 0's output type and
  returning moves, behind the `encoder` feature, so the default build links no ONNX; the writer (`emit.rs`) is a crate
  taking moves. The walker readers (`whole.rs`, `joint.rs`, `trees.rs`, the walk in `mod.rs`) are their own crate until
  unit 13 settles them.
- **`decide` apart.** `decide` is 6,700 lines: the evidence reader (`evidence.rs`), the fences (furniture, folios, page
  labels, margin numbers, contents, constituents, quotations, continuations), the runs (`runs.rs`), the paragraphs
  (`paragraphs/`), the rules and decision (`rules.rs`, `residual.rs`, `levels.rs`) and the writer (`write.rs`). Each is
  a stage crate reading the earlier stages' output types, not `Fences` as one struct.
- **Notes apart.** `notes/` (band, lanes, segments), `note_context.rs` and the pairer glue (`note_pairing.rs`) are one
  notes crate whose output (the band, the notes, the pairs) is a contract type.
- **The graph apart.** `graph/` (nodes, contexts, outline, judgment) and `diagnostics.rs` are the graph crate, reading
  moves and stage outputs.
- **Above the parser.** `legal-pdf-support`'s projection reads `DocumentStructure` only (no parser internals);
  `native/legal-structure-node`'s engine and dispatch call the orchestrator and the projection, nothing deeper; the
  harness bins become harness crates (unit 12). `legal-structure` keeps its crates (`model`, `features`, `query`,
  `opinion`); the parser reads them through `legal-structure-model` and the `StructureAnalysis` channel (unit 7) only.

### 10. Name the imports; the contract crate (decoupling steps 3-4)
- Every `use super::*` in `legal-pdf-structure` becomes explicit imports.
- `legal-pdf-structure-model`, data only: slots, line views, the line table, and each stage's output as plain types:
  page numbers (label, source, line), furniture (role and edge per line), note band, runs, headings, contents,
  constituents, the decision (role, unit, level per line), moves; and the region/stream vocabulary (unit 7).
- `Fences` split into those per-stage outputs (today it holds furniture, folios, page labels, line labels, margin
  numbers, contents and more).
- t0 feeds t1 through the contract: tier 0's output (Notes, Decision, line table) is a model type; DOC takes it as its
  input and returns moves.

### 11. Lift the stages out, one crate each, smallest first (decoupling step 5)
Pages (folios, page labels), furniture, notes, headings/contents/captions, runs/paragraphs/joining/text, graph, decide,
transition. Each depends on the contract crate only; the orchestrator (~300 lines) calls them in order. One commit per
stage, hashed identical.

### 12. Cache per stage; harness crates; one feature set (decoupling steps 6-8)
Each stage's cached output under its own version; the node crate's harness bins (`pinpoint-corpus`, `a2aj_corpus`,
`courtlistener-structure`, ...) into harness crates as `native/a2aj-gold` was; `cargo hakari` workspace-hack in place of
the hand-added `syn` line. Measure build times before and after (decoupling step 1 and 9).

### 13. The walker readers (non-default settings only)
The forest walk, beam, `joint::solve`, `whole.rs` and their local forests and `mod::oracle` change no default or DOC
output (claims 21, 95, 103, 109). DOC is tier 1, and the forests are superseded unless an ablation says otherwise
(memory, `doc-is-tier-one`). Delete them once the ablation ledger confirms none of them is still measured; DOC's own
oracle stays.

## Held for later (they cannot be byte-identical; in `CONSOLIDATION-LATER.md`)
- Two parent rules on one parse (`hierarchy::assemble` gives aliases, `assemble_outline` gives the kept tree). Claims 0,
  23, 63, 80. LATER 6.
- A judgment's paragraph nodes written by emit and then patched by `read_judgment_paragraphs` after assembly; assembly
  overwrites an extent set before it, so moving the write changes extents. Claims 1, 24, 47, 81.
- The heading-marker regex in place of the grammar's reading. Claims 2, 30, 68 (the three writes are now one, unit 4).
- One line table for both tiers (t0 would read DOC's misreadings and recovered marks). Claims 9, 19, 98. LATER 1, 3.
- DOC's moves through tier 0's decoder (DOC breaks ties by its stack; its units lose `opened`/`within`). Claims 70, 97.
- Notes decided once by the pairer before the moves (band, endnote, continuation, label, `give_back`). Claims 28, 34-38,
  41, 42, 102. Each sub-merge is checked for identity first; most move a note decision earlier, which changes output.
- Runs as the one numbering reader (depth from the member's level). Claims 20, 22, 69.
- The paragraph count, its recognizer, misread repair, second printings, rows, ends, furniture in the judgment reader,
  provider text's numbering, quote blocks, locator resolution, outlines, joins, statute provisions, page labels in JS.
  Claims 25-27, 48, 49, 51-58, 82, 85-93. Product-level: each changes what a consumer reads.
- DOC reading anchors and levels from the Decision instead of re-matching contents (DOC output changes). Claims 65, 71, 104.
- One template key (look identity) for LineTable, Stylesheet and State. Claim 66 (the readers' keys differ today).
- The tagger's `retag` writing over tier 0's graph, and its features and decoder. Claims 11, 79, 107. The tagger is an
  opt-in tier; it goes through emit once it supplies moves.
- `Move.rank`, DOC's reading order, read by no writer since c98205f. LATER 4.
- DOC's run-to-run differences on 42 documents. LATER 5.

## Not duplicates (checked)
- `write.rs`'s page region names and tier 0's regions: one now, with the page names derived (unit 4).
- The page-label writers (claim 16): one writer already; emit's copy was dead.
- The machine's replays of moves (claim 18): one builder and one state, called at three points with different evidence.
- The `LineView` builders' remap (claims 60, 99) and the opening reading (claim 101): done in units 3 and 4.
- The A2AJ aligner's experiments copy (claim 62) and the CourtListener opinion layer (claims 61, 88, 89): tools and a
  separate layer; they go with unit 12's harness crates and the opinion layer's own work.

## Last

Actually fix the fucking A2AJ gold.
