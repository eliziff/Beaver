# LibreOffice/UNO document console

`word_uno` supplements compact `Read`, surgical `Edit` and Markdown `Write`.
The [tool's help](../../src/lib/chat/libreOfficeTool.ts) owns the console API;
`describe` discovers the installed UNO interfaces, not a second Beaver catalogue.

## Runtime

Install LibreOffice Writer with its matching Python bridge. Windows/macOS probe
the application's bundled interpreter; Linux normally uses `/usr/bin/python3`
and `python3-uno`. Overrides: `WORD_UNO_PYTHON`, `SOFFICE_BINARY_PATH`,
`LIBREOFFICE_BINARY_PATH`, `LIBRE_OFFICE_EXE`. Ship `backend/scripts` with the backend.
Each job owns a private profile/pipe and Windows Job Object or POSIX process group;
Stop terminates its script and native processes without touching the user's office.

For cloud isolation, build `backend/uno.Dockerfile` and set
`WORD_UNO_CONTAINER_IMAGE` to a qualified immutable digest. The runtime defaults
to Docker (`WORD_UNO_CONTAINER_RUNTIME` overrides it). Jobs have no network,
a read-only root, dropped capabilities, no-new-privileges, resource limits,
scratch storage and only their assigned mount. Never expose the daemon socket
to models. Native local execution is not an OS sandbox against engine exploits.

## Editing

Inspect a versioned `file_path` for its snapshot. `inspect` programs are read-only;
`preview` runs synchronous JavaScript on that snapshot; `apply` publishes the
exact frozen `preview_resource`, never a rerun. QuickJS is separately terminable
and bounded by memory, stack, time, calls and output, without host APIs.

```js
const [a, b] = word.target(['paragraph:1', 'paragraph:2']);
a.set({ ParaStyleName: 'Body Text', CharHeight: 18 });
a.reset(['CharHeight']); // Inherit the style, not an equal-looking direct value.
b.find('paragraph 12').set({ String: 'paragraph 15' });
return a.get(['ParaStyleName', 'CharHeight']);
```

Batch targets retain input order and scan paragraphs once. Collection `items`
can project properties alongside editable handles. Follow `next_offset`; unknown
counts remain null rather than scanning unseen content. Handles live only within
a program, not as legal evidence IDs; retain them before edits and reinspect
indexes afterward. `set` specifies final state in native property groups; use
separate calls when order matters. Styles expose `ParentStyle`; `reset` removes
direct formatting. Native default/state methods share the same text-cursor path.

## Verification

The user's setting owns tracked/direct mode. Every preview checks a no-edit round
trip, export/reopen state, ordered text/stories, tables, bookmarks, drawings and
property postconditions. Prior reviews/comments, custom XML, bindings and opaque
assets are protected. Tracked edits must reject back to a normalized no-edit
control except named volatile metadata. Untrackable edits fail Review mode.

Checks follow retained objects to their final locations. Selected ranges retain
native scope/prefix witnesses; unaddressable objects fail. Resets also verify
native DEFAULT_VALUE state after export; later sets on the same object/property
supersede them. Explicit String assertions use raw redline text, including deletions.
Receipts carry bounded operation summaries and exact revision counts; inspect
the candidate for detail. Scope, hashes and compare-and-swap publication apply.

These checks do not certify all OOXML, anchors or Word-identical layout. Unsupported
round trips fail without pasting XML back. Active fields/links, macros and embedded
objects are refused; loading disables macros/link updates.

## Validation

```sh
cd backend
npx tsx --test experiments/libreoffice-uno/console.node.ts
npx tsx --test experiments/libreoffice-uno/application.node.ts
docker build -f uno.Dockerfile -t beaver-uno:test .
WORD_UNO_CONTAINER_IMAGE=beaver-uno:test npx tsx --test experiments/libreoffice-uno/console.node.ts
```

CI runs actual Windows x64, macOS ARM64, Linux x64 and isolated-container paths;
missing runtimes fail. Application tests use an injected store, not a real database.
Wider document fidelity, joined native/persistence/browser coverage, other CPU/OS
packaging and live-model task measurements remain qualification work. Exact-head
results and reproducible performance evidence belong in the PR.
