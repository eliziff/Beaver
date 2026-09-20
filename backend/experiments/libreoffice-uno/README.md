# LibreOffice/UNO document console

`word_uno` is the main assistant's lazy rich-document tool. Ordinary `Read`,
`Edit`, deterministic text operations and Markdown `Write` retain their efficient
paths. No Microsoft Word, new browser editor, document model or agent loop.

## Runtime

Install LibreOffice Writer with its matching Python bridge. Windows/macOS probe
the installed application's bundled interpreter where available; Linux normally
uses `/usr/bin/python3` and `python3-uno`. Overrides: `WORD_UNO_PYTHON`,
`SOFFICE_BINARY_PATH`, `LIBREOFFICE_BINARY_PATH`, `LIBRE_OFFICE_EXE`.
Keep `backend/scripts` with the compiled backend. No global Python, registry or
signing changes. The gateway owns a fresh profile/local pipe and a Windows Job
Object or POSIX process group; Stop terminates its script and native processes.

Cloud: build `backend/uno.Dockerfile` and set `WORD_UNO_CONTAINER_IMAGE` to the
qualified immutable image digest. `WORD_UNO_CONTAINER_RUNTIME` defaults to Docker.
The job has no network, read-only root, dropped capabilities, no-new-privileges,
CPU/memory/PID limits, temporary storage and only its assigned directory mount.
Do not expose the daemon socket to models. Native local execution restricts
capabilities but is not an OS sandbox against office-engine vulnerabilities.

## Interface

Load `word_uno`, request `help`, then inspect a versioned `file_path` for its
snapshot and targets. `inspect` with `program` runs read-only JavaScript.
`preview` requires a JavaScript program and the inspected snapshot; `apply`
publishes its frozen `preview_resource` through existing version checks.
Compose edits with ordinary JavaScript, not a separate batch language.

Programs are synchronous function bodies; native calls suspend automatically.
QuickJS WASM runs on a terminable thread with memory/stack/time/call/output
budgets, without Node, Python eval, imports, filesystem or network APIs.

| API | Use |
| --- | --- |
| `object.get(name)` or `get([names])` | Read up to 32 properties; native multi-property reads share a character cursor. |
| `object.set(values)` / `call(method,...args)` | Native properties and discoverable document-local methods. |
| `object.items(offset=0,limit=20,properties=[])` | Page reusable handles and up to 32 chosen properties per object in one call; rows contain `name`, `value`, and optional `properties`. |
| `object.describe(filter,offset,limit)` | Paged native signatures/types; metadata is cached only within this program. |
| `word.target(address)` / `word.inspect(query)` | Resolve targets or inspect a family; `properties` plus `include_text:false` omits text. |
| `word.create(service)` / `word.constant(name)` | Document-local factories and native named constants. |
| `word.enum(type,value)` / `struct(type,fields)` / `any(type,value)` | Typed native arguments, including numbering sequences. |
| `textObject.find(literal)` | Select one exact native range within a paragraph/cell/note/header; refuse missing or ambiguous matches. |
| `object.expect(values)` | Verify retained objects, selected ranges and attached notes before and after export. |
| `word.review(targets,decision)` | Selective accept/reject; use a separate program from new edits. |

Follow `next_offset` until null. Enumeration pages leave `total` null rather than
scan an unseen tail or invent a count beyond the end. Indexed/named collections
fetch only the requested suffix; enumeration-only collections must traverse the
prefix. Native handles live within one program: retain objects before structural
edits, then reinspect indexed addresses. They are not durable legal citations.
Postconditions bind live objects to their final location before export, not the
index captured before an insertion. Selected ranges retain their native scope
and exact prefix; removed or unaddressable checked objects fail. Formatting checks
on found ranges are automatic; use `expect` for newly attached objects. Repeated
assignments coalesce into final-value checks, without replaying the edit program.
`String` includes redline deletions; explicit expectations check that raw view.
The native `writable` metadata does not grant mutation rights to read-only programs.
Ordinary `Read` supplies final prose.
`word.mm`/`word.pt` convert geometry to hundredths of a millimetre; fonts use points.

For an exact edit: `word.target('footnote:0').find('paragraph 12').set({String:'paragraph 15'})`.
Retain the returned range to inspect or edit it without counting offsets. Rectangular
table ranges expose native `getDataArray`/`setDataArray` for bulk rows; select the
rectangle with `table.call('getCellRangeByName','A1:B3')`, then call the array method.

## Preservation and review

Receipts give mutating-call counts, at most 20 operation summaries, and exact
revision counts, not text diffs. Inspect the candidate or page its revisions for
details; return chosen before/after values from the program when useful.

The user's application setting owns tracked/direct mode. Every preview verifies
a no-edit round trip, exports/reopens the candidate, and checks ordered story
text, tables, bookmarks, drawings, revisions and targeted properties. Existing
review/comment text/authors, custom XML, bindings and opaque assets are protected.
Only tracked editing needs the extra normalized control export: rejecting new
revisions must restore that control except named volatile metadata. Untrackable
mixed changes refuse Review mode, never silently become direct changes.

These witnesses are not complete OOXML validation, every anchor/formatting
property or Word-identical layout. Unsupported round trips fail; discarded XML
is never pasted back. Active fields/links, macros and embedded objects are refused;
load disables macros/link updates. Scope, mode, hashes, working revision and
compare-and-swap publication remain enforced. Apply never reruns the program.

## Validation

```sh
cd backend
npx tsx --test experiments/libreoffice-uno/console.node.ts
npx tsx --test experiments/libreoffice-uno/application.node.ts
# Isolated Linux cloud path:
docker build -f uno.Dockerfile -t beaver-uno:test .
WORD_UNO_CONTAINER_IMAGE=beaver-uno:test npx tsx --test experiments/libreoffice-uno/console.node.ts
```

Path-filtered CI runs the real console on Windows x64, macOS ARM64 and Linux x64,
plus the Linux container; missing runtimes fail. Existing scenarios cover native
creation, revisions/rejection, restricted access, cancellation, paged collections
and bulk table operations. Fixtures are built with JSZip using the original XML
payloads; the container suite no longer needs a host Python/UNO just to build input.
The application suite uses an injected store/engine, not a real
database. Remaining qualification: wider real-document fidelity, joined native
engine/persistence/browser coverage, additional OS/CPU packaging, and live-model
token/performance measurements. Exact candidate CI evidence belongs in the PR.
