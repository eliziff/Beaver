# Authorities

Authorities uses one TypeScript application and shared Rust citation/PDF operations.
Beaver supplies authentication, Library and work-product adapters; the standalone
host supplies local-file and loopback adapters. The Python
[AuthoritiesHelper reference](https://github.com/eliziff/AuthoritiesHelper) is not
Beaver's current runtime. Implementation presence does not certify complete
reference parity; remaining release gates are in
[legal work products](../roadmap/legal-work-products.md).

## Workflow

Import a brief/factum and choose import options. DOCX intake starts with a **Word output**
modal: book only, citation marks without a table, marks and a table, or marks and
a table with `[Book of authorities Tab n]` / `[Tab n]` suffixes. The choice controls
a Word copy; original input bytes remain unchanged. Reopen this setup from Build outputs.
Source acquisition starts when
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

Build rechecks actual source availability. **Missing PDFs** warns about unresolved
and unavailable attached PDFs and offers **Review sources** or **Build anyway**.
The latter explicitly permits incomplete output, retaining tab numbers with
labelled pages or omitted PDFs according to the existing missing-source policy.
Identify incomplete output in its metadata/cover; source version checks,
attachment verification and required cover details still apply.

User authority order is distinct from Table of Authorities sorting. Each included
authority occupies a monotonically numbered slot even when its PDF is missing;
excluded authorities do not. Supplemental material follows the included sequence.
Drag and keyboard movement change authority order through the same operation.
Custom tab labels/styles belong to fixed slots, not to the authorities moving
between them.

## Source and quotation review

Citation review renders the retained Word or PDF bytes through the shared document
viewers. Clicking a highlighted citation selects its row; the outline groups
in-text citations separately from numbered footnotes. Pinpoints use a distinct
fill. Source selections can reset the whole citation range, set a pinpoint, split
at the cursor, merge adjacent occurrences or remove a detection. These operations
change reviewed ranges, never the source bytes. Whole-range edits preserve the
unselected portions of overlapping neighbouring detections. If a rendered passage
cannot be mapped reliably, the extracted-text editor remains available.

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
The browser and server-side downloader do not share publisher verification cookies.
The recovery path is to download the publisher PDF in the browser and use the
existing **Upload** control. **Retry download** retries that source alone, but a
successful browser visit does not imply the downloader is cleared. A guessed PDF route
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

In **Use available original PDFs**, legislation acquisition uses retained publisher
URLs and validated download controls. Narrow Alberta King's Printer HTML-record
and federal Justice XML routes also supply PDF candidates; downloaded bytes must
pass the normal PDF validation. Identical English/French original hashes attach as
one bilingual source. Automatic legislation acquisition continues to reconstruct
text until independent statute/version/highlighting evidence supports a new default.

Quotation review distinguishes exact/normalized/editorial matches, ambiguity and
unlocated targets. Word-level differences and bounded source context support the
review; a supported quotation is not a judgment about editorial fairness or the
legal proposition. Do not invent a target or coordinates to hide an unresolved
match.

## Visual highlights and export

**Final PDF export** optionally joins the source PDF (or the existing DOCX-to-PDF
conversion) to the entire book, including every volume. Bookmarks and copied
book-index destinations point into the combined page tree. It does not embed
authority PDFs in Word. Tab references can link to book tabs; for DOCX, final-only
tab links add references to the export copy without changing the persistent Word
output choice. For PDF input, verified citation text supplies the link rectangle.

The separate pinpoint option applies to manually attached PDFs. It reuses the
prepared-PDF structure/geometry operation even when visual marks are disabled;
paragraph destinations, initial passage marks and generated passage bookmarks
also require evidence of the printed paragraph number in that source. Detached
margin numbers are supported; inferred paragraph ordinals supply no destination.
Only exact-source, found passages receive destinations. Unknown/ambiguous passages
and unlocated filing citations abstain. When enabled and any links abstain, output
shows a short notice and an **Unlinked citations** text report with citation,
pinpoint, tab and known target page for manual PDF editing. No report is produced
when the optional links are disabled or all requested links succeed.

Reconstructed source PDFs parse Markdown headings, emphasis, lists, quotations,
links, code and tables into searchable styled text. This applies to statutes and
other authorities built from source text in both hosts; attached original PDFs
retain their existing formatting.

**Edit in PDF** uses the shared viewer and a highlight sidebar. Initial passage
preferences seed automatic marks; **None** starts without them and still permits
manual text selection/area drawing. Card selection navigates to exact geometry;
selecting a mark identifies its card, including cycling overlapping marks.
Edits have per-source undo/redo and revision-checked, serialized autosave; editing
continues while a save is in flight. A failed save remains dirty and can be retried.
Each source owns its saved snapshot and review state alongside its undo history.
A save acknowledges only its submitted snapshot, not edits made during the request.
Abandoned automatic preparation resumes on revisit unless that source was reviewed.
Only the active source retains PDF bytes; switching sources preserves mark history.
OCR geometry is retained by the parser and read independently of annotation state,
including when reopening a draft. Word boxes are used when available; line-only
recognition retains its text and line box rather than inventing word coordinates.
Completed recognition updates resident selectable layers without replacing marks,
history, scroll position or PDF canvases. The viewport requests individual pages;
unrelated OCR artifacts are not restored, and native filtering precedes copying
geometry into JavaScript. Native text stays usable while a cached OCR read is pending.
A manual-only source is not opted into OCR by opening the editor.
The durable worker records page-limited OCR artifact references on the exact
source version without replacing its whole-document evidence profile. Separate
passes accumulate; full recognition replaces the slice references. Text-layer
reads use these retained artifacts only and never launch OCR. A missing artifact
requires an explicit Recognize text request; older page-limited passes that did
not retain their references need that request once after updating.

The embedded editor resolves only its selected source and mounts the PDF before
automatic marks finish. Manual tools are enabled after source validation and saved
mark initialization; a late automatic result cannot replace a manually reviewed
history, including edit followed by undo. Annotation preparation reads the version-bound source
and retained recognition, not the standalone PDF-upload/OCR path. Switching
sources cancels abandoned reads and mark preparation. The render scheduler excludes
pages wholly before the preload window, including the preceding page when its
boundary falls in an inter-page gap. Abandoned text reads are cancelled and OCR
progress polls never overlap. Text reads verify the displayed source hash without
a separate metadata request per page.

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

Paragraph geometry can span physical PDF pages and use detached margin numbers.
Independent checks still find omitted continuation text in some cropped, rotated
PDFs and extents that include following headings. The
[remaining precision gates](../roadmap/legal-work-products.md#execution-and-live-proof)
apply to automatic passage marking; a located destination does not certify the
whole highlight's extent.

Passage marks export as ordinary `/Highlight` annotations with `/QuadPoints`,
printable appearances and stable names; margin/sideline marks use `/Square`.
Original page content is not flattened. Quotes sharing a pinpoint remain separate
editable marks. Unlocated automatic targets remain separate findings, not guessed
rectangles. Editable export is not a claim of manual compatibility testing in
every PDF editor.

## Run the standalone host

Build uploads accept up to 500 files, 100 MB per file and 512 MB together, with
up to 16 MB of serialized draft state. Malformed Word/PDF inputs and PDFs the
writer cannot open are rejected before attachment. Encrypted PDFs need an
unencrypted copy, including readable PDFs with owner restrictions that the current
writer does not support. Replacing an unavailable retained file refreshes its
preview availability even when its content hash is unchanged.

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
same-origin and loopback-only. The self-contained `Authorities.html` runs that
runtime in the page with the native crate compiled for WASI; its adapter and
build are in `AuthoritiesHelper/modern/html`.

## Focused reproduction

Printed pagination is composed by `documentProjectionService` from existing parser
and OCR evidence, embedded PDF labels, and retained reporter citation forms. A
single observed reporter-start folio establishes the offset for a case; partial
OCR need not recognize every subsequent page. Opening-page margin candidates reuse
the Text-Fidelity leading/trailing-folio rule, constrained by the known reporter
start. Existing cited-page recognition prioritizes the opening pages when it needs
that anchor. Opening a viewer alone never initiates OCR.

The parser retains raw passage geometry before structural derivation and reads
embedded labels from its existing PDF load. Pagination and passage lookup do not
re-extract the PDF or load it with pdf-lib. The existing versioned parse cache
also retains native extraction and per-page recognition, so expanding partial OCR
reuses both. Recognition identity includes the source and provider/model profile;
page selection does not invalidate recognition already completed for that profile.

Cited-page OCR resolves physical destinations from the page map before requesting
text geometry. Page-only requests skip the optional document-layout model. The
parser's `ocrRoutedPages` can describe scan pages awaiting recognition; it is not
evidence of completed OCR when the profile has no OCR provider. Only a retained OCR
artifact contributes previously recognized pages to a new partial pass.

Display, page-pinpoint highlights and paper extracts use this same mapping. Unknown,
repeated, or incompletely detected printed addresses do not silently become
physical page numbers. Automatic routing can preserve an unlabelled cover before
a verified reporter run; it retains binding provenance instead of flattening to
labels. Citation metadata alone is insufficient: an original publisher PDF can
be a judgment edition without reporter folios. The viewer still shows each known printed label beside its
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
