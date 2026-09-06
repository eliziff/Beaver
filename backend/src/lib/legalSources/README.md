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
