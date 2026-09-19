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
Exact batches use `word.batch(...)` inside the program, not a second tool schema.

Programs are synchronous function bodies; native calls suspend automatically.
QuickJS WASM runs on a terminable thread with memory/stack/time/call/output
budgets, without Node, Python eval, imports, filesystem or network APIs.

| API | Use |
| --- | --- |
| `object.get(name)` or `get([names])` | Read one or up to 32 native properties in one call. |
| `object.set(values)` / `call(method,...args)` | Native properties and discoverable document-local methods. |
| `object.items(offset=0,limit=20)` | Page collections as `{items:[{name,value}],next_offset,total}` with reusable object handles. |
| `object.describe(filter,offset,limit)` | Paged native signatures/types; metadata is cached only within this program. |
| `word.target(address)` / `word.inspect(query)` | Resolve targets or inspect a family; `properties` plus `include_text:false` omits text. |
| `word.create(service)` / `word.constant(name)` | Document-local factories and native named constants. |
| `word.enum(type,value)` / `struct(type,fields)` / `any(type,value)` | Typed native arguments, including numbering sequences. |
| `word.batch(operations)` / `object.expect(values)` | Exact replacements/property batches and export/reopen postconditions. |
| `word.review(targets,decision)` | Selective accept/reject; use a separate program from new edits. |

Follow `next_offset` until null. Enumeration pages leave `total` null rather than
scan an unseen tail or invent a count beyond the end. Indexed/named collections
fetch only the requested suffix; enumeration-only collections must traverse the
prefix. Native handles live within one program: retain objects before structural
edits, then reinspect indexed addresses. They are not durable legal citations.
`String` may include redline deletions; use ordinary `Read` for final prose.
`word.mm`/`word.pt` convert geometry to hundredths of a millimetre; fonts use points.

## Preservation and review

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
/usr/bin/python3 -m unittest discover -s experiments/libreoffice-uno -p 'test_*.py' -v
# Isolated Linux cloud path:
docker build -f uno.Dockerfile -t beaver-uno:test .
WORD_UNO_CONTAINER_IMAGE=beaver-uno:test npx tsx --test experiments/libreoffice-uno/console.node.ts
```

Path-filtered CI runs the real console on Windows x64, macOS ARM64 and Linux x64,
plus the Linux container; missing runtimes fail. Existing scenarios cover native
creation, revisions/rejection, restricted access, cancellation, paged collections
and bulk reads. The application suite uses an injected store/engine, not a real
database. Remaining qualification: wider real-document fidelity, joined native
engine/persistence/browser coverage, additional OS/CPU packaging, and live-model
token/performance measurements. Exact candidate CI evidence belongs in the PR.
