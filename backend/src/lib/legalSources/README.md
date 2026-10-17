# Legal-source boundary

Public entrypoint: `lib/legalSourceApplication.ts`. Its shared operations own provider
search, resolution, passage reads, and optional PDF scheduling; routes own HTTP
validation, caching, and responses. Provider adapters and native parsing remain unchanged.

Application code uses `legalSourceOperations.search`, `.resolve`, `.readPassage`,
and `.readWithRenditions`, plus `legalSourcePassageUrl`. Provider modules adapt
their native search, identity, locator, and passage formats to that contract.

Do not add provider-specific chat, DOCX, Library, citation, or inline-link
facades. Citation presentation consumes the exact passage returned by the
registry; it does not re-fetch or reconstruct provider records.

The corpus adapters remain preferred. Authorities source acquisition also routes
National Archives, GOV.UK Employment Tribunal, CourtListener and GovInfo citations
through their existing adapters. CanLII is never read: a CanLII citation gets its
document-page link, opened by the user, and the PDF the user attaches.

Browser transports preserve each edition's network restrictions. APIs and documents
that lack usable CORS use the narrowly constrained `POST /source` bridge in
AuthoritiesHelper. Raw standalone HTML requires deployment of that Worker endpoint;
building the HTML does not deploy it. Optional CourtListener and GovInfo keys pass through the selected bridge
and are forwarded only to their owning API; local-only operation makes no remote
requests.
