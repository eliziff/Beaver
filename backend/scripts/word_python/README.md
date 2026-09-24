# word_python: Beaver's Word specialist

`word_python` supplements compact `Read`, surgical `Edit` and Markdown `Write` for
styles, formatting, tables, lists, sections, fields, notes, comments and content
controls. The model writes Python against python-docx 1.2 with full lxml access to
the OOXML, so its reach is the file format rather than an office suite's model. The
tool's help ([`wordPythonTool.ts`](../../src/lib/chat/wordPythonTool.ts)) owns the
model-facing API; this directory holds the Python side.

## Contract

- `help` returns the programming API. `inspect` pages the body (blocks, styles, lists,
  sections) or shows one `paragraph:N`, `table:N`, `section:N`, `styles` or
  `part:word/<name>.xml` target; `inspect` with a program runs it read-only.
- `preview` runs a program on the current version (an optional inspected `snapshot`
  refuses a changed document) and files the verified result as a separate
  "(preview)" document with a bound receipt. The source is never touched.
- `apply` with the preview as `file_path` publishes its exact frozen bytes to the
  original named by the receipt, through the version store's compare-and-swap. A
  preview of a preview still revises the original; a program is never rerun.
- The user's edit-mode setting, never a model argument, selects Review (tracked) or
  direct editing. [`wordEditApplication.ts`](../../src/lib/wordEditApplication.ts)
  owns scope, receipts and publication; [`wordPython.ts`](../../src/lib/wordPython.ts)
  runs the worker processes.

## Helpers and Review mode

`helpers.py` covers what python-docx lacks: run-splitting `isolate`/`replace_text`,
`delete`, insert-after, one-list numbering through numbering.xml, `section_range` and
`set_page` (orientation, size, margins, columns), complex fields, TOC, page numbers,
footnotes/endnotes and content controls. Comments, styles, tables, headers and
pictures are native python-docx.

In Review mode the program edits normally. `tracking.py` snapshots every story
beforehand and records the difference as native revisions: removed content returns
as `w:del` at its old position, new content becomes `w:ins` (paragraph marks and
table rows included), moves become delete+insert, plain-text paragraphs are
re-diffed word by word, and changed paragraph/run/table/row/cell/section properties
gain `w:*PrChange`. Existing revisions compose as in Word: an edit inside Beaver's own
pending insertion just changes (or withdraws) it, deleting another author's inserted
text nests a `w:del` inside their `w:ins`, and new text splits their insertion, so
authorship stays true. Accepting every revision must give exactly the program's text.
Style-definition edits, existing list definitions and removed table cells cannot be
tracked, so they fail rather than silently becoming direct.

## Verification

`verify.py` runs in a separate trusted process and never executes model code. It
screens the package (zip bounds, no DTDs, macros, embedded objects, active fields or
non-hyperlink external relationships), reopens it with python-docx, and reports
accepted-view block changes, sections, styles, lists, comments and revision counts.
In Review mode it rejects every revision in source and candidate and requires
identical stories. A candidate whose parts are canonically unchanged fails instead
of becoming a no-op version. LibreOffice headless must then open and lay out the
candidate (the page count is reported). This proves the file opens; it does not
certify Word-identical layout.

## Runtime and isolation

Python 3.10+ with [`requirements.txt`](requirements.txt) installed exactly:

```sh
python -m pip install -r backend/scripts/word_python/requirements.txt
```

The interpreter is `BEAVER_WORD_PYTHON`, then `BEAVER_PYTHON`, then `python`
(`python3` off Windows). The backend runs [`probe.py`](probe.py) before first use
and refuses with an install instruction when it fails; `scripts/mike.ps1 doctor`
reports the same probe and the LibreOffice binary. Workers run in isolated mode
(`-I`), so install into that interpreter or a venv, not the user site.

Locally, each program runs in its own process whose working directory holds only
`document.docx`, with an empty environment and a 60 s timeout. Before model code
runs, the process joins a Windows Job Object (one active process, 1.5 GiB, kill on
close) or sets POSIX rlimits (address space, CPU, file size, no child processes). A
`sys.addaudithook` guard then refuses sockets, process creation, native-code modules,
`gc` object walks and file access outside the directory. This is not an OS sandbox:
audit hooks are an in-process tripwire, the job/rlimits are the only kernel controls,
and the output is treated as untrusted by the separate verifier.

For cloud isolation, build [`word-python.Dockerfile`](../../word-python.Dockerfile)
(python-docx, lxml and LibreOffice headless) and set `WORD_PYTHON_CONTAINER_IMAGE` to
a qualified immutable digest; `WORD_PYTHON_CONTAINER_RUNTIME` overrides `docker`.
Every step (inspect, program, verification, LibreOffice open check) then runs in its
own container with no network, a read-only root, all capabilities dropped,
no-new-privileges, 2 GiB memory, one CPU, 64 processes, a private `/tmp` and only that
step's job directory mounted. Never expose the container daemon to models.

## Validation

```sh
cd backend
npx vitest run src/lib/__tests__/wordPython.test.ts src/lib/__tests__/wordEditApplication.test.ts
docker build -f word-python.Dockerfile -t beaver-word-python:test .
WORD_PYTHON_CONTAINER_IMAGE=beaver-word-python:test npx vitest run src/lib/__tests__/wordPython.test.ts
```

The runtime tests skip when the probe or LibreOffice is missing; the
`word_python integration` workflow installs both on Windows, macOS and Linux and
repeats the suite in the container image.
