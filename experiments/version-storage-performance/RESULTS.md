# Document version storage performance

Measured 2026-09-04 with Node 22.20.0 on Windows. Each run used a fresh
temporary SQLite database and local filesystem object store, called production
applications directly, and deleted temporary state in `finally`.

Run from `backend/`:

```powershell
.\node_modules\.bin\tsx.cmd ..\experiments\version-storage-performance\benchmark.ts
.\node_modules\.bin\tsx.cmd ..\experiments\version-storage-performance\research-scale.ts --passages=10000 --passages-per-source=100 --samples=5
```

## Representative workspace

The 85,994-byte workspace contains 24 labels and 200 saved sources. History
reads and current edits were measured with 606 immutable versions.

| Operation | Median (ms) | p95 (ms) |
| --- | ---: | ---: |
| Decode and validate research file | 0.871 | 1.988 |
| Render research Markdown | 0.216 | 0.382 |
| Autosave working revision | 9.019 | 11.146 |
| Zero-copy checkpoint | 9.602 | 13.309 |
| List 606 versions | 7.108 | 11.176 |
| Read and validate at 606 versions | 4.495 | 7.118 |
| Autosave at 606 versions | 11.173 | 16.088 |
| Integrity-checked restore | 12.873 | 22.661 |
| Add content-changing version | 6.096 | 9.113 |
| List 256 content versions | 3.763 | 7.697 |

Moving the 606-version research document Library to project and back took
143.740 ms and 142.043 ms. Moving the 256-version, 256-blob document took
457.805 ms and 404.166 ms. Moves rewrite metadata in batches with four bounded
copy workers and did not hit SQLite's bind limit.

## 10,000-passage workspace

The current partitioned representation stored a 104,825-byte Markdown index
and 100 source-owned CAS parts totalling 9,134,282 bytes. Its largest part was
91,811 bytes, 0.088% of the 100 MiB object cap.

| Operation | Median (ms) | p95 (ms) |
| --- | ---: | ---: |
| Edit workspace note | 7.176 | 10.324 |
| Edit one passage | 12.665 | 13.391 |
| Read index | 2.351 | - |
| Read 50-passage page | 1.473 | 1.726 |
| Zero-copy checkpoint | 37.204 | - |

Checkpointing produced 200 part references to the same 100 CAS blobs. The
50-item page retained 0.145 MiB; process peak RSS, including fixture creation,
was 161.871 MiB. Raw phase output is in the ignored
`results/research-10000-100.json`.

## Earlier stress bounds

These were not rerun in this pass. A 100,000-passage/1,000-source partitioned
run previously measured 23.1 ms note edits, 31.2 ms passage edits, 13.8 ms
index reads, 5.2 ms pages, 11.5 ms checkpoints, and 214 MiB peak RSS. One
10,000-passage source remained below the 100 MiB part cap; the opposite
10,000-source fan-out remained below SQLite's bind limit. The v1 monolith had
required 166 ms for a 10,000-passage note edit and 4,089 ms at 100,000.

## Finding

History depth does not materially slow current-version operations. Immutable
CAS references keep checkpoints cheap, scope moves scale with distinct blobs,
and source-owned parts keep ordinary reads bounded without another repository,
receipt format, or sharding layer.
