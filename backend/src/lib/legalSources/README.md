# Legal-source boundary

Public entrypoint: `lib/legalSourceApplication.ts`. Its shared operations own provider
search, resolution, passage reads, and optional PDF scheduling. The runtime composes
its Library operations with `legalSourceStore`; routes own HTTP validation, caching,
and responses. Provider adapters and native parsing remain unchanged.

Application code uses `legalSourceOperations.search`, `.resolve`, `.readPassage`,
and `.readWithRenditions`, plus `legalSourcePassageUrl`. Provider modules adapt
their native search, identity, locator, and passage formats to that contract.

Do not add provider-specific chat, DOCX, Library, citation, or inline-link
facades. Citation presentation consumes the exact passage returned by the
registry; it does not re-fetch or reconstruct provider records.

The corpus adapters remain preferred. Authorities source acquisition also routes
National Archives, GOV.UK Employment Tribunal, CourtListener and GovInfo citations
through their existing adapters, then tries an ordinary bounded CanLII document
read. CanLII passage reads use the same native document parser and verified citation
identity as acquisition. A challenge or redirect requires
a manual browser visit and PDF attachment, never automated verification bypass.

Browser transports preserve each edition's network restrictions. APIs and documents
that lack usable CORS use the narrowly constrained `POST /source` bridge in
AuthoritiesHelper. Raw standalone HTML requires deployment of that Worker endpoint;
building the HTML does not deploy it. Optional CourtListener and GovInfo keys pass through the selected bridge
and are forwarded only to their owning API; local-only operation makes no remote
requests.
