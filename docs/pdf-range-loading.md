# Verified PDF range loading

The document-backed PDF viewer uses the existing authorized file route with HTTP byte ranges. Explicit-byte and standalone viewers keep their existing path. This is the transport follow-up to PR #8: that PR removes unnecessary whole-document rendering work; this one removes the browser's compulsory full-file transfer before PDF.js starts.

## Integrity and current access

On the first range request, the server still obtains and verifies the complete content-addressed file against its recorded digest. Only then can any range leave the server. A per-application working set retains up to eight verified buffers / 128 MiB, for at most 60 seconds from verification. Requests share pending verification. No authorization decision is cached: every range goes through the repository lookup, then checks the selected version and access again before returning its bytes. A changed version or revoked access cannot be silently combined with earlier chunks.

The response carries a strong SHA-256 ETag, Accept-Ranges and private/no-store. The browser validates exact Content-Range bounds, response length and ETag, and sends If-Match for later chunks. A revoked, changed, truncated or otherwise invalid response stops the transport and clears the failed viewer. Document invalidation, account-cache clearing and viewer disposal abort its requests. Completed-file and cached-file sessions remain subscribed for their entire viewer lifetime too: explicit invalidation removes already-rendered pages even when no further range request is needed. A failed source invalidates old rendering, quotation-search and page-navigation work before clearing the view, so a late callback cannot restore the deleted pages. A server returning a complete 200 response is supported and uses the existing bounded complete-file cache. Incomplete ranges are not inserted into that cache. The 100 MiB response limit matches the existing object/upload limit.

Single start/end, open and suffix ranges, HEAD, If-Match, If-None-Match, If-Range, and unsatisfiable ranges have explicit handling. Unsupported/malformed/multiple ranges fall back to the complete representation rather than implementing multipart responses. No signed object-store redirect is used for PDF range requests; ordinary downloads retain the existing path.

## What improves, and what does not

Range-friendly PDFs can show a page before most file bytes reach the browser. The server still reads the complete object on a miss: this does not speed up first-time source verification, object-store acquisition, native parsing or OCR. Buffer retention is bounded but active responses/in-flight loads are not a total-process-memory bound. A warm buffer is already verified immutable content, not a new check for physical storage corruption on every chunk; expiry causes reverification.

PDF structure matters. PDF.js may need much of a file just to resolve a dispersed page tree or cross-reference data. A deliberately interleaved test file required most chunks before its first page; a fixture with clustered page dictionaries did not. Neither a universal transfer saving nor a production percentage speedup is claimed. No PDF rewriting/linearization or weaker integrity check is introduced.

## Focused browser result

On the pinned integrated source, the real renderer displayed the first page after **207,212 of 7,022,956 bytes** reached the browser. It navigated to page 75 without a full browser download, used one underlying verified object read, pinned each subsequent request to the same representation, and cleared all page content after a real deletion caused the next range request to fail. Its first-page raster was byte-for-byte identical to the full-file path. No browser page errors were recorded.

This is a controlled dependency/transfer demonstration, not a sampled production latency estimate. No server-push revocation is introduced: a remote deletion is discovered on the next authorized request or the existing explicit invalidation path. Already delivered data cannot be recalled from the browser; complete-file cache reuse retains the existing session policy rather than inventing new access guarantees.

## Targeted reproduction

```sh
cd backend
npx vitest run src/routes/documentRanges.test.ts src/routes/documentRoutes.test.ts
npx tsc --noEmit --incremental false
cd ../frontend
npx vitest run src/app/lib/pdfDocumentSource.test.ts src/app/components/shared/views/PdfView.test.tsx src/app/hooks/useDocumentFile.test.ts
npx tsc --noEmit
cd ..
npx playwright install chromium
node scripts/test-pdf-range-loading.mjs .perf/pdf-ranges
```

The browser probe builds a small harness around the production PDF viewer and uses the real authorized route, database and filesystem storage. The synthetic 100-page file has clustered dictionaries and large independent comment streams: it is a controlled range-capability test, not a natural-corpus benchmark. It checks first-page partial transfer, deep navigation, one underlying verified object read, representation pinning, deletion during the session, and identical full/ranged raster output. No model, OCR, native build, user document or external service is involved.
