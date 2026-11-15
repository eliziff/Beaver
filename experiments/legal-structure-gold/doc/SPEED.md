# Parse and DOC speed: where it stands

The goal, the maintainer's: DOC (tier 1) is the product's default parse, in milliseconds a document on a laptop CPU, with
whole-document awareness and full oracle reach; a grade takes seconds. Never a fake cache miss: a cache is keyed on what
changes the output.

## Measured (2026-11-15, desktop, the 915 gold sources starting `0` or `1`, one thread, release build)

| Parse | ms a document |
| --- | --- |
| tier 0 (the morning's build) | 99.9 |
| tier 0 now (exact speed fixes, fat LTO) | 84.6 |
| tier 0 + DOC `w128w` (width 128, Order windowed) | 281 |
| tier 0 + DOC `w256w` (width 256, both windows) | 408 |

DOC `w256w`'s stages summed over the 915 documents: Detect 109 s, Order 77 s, line heads 45 s, trees 19 s, stylesheet 8 s
(`time-doc.ps1` prints them; `LEGALPDF_DOC_TIMES`).

A grade that changes no parse resumes every kept parse: 23 documents in 2.2 s. A store grade with DOC is DOC's time: a live
sample read 67% ONNX Runtime, 20% kernel (DOC's sessions run without a memory arena: every run allocates afresh), 8% ours.

## Accuracy (same 915 documents; f1)

| | tier 0 | `w256` | `w128w` | `w256w` |
| --- | --- | --- | --- | --- |
| paragraphs (`units_text`) | 0.4433 | 0.6741 | 0.6466 | 0.6803 |
| headings | 0.4171 | 0.7783 | 0.7308 | 0.7833 |
| list items | 0.2681 | 0.7299 | 0.6650 | 0.7397 |
| provisions | 0.5015 | 0.8520 | 0.8351 | 0.8571 |
| page numbers | 0.9539 | 0.9694 | 0.9651 | 0.9698 |

`w256w` (`D:\docfit\w256w`, development 0.9148) is the best DOC. Width 128 costs 2–6 points on the key structures. Every DOC
loses to tier 0 on `continuations` (0.43 → 0.36), `speakers` (0.86 → 0.84), `document_ownership` and `markers_table`.
`w256` must be exported with `--line-window 100000 --order-window 1000000` to be graded as it was fitted.

## How to measure

- `grade/ab-parse.ps1`: two graders (`grader-prev.exe` the last build's, `grader.exe` this one's) parse the same documents
  alternately into an empty dump; each one's summed parse and the totals that moved.
- `doc/time-doc.ps1 -Model EXPORT`: DOC's stages over the 915, its parse time per document.
- `grade/desktop-build.ps1`: release is the one to time; `-Profile iterate` rebuilds in a minute (a grader for scores only);
  `-Profile profiling` keeps symbols for an xperf stack sample (`xperf -on PROC_THREAD+LOADER+PROFILE -stackwalk Profile`).
- `doc/desktop-round.ps1`: training data, fit, export, store grade. Run it with `powershell -ExecutionPolicy Bypass`, as the
  desktop runs no script otherwise. A fit from `-Init` takes the checkpoint's width; pass `-Fit @('--lr','5e-5')` to continue.
- Phase timings (`LEGALPDF_PHASE_TIMING`) are summed per thread and written once a parse; the citation finder's own stages
  are `LEGAL_CITATIONS_PHASE_TIMING`. The per-line timers were removed: they doubled the parse.

## Kept parses

A grade keeps each parse in `doc-dump/` in the data home (`LEGALPDF_DOC_DUMP` names another) under the parse's declared
version (`legal_pdf_structure::PARSE_VERSION`), the text model and the extraction's identity: **bump `PARSE_VERSION` with
any change to what the parse reads**, else grades score the old parse. A parse-only entry is kept unless DOC reads it or a
fit does (`LEGALPDF_DOC` or `LEGALPDF_DOC_DUMP` set), which also keeps DOC's inputs.

## Next, in order

1. **DOC's memory arena:** sessions keep an arena shrunk after each run (ONNX Runtime's
   `memory.enable_memory_arena_shrinkage` run option) instead of none (`doc/onnx.rs`): the kernel's fifth of a grade.
2. **Detect at width 256** (the largest stage): distil width 128 from `w256w` (its outputs the targets), or fewer layers,
   graded against `w256w`.
3. **Order's remaining 77 s** is not its pair MLP (the window cut a quarter): profile `order.onnx` (ONNX Runtime's
   profiling) before changing it; likely the three region encoder layers.
4. **Line heads:** the spatial MLP over 65 pairs a line (`LINE_WINDOW` 32 either side); a narrower window with the far
   bias, refit.
5. **Cold start:** the citation grammars compile on first use (about 0.16 s up front natively; the page's cold import 4.4 s).
   Unmeasured beyond that; a one-document parse pays it every time in the CLI and the browser.
6. **Tier 0:** the citation layer (finder and protected spans) is about a third of the parse; the exact fixes there are
   done. The rest is spread across fences, `finish` and runs.

## Product state

- DOC does not run in the product: `DOC_PROMOTED` (`rust/src/engine.rs`) is empty. When a mode is promoted, DOC loads once
  per export (`loaded_doc`), on every core.
- A reading asks for DOC or not (`doc` in the backend's `profileFor`/`openDocument`/`preparePdf`); readings needing only
  text, page text or paragraphs ask for none. The server's `MIKE_PDF_STRUCTURE_PROVIDER` is the default.
- Authorities Lite's page map is read once a document (`pdf_page_map`'s memo), not once for each of its three calls.
