# Adversarial faithfulness audit — `mike_upstream_native_v1` (commit `010454ea`)

**Auditor B, stance REFUTE.** Every load-bearing claim was re-derived from the pin
(`2266446b`) at runtime. The implementer's probes (`backend/.tmp-native-*.ts`) were
treated as hypotheses and not used as evidence for any verdict below; where a
probe's conclusion is reproduced here it was re-established independently.

Audit probes: `backend/.tmp-nativeaudit-*.ts` (namespace reserved for this audit).
Mechanically-extracted pin references (not retyped by hand):
`backend/.tmp-nativeaudit-renderer-ref.ts`, `backend/.tmp-nativeaudit-readplane-ref.ts`,
`backend/.tmp-nativeaudit-pin/{prompts,courtlistenerTools,toolSchemas,spreadsheet}.ts`.

No git write operations, no model calls, no network. Local `tsx` only.

---

## Verdict table

| # | Claim | Verdict | Severity |
|---|-------|---------|----------|
| 1 | Prompt fidelity: `UPSTREAM_NATIVE_MIKE_BASE_PROMPT` = `buildSystemPrompt(false)` minus exactly the Phase-1 strip-list | **CONFIRMED** | — (one MINOR spec-cite defect) |
| 2 | Project extra (827 B, `3a8da67b…`) and the `base + "\n\n" + trimmed extra` join rule | **CONFIRMED** | — |
| 3 | Inventory block byte-faithful to `contextBuilders.ts:143-153` **and** identical between `chat.ts` and `lab-beaver-arm.ts` | **CONFIRMED** | — |
| 4 | Tool array: 9 schemas verbatim, upstream order, sha `ea440d44…` | **CONFIRMED** | — |
| 5 | Renderer port vs `documentOps.ts:83-582` (true differential oracle) | **CONFIRMED** | — |
| 6 | Read plane reproduces the pinned defective plane, and read/find/edit share one plane | **PARTLY REFUTED** — read+find confirmed; **edit anchors a different plane** | **BLOCKER** |
| 7 | `edit_document` semantics vs `toolDispatcher.ts:1378-1540` + `documentOps.ts:1106+` | **PARTLY REFUTED** — error-envelope shape | MINOR ×2 |
| 8 | Envelope byte-shapes vs pin (citationReminder / find / already_read / generate_docx / fetch headers) | **CONFIRMED** | — (one MINOR clamp) |
| 9 | Loop semantics `maxIterations: 10` equivalent on the `claude -p` lane; provider params | **CONFIRMED** (code) | **RUN-CONFIG action required** |
| 10 | Zero drift for the other 13 arms with the flag off | **CONFIRMED** (sweep coverage gap closed independently) | — |
| 11 | Gate/receipt correctness; the two self-reported findings | **CONFIRMED** (both self-reports adjudicated) | MINOR ×2 gate weaknesses |
| 12 | `ask_inputs` termination equivalent to `streaming.ts:484-486` | **CONFIRMED** model-side; **REFUTED** on "recorded … instead of being suppressed" | MINOR |
| 13 | Silo: 5 files, no ungated reference, no shared detector touched | **CONFIRMED** | — |

**Counts: 10 CONFIRMED (claim 9 additionally carries a run-config action),
3 PARTLY REFUTED (claims 6, 7, 12), 0 UNVERIFIABLE-STATICALLY.**
**1 BLOCKER, 7 MINOR.**

---

## Method note: the CRLF trap is real, and it bites the file the claim is about

`backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts` is **CRLF on disk** (1188 CR
bytes, one per line); `upstreamNativeDocxRenderer.ts` and `prompts.ts` are LF.
Hashing file bytes for the surface file would give a different answer from the
runtime string. Every hash below is of the **runtime** string, obtained by
`import`ing the module under `tsx`. Confirmed empirically: the evaluated
`UPSTREAM_NATIVE_MIKE_BASE_PROMPT` contains no `\r`, and so does the pin's
`buildSystemPrompt(false)` — ECMAScript TV normalisation collapses `<CR><LF>` to
`<LF>` inside template literals, and esbuild honours it.

The pin blob itself is LF (`git cat-file -p` → 0 CR bytes), so `git show` output
and runtime strings are directly comparable.

---

## 1. Prompt fidelity — CONFIRMED

Probe: `backend/.tmp-nativeaudit-prompt.ts`. The pinned `prompts.ts` was staged as a
real module (`.tmp-nativeaudit-pin/prompts.ts`, import rewritten to the pinned
`courtlistenerTools.ts`, which has no imports of its own) and **executed**, so the
reference is the pin's own `buildSystemPrompt(false)` return value, not a transcription.

```
pin buildSystemPrompt(false): 6997 B  sha=461e218471918ddce08d5630847ac80aaf59049a5cf7729e6728848c28a6eb49
native BASE_PROMPT          : 6770 B  sha=39355be587e6d44dd35a65b5ceda2968d44a07d69886020a31b7d609f46e3228
CLAIMED sha  -> true          CLAIMED size 6770 -> true          contains CR -> false
MATCH  BASE_PROMPT  ==  pin buildSystemPrompt(false) minus the two DOCX bullets
```

Independent derivation: I removed exactly the two bullet strings (each with its
trailing `\n`) from the pin's runtime string and got a **byte-identical** result.
Nothing else removed, nothing added. The pin's 6997 B / `461e2184…` also matches the
spec's own Phase-2 row (spec:1379), which is a useful cross-check on the spec.

CourtListener removal is by the native switch (`buildSystemPrompt(false)`,
`prompts.ts:82-86`), not by text surgery — as claimed.

### MINOR finding P1 — the spec and the surface banner cite the wrong pin lines

Spec §2.8 (`docs/harvey-labs/archive/upstream-mike-native-surface-spec-2266446b.md:369`, `:389`, `:1230`,
`:1623`) and the surface file's own banner
(`backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts:886-887`) locate the
`generate_excel` / `generate_ppt` bullets at `prompts.ts:48` and `:49`.

At the pin they are at **`prompts.ts:42` and `:43`**. Lines 48 and 49 at the pin are:

```
48: - Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
49: - Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.
```

Anyone executing the Phase-2 restoration plan (spec:1623-1624) literally against
those cites would strip the contract-preamble and signature-block bullets — two of
the most behaviour-shaping clauses in the DOCX GENERATION section. **The
implementation is correct** (proved byte-level above); this is a documentation
defect only. Per the audit's ordering rule (pin wins over spec), it is recorded here.

Same class, same file: the banner cites `contextBuilders.ts:144-152` for the
inventory block; the enclosing `if` block is `:143-153` and the three `+=`
statements are `:144`, `:148`, `:151-152`.

---

## 2. Project extra + join rule — CONFIRMED

`PROJECT_SYSTEM_PROMPT_EXTRA` was extracted from the pinned `projectChat.ts`
template literal (`:27-33`) and compared against the arm's constant.

```
pin PROJECT_SYSTEM_PROMPT_EXTRA : 1471 B  sha=00642ff87f0ca95a8671150ba8b9a6a0a049b9c8783bc1fb8b22787d9a89c88f
REPLICATING A DOCUMENT: begins at char 827, preceded by "e.\n\n"
native PROJECT_EXTRA            :  827 B  sha=3a8da67b3fb25227249882955c3540e949ca7ce85ab933bce5c151b74df62d94
CLAIMED 827 B -> true
MATCH  PROJECT_EXTRA == pin extra truncated at the REPLICATING heading, trailing newlines trimmed
```

Join rule (`contextBuilders.ts:139-141`: `systemContent += \`\n\n${extra.trim()}\``):

```
MATCH  UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT == BASE + "\n\n" + PROJECT_EXTRA.trim()
       7599 B  sha=7802ff91e430ec049fdf32c01d7f9011bd956ded052fefdb399566c35455c6d7
       (extra is already trimmed, so .trim() is a no-op — no hidden whitespace delta)
```

For reference, the unstripped pin project-chat system prompt is 8470 B /
`9069a2e5e7594e7f567c2a8a9e28e646349314eff465b6db8a1cbfa16f491a81`. The 871 B delta is
exactly the four Phase-1 strips.

---

## 3. Inventory block — CONFIRMED

Probe: `backend/.tmp-nativeaudit-inventory.ts`. The pin's header and trailer string
literals were parsed out of the pinned `contextBuilders.ts` and `JSON.parse`d, then
compared against the literals in `chat.ts` and `lab-beaver-arm.ts`.

```
PIN     : header sha=42a0da008c8a (27 ch)   trailer sha=b5bbb2e58d69 (541 ch)
chat.ts : header sha=42a0da008c8a (27 ch)   trailer sha=b5bbb2e58d69 (541 ch)
lab-arm : header sha=42a0da008c8a (27 ch)   trailer sha=b5bbb2e58d69 (541 ch)

whole-block, 3 documents:   pin == chat.ts : true
                            pin == lab-arm : true
                            chat.ts == lab : true
                            sha 766fc1da5279fe97c5a2dbac5a823f2a77744466a720b3f5751bc9d21e22aabc
```

The specific traps were checked and are all handled:

- Fence newlines: `"\n\n---\nAVAILABLE DOCUMENTS:\n"` — exact.
- Per-line `\n` inside `.map` + `.join("")` correctly reproduces upstream's
  `systemContent += \`- ${doc_id}: ${label}\n\`` accumulation. Using `.join("\n")`
  (the Beaver shape) would have dropped the final newline and merged the last
  document line into the blank line before the trailer; it does not.
- Trailer begins with `\n`, producing the blank line after the last document, and
  ends `…stale content.\n---\n`. Exact.
- LAB documents carry no `folder_path`, so `label` is the bare filename — matching
  the pin's `doc.folder_path ? … : doc.filename` false branch.

Rendered block (both call sites, identical):

```
"\n\n---\nAVAILABLE DOCUMENTS:\n- doc-0: Master Services Agreement.docx\n- doc-1: Schedule A - Fees.pdf\n- doc-2: board_minutes.docx\n\nYou do NOT retain document content between conversation turns. …\n---\n"
```

The preflight prompt-sha gate therefore rests on a real byte-identity, not a
coincidence.

---

## 4. Tool array — CONFIRMED

Probe: `backend/.tmp-nativeaudit-tools.ts`. The pinned `toolSchemas.ts` (no imports)
was executed and each arm schema compared against the pin object by **raw**
`JSON.stringify` — so key order is included, not just content.

```
MATCH  ask_inputs (1991ch)   read_document (599)   find_in_document (1059)
MATCH  generate_docx (1469)  edit_document (1410)  list_workflows (311)
MATCH  read_workflow (378)   list_documents (304)  fetch_documents (589)
ALL 9 BYTE-IDENTICAL TO PIN
tools sha256(JSON.stringify(array)) = ea440d44c5be6e55ceb3a453252994406c554c9a65295043ea6199d5d13116a4   (claim -> true)
```

**Order was verified against the pin's assembly, not against the spec.**
`2266446b:streaming.ts:189-194`:

```ts
const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
const mcpTools = await buildUserMcpTools(userId, db);
const baseTools = [...TOOLS, ...researchTools, ...WORKFLOW_TOOLS];
const activeTools = extraTools?.length ? [...baseTools, ...mcpTools, ...extraTools] : …
```

with `extraTools: PROJECT_EXTRA_TOOLS` (`projectChat.ts:203`). Pin composition with
research off and no MCP tools is
`TOOLS(7) + WORKFLOW_TOOLS(2) + PROJECT_EXTRA_TOOLS(3)`; removing `generate_excel`,
`generate_ppt`, `replicate_document` yields exactly

```
ask_inputs, read_document, find_in_document, generate_docx, edit_document,
list_workflows, read_workflow, list_documents, fetch_documents
```

which is the arm's order. Note this puts workflows *before* project extras — a
non-obvious ordering that a spec-only reading could easily have gotten backwards.
Dropped pin tools: `generate_excel`, `generate_ppt`, `replicate_document`,
`read_table_cells` (the last has no Phase-1 prompt clause and no LAB executor).

---

## 5. Renderer port — CONFIRMED (true differential oracle)

The implementer's normalised-diff probe was **not** used. Instead
`backend/.tmp-nativeaudit-renderer-ref.ts` was generated **mechanically from pin
bytes** — `git cat-file -p 2266446b:…/documentOps.ts` lines `83-491` plus `507-511`,
concatenated with a `return { buffer, filename }` tail, with only the storage/DB
epilogue dropped and the function renamed. No hand transcription, so no
transcription errors.

Both renderers were run on 6 fixtures (`backend/.tmp-nativeaudit-renderdiff.ts`) and
five package parts plus the part-name list were byte-compared:
`word/document.xml`, `word/numbering.xml`, `word/styles.xml`, `word/settings.xml`,
`[Content_Types].xml`.

```
MATCH  F1 memo, nested headings (L1-L4)                          document.xml 7702 ch  sha=a71eecb438501953
MATCH  F2 contract: recitals + WHEREAS + numbered operative
       clauses + (a)/(i) manual markers + unnumbered signature
       block with pageBreak:true final section                   document.xml 11071 ch sha=f3818565520c8105
MATCH  F3 manual-numbering strip cases ("1 ", "2.1.3 ", "10.4.2 ",
       "(a) ", "(iv) ", "b) ", "c. ", empty heading, no heading)  document.xml 7931 ch  sha=54d0c4a8c20284e9
MATCH  F4 table (short row, over-long row, non-string cells,
       empty-headers table)                                      document.xml 12238 ch sha=13f9661ef346fd15
MATCH  F5 bullet/number mix (-, *, •, "1. ", "(b) ", indented,
       blank lines)                                              document.xml 6754 ch  sha=4bd8381a3e31f84e
MATCH  F6 landscape + title-like first-heading suppression       document.xml 4172 ch  sha=e3473aaf9eea3595

determinism control (pin renderer run twice on F2): DETERMINISTIC
RENDERER PORT: NO DIVERGENCE across 6 fixtures
```

The determinism control matters: without it, "identical" could have been an artifact
of a deterministic-but-unexercised path. It passes, so the comparisons are sound.
Filenames (`safeGeneratedFilename` rule at `:506-511`) also matched on every fixture.

---

## 6. Read plane — read/find CONFIRMED; **edit REFUTED (BLOCKER)**

### 6a. The DOCX read plane reproduces the pinned defect exactly — CONFIRMED

Reference (`backend/.tmp-nativeaudit-readplane-ref.ts`) mechanically extracted from
`2266446b:backend/src/lib/docxTrackedChanges.ts` (`getZipEntry`, the `XNode`
helpers, `getTextContent`, `flattenParagraph`, `createParser`, `findBody`,
`extractDocxBodyText`). The pin's `createParser()` (`:647-656`) **omits**
`parseTagValue: false`, which is the defect.

Probe `backend/.tmp-nativeaudit-readplane.ts`, 400 real corpus `.docx` sampled
evenly across all 11,293 files under `benchmarks/harvey-labs/tasks`:

```
native == PIN plane      : 400 / 400   (mismatches: 0)
native != Beaver plane   :  70 / 400   (identical on the other 330; 0 errors)
```

Synthetic control, exact coercion semantics reproduced (pin | native | Beaver-fixed):

```
"12.10"  -> "12.1"  | "12.1"  | "12.10"
"8.0"    -> "8"     | "8"     | "8.0"
"1."     -> "1"     | "1"     | "1."
"0012"   -> "12"    | "12"    | "0012"
"1e3"    -> "1000"  | "1000"  | "1e3"
"-4.20"  -> "-4.2"  | "-4.2"  | "-4.20"
"0x1A"   -> "26"    | "26"    | "0x1A"
"+7"     -> "7"     | "7"     | "+7"
"Section 12.10 applies" -> unchanged in all three   (only whole-run numerics coerce)
```

Real corpus examples of what the arm serves vs what Beaver would serve:

```
luminark-standard-agency-msa.docx
  Beaver: 1.10 "Intellectual Property" or "IP" means all intellectual property …
  native: 1.1  "Intellectual Property" or "IP" means all intellectual property …
precedent-m9876-terrano-fieldmark.docx
  Beaver: 1.Transitional supply period: M.11247 proposes 3 years vs. M.9876's 5 years …
  native: 1Transitional supply period: …
co-sell-agreement-turn-1.docx
  Beaver: QO-_-001        native: QO-_-1
```

Serving the defect is deliberate and correct for this arm. Confirmed.

`read_document` and `fetch_documents` both route through the same `readOne` helper in
`runUpstreamMikeRetrievalCall`, so both get the native plane;
`find_in_document` has its own `nativeFindFile`/`nativeFindText` branch on the same
extractor. Three of the four consumers are on one plane.

### 6b. BLOCKER — `edit_document` anchors against a **different** plane

The commit message states: *"read_document, find_in_document, and edit_document all
serve the same characters upstream serves."* The renderer file's own header
(`upstreamNativeDocxRenderer.ts:31-33`) states: *"the read plane is also the plane
edit_document anchors against (documentOps.ts:1502-1504), so read and edit must not
diverge."*

**Both statements are false as implemented.**

Native `edit_document` (`localAssistantTools.ts:3193`) calls Beaver's
`applyTrackedEdits`. Beaver's `applyTrackedEdits`
(`backend/src/lib/docxTrackedChanges.ts:806`) parses with `createParser()` imported
from `backend/src/lib/docx/core.ts:85-99`, which **has the fix**:

```ts
// backend/src/lib/docx/core.ts:91-95
// Word text nodes are strings even when a run happens to contain
// only "1.0", "001", or another numeric-looking token. …
parseTagValue: false,
```

At the pin there is no such split: `applyTrackedEdits`
(`2266446b:docxTrackedChanges.ts:787,:799`) uses the *same* defective
`createParser()` as `extractDocxBodyText`, and the pin's own comment at
`documentOps.ts:1502-1503` states the invariant explicitly:

```
// Use the same flattening as the edit_document matcher so the
// LLM sees exactly the characters it can anchor against.
```

So upstream is self-consistent (both planes coerced); the arm is not (read coerced,
anchor un-coerced).

Empirical proof, `backend/.tmp-nativeaudit-mixedplane.ts` — a `.docx` whose clause
number `1.10` is its own `w:t` run:

```
plane served to the model (native arm): "1.1 “Intellectual Property” means all rights of any kind."
plane served at the PIN               : "1.1 “Intellectual Property” means all rights of any kind."
plane Beaver (fixed) would serve      : "1.10 “Intellectual Property” means all rights of any kind."
native == pin read plane : true

edit quoting the NATIVE-SERVED text   find="1.1 “Intellectual Property”"
   applied=0  errors=[{"index":0,"reason":"Could not locate find=\"1.1 “Intellectual Property”\".
     Its last 24 characters do match, in this paragraph — but the wording then diverges.
     The document reads:\n  \"1.10 “Intellectual Property”…\"\n Copy the document's wording verbatim …"}]

edit quoting the FIXED text           find="1.10 “Intellectual Property”"
   applied=1  errors=[]

served substring present in the native/pin read plane                : true
served substring present in the plane applyTrackedEdits anchors on   : false
```

Second shape, the whole-paragraph case:

```
native served : "Term is \n8\n years from the Effective Date."
beaver served : "Term is \n8.0\n years from the Effective Date."
edit quoting the native-served text ("Term is 8 years"):
   applied=0  errors=[{"reason":"Could not locate … no part of this wording appears in the document body.
     Re-read the document — the text may be in a header, footer, footnote or text box …"}]
```

**Consequence.** The arm hands the model `1.1` / `8`, the model quotes back exactly
what it was given, and the arm rejects it with a message telling the model its
verbatim quote is not verbatim — and, in the second shape, actively misdirects it
toward headers/footers/text boxes. Upstream would have applied both edits. The
effect is one-directional: it can only make the native arm's `edit_document` look
worse than upstream, on exactly the **70/400 ≈ 17.5 %** of corpus `.docx` that carry
a coercible token, and it is invisible in the trace (it presents as ordinary model
quoting failure).

For an arm whose entire purpose is to be an upstream-contribution-grade faithful
baseline, this is a **BLOCKER**.

**Fix direction** (reported, not applied, per the audit's scope): the native edit
path must anchor on the pinned plane — i.e. the arm needs its own
`applyTrackedEdits` bound to a pin-faithful parser (no `parseTagValue: false`),
vendored into `upstreamNativeDocxRenderer.ts` alongside the read plane, rather than
calling Beaver's shared `applyTrackedEdits`. The read plane was correctly vendored
for exactly this reason; the write-anchor plane was not.

### 6c. MINOR — the non-DOCX read planes are not ported (empirically harmless today)

The native branch is gated on `file.fileType?.toLowerCase() === "docx"`. `.xlsx`
reads fall through to Beaver's `extractLocalDocument` → `spreadsheetToLLMText`, and
that module has been substantially rewritten since the pin (typed grid,
`occupiedColumns` instead of a `!ref` used-range walk, empty-cell skipping).

I did not assume this diverges. Probe `backend/.tmp-nativeaudit-xlsxplane.ts` runs the
pinned `spreadsheetToLLMText` (mechanically extracted) against Beaver's on 150 real
corpus `.xlsx` sampled from all 3,832:

```
sample 150: identical=150   DIFFERENT=0   errors=0
```

**Null result — no divergence in practice.** The refactor is output-preserving on
this corpus. Recorded as a MINOR *structural* risk only: unlike `citationReminder`
(which the arm deliberately vendored so a later Beaver-side edit cannot drift the
baseline), the xlsx plane is still shared, so a future Beaver spreadsheet change
would silently move the native baseline. The corpus contains no `.pdf`, so the PDF
plane is moot; `.pptx` (459 files) is likewise served by Beaver's refactored
`officeText.ts` and was not separately measured.

---

## 7. `edit_document` semantics — mostly CONFIRMED, two MINOR refutations

Verified against `2266446b:toolDispatcher.ts:1378-1540` and `documentOps.ts:1106-1260`.

**Confirmed:**

- **Partial success.** Pin applies every locatable edit and returns the rest in
  `errors[]`; only `changes.length === 0` is a hard failure
  (`documentOps.ts:1157-1164`). The arm reproduces this, including the fallback
  string byte-for-byte: `errors[0]?.reason ?? "No edits could be applied. Refine context_before/context_after and retry."`
- **Author `"Mike"`** — `applyTrackedEdits(current.bytes, edits, { author: "Mike" })`
  at `documentOps.ts:1151-1155`; the arm passes the same explicit option.
- **Read-guard cleared on success** — pin `clearTurnReadsForDocument(turnReadState, …)`
  at `toolDispatcher.ts:1467`; the arm deletes every `turnReadState` entry for the
  document. Equivalent.
- **Success envelope keys and order** — pin `toolDispatcher.ts:1503-1517`:
  `ok, doc_id, document_id, version_id, version_number, applied, errors, next_required_action`.
  The arm emits exactly that sequence.
- **`applied` count** — pin uses `result.annotations.length`; `annotations` is
  `insertedEdits.map(…)` derived 1:1 from `changes` (`documentOps.ts:1259+`), so the
  arm's `edited.changes.length` is the same number. LAB has no DB rows, so the direct
  count is the faithful analogue.
- **`next_required_action`** — 4 sentences, extracted from the pin and compared:
  `pin == ours: true`.

### MINOR finding E1 — pre-dispatch error envelopes carry an extra `ok` key

Extracted from the pin (`backend/.tmp-nativeaudit-envelopes.ts`, claim 8e section):

```
pin error envelope: err=`Document '${docId}' not found in this chat's attachments.`  ->  { error: err }
pin error envelope: err="edits array is required and must not be empty."             ->  { error: err }
pin error envelope: err="edit_document only supports .docx files."                   ->  { error: err }
```

The pin emits **`{"error": …}` with no `ok` key** for all three pre-dispatch
validation failures, and reserves `{"ok": false, "error": …}` for a `runEditDocument`
failure (`toolDispatcher.ts:1534-1537`). The arm's `nativeError` helper
(`localAssistantTools.ts:3105-3106`) emits `{"ok": false, "error": …}` for *every*
error path, including all three above. Model-visible byte divergence; a model that
branches on the presence of `ok` sees a different signal. MINOR.

### MINOR finding E2 — document-resolution precedence is swapped

Pin `resolveDocLabel` (`2266446b:types.ts:72-87`): **label → filename → UUID**.
Arm (`localAssistantTools.ts:3120-3126`): **label → UUID → filename**.
Only observable if a filename equals another document's UUID, i.e. never in practice.
Recorded for completeness. The not-found message text is identical either way.

---

## 8. Envelope byte-shapes — CONFIRMED

All expected strings were lifted mechanically from the pin blob; nothing was
compared against the spec's recorded values.

**`citationReminder`** (`documentOps.ts:33-47`) — the arm's vendored copy matches the
pin on every file-type label variant:

```
MATCH  Master Services Agreement.docx   MATCH  Fee Schedule.xlsx    MATCH  Prospectus.pdf
MATCH  legacy.xls                        MATCH  macro.xlsm          MATCH  noextension
```

Both branches of the `isSpreadsheet` ternary are exercised. The classifier import is
safe: pin and working-tree `SPREADSHEET_TYPES` are both `new Set(["xlsx","xlsm","xls"])`.

**`find_in_document`** — pin `documentOps.ts:1727-1735`:

```
{ ok, filename, query, total_matches, returned, truncated, hits }     ← no top-level doc_id
```

The arm emits that key sequence exactly. Hit shape `{index, excerpt, context}`
matches pin `TextMatch` (`:1613-1617`); the arm's native branch strips Beaver's extra
`at`, `locator`, `page` and `read` fields. Window sizes match: pin defaults
`maxResults = 20`, `contextChars = 80` (`:1676-1677`); the arm defaults 20 / 80.
Beaver's `findTextMatches` (`documentOps.ts:1360-1402`) is line-for-line the pin's
algorithm — same `normalizeWithMap`, same ellipsis fencing
`(ctxStart > 0 ? "…" : "") + slice.replace(/\s+/g," ").trim() + (ctxEnd < len ? "…" : "")`,
same `from = pos + Math.max(1, needle.length)` advance — plus the extra `at` field.

*MINOR:* the arm clamps `max_results` to 1..100 and `context_chars` to 0..10 000; the
pin passes them through unclamped (`typeof === "number" ? … : undefined`). Divergent
only for out-of-schema arguments.

**`already_read`** — pin `duplicateReadDocumentResult` (`documentOps.ts:1374-1392`):

```
key order: ok, already_read, doc_id, filename, document_id, version_id, content, next_required_action
content            EQUAL: true
next_required_action EQUAL: true
```

The arm's native branch emits that order (Beaver's default branch swaps `filename`
and `document_id`, which is why the gate was needed).

**`generate_docx`** — pin strips `download_url`/`storage_path` and spreads
`safeToolResult` then `doc_id` then `next_required_action`
(`toolDispatcher.ts:560-572`), giving
`filename, document_id, version_id, version_number, message, doc_id, next_required_action`.
The arm emits that sequence, and the 4-sentence `next_required_action` compares
`pin == ours: true`.

**`fetch_documents`** part headers — pin `` `--- ${filename} (${docId}) ---\n` ``
(`toolDispatcher.ts:726,:744`); the arm uses `` `--- ${filename} (${docLabel}) ---\n` ``
with the same citationReminder + `\n\n` + content composition. Match.

**`list_documents`** — pin returns `[{doc_id, filename, file_type}]`
(`toolDispatcher.ts:699-709`); the arm's non-adaptive branch returns exactly that.

I did not take "Beaver's shared serving code happens to match the pin" on trust for
any of these; each was compared key-for-key against pin source.

---

## 9. Loop semantics and provider params — CONFIRMED (code) + RUN-CONFIG action

### Loop — no off-by-one, no dropped round-10 results

Pin (`claude.ts:123,:128`): `const maxIter = params.maxIterations; … for (let iter = 0; iter < maxIter; iter++)`,
called with `maxIterations: 10` from `streaming.ts:341`. `runTools` is invoked at
`claude.ts:243` **before** the loop re-tests its condition, and the assistant +
`tool_result` messages are pushed at `:249-250`. So at the pin: round-10 tool calls
execute, their results are appended, and the loop exits with **no injected message**.

`claudeP.ts:472,:479`:

```ts
const maxIter = params.maxIterations;
for (let iter = 0; maxIter === undefined || iter < maxIter; iter++) {
```

and `:707-716`: `if (!toolCalls.length || !runTools) break; const results = await runTools(toolCalls); … messages.push(assistant); messages.push(user with tool_results)`.

Identical counting (`iter < 10` → 10 rounds), round-10 tools executed, results
appended, silent exit, no "max iterations" message injected. **Observably the same.**
Pin additionally tests `stopReason !== "tool_use"`; `claudeP` has no stop reason and
uses `!toolCalls.length`, which is equivalent on this transport.

Deliverable capture still fires at round 10: capture happens *inside* the
`generate_docx` executor (`createLocalDocument`), which runs within `runTools`, not in
any post-loop step.

`claudeP`'s extra `if (results.some(r => r.terminal)) break;` is inert for this arm —
no native result path sets `terminal`, and `MIKE_TERMINAL_AUTHORING=0`.

Non-native arms are unaffected: `maxIterations: UPSTREAM_NATIVE_MIKE_SHAPE ? 10 : undefined`
adds an explicitly-`undefined` key where the key was previously absent. Every provider
reads it as `params.maxIterations` with either `=== undefined` or `?? default`
(`claude.ts:123`, `claudeP.ts:472`, `codex.ts:288`, `deepseek.ts:193`, `gemini.ts:164`,
`ollamaApi.ts:268`, `openai.ts:437`), so absent and `undefined` are indistinguishable.

### RUN-CONFIG finding R1 — native cells must run `--effort high`, not `--effort max`

The pin sends, per turn (`2266446b:claude.ts:130-148`):

| param | pin value | cite |
|---|---|---|
| `max_tokens` | `16384` | `claude.ts:22`, `:137` |
| `temperature` | omitted entirely | `claude.ts:147` comment; absent at `:130-148` |
| `thinking` | `{ type: "adaptive" }` | `claude.ts:142` |
| `output_config` | **`{ effort: "high" }`** | `claude.ts:143`; spec §4 line 1109 |

`max_tokens` and `temperature` are unavailable on the `claude -p` lane (spec §6 D1) —
`temperature` matches by omission, `max_tokens` is a CLI default that cannot be pinned.
Unchanged, and correctly recorded as a deviation.

Effort is different, and the spec is wrong about it. Spec §6 D1 and §7
(`docs/harvey-labs/archive/upstream-mike-native-surface-spec-2266446b.md:1256`, `:1318`, `:1559`) say to
*"Set `--effort max` to approximate `effort: \"high\"`"*, and `lab-beaver-arm.ts:490`
defaults `--effort` to `max`. But the CLI accepts the literal value:

```
$ claude --help
  --effort <level>    Effort level for the current session (low, medium, high, xhigh, max)
```

`high` is available verbatim. `max` is **two levels above** it (`high` < `xhigh` < `max`).
So this is not an approximation forced by the transport — it is an unforced upgrade
that gives the pinned-baseline arm more reasoning budget than upstream actually
spends, in the arm's own favour, in a design whose whole point is that the baseline is
what upstream ships.

**Requirement: run `mike_upstream_native_v1` cells with `--effort high`.**
If the other 13 arms stay on `--effort max`, effort is no longer held constant across
the 24-cell design and that must be recorded as a deliberate, documented asymmetry
(native = pin-faithful effort; others = harness default). Either choice is defensible;
leaving native on `max` while calling it pin-faithful is not.

---

## 10. Zero drift for the other 13 arms — CONFIRMED (and the sweep's gap closed)

### What a preflight snapshot actually covers

```json
{"task":…,"split_sha256":…,"task_config_sha256":…,"instructions_sha256":…,
 "source_bundle_sha256":…,"source_count":8,"source_bytes":316921,"arm":"upstream_terminal_v1",
 "system_prompt_sha256":"fefebe…","tool_schema_sha256":"5b3ac1…",
 "tool_names":["read_document","find_in_document","list_documents","fetch_documents","generate_docx"]}
```

So it covers **system prompt sha, tool-schema sha, tool names** (plus task/source
pinning). All 14 before/after pairs are byte-identical.

**It does not cover:** tool-result envelope bytes, `maxIterations`, receipt shape, or
tool *descriptions* other than via the schema sha (which does include them). The
`activeCitationReminder` indirection and the `already_read`/find-hit gates are exactly
the class of change a prompt+tools sweep cannot see. I closed that gap independently.

### Closure 1 — the surface file is provably append-only

`backend/.tmp-nativeaudit-drift.ts`:

```
parent 39076 ch, child 56999 ch
child.startsWith(parent): true
parent sha=66438dd2b19f98d0   child-prefix sha=66438dd2b19f98d0
appended tail: 17923 chars
tail defines any non-native identifier? false
```

Byte-prefix identity. Every constant the other 13 arms hash
(`UPSTREAM_MIKE_LAB_SYSTEM_PROMPT`, the markdown/e2e/lean/grep families, …) is
unchanged **by construction**, not by sampling. The single diff hunk header
`@@ -865,3 +865,324 @@` corroborates it.

### Closure 2 — every removed line in the other three files, enumerated

34 removed lines total. Each is one of: (a) the head of an expression that gained a
`UPSTREAM_NATIVE_MIKE_SHAPE ? … :` prefix, leaving the original as the false branch;
(b) a pure reformat; (c) a signature/argument change preserving the non-native branch.

- `chat.ts` (11): the `LEAN_BATCH_FAMILY_TOOL_SHAPE` ternary heads for `systemPrompt`
  and `expected`, and the old inventory block — all now the `: …` branch of a native
  ternary.
- `localAssistantTools.ts` (18): `ORIGIN_MIKE_ACTIVE_TOOLS` head; the `ASK_INPUTS_DISABLED`
  spread; the `already_read` `JSON.stringify({` head; two `extractLocalDocument` tails;
  two `upstreamMikeCitationReminder(` call sites → `activeCitationReminder(`; the
  `markdown` ternary head; and the `renderMarkdownDocx(…)` call, reformatted from
  4-line to inline with identical arguments.
- `lab-beaver-arm.ts` (5): `armExpectedSurface` head, `inventoryPromptFor` signature,
  the unknown-arm error string, and two `inventoryPromptFor(documents)` →
  `inventoryPromptFor(documents, arm)` call sites (same else-branch for every
  non-native arm).

### Closure 3 — `activeCitationReminder`

With the flag off, `const activeCitationReminder = UPSTREAM_NATIVE_MIKE_SHAPE ? upstreamNativeCitationReminder : upstreamMikeCitationReminder`
resolves to **the same function object** the call sites previously named directly.
Zero drift by construction, independent of whether the two functions agree. The
same-bytes claim is *also* true — both produce identical output on all six label
variants (§8) — so the vendoring is a pure structural hardening.

### Closure 4 — the three named arms

```
mike_markdown_e2e_v1              prompt fefebe569e7c520d ✓  tools f9fd64d4634a8361 ✓  names ✓
upstream_terminal_v1              prompt fefebe569e7c520d ✓  tools 5b3ac1b5490592e1 ✓  names ✓
mike_markdown_e2e_index_floor_v1  prompt 44bd42ca7bd5a374 ✓  tools ec51e1d43e2a5dec ✓  names ✓
```

### Non-behavioural output additions (all arms), for the record

New receipt/metric keys emitted for every arm: `upstream_native_shape`,
`max_iterations`, `ask_inputs_terminated`, `turn_termination_reason`, plus one new
`harnessSourceFiles` entry (`upstreamNativeDocxRenderer.ts`) in the per-file
fingerprint map. None gate anything. Runs from before this commit are not
fingerprint-comparable to runs after it — but that was already true, since
`chat.ts`, `localAssistantTools.ts` and `upstreamMikeBenchmarkSurface.ts` are
themselves in the fingerprint list and all three changed.

---

## 11. Gate and receipt correctness — CONFIRMED, with two gate weaknesses

### Adjudication of self-reported finding (a): `MIKE_TOOL_RESULT_CAP: ""` → 64000

**Both halves confirmed.** `backend/.tmp-nativeaudit-cap.ts`:

```
MIKE_TOOL_RESULT_CAP=""  ->  MAX_TOOL_RESULT_CHARS = 64000
  Number("" || 64_000) = 64000     (Number("") would have been 0, but "" is falsy first)
WHOLE_READ_MAX_CHARS = 0     ← different variable, MIKE_WHOLE_READ_MAX_CHARS,
                               additionally gated on MODEL_COVERAGE_ROUTING
```

So the arm's env entry does not do what its `""` suggests, and the `whole_read_max_chars`
reasoning is about a genuinely different variable. Both as self-reported.

**Bypass claim verified path-by-path.** Every native tool result returns through
`upstreamMikeResult` (`localAssistantTools.ts:5927-5933`), which does no truncation:
`read_document`, `fetch_documents`, `find_in_document` (all via
`runUpstreamMikeRetrievalCall`), `edit_document` (`nativeError` and the success
envelope), `list_workflows`, `read_workflow`, `list_documents` (the
`!ADAPTIVE && !MIKE_GREP_FAMILY && !LEAN_BATCH_FAMILY` branch, true for native).
`ask_inputs` returns `[]`. The single exception is `generate_docx`.

### Adjudication of self-reported finding (b): `generate_docx` through `result()`

**Confirmed harmless — but the reasoning must be stated correctly, because the two
findings are coupled.**

```
worst-case native generate_docx envelope: 1214 chars   (200-char filename, 36-char UUIDs)
  <= MAX_TOOL_RESULT_CHARS (64000)?  true   -> truncator cannot fire
  would it fire if the cap had resolved to 0 (the env entry's apparent intent)?  true
```

`result()` truncates when `serialized.length > MAX_TOOL_RESULT_CHARS`
(`localAssistantTools.ts:5380-5381`). At 64000 the ~1.2 KB envelope can never reach it.
But had `MIKE_TOOL_RESULT_CAP: ""` resolved to `0` — which is what the entry reads as
intending — `1214 <= 0` is false and the native `generate_docx` envelope **would** have
been rewritten into the truncation envelope, destroying the pinned key order and the
`next_required_action`. Finding (b) is harmless *because* finding (a) is a harmless
mistake. That coupling should be recorded rather than left implicit.

`result()` also attaches a `status` field that `upstreamMikeResult` omits. It never
reaches the model — the model sees `content` only. Its consumers are a dedup/zero-yield
bookkeeping map (`chat.ts:2047`), an SSE trace field (`chat.ts:2130`), and a
research-context-refresh gate (`chat.ts:2392`) that is disabled for this arm
(`continuous_evidence`/`context_handoff` asserted false). No behavioural effect.

### Gate weakness G1 — the `max_iterations` assertion is tautological

```ts
surface?.upstream_native_shape !== true || Number(surface?.max_iterations ?? 0) !== 10 || …
```

with the receipt built as `max_iterations: UPSTREAM_NATIVE_MIKE_SHAPE ? 10 : null`
(`chat.ts:2539`). Once the predicate has asserted `upstream_native_shape === true`,
`max_iterations` is **necessarily** `10`. The assertion can never fail.

Worse, it is not evidence of the thing it appears to check: the receipt's `10` is a
second independent literal in the same file, re-derived from the same flag — not the
value handed to `streamChatWithTools` (`chat.ts:2668`). **The gate does not verify the
loop cap.** (The cap itself is correct — proven in §9 by reading `claudeP` — but the
gate would not catch a regression there.)

### Gate weakness G2 — missing isolation axes

`tool_result_max_chars` is present in the `benchmark_surface` receipt but **not
asserted**. Asserting it would have surfaced finding (a) automatically. Also present-
but-unasserted: `navigation_shape` (should be `"legacy"`), `retrieval_experiment`
(should be null/empty), `tool_description_variant`, `resident_authoring`,
`grounding_first`, `grounded_outline_injection`. An env leak in any of these would
pass the predicate.

Redundant-but-harmless: `trajectory_mode !== "continuous"` is implied by
`context_handoff !== false` (`trajectory_mode = contextHandoffEnabled ? "handoff" : "continuous"`),
and `hard_reference_hints` is definitionally `lean_batch_hardrefs_shape`.

Everything else in the ~28-field predicate is meaningful and would catch real leakage,
including the prompt-sha equality check — which is the check whose absence caused the
SECT-INDEX arm's first wave to run on the wrong prompt, and which is correctly present
here.

---

## 12. `ask_inputs` termination — model-side CONFIRMED, metrics claim REFUTED

**Model-visible and abort behaviour: equivalent.** Pin
(`toolDispatcher.ts:620-624`) pushes **no** `tool_result` and `continue`s; then
`streaming.ts:484-486` throws `AssistantStreamAskInputsPause`, aborting the turn. The
arm writes a `benchmark_turn_termination` SSE receipt, calls `streamAbort.abort()`,
and returns `[]`. Because the same controller is passed as
`abortSignal: streamAbort.signal` (`chat.ts:2681`), `claudeP`'s `throwIfAborted`
immediately after `runTools` (`claudeP.ts:709`) fires before the empty results array
could be pushed as a malformed user message. No `tool_result` ever reaches the model
in either implementation. Equivalent.

**The empty-items edge also matches.** Pin: `if (event.items.length > 0) askInputsEvents.push(event)`
— an `items: []` call produces no pause. Arm: `acceptPendingAskInputs` returns early
on `event.items.length === 0` (`chat.ts:2495`), so `pendingAskInputs` stays null and
the native termination branch is not entered. Same branch structure. (The schema's
`minItems: 1` makes this unreachable for a well-formed call anyway.)

### MINOR finding A1 — the `ask_inputs_terminated` instrumentation is unreachable

The commit message claims the termination is *"recorded as a typed receipt
(`ask_inputs_terminated`) instead of being suppressed"*, and the runner computes
`askInputsTerminated` at `lab-beaver-arm.ts:1421-1427`.

But `mike_upstream_native_v1` was added to the strict-deliverable list at
`lab-beaver-arm.ts:2038-2056`. On a terminated turn there is no authored DOCX, so:

```
lab-beaver-arm.ts:2061-2067
  throw new Error(`${arm} run authored 0/N required DOCX deliverables;
                   answer-text fallback and extra artifacts are forbidden for this matrix`)
```

fires at ~`:2065`. The metrics object that carries `ask_inputs_terminated` and
`turn_termination_reason` is not written until ~`:3174`. The throw always precedes it.
(`:3090`'s `if (!answer.trim() && !authored.length) throw new Error("empty assistant answer and no documents authored")` is a second, later throw on the same path.)

So: the harness fails **cleanly and typed** — it does not crash, which is what was
asked — but the rate this instrumentation exists to report **can never be reported**.
An `ask_inputs` termination presents as a hard harness error indistinguishable in the
queue from a genuine failure, which is close to the "suppressed" outcome the commit
says it avoids.

This is not a divergence from the pin — the *behaviour* (turn ends, no deliverable) is
faithful upstream behaviour on an under-specified prompt. It is a measurement defect,
hence MINOR, but it needs a decision before the queue runs (see Run-config).

---

## 13. Silo — CONFIRMED

`git show --stat 010454ea` is exactly the five declared files:

```
backend/scripts/lab-beaver-arm.ts                   151 ++++-
backend/src/lib/chat/localAssistantTools.ts         332 +++++++++-
backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts 321 ++++++++++
backend/src/lib/chat/upstreamNativeDocxRenderer.ts  675 +++++++++++++++++++++
backend/src/routes/chat.ts                           62 +-
```

No detector, extractor, skeleton, or shared-parsing module modified.
`legalTextSkeleton.ts`, `legalCrossReference.ts`, `legalStructureSidecar.ts`,
`docxTrackedChanges.ts`, `docx/core.ts`, `spreadsheet.ts` are all untouched.

Every `UPSTREAM_NATIVE` / `upstreamNative` reference outside the two surface modules
sits inside a `UPSTREAM_NATIVE_MIKE_SHAPE`-gated branch or an
`arm === "mike_upstream_native_v1"` branch. The 13 gate sites in
`localAssistantTools.ts` and the 6 in `chat.ts` were each read individually. The only
ungated additions are the five inert ones enumerated in §10.

`upstreamNativeDocxRenderer.ts` imports exactly three things:

```ts
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { isSpreadsheetDocumentType } from "../documentTypes";
```

No shared legal detector. The one shared import is safe: pin and working-tree
`SPREADSHEET_TYPES` are both `new Set(["xlsx","xlsm","xls"])`.

One nuance worth stating: the silo is one-directional. Nothing leaks *out* of the
native arm into the other 13 — that is solid. But the arm still reaches *in* to
Beaver's shared `applyTrackedEdits` (§6b) and `spreadsheetToLLMText` (§6c), which is
precisely how the BLOCKER arose. The vendoring discipline applied to the read plane
and `citationReminder` was not applied to the write-anchor plane.

---

## BLOCKERS before first run

1. **Mixed read/edit plane in `edit_document` (§6b).** The arm serves the model the
   pinned numerically-coerced DOCX plane (`"1.10"` → `"1.1"`, `"8.0"` → `"8"`) but
   anchors tracked edits with Beaver's shared `applyTrackedEdits`, which parses with
   `parseTagValue: false` (`backend/src/lib/docx/core.ts:95`) and therefore matches
   against the **un-coerced** text. At the pin both planes come from the same
   defective `createParser()` (`2266446b:docxTrackedChanges.ts:647-656`, used by both
   `extractDocxBodyText:719` and `applyTrackedEdits:799`), and the pin states the
   invariant explicitly at `documentOps.ts:1502-1503`. Proven empirically: an edit
   whose `find` is copied verbatim from the text the arm served returns
   `applied=0` with *"Could not locate … The document reads: \"1.10 …\""*, while the
   same edit against upstream's plane returns `applied=1`. Affects the ~17.5 % of
   corpus `.docx` (70/400 sampled) carrying a coercible token, is one-directional
   against the native arm, and is invisible in the trace. Fix: vendor a pin-faithful
   `applyTrackedEdits` into `upstreamNativeDocxRenderer.ts` next to the read plane,
   rather than calling Beaver's.

Nothing else blocks. Claims 1-5, 8, 10 and 13 are confirmed byte-level against the
pin, and claims 7, 9, 11 and 12 carry only MINOR divergences plus one run-config
decision.

---

## Run-config requirements

1. **`--effort high`, not `--effort max`, for `mike_upstream_native_v1` cells (§9, R1).**
   The pin sends `output_config: { effort: "high" }` (`2266446b:claude.ts:143`; spec §4
   line 1109). `claude -p --effort` accepts `low, medium, high, xhigh, max`, so `high`
   is available verbatim and the spec's "`--effort max` ≈ `effort: \"high\"`"
   (spec:1256, :1318, :1559) is not a forced approximation — it is an unforced
   two-level upgrade (`high` < `xhigh` < `max`) in the baseline arm's favour.
   `lab-beaver-arm.ts:490` defaults to `max`, so the Phase C queue must pass
   `--effort high` explicitly for these cells. If the other 13 arms remain on `max`,
   record the asymmetry deliberately — effort is then no longer held constant across
   the 24-cell design.

2. **Decide the `ask_inputs` termination policy before queueing (§12, A1).** As built,
   an `ask_inputs` termination throws at the deliverable gate
   (`lab-beaver-arm.ts:2061-2067`) before the `ask_inputs_terminated` metric is written
   (~`:3174`), so the outcome is a hard, typed harness error and the rate is never
   reported. Either exempt `mike_upstream_native_v1` from the strict-deliverable list
   when `askInputsTerminated` is true and let the run record the outcome, or accept
   that these cells fail loudly and count them by hand from the SSE receipt. Do not
   leave it as-is while describing the outcome as "recorded".

3. **Optional, cheap: assert `tool_result_max_chars` in the isolation predicate (§11, G2)**
   and drop or re-source the tautological `max_iterations` assertion (§11, G1) so the
   gate checks the value actually handed to `streamChatWithTools` rather than a second
   literal derived from the same flag.

---

## Documentation defects (no run impact)

- **P1 (§1):** spec §2.8 / §7 and the surface banner cite `prompts.ts:48-49` for the
  `generate_excel`/`generate_ppt` bullets; at the pin those are `:42-43`, and `:48-49`
  are the contract-preamble and signature-block bullets. Following the Phase-2
  restoration plan (spec:1623-1624) literally would strip the wrong clauses.
- The surface banner cites `contextBuilders.ts:144-152` for the inventory block; the
  block is `:143-153`.
- `upstreamNativeDocxRenderer.ts:31-33` and the commit message both assert that
  `edit_document` anchors the same plane `read_document` serves. It does not (§6b).
