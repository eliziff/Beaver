# LibreOffice/UNO document console

`word_uno` is the main assistant's lazy rich-document tool. Ordinary `Read`,
`Edit`, `edit_docx_advanced` and Markdown `Write` keep their compact/surgical paths.
Rich tasks use JavaScript over native Writer objects, not a second Word model or
an expanding list of Beaver formatting commands. No Microsoft Word is required.

## Runtime and installation

The same gateway runs on Windows, macOS and Linux. It locates LibreOffice and
probes a compatible Python/UNO bridge, including the actual office type registry.
Windows/macOS use the installed application's bundled interpreter where available;
Linux normally uses `/usr/bin/python3` with `python3-uno`. No manual PYTHONPATH,
registry, Trust Center or signing changes are made. Overrides are `WORD_UNO_PYTHON`
and the existing `SOFFICE_BINARY_PATH`/`LIBREOFFICE_BINARY_PATH`/`LIBRE_OFFICE_EXE`.
Install LibreOffice with its Python component before using the native path.

Each job owns a private profile and random local pipe. A Windows Job Object or
POSIX process group owns cleanup; a termination listener holds Writer across
close/reopen. `Stop` terminates an independent script thread and the owned native
job, not the user's office. Keep `backend/scripts` alongside the compiled backend.
`quickjs-emscripten` and its WASM dependencies are pinned in the backend lockfile.

For an isolated cloud worker, build from `backend/`:

```sh
docker build -f uno.Dockerfile -t beaver-uno:qualified .
```

Set `WORD_UNO_CONTAINER_IMAGE` to the qualified image's immutable digest.
`WORD_UNO_CONTAINER_RUNTIME` defaults to `docker` (a compatible `podman` executable
may be configured). The gateway uses no network, a read-only root, dropped
capabilities, no-new-privileges, bounded CPU/memory/PIDs, a temporary filesystem
and only the assigned per-job directory mount. It removes the container on all
exit paths. The image build recipe is not itself a release pin; qualify and
retain its actual digest and engine/font versions. Never expose a daemon socket
to model code or the browser. The native local path is document-capability
restricted, not an OS sandbox against a vulnerability inside LibreOffice.

## Model interface

Load `word_uno`, then `help` for concise console instructions. `inspect` returns
bounded native text/targets and the immutable source `snapshot`; `describe`
returns selected property metadata. `inspect` with `program` is read-only.
`preview` takes the snapshot and either `program` or `operations`, executes on a
copy, exports/reopens/verifies it, and saves a separate version-bound candidate.
`apply` publishes those frozen candidate bytes after another base-version check;
it never reruns the program. Existing artifact events, views, storage, scope,
mutation fences and cancellation are used. No new service/store/model loop/UI.

Programs are synchronous JavaScript function bodies with variables, loops and
functions. Native calls suspend through QuickJS Asyncify automatically. Return a
small result, not the document object tree. Guest code has no Node APIs, imports,
Python evaluator, filesystem or network. It runs in QuickJS WASM on a terminable
worker thread with memory, stack, time, call and output limits.

| Operation | Purpose |
| --- | --- |
| `object.get(name)` / `object.set(values)` | Native properties; character formatting on a paragraph addresses its text rather than its paragraph mark. |
| `object.call(method, ...args)` | Discoverable document-local UNO methods and collections. |
| `object.describe(filter, offset, limit)` | Native method signatures and property types, loaded only as needed. |
| `word.target(address)` / `word.inspect(query)` | Resolve or enumerate native document objects. |
| `word.create(service)` | Available document-local factories, including notes, tables, bookmarks and styles. |
| `word.enum(type, value)` / `word.struct(type, fields)` / `word.any(type, value)` | Typed UNO method arguments, including sequences required by numbering APIs. |
| `word.constant(name)` | Actual named native constants, rather than guessed numeric values. |
| `word.batch(operations)` | Existing exact replacements and coordinated property batches. |
| `object.expect(values)` | Register explicit export/reopen property postconditions for an inspected address. |
| `word.review(targets, decision)` | Accept/reject selected native revisions; keep review separate from new changes. |

`doc` is the current Writer document. Native handles live inside one program.
Resolve objects before structural edits and retain those handles; inspect again
for new indexed addresses after insertions/removals. Addresses are not durable
legal citations. `String` is native redline text and may include deletions;
use compact `Read` for final prose or inspect the revisions explicitly.

For example, in a Direct-mode preview, after inspecting the actual table name:

```js
const table = word.target('table:Table1');
const rows = table.get('Rows');
rows.call('insertByIndex', rows.get('Count'), 1);
table.set({ RepeatHeadline: true });
return word.inspect({ target: 'table:Table1' });
```

Use native introspection for detailed features instead of adding another wrapper.
Application/storage/scripting interfaces, arbitrary document loading, executable
services, active external fields, macros and embedded objects are excluded.
Document-local breadth is not permission to access the host.

## Review, preservation and publication

The application's existing user setting selects tracked or direct mode; a model
argument cannot override it. Tracked text and footnote edits are emitted by Writer
as real DOCX revisions. The worker reopens the exported candidate, accepts the new
revisions on a disposable copy for property checks, and rejects them on another
copy. Rejection must restore a no-edit round-trip control (apart from named
volatile serialization/statistics metadata). It does not waive entire XML parts.
An untrackable property or mixed batch fails instead of silently applying direct
changes in Review mode. Some page/formatting operations therefore require the
user's explicit Direct mode; broad native review fidelity is not assumed.

Every mutation first proves that this input survives the tested no-edit text and
protected-content checks. Export/reopen checks ordered body structure, story
text, table cells/rows, bookmark text, drawing geometry and revision identities,
plus targeted native properties. Existing review/comment text/authors, custom XML,
bindings and opaque parts are protected unless an explicit revision-review action
accounts for their removal. These witnesses are not full OOXML validation, all
anchor geometry or all Word layout behavior. Unsupported documents fail; XML parts
are never copied back to conceal import/export damage. Direct programs can make
intentional structural changes, so application intent still requires reviewing
the candidate, not interpreting a successful export as semantic approval.

Macros and link updates are disabled with named UNO constants. The old numeric
macro setting was corrected: `NEVER_EXECUTE` is used explicitly. ZIP/XML screening
is defense in depth; cloud deployments should use the isolated image path.

The receipt binds the original version, working revision, source hash, candidate
hash, execution mode and verification. Application publication uses the existing
compare-and-swap version write. Repeated application in one turn is idempotent;
a stale later retry cannot overwrite newer work. No claim of a new distributed
exactly-once transaction or unrestricted concurrent document editing is made.

## Reproduction and evidence

The path-filtered workflow runs real console/Writer tests on Windows x64,
macOS ARM64 and Linux x64. Linux also repeats them inside the network-isolated
image. It exercises actual creation, table/footnote edits, native review/rejection,
existing revision preservation, rejected mixed edits, failed programs, read-only
policy and QuickJS cancellation. Missing runtimes fail instead of skipping.
Artifacts retain exported candidates and engine receipts.

```sh
# With backend dependencies installed and a usable LibreOffice/Python bridge:
cd backend
npx tsx --test experiments/libreoffice-uno/console.node.ts
npx tsx --test experiments/libreoffice-uno/application.node.ts
# Linux's independent bounded-batch regression suite:
/usr/bin/python3 -m unittest discover -s experiments/libreoffice-uno -p 'test_*.py' -v
```

The application suite uses an injected document store/engine for publication,
mode, tamper, stale/race, scope and cancellation outcomes; it is not native or
real-database proof. Normal repository CI and browser tests remain separate.
The cross-platform suite and full existing CI passed at
`29b93e6a17f5ea4e73918e92fe94321a6d3357f8`; subsequent changes require their own
checks. No live model spend or full sweep is part of this workflow. The small
compound slate is not universal Word-feature or successful-task-token benchmarking.

Remaining work is broader compound-document compatibility, integration coverage
that joins the actual engine to actual persistence/browser review, measured warm
session economics and deliberate packaging qualification for additional CPU/OS
versions. The programmable console and Windows/macOS execution are implemented,
not deferred. Keep useful legal/evidence/compiler/surgical code; remove generic
machinery only when a tested replacement makes it genuinely redundant.
