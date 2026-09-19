# LibreOffice/UNO editing

This is a working, bounded rich-edit path, not a replacement for the Markdown
composer or surgical tracked text edits. Production code is in
`src/lib/libreOffice{,Application}.ts`, `src/lib/chat/libreOfficeTool.ts` and
`scripts/word_uno.py`. The ordinary chat tool registry exposes `word_uno` only to
the main agent. It uses existing document versions, artifact events and storage.
No new document service, browser editor, inference loop or npm dependency exists.

## Install and run

The qualified process boundary is **Linux** (local or cloud), with LibreOffice
Writer and its matching Python/UNO bridge. For Debian/Ubuntu images:

```sh
apt-get install libreoffice-writer python3-uno
/usr/bin/python3 -c 'import uno'
soffice --version
```

Pin the OS image/package versions in deployment and run this suite on that image.
Every result records the actual engine version; version recording alone is not
qualification. `WORD_UNO_PYTHON` selects a trusted Python with UNO (default
`/usr/bin/python3`). Existing `SOFFICE_BINARY_PATH`, `LIBREOFFICE_BINARY_PATH` and
`LIBRE_OFFICE_EXE` overrides select the office executable. Keep `backend/scripts`
with the compiled backend. Nothing installs Word or requires Word activation.
Windows/macOS process ownership and packaging are not implemented or qualified;
the gateway refuses there rather than leaking an owned office process.

From the repository root:

```sh
/usr/bin/python3 -m unittest discover -s backend/experiments/libreoffice-uno -p 'test_*.py' -v
cd backend
npx tsx --test experiments/libreoffice-uno/application.node.ts
```

The first command starts real private Writer instances and never skips missing
runtimes. The second tests application publication outcomes with a fake document
store and fake expensive engine; it is not proof of a database or Writer runtime.
The path-filtered CI job runs these checks separately from the normal Vitest suite.
No live model or paid API is used.

## Model workflow

Use `Read`, `Edit` and `Write` for ordinary content. Load `word_uno` for depth:

1. `inspect` a version-pinned `file_path`, optionally with `family`, `target`,
   `offset` and `limit`. It returns native object targets and a source `snapshot`.
2. `describe` a target, optionally filtering property names. It discovers native
   types and values; `writable` describes this worker's policy, not all UNO powers.
3. `preview` with that snapshot and a coordinated batch. The source stays intact;
   the exported/reopened candidate is a separate Library DOCX with a bound receipt.
4. Review the report and actual candidate, using existing document/PDF views.
   `apply` consumes the exact `preview_resource` and original `file_path`.
   It requires the application's **Direct** edit mode. Manual/review mode may
   produce the copy but cannot silently publish direct edits to the original.

An illustrative batch (obtain actual names/targets from inspection):

```json
[
  {"target":"footnote:0","replace":{"find":"paragraph 12","text":"paragraph 15"}},
  {"target":"table:Table1","set":{"RepeatHeadline":true}},
  {"target":"page-style:Standard","set":{"LeftMargin":1905}}
]
```

UNO measurement properties normally use hundredths of a millimetre, not points.
The console uses native property names, with bounded enum/struct values. Targets
cover body paragraphs, tables/cells, notes, frames and page/paragraph/character
styles; `header:<page-style>` and `footer:<page-style>` address their text.
Bodies and tables are not interchangeable: inspect the table to get cell targets.
Native range search resolves exact text inside the chosen object, including
Unicode and notes; models do not calculate character offsets. Handles are valid
only for the inspected snapshot. They are not legal evidence or durable citations.

## Execution and preservation contract

Each batch owns a random UNO pipe and fresh profile, never a public TCP listener
or the user's office. The Node gateway sanitizes credentials, bounds input/output,
owns the process group, supports cancellation and kills timed-out descendants.
The Linux worker applies resource limits. Macros, embedded objects, active fields,
DTD/entities and active external relationships are refused; macro execution and
link updates are disabled when loading. This is **not an OS sandbox**. Run the
worker under deployment-level filesystem/network isolation for untrusted files.

There is deliberately no `eval`, arbitrary Python program or unrestricted UNO
method invocation. A full programmable console requires an established execution
sandbox and is still follow-on work. The current batch surface supports only
explicit document-local property families and exact text replacements.

A failed operation discards the entire candidate. Export and reopen must preserve
requested property values and text/story identities. An independent source XML
paragraph inventory also rejects text changes outside explicit replacements;
identical inherited header/footer copies are deduplicated for that inventory.
Existing revision/comment text and authors, bindings, custom XML, and opaque
assets are checked. Changed ZIP parts are reported. These witnesses do **not**
prove paragraph ordering, every anchor position, all formatting, full OOXML
validity or Word-identical pagination. Conservatism can refuse a harmless
serialization change, field result or property quantization. No part is copied
back to conceal an import/export failure.

New changes are direct edits, **not native tracked changes**. Existing source
revisions are checked; review-mode publication is refused. The receipt binds
source version, working revision, original hash and candidate hash. Publication
uses the document store's compare-and-swap; it never reruns the edit program.
Duplicate application in one turn is idempotent; later retries hit the stale-base
check. A crash after an uncertain write is fenced from automatic replay, not
represented as a durable cross-process exactly-once transaction.

## Evidence for this change

Locally executed on LibreOffice **25.2.3.2**, system Python/UNO and Node **22.16.0**:
seven real-engine tests passed (compound note/table/margin edit, no-change control,
paged/property inspection, Unicode targeting, failed batches, stale/output guards,
unsafe properties/packages); five application outcome tests passed.
The actual TypeScript gateway was also exercised through export/reopen, and an
aborted job left no owned office process. A two-page candidate was rendered to
PDF/PNG; both pages were visually inspected. A table colour edit that did not
survive export was refused rather than reported successful.

TypeScript syntax/transpilation and a strict gateway-only typecheck were run.
A full checkout/registry was unavailable, so repository builds/typecheck, source
boundary/docs gates, real database integration and browser/chat smoke were not
run. Those remain PR gates. This small synthetic corpus is not comprehensive
Word fidelity, arbitrary-property coverage, or performance qualification.
