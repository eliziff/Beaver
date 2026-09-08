# Authorities

Authorities uses one TypeScript application and shared Rust citation/PDF operations.
Beaver supplies authentication, Library and work-product adapters; the standalone
host supplies local-file and loopback adapters. The Python
[AuthoritiesHelper reference](https://github.com/eliziff/AuthoritiesHelper) is not
Beaver's current runtime. Implementation presence does not certify complete
reference parity; remaining release gates are in
[legal work products](../roadmap/legal-work-products.md).

## Workflow

Import a brief/factum and choose import options, review citations, then finish
that review before source acquisition. Show source rows after acquisition, not
as a competing pre-import stage. Resolve source identities and attach remaining
PDFs before proceeding to highlight review; build follows review.

After Sources, scanned inputs open the **Recognize text** modal before Highlights.
The modal lists scanned PDFs, page choices, recognition controls and progress;
eager recognition does not bypass it. Physical page citations can narrow OCR; paragraph/section targets may
need broader processing. Missing runtime dependencies are actionable errors.
Manual-only marks and margin-only workflows do not silently require full OCR.

**Continue with stubs** is an explicit incomplete-draft path. Preserve missing
sources in the book's slots and identify incomplete output in its metadata/cover;
it does not waive version checks, verification or filing requirements.

User authority order is distinct from Table of Authorities sorting. Each included
authority occupies a monotonically numbered slot even when its PDF is missing;
excluded authorities do not. Supplemental material follows the included sequence.
Drag and keyboard movement change authority order through the same operation.
Custom tab labels/styles belong to fixed slots, not to the authorities moving
between them.

## Source and quotation review

Rust citation records and verified provider aliases own identity. Do not resolve
an ambiguous citation by selecting the first plausible candidate or recreating
citation regexes in the UI. Source changes must pass the normal binding/revision
boundary and invalidate geometry that no longer describes the same bytes.

CanLII is manual-only: navigate through the validated provider link, then attach
the returned PDF through Add PDF/drop and validate it against the pending source.
No iframe, proxy, server fetch, scraper, automated navigation, Downloads-folder
watcher or background acquisition is part of this handoff.

Quotation review distinguishes exact/normalized/editorial matches, ambiguity and
unlocated targets. Word-level differences and bounded source context support the
review; a supported quotation is not a judgment about editorial fairness or the
legal proposition. Do not invent a target or coordinates to hide an unresolved
match.

## Visual highlights and export

**Edit in PDF** uses the shared viewer and a highlight sidebar. Initial passage
preferences seed automatic marks; **None** starts without them and still permits
manual text selection/area drawing. Card selection navigates to exact geometry;
selecting a mark identifies its card, including cycling overlapping marks.
Edits have per-source undo/redo. Save and close commits all edited sources
atomically through the draft revision boundary; Cancel protects unsaved edits.

`AuthorityIdentity.annotations[bindingRole]` stores a `beaver.pdf-annotations.v1`
set bound to the exact source SHA-256. Missing means initialization is permitted;
explicitly empty means the user removed all marks. Refresh preserves reviewed
sets. Replacement bytes require an explicit reset, never reuse of stale coordinates.

Geometry is normalized top-left in the rotated visible crop box. Source pages and
assembled-book pages remain distinct. The builder applies the reviewed set before
merging language versions, extracting pages or splitting volumes; it does not
regenerate marks at export. Manually marked pages remain in paper extracts.

Passage marks export as ordinary `/Highlight` annotations with `/QuadPoints`,
printable appearances and stable names; margin/sideline marks use `/Square`.
Original page content is not flattened. Quotes sharing a pinpoint remain separate
editable marks. Unlocated automatic targets remain separate findings, not guessed
rectangles. Editable export is not a claim of manual compatibility testing in
every PDF editor.

## Run the standalone host

Restore the [repository checkout](local-subrepositories.md), install root/backend/
frontend npm dependencies, and build the native addon for the current platform:

```sh
cargo build --locked --release --manifest-path native/legal-structure-node/Cargo.toml
npm run dev:authorities
```

The helper builds into `.authorities-dev` and serves loopback port 3002 by default;
`PORT` selects another port. `LEGAL_STRUCTURE_NATIVE` can select the addon for the
current operating system. This is a build-and-launch helper, not hot reload.
The portable Windows package uses the same application/runtime boundary, not
rewritten authentication or a second Python service. Standalone writes remain
same-origin and loopback-only.

## Focused reproduction

Shared compilation/test guidance is in [CONTRIBUTING.md](../../CONTRIBUTING.md).
Useful product checks from the root are:

```sh
npm run test:authorities-package
npm run test:authorities:highlights
npx playwright install chromium
npm run test:authorities:browser
```

The highlight browser fixture additionally needs Python `playwright`, `pymupdf`
and Chrome/Chromium. Its separate terminals are:

```sh
node backend/node_modules/tsx/dist/cli.mjs backend/scripts/authorities-highlight-browser-runtime.ts
(cd frontend && BEAVER_API_ORIGIN=http://127.0.0.1:3037 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3036)
python3 scripts/test-authorities-highlights-browser.py --output /tmp/authorities-highlight-test
```

It exercises the real editor/viewer, persistence and export with controlled native
passage geometry. PyMuPDF checks reopened editable annotations and unchanged source
text, including cropped/rotated and manual-only cases. Synthetic geometry does
not prove native passage fidelity, OCR quality, live-provider resolution, every
court profile or the Windows portable package. Those remain distinct gates.
