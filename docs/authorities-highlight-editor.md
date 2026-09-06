# Authorities visual highlight editor

Authorities → Sources → Highlights → **Edit in PDF** opens the shared PDF viewer with a highlight sidebar. The initial passage-marking preference seeds the document; it does not restrict manual editing. **None** starts with no automatic marks.

Text selection and area drawing create ordinary highlights. Selecting a card navigates to its exact geometry; clicking a mark selects its card. Overlapping marks can be cycled by clicking. Text/area erasure subtracts geometry without changing the PDF content. Undo/redo is per source. Save and close writes all edited sources atomically through the existing draft action/revision boundary. Cancel asks before discarding edits.

## State and export

`AuthorityIdentity.annotations[bindingRole]` contains a `beaver.pdf-annotations.v1` set anchored to the exact source SHA-256. A missing set permits initial generation; an explicitly empty set means the user removed every mark. Source refreshes preserve the set. A source hash mismatch cannot silently reuse old coordinates; the editor offers an explicit reset for the replacement PDF.

Rectangles use normalized top-left coordinates in the rotated visible crop box. Source pages remain distinct from assembled-book pages. The builder applies the final set to each source PDF before merging language versions, extracting pages, or splitting volumes. It does not regenerate reviewed marks at export. Manually marked pages are retained in the existing paper-extract path.

Passage marks export as `/Highlight` annotations with `/QuadPoints`, printable appearance streams and stable names. Margin/sideline marks use `/Square`. Page content is not flattened. Automatic quotes sharing a pinpoint remain independently editable.

The runtime prepares initial geometry through the existing `authorityPdfText` pipeline. Manual editing with no automatic marks does not require OCR. Unlocated targets are listed separately; no coordinates are invented for them.

## Focused checks

```sh
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend
node backend/node_modules/typescript/bin/tsc -p backend
(cd backend && node node_modules/vitest/vitest.mjs run src/lib/authoritiesAnnotations.test.ts src/lib/authoritiesBuild.test.ts src/lib/authoritiesDomain.test.ts src/lib/authorityPdfText.test.ts)
(cd frontend && node node_modules/vitest/vitest.mjs run src/app/components/shared/views/PdfView.test.tsx src/app/authorities/beaverHost.test.ts src/app/authorities/standaloneHost.test.tsx)
node scripts/check-source-boundaries.mjs
node --test frontend/scripts/transport-boundary.test.mjs
```

The backend compilation supplies the generated `backend/dist` imports checked by the existing source-boundary script.

For the real-browser fixture, install Python `playwright` and `pymupdf`, and provide Chrome/Chromium. Run these in separate terminals:

```sh
node backend/node_modules/tsx/dist/cli.mjs backend/scripts/authorities-highlight-browser-runtime.ts
(cd frontend && BEAVER_API_ORIGIN=http://127.0.0.1:3037 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3036)
python3 scripts/test-authorities-highlights-browser.py --output /tmp/authorities-highlight-test
```

The fixture uses the production editor, PDF.js viewer, action decoder/reducer, annotation preparation, and book builder. Only expensive native passage resolution is supplied synthetic geometry; no legal corpus, OCR job, or metered API is used. It exercises independent quote deletion, arbitrary text highlighting, partial erasure, undo/redo, a cropped/rotated page, an image-only scan, persistence/reopening, narrow layout, and manual-only export. PyMuPDF independently reads, renders, deletes, saves, and reopens exported annotations. This is not a claim of a manual Acrobat compatibility test.

## Recorded validation

On September 6, 2026, both application TypeScript checks passed, as did 57 focused backend tests and 32 viewer/host tests. Source and HTTP transport boundaries passed. Standalone Authorities and Court Records production bundles built and passed the preload-boundary check.

The real Chrome fixture completed with no page errors. Its exported book contained four editable Highlight annotations; PyMuPDF deleted one and reopened the saved PDF with three remaining and the source text unchanged. Manual-only export contained one highlight with automatic marking set to `none`. The cropped/rotated page's exported highlight was verified at the corresponding visible-page coordinates. Browser and independently rendered PDF screenshots were inspected.
