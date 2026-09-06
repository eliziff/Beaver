# Document versions and content-addressed storage

Status/order/gates: [master plan](master-plan.md). Extend existing document/object
ports, not Git or another research store: stable identity → mutable working
revision → immutable checkpoint → linear restorable history, local and cloud.

## Contract

- Rename/move/revise retains identity. Human autosaves do not create versions.
  One assistant turn creates at most one version per document, atomically updating
  that version on subsequent writes with original parent and DOCX review safeguards.
- Uploads, completed generated builds, snapshots and restores create checkpoints.
  Restore is a new descendant of the former head with historical content, never
  rewind/history mutation. Old reads stay explicit/read-only.
- Activity/search/read/labels belong in existing receipts, not versions. Research
  files, including their optional Markdown memo and owned evidence/query parts,
  obey the ordinary lifecycle as one document.
- Library details show newest-first actor/time/provenance/comment; Preview/Restore/
  Compare only where supported. No branches/staging/checkout/minor-version jargon
  or second Workspace history panel.

## Storage and failure invariants

- Hash exact bytes once on ingestion, never canonicalize Office/PDF/Markdown.
  Immutable whole blobs use `<scope>/blobs/sha256/<2 hex>/<rest>`; deduplicate only
  within the narrow durable authorization scope, never unrelated users/projects.
  Filename/type/provenance/author/parent/time remain metadata.
- Validate, write/verify content, then publish version/head transactionally with
  expected head/working revision. Same-document parent foreign key; repository CAS
  enforces current-head integrity. Existing digest/size match succeeds; never
  overwrite CAS content. Read by stored key with trust-boundary integrity checks.
- Publication failure leaves an orphan, not a visible broken version. Delete
  references before bytes and only after no version/rendition/part/durable reference
  remains. Reachability, not mutable counters; extend existing orphan/pending
  cleanup with grace for interrupted writers/readers, idempotent restart and
  progress/usable partial results.
- Audit every add/replace caller by semantic event. Human research replacement is
  atomic, builds immutable, deterministic cleanup outside assistant turns retained.
  Replace old key layout outright, no migration/dual-read path.

## Proof

- Two writes in one turn: one new version/final bytes; different turns: two correct
  parents. Create/revise/revise/restore: four rows, first content and former-head
  parent on restored row.
- Filesystem/S3-compatible fixtures: identical same-scope versions share one blob,
  different bytes do not; deletion retains shared objects until last reference.
- SQLite/Postgres: stale concurrent writers, injected blob/version/head/cleanup
  failures, restart recovery, hash mismatch/missing objects, restore/deletion
  authorization, queryable receipts and common application behavior.
- ChromeDriver/screenshots: historical preview, restore/reload, keyboard history
  and actual assistant research without version proliferation. Measure storage/
  latency; no reachable blob loss.

References: [iManage](https://registration.imanage.com/pages/imanage-work-feature-foundations),
[M-Files](https://www.userguide.m-files.com/user-guide/latest/eng/object_history.html),
[SharePoint](https://learn.microsoft.com/en-us/sharepoint/version-overview),
[Nuxeo](https://doc.nuxeo.com/nxdoc/2021/file-storage-configuration/),
[OCI](https://github.com/opencontainers/image-spec/blob/main/descriptor.md?plain=1),
[restic](https://restic.readthedocs.io/en/latest/100_references.html).
No initial dependency: libgit2/lakeFS/full DMSes bring unwanted repository/server
machinery; cacache is not a local/cloud source of truth. Evaluate maintained chunk
storage behind the same port only if retained large versions dominate measured
cost. Keep experiments/raw outputs separate; do not adopt a whole subsystem.
