# Authorities: shared workflow and standalone runtime

Authorities has one TypeScript application and one Rust engine. Beaver supplies its
work-product, document, library, authentication, and download adapters. The local
standalone entry supplies a local workspace and loopback-only HTTP host. Neither
host owns a second citation parser, quotation verifier, or PDF renderer.

## Workflow

A document import opens import options, then citation review. **Done** closes the
review and acquires available source PDFs; source rows are not rendered before
that step finishes. Sources can be replaced from the computer or, in Beaver, from
Library/Project. Source PDFs open in the shared in-app renderer.

**Done — review highlights** checks originals for textless pages. Scanned sources
open the OCR-choice modal. The selected policy is applied through the shared PDF
preparation operation before highlight review, and export reuses that cache.
Cited-page OCR can narrow physical-page citations; paragraph or section citations
may require a full document OCR pass to locate those passages. Page-margin-only
mode does not perform OCR. OCR availability depends on the configured native
OCR assets; failures remain visible rather than silently losing annotations.

With missing sources, **Continue with stubs** is an explicit incomplete-draft
choice. It preserves tab slots and produces clearly labelled stub pages in a
book whose filename, metadata, and cover identify it as an incomplete draft.
This does not waive source-version checks or certify that an output is filing-ready.
Normal filing requirements remain in force when incomplete export is not selected.

The highlight-review component is a shared extension point; this change does not
replace the visual editor being developed separately. Build controls follow that
stage, not the Sources panel. Changing an authority's source returns to Sources.

## Ordering

Book order is user order. Table-of-authorities sorting is a separate setting.
Every included authority has a tab slot, whether or not its PDF is present.
Excluded authorities do not consume slots; supplements follow the last included
slot. Arrow buttons, Alt+Up/Down on a drag handle, and drag/drop use the same
`move-authority` operation. Focus follows the moved authority.

**Tab labels** controls numeric, alphabetic, or Roman patterns, starting number,
prefix, and arbitrary per-slot labels. Blank custom labels use the pattern. Labels
belong to slots, not PDFs, so moving an authority cannot move its label.

## Source and quotation parity

The pinned Rust citator retains complete case styles, including numbered names,
and classifies report citations such as SCR/RCS as case authorities. Recognized
reporter spans include their series and first page. Existing A2AJ and local alias
inventories provide candidate identities. Ambiguous candidates are not resolved
by arbitrarily taking the first hit; confirmed citation/alias identity is required.

CanLII is a manual handoff: open the provider page, use its download controls, and
return to upload the file to the same authority. No iframe, proxy, scraping, or
Downloads-folder monitoring is used. The browser's directory permission is not a
reliable mechanism for automatic capture of the user's Downloads folder.

Quotation findings show a word-level visual difference and readable pinpoint
labels. The Rust verifier tolerates balanced nested quotation delimiters and
explicit editorial brackets/ellipses without erasing apostrophes or ignoring
unmarked word changes. Acceptance of marked editing establishes textual support,
not the substantive fairness of an omission or editorial substitution.

## Run the standalone app from source

Install the locked dependencies in the root, backend, and frontend and initialize
the `legal-structure` and `legal-pdf-parser` submodules. Build the pinned native addon:

```sh
cargo build --locked --release --manifest-path native/legal-structure-node/Cargo.toml
npm run dev:authorities
```

The development command builds the standalone frontend and backend bundle in
`.authorities-dev`, then starts it on `127.0.0.1:3002`. It requires no Beaver account
or Supabase. `PORT` overrides the local port. `LEGAL_STRUCTURE_NATIVE` can point to
an already-built addon for the current operating system. Re-run the command after
editing source; it is a one-command build/launch, not a hot-reload server.

For the portable Windows distribution, retain `npm run package:authorities` and
the existing Start/Stop launchers. Packaging uses the same runtime entry and UI,
with real source validation: it no longer rewrites authentication imports into a
stub. The runtime accepts only its configured loopback host and same-origin writes.

## Focused validation

```sh
npm run build --prefix backend
npm exec --prefix frontend -- tsc --noEmit
(cd backend && npx vitest run authorities authorityPdfText a2aj.test)
(cd frontend && npx vitest run authorities PdfView inspectPdf prepareDeviceFile)
npm run check:source-boundaries
npm run test:authorities-package
cargo test --locked --manifest-path legal-structure/Cargo.toml --features citator,quote-verification --lib
```

The Windows launcher smoke, live provider corpus, full cloud stack, and full
browser-through-server workflow remain separate release checks. Component/browser
visual inspection is not a substitute for those integration checks.
