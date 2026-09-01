# Authorities production parity

Status: production decision, audited 2026-09-01.

## Reference baseline

The historical product oracle is `eliziff/AuthoritiesHelper` at commit
`5afe676014799c536785088250efb3da0e165184`. The comparison covers
`web/index.html`, `web/app.js`, `toa_maker.py`, `document_delivery.py`,
`tests/test_toa_maker.py`, `tests/test_toa_web.py`, and
`tests/test_toa_layout_browser.py` at that commit.

The TypeScript implementation is the production successor. Parity means
retaining useful lawyer-facing outcomes, not its Python job, manifest, polling,
or iframe mechanics.

## Capability decisions

| Workflow or capability | Status | Production decision and evidence |
| --- | --- | --- |
| Start from a Word/PDF filing or start a manual Book from PDFs | **Preserved** | Both starts use one draft model in `backend/src/lib/authoritiesDomain.ts` and one interface in `frontend/src/app/authorities/AuthoritiesWorkspace.tsx`. Import and manual-order behaviour are covered by `backend/src/lib/authoritiesImport.test.ts` and `frontend/src/app/(pages)/table-of-authorities/page.test.tsx`. |
| Detect full citations, case styles, pinpoints, body/footnote locations, and exact UTF-16 spans | **Preserved** | Native extraction feeds `backend/src/lib/authoritiesImport.ts`; selection, split, merge, and relink edits use `backend/src/lib/authoritiesWorkspaceApplication.ts`. Exact spans and edits are covered by their adjacent tests. |
| Create and infer ordinary Ibid and supra occurrences | **Restored** | `legal-structure/src/citator.rs` exposes the frozen reference grammars through `native/legal-structure-node/src/lib.rs`; `backend/src/lib/authoritiesImport.ts` links Ibid to the prior authority and abstains on ambiguous named/note references. Real DOCX/PDF and ambiguity cases are in `backend/src/lib/authoritiesImport.test.ts`. |
| Use original PDFs, rebuild missing sources, supply originals manually, or rebuild every source from text | **Restored** | The current source modes are `automatic`, `manual-originals`, and `render`. Rebuild-all and source preparation are covered by `backend/src/lib/authoritiesWorkspaceApplication.test.ts`; initial selection is covered by the Authorities page and standalone-host tests. |
| Resolve sources automatically and complete unresolved sources manually | **Improved** | `backend/src/lib/authoritiesWorkspaceApplication.ts` uses grounded provider sources, reconstructs only where permitted, and exposes a CanLII handoff only when an exact URL is derivable. Normal PDF attachment replaces the old manifest/finalize staging. Tests cover reconstruction, provider deduplication, manual overrides, CanLII, and no-link abstention. |
| Preserve manual titles, tabs, exclusions, and ordering | **Preserved** | These are durable domain fields/actions in `backend/src/lib/authoritiesDomain.ts`; reducer and UI behaviour are covered by `backend/src/lib/authoritiesDomain.test.ts` and the Authorities page test. |
| Produce Book, Table, or both; support native Word marks, an appended native TOA, or an appended linked list | **Preserved** | `backend/src/lib/authoritiesBuild.ts` implements the three real table deliveries and page/pinpoint/combined locations. Inspectable DOCX/PDF output tests are in `backend/src/lib/authoritiesBuild.test.ts`. |
| Build indexed Books with internal links, bookmarks, page labels, custom cover/index, and ordered supplemental PDFs | **Preserved** | Book composition is represented directly in the draft and built in `backend/src/lib/authoritiesBuild.ts`; domain, build, runtime, and standalone-host tests cover all slots and navigation. |
| Passage marking and scanned-PDF policy | **Improved** | The existing mark styles and cited-page/full OCR policies remain. Source preparation now checks searchability/password state and exposes progress or an actionable failure only when needed; the historical confirmation prompt is not restored. Coverage is in `backend/src/lib/authoritiesBuild.test.ts`, `backend/src/lib/authoritiesWorkspaceApplication.test.ts`, and `frontend/src/app/authorities/beaverHost.test.ts`. |
| Alberta Court of Appeal filing-PDF delivery | **Improved** | The real seam appends the linked Table to the filing PDF, then appends any authority lacking a public link and adds bookmarks. `backend/src/lib/authoritiesBuild.test.ts`, `backend/src/lib/authoritiesWorkspaceApplication.test.ts`, and `frontend/src/app/authorities/standaloneHost.test.tsx` cover the shared application result and standalone file handoff. |
| Save, reopen, relink, refresh, rebuild, and retain prior outputs | **Improved** | Durable work-product revisions replace ephemeral job history. Exact source hashes and version pointers permit in-place refresh while preserving unambiguous edits. Coverage is in `backend/src/lib/authoritiesDomain.test.ts`, `backend/src/lib/authoritiesWorkspaceApplication.test.ts`, `backend/src/routes/authoritiesRuntime.test.ts`, and `frontend/src/app/authorities/standaloneHost.test.tsx`. |
| Cancellation, bounded source work, OCR queue state, errors, and downloadable outputs | **Preserved** | These are application/runtime outcomes rather than UI polling state. They are covered by `backend/src/lib/authoritiesBuild.test.ts`, `backend/src/lib/authoritiesWorkspaceApplication.test.ts`, `backend/src/routes/authoritiesRuntime.test.ts`, and both host tests. |
| Court-specific presets | **Improved** | Alberta King's Bench, Alberta Court of Appeal, Federal Court, and Federal Court of Appeal profiles are typed domain data with enforced output/source constraints in `backend/src/lib/authoritiesDomain.ts`; build tests verify their resulting filings. Audit receipts remain internal. |
| Grounded citations and Beaver assistant operation without reparsing | **Improved** | Receipt seeds and assistant citation ledgers enter through `backend/src/lib/authoritiesImport.ts`; the Beaver wrapper is `frontend/src/app/(pages)/table-of-authorities/page.tsx`. The standalone entry `frontend/src/authoritiesMain.tsx` mounts the same workspace without assistant code. |
| Historical `pdf_append` table delivery | **Intentionally not restored** | The old UI described a PDF-copy mode, but `toa_maker.py` immediately aliased it to `native_append`, rejected PDF input whenever a Table was requested, and emitted no PDF-copy artifact. The pinned `tests/test_toa_maker.py` expressly asserted that result. It was dead and misleading; the tested Alberta appeal append/bookmark seam above supersedes it. |
| Python job directories, manifest finalization, session polling, and iframe/mode routing | **Intentionally not restored** | These were implementation mechanics, not capabilities. Durable drafts, file bindings, application operations, and host adapters replace them. |

## Shared production seams

- Domain contract: `backend/src/lib/authoritiesDomain.ts`
- Import and reference review: `backend/src/lib/authoritiesImport.ts`
- Source preparation and draft operations:
  `backend/src/lib/authoritiesWorkspaceApplication.ts`
- Output builder: `backend/src/lib/authoritiesBuild.ts`
- Standalone runtime: `backend/src/authoritiesStandaloneServer.ts` and
  `backend/src/routes/authoritiesRuntime.ts`
- Shared UI/host contract: `frontend/src/app/authorities/AuthoritiesWorkspace.tsx`
  and `frontend/src/app/authorities/host.ts`
- Beaver host: `frontend/src/app/authorities/beaverHost.ts`
- Beaver persistence/application seam: `backend/src/lib/workProductApplication.ts`
  and `backend/src/lib/relationalWorkProductRepository.ts`
- Local-only host/storage: `frontend/src/app/authorities/standaloneHost.ts` and
  `frontend/src/app/lib/standaloneWorkProducts.ts`
- Browser production check: `scripts/test-authorities-browser.py`
