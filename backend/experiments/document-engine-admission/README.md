# Document-engine admission

**Phase 0 tooling; adoption blocked.** This exports Beaver's existing corpus and
scores physical document outputs. It does not install, invoke, or admit SuperDoc,
change the production editor, or implement the rich console. The canonical
implementation sequence is [document capabilities](../../../docs/roadmap/document-capabilities.md).

## Why no engine dependency is installed

Inspection on 19 September 2026 found a separately proprietary
`@superdoc/docx-engine` dependency in the editor's public package manifest.
The [engine terms](https://docs.superdoc.dev/resources/docx-engine-license/)
(version 2026-07-14, especially sections 2.1 and 5) restrict benchmarking and
results disclosure. We have not established an applicable permission for Beaver.
The editor's AGPL label is not approval for this dependency. This is a dependency
admission blocker, not a legal opinion about a particular agreement.

`admission.json` records the decision and unpassed gates. A maintainer must resolve
permitted evaluation, local/cloud distribution, agent use, support, and publication
of findings before installing an exact compatible engine/SDK/editor combination.
This PR accepts no vendor terms and contains no proprietary engine material.
Do not replace the candidate with an old release or an alternative engine silently.

## Run the independent checks

From the repository root, Python 3.10+ with only the standard library:

```sh
python -m unittest discover -s backend/experiments/document-engine-admission -p 'test_*.py' -v
python backend/experiments/document-engine-admission/audit.py before.docx after.docx
python backend/experiments/document-engine-admission/audit.py before.docx after.docx --allow-xml word/document.xml
```

The tests mutate actual ZIP/XML artifacts and verify rejection of lost human
revisions, anchors, headers, custom XML, opaque assets, unsafe packages and dangling
relationships. They are oracle tests, **not engine benchmarks**. Normal backend
Vitest runs do not load them. The path-filtered workflow runs only these tests;
it never installs a document engine or calls a model.

## Reuse the existing 12-fixture / 28-task corpus

Use the dependencies already installed for `backend`, from a clean tracked checkout:

```sh
cd backend
npx tsx experiments/document-engine-admission/corpus.ts export /tmp/beaver-admission
```

Choose a new destination directory (on Windows, for example `C:\Temp\beaver-admission`).
An existing directory is refused. The exporter calls the existing fixture builders
and task loader, rather than copying their data or creating another generator. It
adds a no-op round-trip case per fixture: the current corpus yields 40 cases.
The bundle freezes actual DOCX bytes with SHA-256 hashes, tasks, source revision,
and the checker/reader/evaluator identities. Regeneration creates a new bundle, not a quietly
updated baseline. Partial exports without `bundle.json` are not usable bundles.

After a licensed engine runner exists and has actually executed the cases, put a
completed copy of `results.template.json` beside its output files. For each case,
provide **every input document**, including unchanged guard documents. Each entry is:

```json
{
  "id": "roundtrip-crossbridge-bylaw",
  "status": "completed",
  "documents": {
    "crossbridge-bylaw": {
      "file": "roundtrip-crossbridge-bylaw/export.docx",
      "reopened": "roundtrip-crossbridge-bylaw/reopened.docx"
    }
  }
}
```

The second file must be exported after reopening the first in the tested engine,
not just copied or renamed. Refusal tasks use `status: "refused"`, supply unchanged
artifacts, and include the actual `answer`. Errors, unsupported cases and unrun
cases remain in the results; never invent a successful artifact or answer.
Record the real engine name, exact version, distribution SHA-256 and runtime.
These are trusted runner provenance, **not cryptographic proof of engine execution**.
There is deliberately no engine driver until the licensing/distribution gate is
settled; producing the result files remains a separate implementation step.

```sh
npx tsx experiments/document-engine-admission/corpus.ts score /tmp/beaver-admission /tmp/candidate/results.json /tmp/candidate/report.json
```

Set `PYTHON_BINARY` only when Python's executable name differs. No shell expression
is evaluated. Paths must stay inside their declared artifact directories, including
when resolved through symlinks. The report is created exclusively, not overwritten.
The scorer refuses duplicate/unknown cases, changed fixtures, stale checker/reader/evaluator
identities, and unbound or unpinned engine results. Missing cases and guard documents
cannot disappear from the denominator.

Body-text results use Beaver's existing extractor and `scoreTask`, including the
frozen refusal and near-miss contracts. They are checked on **both** physical exports;
model-supplied text is never accepted in place of a document. Package checks then
cover parts which that body-text score cannot see.

## What the report proves, and what it does not

A package audit ignores ZIP metadata and narrowly harmless XML serialization
changes in known Word parts. Unknown XML and binary assets remain byte-checked.
It preserves text whitespace, namespace bindings and run boundaries. It
rejects removed/added parts, changed opaque data, invalid internal relationships,
and altered protected review/anchor/binding nodes. This is intentionally conservative:
ID renumbering or a harmless metadata update can require investigation. It is not
an implementation of the complete OPC/OOXML schema or a malware sandbox.

`--allow-xml` means **review required**, never permission to ignore that part. For
legacy text-edit tasks, only `word/document.xml` is eligible for that status;
refusal and no-op cases allow none. A correct textual result cannot certify an
arbitrary rewrite of the main XML. Intended richer structural changes need their
own native assertions before they become admission cases. Do not weaken the gate
with a whole-part ignore list to make an engine pass.

Audit exit codes: 0 = checked equivalence, 1 = failure, 2 = native review required.
Corpus scoring exits nonzero for failures, missing/unsupported results or native
review requirements. Its report always retains `qualification: "not_admitted"`:
passing this corpus is not approval of licensing, rendering, full Word semantics,
advanced editing, browser handoff, or application isolation.

The existing corpus is a baseline, not the complete planned advanced slate. In
particular, it preserves the historical note-edit refusal task; it is not evidence
that notes should remain uneditable. Add separately authored advanced cases rather
than rewriting old gold. Rich compound edits, browser/headless handoff, review-mode
policy, isolated code execution, version-safe publication and measured tokens/latency
remain gates before any production replacement. No engine code should be removed
until its actual replacement passes those gates.

### Validation of this change

The eleven standard-library oracle tests ran successfully in the implementation
container. The TypeScript entry point passed a syntax/transpilation check. A complete
checkout and npm registry were unavailable there, so corpus export/scoring, repository
typecheck/builds, browser tests and actual SuperDoc evaluation were **not run**.
No live models, native Word processes or paid calls were used.
