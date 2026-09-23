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

Use a versioned document resource or a current-turn `draft-N` artifact as
`file_path`. Published artifacts include a canonical `resource` for later turns.
`inspect` programs are read-only;
`preview` runs synchronous JavaScript on the current version (an optional inspected
`snapshot` refuses a changed document); `apply` with the candidate as `file_path`
publishes its exact frozen bytes to the original named by its receipt, never a rerun.
A preview of a candidate still revises that original. QuickJS is separately terminable
and bounded by memory, stack, time, calls and output, without host APIs. Handles also
take native UNO member syntax (UpperCamel properties, lowerCamel methods) through the
same checked broker operations; errors name the member and program line.

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
separate calls when order matters. A combined `String` and formatting assignment
replaces text before resolving the formatting range, irrespective of key order.
Styles expose `ParentStyle`; `reset` removes
direct formatting. Native default/state methods share the same text-cursor path.
Word keeps sections and lists, not LibreOffice style names: checks on unused page
styles are reported as not saved, used page styles are checked through a paragraph
they lay out, applied `PageDescName` by page layout, and list styles by list labels.
Word's top/bottom margins include an enabled header/footer, so page-style inspection
reports `word_margins`, `word.margins` sets margins in Word's model, and previews that
change page layout report `word_sections` read back from the exported DOCX.
`word.section` starts a Word-like section: a copy of the current page style whose
header/footer content Writer copies through its own clipboard format. Inspected paragraph text is the accepted reading, with `{-deleted-}{+inserted+}` marks.

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
missing runtimes fail. The application suite exercises the production chat registry,
SQLite/filesystem document store and native Writer through inspect, preview, apply,
ordinary/advanced edits and version comparison. Injected edge cases cover
publication races and review-policy refusal.
Wider document fidelity, full browser coverage, other CPU/OS
packaging and live-model task measurements remain qualification work. Exact-head
results and reproducible performance evidence belong in the PR.
