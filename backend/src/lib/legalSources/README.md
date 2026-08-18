# Legal-source boundary

Public entrypoint: `lib/legalSourceRegistry.ts`.

Application code uses only `searchLegalSources`, `resolveLegalSource`,
`readLegalSourcePassage`, and `legalSourcePassageUrl`. Provider modules adapt
their native search, identity, locator, and passage formats to that contract.

Do not add provider-specific chat, DOCX, Library, citation, or inline-link
facades. Citation presentation consumes the exact passage returned by the
registry; it does not re-fetch or reconstruct provider records.
