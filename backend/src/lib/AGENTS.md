# Document projection boundary

- `documentProjectionService.ts` is Beaver's only document-read/projection API. Routes, assistant tools, Library stores, citation code, tabular review, and providers must call it.
- Keep format work in the existing compilers: `legal-pdf-parser`, `NativeDocument`, `DocxSession`, and the spreadsheet grid renderer. The service is only their bounded host adapter.
- `documentProjection.ts` owns projection identity, safe local paths, source publication, atomic writes, locks, and immutable receipts. Do not add another hash, cache root, artifact search, hard-link farm, or rehydration store.
- `documentProjectionPdf.ts` is private PDF evidence/lookup implementation used by the service. Production consumers must not import it directly.
- A projection identity always binds document ID, version ID, source SHA-256, compiler/parser version, and material options. Never key a projection by source bytes alone.
- Do not restore `localPdfIngestion`, `localPdfLookup`, `parseCache`, compatibility exports, or a second cache. Update the service and its existing primitives instead.
- Run `documentProjectionBoundary.test.ts` whenever document reading, provider attachments, evidence, or cache code changes; it deliberately fails on duplicate paths and bypasses.
