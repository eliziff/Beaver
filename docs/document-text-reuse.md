# Reusing extracted document text

`documentProjectionService.text()` reuses immutable text in the service's existing
process-local projection working set. This most directly benefits repeated
unscoped Grep calls: each tool turn still resolves the authorized document version,
but an unchanged source need not be downloaded, hashed and extracted again.
No model answers, tool results, query results or authorization decisions are cached.

## Identity and lifetime

The identity belongs to `documentProjection.ts`. It includes document ID, version
ID, source SHA-256, normalized format and the `beaver.document-text.v1` extraction
contract. Native DOCX drafting mode and its native text limit are separate keys.
Other formats retain the full extraction and apply each reader's UTF-16-safe limit
afterwards; a short request cannot truncate another reader's cached text.

The cache is memory-only and uses the compilers loaded in that process. Replacing
the running compiler/service clears it; no cache is reused across builds, restarts
or processes. A future persistent cache must include actual compiler/build
fingerprints, not treat the adapter contract as a native binary fingerprint.

The existing eight-entry working set is shared with weak native projections.
Text is strongly retained with LRU eviction and an aggregate 8 MiB UTF-16 payload
budget. Oversized valid outputs are returned but not retained. These bounds do not
include in-flight extraction, caller-held values, native structures or total heap
usage. No additional disk cache, directory, dependency or database table is created.

## Authorization, integrity and changes

Repository sources provide `assertAvailable()`, which rechecks the caller's access
to the captured version, its hash, type, storage key, size and working revision.
The text service calls it separately for every reader before using cached/shared
work and before returning the result. The descriptor captures the original scope
and version fields, not a mutable caller-owned scope object.

On a cache miss, source bytes still pass the existing size and SHA-256 verification
before extraction. On a hit, the service serves that previously verified immutable
result after current repository authorization; it does not read the blob again to
check for later storage-media corruption. Sources without a repository validator
still supply and verify bytes on every call, including hits.

An edited-in-place version rejects old descriptors and requires a new one. A new
current version does not prevent reading an explicitly requested, still-authorized
historical version. Deletion and sharing revocation prevent reading old descriptors,
even if their text remains in the bounded working set for other authorized readers.

Each reader may cancel its wait promptly without cancelling shared extraction.
Late extraction failures are observed, failed loads are not retained, and a later
attempt can retry. A transient DOCX drafting failure preserves the existing plain
text fallback for that request but does not store the fallback as a drafting result.
No production timer or polling interval is added.

## Verification

Focused cases cover the real SQLite repository/filesystem, sharing revocation,
deletion, in-place replacement, historical versions, mid-read revocation, corrupt
storage, and real Grep calls in separate turns. XLSX, PPTX, email and plain-text
fixtures use their actual compilers and compare exact output. Native DOCX option,
fallback and cancellation cases use a controlled native compiler double; this is
not a native DOCX parser fidelity test. Structured native reads and plain text use
disjoint cache namespaces.

```sh
cd backend
npx vitest run src/lib/__tests__/documentTextReuse.test.ts src/lib/__tests__/documentTextAccess.test.ts src/lib/__tests__/spreadsheet.test.ts
npx tsc --noEmit --incremental false
cd ..
node scripts/check-source-boundaries.mjs
node scripts/benchmark-document-text.mjs /path/to/baseline .perf/document-text.json
```

The benchmark uses real local storage, repository lookups and XLSX/PostalMime
extraction. Five fresh-process samples per variant alternate candidate/baseline.
Each sample reports its cold read separately from eight sequential repeat reads
and eight concurrent reads of a second, uncached document. Setup/import time is
excluded. Every output and the cross-variant SHA-256 must match. This does not
measure live models, cloud latency, native DOCX/PDF parsing or application startup.

Cold reads now include two additional metadata validations. They may be slightly
slower; the optimization targets repeated extraction and overlapping requests.
There is no persistent reuse after restart, cross-process sharing, PDF byte-range
transport, off-thread SQLite execution, or new structured-document compiler here.
