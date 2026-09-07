# PDF first-use performance

The shared renderer no longer waits for every page's geometry before painting the
requested page. It loads page one for the existing fit scale and the requested
page, creates the page slots, then resolves remaining geometry in bounded batches
after the first bitmap. Visible-page requests can proceed independently of a slow
unrelated page. A per-open-document page cache survives zoom and resize.

Unknown page geometry remains hidden until resolved. Viewport anchoring compensates
for mixed page sizes becoming known; annotation navigation awaits the target's
exact geometry before focusing. Existing normalized annotation coordinates and
PDF.js rendering options are unchanged. No page raster or highlight is flattened.
The text-layer rotation stylesheet follows PDF.js viewport rotation so selection
and quote highlights align with cropped/rotated raster pages.

Quote lookup searches normalized text with the existing matching rule, without
creating text-layer DOM across the whole document. Matching and visible pages
share one text-layer task. Ordinary readers can select visible text too. Unreadable
text does not turn a successfully painted scan into an error. Changing quotes
preserves canvases and invalidates obsolete asynchronous search/focus work.

The Beaver adapter starts loading the PDF.js module alongside the authenticated
file request. Explicit supplied bytes do not trigger an unused document download.
The document-file cache retains at most eight files and 64 MiB, evicting least
recently used entries. Larger individual files are usable by their current reader
but are not retained for reopening. Clearing an account or invalidating a document
aborts pending reads and checks again after reading the body, so a late response
cannot repopulate the cache. The cap is retained buffer bytes, not total renderer,
active-document or JavaScript memory. No persistent browser storage is introduced.

## Scope

The authenticated, integrity-checked full-file download path is preserved. This
change does not introduce HTTP byte-range transport or remove the wait for file
bytes. It reduces the work after download and overlaps engine-code discovery with
that request. Backend parsing, storage, OCR, source bytes, annotation persistence,
model behavior and export semantics are unchanged.

## Focused checks

```sh
cd frontend
npx vitest run src/app/hooks/useDocumentFile.test.ts src/app/components/shared/views/PdfView.test.tsx src/app/components/shared/views/highlightQuote.test.ts src/app/components/shared/views/quoteText.test.ts
npx tsc --noEmit
cd ..
node scripts/test-pdf-first-use.mjs .perf/pdf-first-use /path/to/pinned/baseline
```

The browser probe builds only a small harness around the production renderer and
uses PDF.js with a synthetic 300-page mixed-size PDF, including a cropped/rotated
page. Only an unrelated page-metadata promise is deliberately held; PDF parsing,
canvas/text rendering, navigation and annotation interaction are real. It compares
first useful paint before release, target bitmap equality, stable viewport,
text-layer count, and annotation geometry. It accepts no mutations outside its
in-memory fixture and blocks traffic outside its loopback server. This is a
behavioral blocked-dependency check, not a production latency percentage estimate.
