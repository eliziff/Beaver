# Decoupling the native stack so builds are fast

A plan for an agent to carry out. Goal: an edit to any one stage of the PDF structure engine, or to any one tool, rebuilds
that stage or tool and relinks, in well under a minute, and switching between building the engine, the addon and the
tools never rebuilds the stack. Behaviour does not change: every step lands with the engine's output identical.

## What is wrong today (measured 2026-11-07)

- `legal-pdf-parser/legal-pdf-structure` is one crate of 74 files, 22,064 lines: `structure/decide` 6,739,
  `structure/transition` 6,249, `structure/notes` 1,888, `layout` 1,178, `structure/graph` 1,146, `structure/headings`
  855, `structure/furniture` 846, `paragraphs` 590, `contents_lists` 482, `constituents` 394, `diagnostics` 346,
  `note_context` 271, `heading_ladder` 248, `joining` 171, `text` 141, `note_pairing` 134, `captions` 113, `structure.rs` 269.
  An edit anywhere recompiles all 22,000 lines in release, then everything above it (the parser crate, the node engine,
  every tool). A clean rebuild of it and its dependents took 8 min 19 s; a one-file edit took 2-4 min.
- Every module reads its siblings through `use super::*` (the parent's glob), so nothing states what it depends on and
  any split first has to name each import.
- Stage internals cross stages directly. The real code edges between modules (comments aside) are:
  - `headings -> decide::ladder_levels`
  - `constituents -> graph::PdfTextIndex`
  - `decide -> graph::{grammar_rank, split_line_numbers}`
  - `decide -> {captions, constituents, contents_lists, furniture, heading_ladder, headings, notes, paragraphs}`
  - `transition -> {constituents, contents_lists, decide, graph, headings, joining, note_pairing, notes}`
  - `structure.rs -> {decide, graph, layout, notes, transition}`
  So the only cycles (`headings <-> decide`, and `decide -> graph -> ... -> decide`) come from three small items in the
  wrong place.
- The stage outputs are cached to disk as one struct (`Measured { evidence, fences, runs }`, written with
  `write_gzip_json`), so the cache format couples to every stage's private fields.
- Tools were compiled into the engine crate. `pinpoint-corpus` pulled the whole A2AJ gold harness in through
  `#[path]` includes, and an edit to it re-optimised 8,500 lines. That one is fixed: `native/a2aj-gold` is its own crate
  with bins `a2aj-gold`, `a2aj-volumes`, `page-labels-check`, `reporter-pins` over a library, and a bin-only edit now
  rebuilds in about 20 s.
- Feature sets differed between builds of the same crates in different workspaces or packages (`serde_json/float_roundtrip`
  in the gold build only; `syn/full` from `napi-derive` in the node build only), so each build rebuilt every crate that
  derives serde. That one is fixed too: `serde_json` carries `float_roundtrip` in the node crate, and `a2aj-gold`
  asks for `syn` with `full` as a build dependency (`cargo-hakari`'s workspace-hack). `cargo tree -e features` on
  `-p a2aj-gold` and on `-p legal-structure-node --features corpus` showed 269 shared crates and no difference.

## The architecture

Hub and spoke, not a chain. A chain (readers -> decide -> transition -> top) still rebuilds everything above an edit.
Instead every stage depends only on a small, stable contract crate, and one thin orchestrator depends on the stages:

```
legal-pdf-core (existing: Page, Line, extraction model)
      |
legal-pdf-structure-model            <- the contracts: data only, no logic
  slots, rows, line views, the line table;
  each stage's OUTPUT as plain data (serde):
    PageNumbers (each page's printed label, its source and line),
    Furniture (each line's furniture role and edge), NoteBand, Runs, Headings,
    Contents, Constituents, Decision (each line's role, unit, level), Moves
      |
      +-- legal-pdf-pages       folio witnesses (edge_folios, alternating_folios), the folio sequence, each page's label
      +-- legal-pdf-furniture   running heads, feet, frame rows, document ids
      +-- legal-pdf-notes       note band, note context, note pairing
      +-- legal-pdf-headings    headings, heading ladder, captions, contents lists
      +-- legal-pdf-runs        numbering runs, paragraphs, joining, text
      +-- legal-pdf-decide      the decision (reads the stages' outputs, writes Decision)
      +-- legal-pdf-transition  the transition parser (reads Decision and the outputs, writes Moves)
      +-- legal-pdf-graph       the structure graph and diagnostics (reads everything, writes DocumentStructure)
      |
legal-pdf-structure                   <- the orchestrator: ~300 lines, calls each stage in order, owns the cache
```

Rules that make it hold:

1. A stage crate depends on `legal-pdf-structure-model` and external crates only, never on a sibling stage. What a stage
   needs from another is that stage's output type in the model crate, handed to it by the orchestrator.
2. Model types are data: structs and enums with `pub` fields, `serde` derives, no methods beyond trivial accessors. They
   change rarely; when one changes, everything rebuilds, so keep them stable and small.
3. No glob imports between crates. Each `use` names what it takes.
4. The orchestrator holds no logic: it builds inputs, calls `stage::read(&inputs) -> Output` in order, and writes the
   cache. An edit to one stage then rebuilds that stage and the ~300-line orchestrator, and relinks.
5. The on-disk cache holds the model's output types under a version per stage (each stage exports
   `const VERSION: u32`), so changing one stage invalidates only its own cached output and those after it.
6. Tools are their own crates over libraries, as `native/a2aj-gold` is. The same treatment for the other bins in
   `native/legal-structure-node/src/bin` (`pinpoint-corpus`, `a2aj_corpus`, `courtlistener-structure`, ...): a harness
   crate per family, so an edit to a harness never touches the engine library and the addon never compiles a harness.
7. Heavy native dependencies (ONNX runtime, PP-DocLayout, the hayro renderer) stay behind the features that need them. A
   stage or tool that does not read images or run models must not link them.
8. One feature set per shared crate across every workspace and package that builds into the same target folder. Keep a
   workspace-hack crate (generate it with `cargo hakari generate`; check with `cargo hakari verify` in CI) instead of the
   hand-added `syn` line in `native/a2aj-gold/Cargo.toml`.

## Steps (each lands on its own, output unchanged)

1. **Measure first.** Script `scripts/build-times.ps1`: for each crate, touch one file and time an incremental release
   build of the engine addon (`node scripts/native-build.mjs`) and of each tool. Record the table in this file. Repeat at
   the end.
2. **Cut the three wrong-place items.** Move `ladder_levels` from `decide` into `heading_ladder`; move `PdfTextIndex`,
   `grammar_rank` and `split_line_numbers` from `graph` into the module that owns the data they read (the text index and
   the line-number reading). No behaviour change; no cycles left.
3. **Name the imports.** Replace every `use super::*` in `legal-pdf-structure` with explicit imports (rust-analyzer's
   "expand glob import" does this mechanically). This is the step that makes the dependencies visible.
4. **Create `legal-pdf-structure-model`.** Move the shared types (slots, rows, line views, the line table) and define
   each stage's output type. Change each stage to return its output type instead of writing into shared structs
   (`Fences` today holds furniture, folios, page labels, line labels, margin numbers, contents and more: split it into
   the per-stage outputs).
5. **Lift the stages out one at a time,** smallest and most stable first: `legal-pdf-pages` (page numbering is the
   change that started this), then furniture, notes, headings/contents/captions, runs/paragraphs/joining/text, graph,
   decide, transition. After each, the orchestrator calls the new crate and the yardstick below must be identical.
6. **Version the cache** per stage (rule 5) and drop the single `Measured` blob.
7. **Split the node crate's harness bins** into harness crates (rule 6), as `native/a2aj-gold` was split.
8. **Workspace-hack** with `cargo-hakari` across the root workspace, and remove the hand-added `syn` line (rule 8).
9. **Measure again** and record the table. Target: a one-file edit to any stage or tool rebuilds and relinks in under
   45 s; switching between the addon build and any tool build recompiles nothing but the crates actually changed.

## Proof that output did not change

After every step, the engine's output on the yardstick must be byte-identical to the output before the step:

- the structure gold store: the grader in `experiments/legal-structure-gold/grade` (its snapshot build; see the memory
  note on grader builds) over THE gold store, every layer's score identical;
- `pinpoint-corpus run` over the gold store, the table identical;
- the page map: `page-labels-check` (in `native/a2aj-gold`) over a fixed sample of journals.db's confirmed page maps
  (key at `E:\OpenLegalData-corpus\page-map-check\key.jsonl`), identical counts.

Do not write new tests for this; these yardsticks are the proof. Do not change behaviour while moving code: a
behaviour change is its own commit, measured on its own.

## Constraints

- Other sessions edit `structure/transition` and `structure/decide` in this tree. Coordinate (`ListAgents`) before
  moving their files, and land the moves of a stage in one commit so no one edits a file that has moved.
- Builds go through `scripts/cargo.mjs` (one target folder, `native/legal-structure-node/target`). Run long builds
  detached (`Start-Process cmd /c ... > log`), not in a session shell, so the memory reaper cannot kill one halfway and
  leave corrupt incremental artifacts (that happened on 2026-11-07 and needed a clean of `legal-pdf-structure`).
- No releases and no pushes without the user's word; commits go to main.
