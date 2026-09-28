# Authorities

Authorities uses one TypeScript application and shared Rust citation/PDF operations.
Beaver supplies authentication, Library and work-product adapters; the standalone
host supplies local-file and loopback adapters. The Python
[AuthoritiesHelper reference](https://github.com/eliziff/AuthoritiesHelper) is not
Beaver's current runtime. Implementation presence does not certify complete
reference parity; remaining release gates are in
[legal work products](../roadmap/legal-work-products.md).

## Workflow

Import a brief/factum and choose import options. Source acquisition starts when
the imported citations enter review, before the user advances to Sources, and
reconciles changed citations and newly linked references. Attached scans begin OCR
after inspection unless the user chose page-margin mode. Pinpoint changes update
recognition demand even for an already tracked PDF; paused/cancelled work stays
stopped until resumed. Old asynchronous responses cannot finish newer OCR demand.
PDF inspection is reused by source hash. Source acquisition and citation edits
still share the draft revision queue; acquisition is not streamed one case at a time.
Resolve remaining source identities and attachments before highlight review; build follows review.

After Sources, scanned inputs open the **Recognize text** modal before Highlights.

Authorities uses the shared folder-aware document chooser for existing files.
Initial imports show PDF and DOCX files; authority and book attachments show PDFs
only. It does not maintain a separate search-only Library picker.
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
Scanned engine groups without a durable lookup key remain visible under
document-local review IDs. These IDs do not assert an authority identity or
merge separate groups; references follow the engine's resolved groups.
Installed citation indexes supply alias evidence to the same resolver; the
shared engine checks reciprocal agreement and contradictory identities before
grouping sources.

CanLII is manual-only: the row opens the document page in a new tab; **Attach PDF**
opens the file chooser, and dropping a downloaded PDF onto that row uses the same
attachment operation. The opening citation must match the pending authority or a
verified alias before binding. A mismatch or unreadable citation leaves the file
unbound and shows one line explaining why. CanLII and View share one aligned column.
No iframe, proxy, server fetch, scraper, automated navigation, Downloads-folder
watcher or background acquisition is part of this handoff.

When a case page itself presents a challenge, or its advertised PDF challenges
the downloader, the existing source row offers **Solve CAPTCHA** if the response
contains an exact same-origin CAPTCHA form, or **Open publisher** for a challenge
without one. A challenged case page may still prove to have no PDF once opened.
**Retry download** retries that source alone after the browser visit; **Upload**
remains available if the user downloads the PDF manually. A guessed PDF route
that challenges while the case page advertises no PDF is treated as no published
PDF, not as a user-solvable CAPTCHA. A plain HTTP 403 is also not enough to claim
a CAPTCHA. Upload uses opening-citation verification. Downloads run sequentially
within a preparation batch; after a confirmed challenge, remaining PDFs from
that publisher are left for manual recovery while other publishers continue.
This is a per-batch guard, not a cross-user rate limiter.

Authorities acquisition owns PDF discovery: A2AJ resolution does not separately
fetch publisher HTML first. For approved Decisia hosts, both downloaders try the
existing `/item/{id}/index.do` to `/{id}/1/document.do` candidate before HTML
discovery. A successful response must pass PDF validation; an absent candidate
falls back to published download controls. A challenge stops acquisition instead
of trying to route around it. Verified representation metadata used by other
source-link consumers still comes from publisher controls, never the URL formula.

`publisherPdfCandidate(url)` in `backend/src/lib/legalSourcePresentation.ts` is
the shared, pure URL primitive; unsupported URLs return null. Lite imports its
tracked browser distribution, generated with
`node AuthoritiesHelper/modern/authorities-lite/sync-publisher.mjs`; append
`--check` to verify it matches the canonical source. Host and representation-control
rules live in that same source, not build-script patches.

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
Edits have per-source undo/redo and revision-checked, serialized autosave; editing
continues while a save is in flight. A failed save remains dirty and can be retried.
Only the active source retains PDF bytes; switching sources preserves mark history.
OCR geometry is retained by the parser and read independently of annotation state,
including when reopening a draft. Word boxes are used when available; line-only
recognition retains its text and line box rather than inventing word coordinates.
Completed recognition updates the selectable
layer in place without replacing marks, history, scroll position or PDF canvases.
A manual-only source is not opted into OCR by opening the editor.

Live text selection and newly saved highlights use the same continuous band per
selected line, retaining precise character endpoints and native copy/keyboard
semantics. Pointer hit testing chooses the page and line before the text run;
drag starts on page whitespace do not require a glyph hit. PDF.js line endings
and OCR line breaks supply the order, not a new semantic reading-order engine.
Existing word-box marks are coalesced for display and hit testing without changing
their stored coordinates. Text highlights have no per-word selection outlines;
area drawing and margin marks remain separate. The shared geometry module retains
source attribution to Zotero reader and react-pdf-highlighter with license notices.

`AuthorityIdentity.annotations[bindingRole]` stores a `beaver.pdf-annotations.v1`
set bound to the exact source SHA-256. Missing means initialization is permitted;
explicitly empty means the user removed all marks. Refresh preserves reviewed
sets. Replacement bytes require an explicit reset, never reuse of stale coordinates.

Geometry is normalized top-left in the rotated visible crop box. Source pages and
assembled-book pages remain distinct. The builder applies the reviewed set before
merging language versions, extracting pages or splitting volumes; it does not
regenerate marks at export. Manually marked pages remain in paper extracts.

Native paragraph geometry uses printed addresses, including sequential detached
margin numbers in parallel-column reports. A passage can span physical PDF pages;
its extent includes continuation lines and excludes the following section heading.
Missing, repeated or unbounded addresses are refused rather than replaced with
structural paragraph ordinals.

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

The helper builds into `AuthoritiesHelper/modern/.authorities-dev` and serves loopback port 3002 by default;
`PORT` selects another port. `LEGAL_STRUCTURE_NATIVE` can select the addon for the
current operating system. This is a build-and-launch helper, not hot reload.
The portable Windows package uses the same application/runtime boundary, not
rewritten authentication or a second Python service. Standalone writes remain
same-origin and loopback-only.

## Focused reproduction

Printed pagination is composed by `documentProjectionService` from existing parser
and OCR evidence, embedded PDF labels, and retained reporter citation forms. A
single observed reporter-start folio establishes the offset for a case; partial
OCR need not recognize every subsequent page. Opening-page margin candidates reuse
the Text-Fidelity leading/trailing-folio rule, constrained by the known reporter
start. Existing cited-page recognition prioritizes the opening pages when it needs
that anchor. Opening a viewer alone never initiates OCR.

Cited-page OCR resolves physical destinations from the page map before requesting
text geometry. Page-only requests skip the optional document-layout model. The
parser's `ocrRoutedPages` can describe scan pages awaiting recognition; it is not
evidence of completed OCR when the profile has no OCR provider. Only a retained OCR
artifact contributes previously recognized pages to a new partial pass.

Display, page-pinpoint highlights and paper extracts use this same mapping. Unknown,
repeated, or incompletely detected printed addresses do not silently become
physical page numbers. The viewer still shows each known printed label beside its
PDF page; a printed-page search asks the user to choose a known PDF page when
other pages have no detected label.
Provider citation forms survive canonical neutral-citation replacement and draft
reopening. Embedded labels require agreement with detected folios and no detected
contradiction before supplying unobserved labels; the public validation corpus
includes stale publisher number trees.

The [pagination validation harness](../../benchmarks/pdf-pagination/README.md)
separately measures real Authorities acquisition, original versus reconstructed
PDFs, partial OCR, and independent visual agreement.

Shared compilation/test guidance is in [CONTRIBUTING.md](../../CONTRIBUTING.md).
The citation graph builder and A2AJ bulk importer use the same published engine
as the application. Install their Python binding with
`python -m pip install -r backend/scripts/requirements-citations.txt` before running them.
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
