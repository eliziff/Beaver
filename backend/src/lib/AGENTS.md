# Reading a stored source

- `sourceDocument.ts` is the one way from a stored source to the engine's document (`openDocument`) or text (`sourceText`). The engine (native/legal-structure-node, `source.rs`) routes each format to its reader (PDF, Word, workbook, presentation, email, plain text) and keeps the working set of documents it read, keyed by what each was read as, beside the PDF parser's disk cache. Do not add a cache, a working set, or in-flight deduplication in the backend.
- Consumers call the engine (`structureNative()`) on the document directly; do not add pass-throughs around engine calls.
- Format reading lives in the engine (`src/formats/`, `legal-pdf-parser`). The one step before it is LibreOffice's conversion of a Word or PowerPoint binary (doc, ppt) to PDF.
- A PDF's parse failure carries its kind (`error.kind`, `pdfFailureKind`): match on the kind, never on message text.
- `contentStore.ts` owns safe local paths, PDF content by hash, atomic writes, locks, and immutable receipts. Do not add another hash, cache root, artifact search, hard-link farm, or rehydration store.
- `pdfEvidence.ts` looks PDFs up by locator and writes, rehydrates and verifies their evidence receipts.
- A document the engine keeps is keyed by document ID, version ID, source SHA-256 and how it was read (a PDF by its parse's cache key or its request). Never key one by source bytes alone.
