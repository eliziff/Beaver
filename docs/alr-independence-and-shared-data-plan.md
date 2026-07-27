# ALR independence and shared legal data plan

Status: accepted, 2026-07-26

This accepted decision remains authoritative for the ALR coupling boundary.
Project-wide implementation status is tracked in the
[Mike-Canada master plan](mike-canada-master-plan.md).

## Decision

ALR Quote Verifier remains an independent product with its own repository,
maintainers, releases, CLI, and GUI. MikeOSS and its subprojects must not import
ALR modules, modify `sys.path` to find an ALR checkout, invoke ALR as a hidden
runtime dependency, or require an ALR fork.

Reusable capabilities are divided between two neutral components:

- `OpenLegalData/` owns shared provider downloads, provider databases,
  importers, and the versioned local lookup contract.
- `universal-legal-pdf-engine/` owns application-neutral PDF structure and
  footnote parsing.

MikeOSS, Table of Authorities Maker, and future applications consume those
neutral contracts. ALR may adopt the same contracts later, but it is not
required to do so.

```text
ALR Quote Verifier (independent)
        | optional data adapter or upstream contribution
        v
OpenLegalData <-------- MikeOSS / ToA / other applications

ALR algorithms and fixtures
        | selective ports with parity tests
        v
universal-legal-pdf-engine <--- MikeOSS / ToA / other applications
```

## Storage boundary

The default shared root is:

`%LOCALAPPDATA%\OpenLegalProducts\LegalData`

It is overridable with `OPEN_LEGAL_DATA_HOME`.

Share:

- immutable or atomically replaced upstream downloads;
- provider databases and raw snapshots;
- stable source identities, checksums, licenses, and import metadata;
- provider-neutral document and pinpoint records.

Do not share:

- application settings or credentials;
- prompts, model transcripts, or application-specific LLM caches;
- user projects, generated work product, or review decisions;
- derived indexes whose schema or meaning belongs to one application.

Application state remains under `apps/<application>/`. Disposable provider
HTTP caches may live under `cache/<provider>/`, but must never be the only copy
of user work.

OpenLegalData is the only owner of shared provider schemas and write
transactions. Bulk updates build beside the live database, validate, and
replace atomically. Other applications use its public Python/HTTP contract or
open documented immutable snapshots read-only.

## Code reuse boundary

Do not use a sibling-path import from ALR. A small import is still coupled to
ALR's private API, dependency graph, filesystem layout, and release cadence.

For generally useful ALR behavior:

1. Identify the smallest deterministic function or algorithm.
2. Record the ALR source repository, commit, and file as technical history.
3. Port it into the appropriate neutral component.
4. Remove assumptions about ALR's GUI, configuration, or output directories.
5. Test the port against representative ALR fixtures and expected outputs.
6. Let the implementations evolve independently after the compatibility
   contract is established.

An extracted package jointly maintained by both projects can replace a port
later, but only if ALR's maintainers choose that dependency and the API is
versioned independently.

## Fork policy

A fork is not a runtime architecture. Use one only to prepare upstream
contributions, retain a pinned provenance reference, or intentionally maintain
a separate ALR edition. MikeOSS must not depend on such a fork.

Record source revisions beside a port when they help track compatibility; no
separate copyright attribution is required for project-authored ALR behavior.

## Compatibility with existing ALR downloads

OpenLegalData should recognize reusable existing ALR provider material through
an explicit, read-only compatibility importer:

- discovery is opt-in or given an explicit ALR data directory;
- source files are never edited or deleted;
- compatible files are validated before use;
- import uses a copy, hard link when safe, or normal provider import;
- imported records retain source path, content hash, and upstream license;
- ALR-specific derived caches remain in ALR's own directory.

If ALR's maintainers later accept a small OpenLegalData adapter, ALR can look in
the canonical shared root first and retain its legacy location as a fallback.
Until then, MikeOSS does not assume that ALR reads shared storage.

## Execution

1. Remove the prior plan to migrate ALR's UI or runtime into MikeOSS.
2. Finish and test the standard-library OpenLegalData runtime, A2AJ, and
   CourtListener provider contracts.
3. Add the smallest safe compatibility importer for reusable ALR downloads
   after auditing their actual formats.
4. Keep Table of Authorities Maker and MikeOSS on OpenLegalData paths without
   importing ALR.
5. Keep all ALR-derived PDF behavior in `universal-legal-pdf-engine`, with
   provenance and parity fixtures.
6. Verify clean startup with no ALR checkout present.

## Acceptance checks

- Renaming or removing the local ALR checkout does not break MikeOSS, Table of
  Authorities Maker, OpenLegalData, or the universal PDF engine.
- MikeOSS and Table of Authorities Maker resolve the same
  `OPEN_LEGAL_DATA_HOME` and provider database paths.
- Two applications can read the same provider snapshot without either writing
  application state into it.
- Interrupted or invalid imports leave the previous provider database intact.
- A compatibility import does not modify its ALR source and produces the same
  content hash on repeated runs.
- Ported parser fixtures remain equivalent without importing any ALR module.
