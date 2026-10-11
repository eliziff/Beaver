# CourtListener rendition comparison

The objective is to recover and preserve legal document structure across arbitrary
CourtListener records with the independent Rust legal structure parser. Beaver
is a consumer. Storage reduction is useful only if the evidence for structure,
native anchors and browser text fragments remains available for later iteration.

The current iteration has a **45,000,000,000 byte cap for CourtListener data**,
including source records, metadata, browser captures and comparison receipts.
The bulk pool has no record-count target. The served-website milestone is at
least **7,000 validated captures**: the original 5,000 plus 2,000 more. The saved
12,000-target continuation may continue within the shared cap. Competing
renditions stay on disk until actual comparisons establish what they contain.
No rendition has been discarded.

## Inputs and ownership

The official snapshot is dated 2026-09-30. `sample.py` retains an independent
24,302-record source SQLite database. `acquire.py` acquires wider, distributed
compressed windows and streams complete source rows to the Rust packer. These
are partial source-position samples, not a random sample or the entire corpus.
Boundary-crossing records can be absent; their absence must not be confused with
lack of large or unusual source documents in CourtListener.

Every supplied opinion field is retained, including all eight renditions,
unknown columns, NULL versus quoted empty strings, original whitespace and
attributes. Original metadata snapshots for clusters, dockets, courts and
citations remain compressed on disk. Acquisition receipts record the source URL,
ETag, window positions and SHA-256 digests. `budget.py` owns the shared cap.

Private inputs and outputs live in `benchmarks/local-data/courtlistener-renditions/`.
Raw browser HTML lives once by SHA-256 in `%LOCALAPPDATA%/OpenLegalData/corpus`.
The [copied UCD collector](../courtlistener-ucd/README.md) keeps private acquisition
manifests and independent browser DOM evidence in the owning browser corpus.
Scratch profiles and recoverable source blocks are disposable; the collector
cleans only the exact paths it creates.

## Resuming and extending acquisition

The original 128 windows are committed, and the Rust packer's index-only
exclusion interface is available. This command extends the same pool; it
preserves the original source identity, window ordinals, byte bounds and
completed part receipts:

```powershell
python experiments/courtlistener-renditions/acquire.py `
  --snapshot 2026-09-30 `
  --out benchmarks/local-data/courtlistener-renditions/broad `
  --packer native/legal-structure-node/target/release/courtlistener-corpus.exe `
  --ranges 128 --range-bytes 33554432 `
  --total-windows 255 --fill-budget `
  --exclude-pack benchmarks/local-data/courtlistener-renditions/pack-zstd15 `
  --exclude-source benchmarks/local-data/courtlistener-renditions/sample/source.json `
  --coverage-priorities benchmarks/local-data/courtlistener-renditions/broad/coverage-priorities.json
```

Resume with the same source and exclusion arguments. `--total-windows` specifies a
minimum planned count and preserves any larger resumed plan. `--fill-budget`
first appends 127 complementary windows, then adds windows
in remaining uncovered gaps while the shared budget admits another download.
The initial extension requests **4,261,412,864 compressed source bytes**. Four
midpoints shift within their original gaps to avoid the retained independent
sample's byte windows. Approximate retained pack growth is 3.6 GB at the observed
28.5 MB per broad window; actual growth depends on recovered complete records.

Each resumed invocation verifies the remote size and ETag with HEAD, then reuses
the retained original CSV columns instead of downloading the first 32 MiB again.
Existing windows are never renumbered or moved. Partial uncommitted pack outputs
and pending receipts require inspection before resuming; they are not silently
accepted or deleted.

The optional coverage-priority file is reloaded between downloads. Its `source`
object must match the snapshot's `url`, `bytes` and `etag`. It accepts an ordered
`ordinals` array for pending planned windows and a `gaps` array of
`{start, end, priority}` objects for choosing subsequent uncovered gaps. `basis`
and `catalog_sha256` record the cached metadata/all-rendition evidence behind that
order. Update this private JSON file atomically. The current order is retained in
the pool manifest; each new part records its priority-file SHA-256 and basis.
A missing file uses exploration order until coverage feedback becomes available.
Compressed positions are explicitly **not metadata strata**: jurisdiction, era,
subject hints and rare source structures must come from the joined catalog.

Build this feedback from a completed native catalog in one cached pass:

```powershell
node experiments/courtlistener-renditions/build-coverage-priorities.mjs `
  CATALOG.jsonl.zst `
  benchmarks/local-data/courtlistener-renditions/broad/source.json
```

The default output is `coverage-priorities.json` beside the pool manifest; an
optional third argument chooses its destination. The builder reads only the
catalog header, one current pool manifest snapshot and its declared exclusion
window receipts. Its `catalog_sha256` explicitly hashes **only the complete JSONL
header**, including its newline. It retains the header's frozen opinion-source
and metadata identities, current manifest digest and exclusion digests. Observed
range declarations must match the committed source-window bounds, index digests
and row counts; no catalog records or opinion renditions are replayed.

Rarity uses source-record frequencies and gives each varying metadata/source
dimension equal weight. Nearby observations guide pending ordinals and uncovered
gap midpoints; a bounded exploration component also favors distant gaps. This is
a source-locality heuristic, not a classification of unseen records. Subject
terms remain hints. Additional committed bytes and rows near an old observation
progressively damp its priority. Rerun after a few committed windows so that a
stale rare region cannot keep consuming the remaining budget. The command writes
one output atomically for the existing adapter's next reload; it starts no watcher.

The destination pool is an implicit exclusion. Each additional exclusion pack
requires its matching original acquisition source receipt, with identical URL,
size, ETag and columns. Complete recovered records go unchanged to Rust, which
skips already retained bulk source IDs using indexes without inflating records.
The adapter independently verifies the exact expected new ID set. Receipts
distinguish recovered, skipped and stored rows and retain source boundary losses.
Independent originals remain available. CAP JSON and served HTML are different
representations and must never be bulk-record exclusions.

The default admission rule reserves 1.5 GB for browser captures, scratch blocks,
indexes and receipts, and stops when less than another 512 MiB remains beyond
that reserve. Required metadata growth is reserved separately by `budget.py`.
The original acquisition kept its 30 GB cap and command through its natural
committed stop. A later guarded invocation imports the authorized 45 GB cap;
editing `budget.py` does not change a running process.

For a bounded final allocation, `--working-reserve-bytes` and
`--minimum-available-bytes` explicitly set scratch and admission headroom.
`--outstanding-browser-bytes` and `--outstanding-output-bytes` reserve all queued
browser growth and other pending outputs separately. Their defaults preserve
the existing admission rule. Choose these allocations from a fresh census and
the actual remaining queue before starting; observed page sizes do not bound
future pages. The private `broad/tail-allocation-plan.json` records the proposed
allocation and its remaining gates. The new adapter waits for the old process's
clean stop and the guarded live pilot's first real capture and publisher results.
Admission also checks actual physical free space on the source and pack drives,
protecting the same allocations and pending metadata growth. The native byte
ceiling uses the smaller logical or physical allowance. Each committed part
records both; `physical_disk_budget` reports a physical-space stop even when
the authorized 45 GB dataset cap has headroom. Metadata pending writes check
their full serialized size against actual free space before publication.
The adapter hashes the exact CSV-derived JSONL bytes submitted for independently
expected new IDs, in their original order, preserving every string, empty value
and null. The part receipt retains that digest and byte count. The first actual
window verifier independently decompresses only the new persisted pack and
compares the complete bytes, field keys/types, IDs and cluster membership. This
compares acquired input with reopened storage; it does not re-download the CSV.
The continued acquisition opts into `--verify-parts`, invoking the same bounded
Node verifier after every new committed pack and before acquiring another window.
It reuses one frozen prefix manifest, records each proof beside the acquisition
receipt, and retains the original compressed window if this check fails.
The reviewed first allocation reserves 96 MiB for working space, 64 MiB for
admission, 4 GB plus the original 256 MiB floor for the browser queue, and
4 GB for pending corpus outputs: 1.5 GB for the fresh metadata join and selected
comparisons, plus a separate 2.5 GB for the full frozen-pool catalog. A first
guarded window waits for the actual publisher pilot terminal proof and that
catalog's exact frozen source snapshot. Continuous filling waits for the
completed catalog and its published coverage priorities. Once that catalog
settles, its actual bytes and the completed join are counted in occupied
storage; replace the 4 GB output estimate with a 2 GB reserve for the final
metadata join and receipts. Re-census and reallocate unused browser headroom
at the actual 7,000-capture milestone and when the saved 12,000-target
continuation finishes or reaches its budget stop.

Guarded bulk and host persistence share `budget.writer()`. Fresh allocation,
native packing, sidecars and manifest commit hold the same lock. Actual recovered
IDs and clusters give a conservative serialized sidecar allowance before packing;
full pending receipts are preflighted before publication. A header-only coverage
priority refresh also takes the lock and reserves 16 MiB for its atomic output.
The five owned CourtListener collection locations are counted; the unrelated
shared `corpus.sqlite` is outside that scope. The browser collector's delays and
copied UCD path are unchanged.

## Corpus runs

[The Rust executable](../../legal-structure/experiments/courtlistener-corpus/README.md)
owns compression, metadata joins, selection, structure parsing and rendition
comparison. Python is limited to source acquisition and the copied browser path.
Builds use one job and the ordinary Cargo target. This session runs no unit,
integration or browser smoke suites and writes no tests; behavioral checks use
actual retained corpus records and independent browser evidence.

- `metadata` joins source records to official cluster, docket and court data.
  Canonical opinion URLs require the source cluster ID **and slug**.
- `catalog` indexes jurisdiction, court, time, source, opinion type, OCR, size,
  rendition combinations and markup features. Subject keyword hints are explicitly
  labelled as hints, never verified legal classifications. Coverage is measured
  on the selected and successfully captured records.
- `select` reads that ranked catalog; repeated selection does not rescan HTML.
- `derive-pack` measures retained source plus exact annotation insertions,
  including the upstream plain-text branch. It verifies reconstructed fields
  against the independent originals and reopens the persisted candidate.
- `richness` feeds every populated rendition independently to the engine. It
  compares source tags, IDs, links, exact field equality, recovered node kinds,
  recovered anchors, byte sizes and processing time. Alternate fields receive no
  fallback text from another rendition.
- `web-run` compares recovery from saved opinion bodies with independently
  captured browser DOM anchors. Parser output never supplies its own gold.
  A generated fragment directive is not evidence of real browser highlighting.

## Storage decisions

The native pack uses independently seekable Zstandard frames. Each frame is
immediately decompressed and compared byte for byte with its actual input.
The reader checks frame digests, source membership and counts. Compression
preserves the original decoded values; it does not replace HTML with parser output.

The supplied `audit.py` remains a reference codec for exact duplicate references
and exact reversible string edits. It is not the parser or the main iteration
path. `production-proof.ts` compares an original row with its reconstruction;
that comparison cannot establish which competing rendition is richer. Its URL
handling requires complete source metadata. The optional compiler-export patch
has not been applied.

An equal normalized text, a lower node count, a parser error, or absence from the
current display preference does not establish that a rendition is needless.
A removable storage relationship must reconstruct the independently retained
original exactly, including metadata and attributes. Any proposed semantic
reduction needs separate evidence about the structure and usable links it loses.
Until then, preserve both originals losslessly.

## Primary sources

- [Official bulk data format](https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data)
- [Official case-law API and representation fields](https://wiki.free.law/c/courtlistener/help/api/rest/v4/case-law)
- [CourtListener models and canonical URL construction](https://github.com/freelawproject/courtlistener/blob/main/cl/search/models.py)
- [CourtListener citation annotation](https://github.com/freelawproject/courtlistener/blob/main/cl/citations/annotate_citations.py)

Durable findings belong beside the Rust harness. Private receipts record the
actual data scope and engine fingerprint; no full-corpus claim follows from a
successful partial run.
