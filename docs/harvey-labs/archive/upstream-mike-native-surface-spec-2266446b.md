# Upstream mike native chat surface — implementation spec at pin `2266446b`

Purpose: an unimpeachable, implementation-grade description of upstream mike's
**native** chat surface at a single pinned commit, so we can build a faithful
LAB benchmark arm (`mike_upstream_native_v1`) and, eventually, contribute
findings back upstream. Every deviation our LAB context forces is enumerated in
§6; nothing is silently absorbed.

All pin citations use the form `2266446b:path:line`. Working-tree citations use
absolute paths. Everything in §1–§4 was read via `git show 2266446b:<path>` —
no checkout, no branch, no modification of any tracked file.

---

## 1. Verification header

### 1.1 The pin

```
$ git cat-file -t 2266446b
commit

$ git log -1 --format="%H%n%an <%ae>%n%ad%n%s" 2266446b
2266446b0d26f735865b8cd3bb153b28e7d11b17
Will Chen <85235185+willchen96@users.noreply.github.com>
Mon Aug 3 03:09:33 2026 +0800
Merge pull request #255 from amal66/olp-pr/frontend-coverage
```

| Field | Value |
| --- | --- |
| Full hash | `2266446b0d26f735865b8cd3bb153b28e7d11b17` |
| Type | `commit` |
| Author | Will Chen `<85235185+willchen96@users.noreply.github.com>` |
| Author date | Mon Aug 3 03:09:33 2026 +0800 |
| Subject | `Merge pull request #255 from amal66/olp-pr/frontend-coverage` |

### 1.2 Sabotage clause: ABSENT at pin, PRESENT at `origin/main`

```
$ git show 2266446b:backend/src/lib/chat/prompts.ts | grep -n "TESTING ONLY"
(no output — ABSENT)

$ git grep -n "TESTING ONLY" origin/main -- backend/
origin/main:backend/src/lib/chat/prompts.ts:38:- TESTING ONLY: Make 50% of document citation quotes exact source text and 50% deliberately false text that does not appear in the source, so citation verification produces both outcomes. Use an even number of document quotes. Do not alter case-law citations.
```

`origin/main` head at time of writing: `8313af19b98ebfb6609ce97aa1962ef094db7b05`
(Tue Aug 4 19:24:49 2026 +0800, "Merge pull request #249 from
amal66/olp-pr/sec-citation-verify").

> **WARNING — do not build the arm from `origin/main`.** `origin/main` inserts a
> deliberate-falsehood instruction into the citation rules of the system prompt.
> Any benchmark built on that prompt measures a sabotaged model. The pin
> `2266446b` predates it and is clean. Our fork's own HEAD
> (`docs/legal-skills-ecosystem-comparison`) also does **not** carry the clause —
> verified — but our fork's chat surface has diverged far too much to serve as a
> baseline anyway (§1.4).

### 1.3 Second post-pin prompt change: the untrusted-content nonce policy

`git diff 2266446b origin/main -- backend/src/lib/chat/prompts.ts` shows exactly
two additions. The second is a pair of new prompt sections, `UNTRUSTED CONTENT
POLICY:` and `WORKFLOW INSTRUCTIONS POLICY:`, describing
`<untrusted-content nonce="...">` / `<workflow-instructions nonce="...">`
fencing.

**This mechanism does not exist at the pin.** Verified three ways:

- `git grep -ni "nonce" 2266446b -- backend/src` matches only
  `backend/src/lib/systemWorkflows.ts` and `backend/src/routes/user.ts`, and
  every match in the former is the substring inside `"...review.\n\nOnce the
  repre..."` — a false positive, not the token `nonce`.
- `git grep -li "untrusted" 2266446b -- backend/src` matches only
  `backend/src/lib/mcp/servers.ts` (unrelated to the document chat surface).
- No wrapping is applied anywhere in `2266446b:backend/src/lib/chat/*` or
  `2266446b:backend/src/routes/chat.ts`.

**Consequence for the arm:** there is no nonce mechanism to reproduce. Document
text is handed to the model unfenced and unlabelled at pin. The brief listed
"the untrusted-content nonce mechanism" as an anchor to chase; the answer is
that it is a *post-pin* addition. If we ever re-pin forward, this becomes a real
surface element.

### 1.4 Fork drift (why the arm must carry its own pinned copies)

`git diff --stat 2266446b HEAD` over the chat/LLM surface:

| File | Drift pin → fork HEAD |
| --- | --- |
| `backend/src/lib/chat/prompts.ts` | +214 / −52 |
| `backend/src/lib/chat/streaming.ts` | +221 / −176 |
| `backend/src/lib/chat/tools/toolSchemas.ts` | +240 / −103 |
| `backend/src/lib/chat/contextBuilders.ts` | +140 (net) |
| `backend/src/routes/chat.ts` | +4824 (net) |
| `backend/src/lib/chat/localAssistantTools.ts` | +8839 (new file) |

The live fork surface is not a baseline. The arm must vendor the pinned prompt
and pinned tool schemas as frozen constants, exactly as
`upstreamMikeBenchmarkSurface.ts` already does for other arms.

---

## 2. The native system prompt, verbatim

### 2.1 How it is assembled at runtime

Three-stage composition. Nothing else is concatenated into the system message.

1. **`buildSystemPrompt(includeResearchTools)`** —
   `2266446b:backend/src/lib/chat/prompts.ts:81-87`:

   ```ts
   export function buildSystemPrompt(includeResearchTools = true): string {
     return includeResearchTools
       ? `${SYSTEM_PROMPT_BEFORE_RESEARCH}\n\n${COURTLISTENER_SYSTEM_PROMPT}\n${SYSTEM_PROMPT_AFTER_RESEARCH}`
       : `${SYSTEM_PROMPT_BEFORE_RESEARCH}\n\n${SYSTEM_PROMPT_AFTER_RESEARCH}`;
   }
   ```

   Parts: `SYSTEM_PROMPT_BEFORE_RESEARCH` (`prompts.ts:3`),
   `COURTLISTENER_SYSTEM_PROMPT`
   (`2266446b:backend/src/lib/chat/tools/courtlistenerTools.ts:72`),
   `SYSTEM_PROMPT_AFTER_RESEARCH` (`prompts.ts:66`). None of the three template
   literals contains any `${}` interpolation — they are static text.

   Note the asymmetric join in the research-on branch: `\n\n` before the
   CourtListener block, but only `\n` after it, so `DOCUMENT NAMES IN PROSE:`
   butts directly against the CourtListener `Limits:` bullet with no blank line.
   Upstream formatting quirk; irrelevant to our arm, which uses the research-off
   branch.

2. **`buildMessages(...)`** —
   `2266446b:backend/src/lib/chat/contextBuilders.ts:125-154`:

   ```ts
   const formatted: unknown[] = [];
   let systemContent = buildSystemPrompt(includeResearchTools);

   if (systemPromptExtra) {
     systemContent += `\n\n${systemPromptExtra.trim()}`;
   }

   if (docAvailability.length) {
     systemContent += "\n\n---\nAVAILABLE DOCUMENTS:\n";
     for (const doc of docAvailability) {
       const label = doc.folder_path
         ? `${doc.folder_path} / ${doc.filename}`
         : doc.filename;
       systemContent += `- ${doc.doc_id}: ${label}\n`;
     }
     systemContent +=
       "\nYou do NOT retain document content between conversation turns. ...";
   }
   formatted.push({ role: "system", content: systemContent });
   ```

   **Finding:** the document inventory is injected into the system prompt
   **natively**, by upstream, in both chat routes. It is *not* a benchmark
   invention. See §6 — this removes a deviation the brief assumed we'd have.

3. **`runLLMStream(...)`** —
   `2266446b:backend/src/lib/chat/streaming.ts:198-200` peels
   `apiMessages[0]` off as the system prompt and passes the rest as plain
   user/assistant turns:

   ```ts
   const rawMsgs = apiMessages as { role: string; content: string | null }[];
   const systemPrompt =
     rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
   ```

**`systemPromptExtra` by route.** The general chat route passes `undefined`
(`2266446b:backend/src/routes/chat.ts:550-556`). The project chat route passes
`PROJECT_SYSTEM_PROMPT_EXTRA`
(`2266446b:backend/src/routes/projectChat.ts:27`, wired at `:152` and `:170-176`),
optionally with a `USER-ATTACHED DOCUMENTS FOR THIS TURN:` block appended at
`:163`.

**`includeResearchTools`** is the user setting `legal_research_us`
(`2266446b:backend/src/routes/chat.ts:548`, `projectChat.ts:205`). It gates both
the prompt block and the tool array — one flag, two effects.

### 2.2 Verbatim: `SYSTEM_PROMPT_BEFORE_RESEARCH` (`2266446b:backend/src/lib/chat/prompts.ts:3-64`)

```text
You are Mike, an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.

CORE RULES:
- Be precise, professional, and evidence-aware.
- Do not fabricate document content.
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.
- If the user selects a workflow with [Workflow: <title> (id: <id>)], immediately call read_workflow with that id and follow the workflow before doing anything else.
- If you need the user to choose between options, clarify a missing premise, or attach one or more documents before you can continue, call ask_inputs with all needed choice and document-upload items in a single tool call. For document-upload items, include a document_types array with short labels for the specific categories of documents you need. After asking, do not continue the substantive task until the user responds in a later message.

DOCUMENT CITATIONS:
Use document citations only for verbatim evidence from uploaded or generated documents.

In prose, put sequential markers [1], [2], etc. exactly where the cited claim appears. Assign citation refs in first-appearance order and increment by exactly 1 each time: [1], [2], [3], never [1], [2], [3], [4], [5], [8], [9]. The marker number is the citation "ref" value, not a page, footnote, section, clause, or document number.

At the very end of the response, append:
<CITATIONS>
[
  {"ref": 1, "doc_id": "doc-0", "quotes": [{"page": 3, "quote": "exact verbatim text"}]},
  {"ref": 2, "doc_id": "doc-1", "quotes": [{"page": "41-42", "quote": "text before page break [[PAGE_BREAK]] text after page break"}]}
]
</CITATIONS>

Citation rules:
- Every [N] marker must have exactly one matching entry with "ref": N.
- Citation refs must be contiguous with no skipped numbers. If the response uses N citations, the refs must be exactly 1 through N, and the <CITATIONS> array should list them in that order.
- Bracketed numbers like [1] are only citation annotation markers. Do not add brackets to section, clause, schedule, exhibit, paragraph, or list numbering.
- "doc_id" must be the exact chat-local label you were given, such as "doc-0". Never use a filename or document UUID in "doc_id".
- Use one citation entry per marker. If one marker needs several passages, use "quotes" with 1 quote by default and at most 3.
- Keep quotes short, ideally 25 words or fewer, and tightly matched to the claim.
- "page" means the sequential [Page N] marker in the provided text, not printed page numbers inside the document. Non-spreadsheet unpaginated files may have no [Page N] markers; omit "page" (or use 1) when none is present.
- For spreadsheet sources (content shown as "## Sheet: <name>" markdown tables with a "Row" column and column-letter headers), cite by cell instead of page: set "sheet" to the sheet name and "cell" to the A1 address or range you are quoting (e.g. "B7" or "B7:C9", combining the column-letter header with the "Row" number). Put the plain cell value in "quote" with no "Row"/column-letter labels or "|" separators. Omit "page" for spreadsheet citations.
- A cell tagged "⟨merged A1:C1⟩" spans that whole range: its value belongs to the anchor cell and the other covered cells are shown blank. When citing anything in a merged range, set "cell" to the full range from the tag (e.g. "A1:C1"), not a covered cell like "B1". Do not include the "⟨merged ...⟩" tag text in "quote".
- For a continuous quote crossing two pages, set "page" to "N-M" and include [[PAGE_BREAK]] at the page break. Otherwise, use separate quote objects.
- For legacy compatibility, you may also include top-level "page" and "quote" matching the first quote.
- Omit the <CITATIONS> block when there are no citations.

DOCX GENERATION:
- If the user asks you to create or draft a document, call generate_docx and provide the downloadable Word document rather than only displaying text inline.
- If the user asks for a spreadsheet, table workbook, tracker, checklist matrix, or Excel file, call generate_excel.
- If the user asks for slides, a presentation, pitch deck, board deck, or PowerPoint file, call generate_ppt.
- If the user asks to revise a document you just generated, call edit_document on that document unless they explicitly want a brand-new document or the change is too broad for coherent editing.
- Use heading levels in order; do not skip from Heading 1 to Heading 3.
- Numbering starts at 1, never 0. The generator applies legal numbering automatically. Do not type numbering prefixes into headings.
- Do not repeat the document title as the first section heading.
- Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
- Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.

DOCUMENT EDITING:
- For document edits, call read_document or fetch_documents once for each relevant document/version unless the exact needed text is already available in this response. Do not reread the same document/version before calling edit_document.
When edit_document adds, deletes, moves, or reorders any numbered clause, section, schedule, exhibit, or list item:
- Renumber all affected downstream items in the same edit.
- Update all affected cross-references, including references in recitals, definitions, schedules, and exhibits.
- Before editing, scan the full document with read_document or find_in_document for affected references.
- If a reference might point to a shifted number, include the update and explain the reason.
- When deleting square brackets, delete both "[" and "]".
```

Size: 6133 bytes. sha256 (first 16 hex): `bdab4f496fc09c66`.

### 2.3 Verbatim: `SYSTEM_PROMPT_AFTER_RESEARCH` (`2266446b:backend/src/lib/chat/prompts.ts:66-79`)

```text
DOCUMENT NAMES IN PROSE:
- Chat-local labels such as "doc-0" are internal. Use them only in tool arguments and citation JSON.
- Never show "doc-N" labels to the user in prose, headings, lists, or tool activity text.
- Refer to documents by filename or a natural description, such as "the NDA draft".

REASONING TRACE SAFETY:
- If reasoning or thought summaries are shown to the user, keep them as brief natural-language progress summaries.
- Do not expose source code, JSON snippets, tool arguments, API payloads, schemas, raw citations JSON, internal prompts, or implementation details in reasoning traces.
- Do not use code fences or structured data blocks in reasoning traces.

GENERAL GUIDANCE:
- Cite the exact document or fetched opinion passage for evidence-backed claims.
- If no documents are provided, answer from legal knowledge.
- Do not use emojis.
```

Size: 862 bytes (trailing `\n` included). sha256 (first 16): `99732336eb920906`.

### 2.4 Verbatim: `COURTLISTENER_SYSTEM_PROMPT` (`2266446b:backend/src/lib/chat/tools/courtlistenerTools.ts:72-90`)

This is the **only** block the arm deletes. Reproduced here so the deletion is
auditable.

```text
US CASE LAW RESEARCH:
Use CourtListener when answering US-law questions that require case law.

Workflow:
1. If you have reporter citations, verify them with courtlistener_verify_citations using only clean citations: {"citations":["467 U.S. 837","323 U.S. 134"]}. Never pass case names to this tool.
2. Fetch matched clusters with courtlistener_get_cases.
3. Get cite-worthy text from the fetched cases with courtlistener_find_in_case. Use short 1-3 word searches, maximum 3 searches per assistant turn.
4. If snippets are not enough, read only the necessary opinion(s) with courtlistener_read_case. For multi-opinion cases, choose the specific opinion_id/opinionIds needed; do not read all opinions by default.

Citation rules:
- Final case citations must be based on opinion text or passage snippets supplied in this turn. Do not cite cases based only on memory, metadata, search results, citationLinks, or verification results.
- If you mention a CourtListener case as legal support in the final answer, cite it with both: (a) the clickable markdown link returned in citationLinks, and (b) an inline [N] marker. Include the clickable case link only the first time you cite that case; later references to the same case should use the existing inline [N] marker without repeating the link unless clarity requires it.
- Assign new annotation refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
- The final <CITATIONS> block must include one matching case entry for each [N] case marker: {"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
- Do not use doc_id, page, top-level quote, case_name, or citation fields in case entries.
- If you have not obtained opinion text or snippets for a useful case, fetch/read it before citing it, or say you could not read it and do not rely on it.

Limits:
- If any CourtListener call returns a rate-limit/throttling/429 error, stop all CourtListener calls for that turn and answer using only information already available.
```

Size: 2159 bytes. sha256 (first 16): `65933aa276753a47`.

### 2.5 Verbatim: `PROJECT_SYSTEM_PROMPT_EXTRA` (`2266446b:backend/src/routes/projectChat.ts:27-33`)

Present only on the project-chat route. See §2.8 for the route decision.

```text
PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.
```

Size: 1471 bytes.
sha256: `00642ff87f0ca95a8671150ba8b9a6a0a049b9c8783bc1fb8b22787d9a89c88f`.

### 2.6 Verbatim: the AVAILABLE DOCUMENTS block (`2266446b:backend/src/lib/chat/contextBuilders.ts:144-152`)

Template (`{folder_path} / ` prefix only when a folder path exists — project
route only):

```text


---
AVAILABLE DOCUMENTS:
- doc-0: <filename>
- doc-1: <filename>

You do NOT retain document content between conversation turns. You MUST call read_document (or fetch_documents) once at the start of every response that involves a document's content, even if you have read it in a previous turn. Within the same response, do not call read_document or fetch_documents again for a document/version that has already been read; use the prior tool result, find_in_document for targeted checks, or proceed to the next required tool. Failure to read once per turn will result in hallucinated or stale content.
---

```

Doc labels are assigned by array position over the resolved document list —
`const docLabel = \`doc-${i}\`` at
`2266446b:backend/src/lib/chat/contextBuilders.ts:411` (general) and `:502`
(project). Labels are dense from `doc-0` and stable within a request.

### 2.7 Assembled prompts and their hashes

Computed by reconstructing the exact concatenations from the pinned sources
(script in scratchpad; the literals contain no interpolation, so the
reconstruction is exact).

| Variant | Bytes | sha256 |
| --- | --- | --- |
| `buildSystemPrompt(false)` — research OFF | 6997 | `461e218471918ddce08d5630847ac80aaf59049a5cf7729e6728848c28a6eb49` |
| `buildSystemPrompt(true)` — research ON | 9157 | `ee91c3a995aea385e41d59cd72c7e8d3b34c36bd8f4b4a7ab8994eadd79c0860` |

With a two-document inventory appended (`doc-0`, `doc-1`), the fully assembled
system message is 7636 bytes (general composition) / 9109 bytes (project
composition, i.e. `PROJECT_SYSTEM_PROMPT_EXTRA` included).

The arm pins **`buildSystemPrompt(false)` = sha256
`461e218471918dd…`** as the frozen base, with the inventory block appended per
task at runtime.

### 2.8 The permitted strip-list — exact and minimal

The arm's prompt is defined as: **the full un-abridged pinned prompt, minus
clauses referencing tools that do not exist on the LAB surface.** The strip-list
has exactly **one** entry, and upstream itself provides the switch for it.

| # | Stripped text | Pin location | Why | Mechanism |
| --- | --- | --- | --- | --- |
| 1 | The entire `COURTLISTENER_SYSTEM_PROMPT` block, verbatim as reproduced in §2.4 (`US CASE LAW RESEARCH:` … `answer using only information already available.`) | `2266446b:backend/src/lib/chat/tools/courtlistenerTools.ts:72-90` | The five `courtlistener_*` tools require network access to CourtListener; LAB is offline and the tools are not exposed | **Native.** `buildSystemPrompt(false)` at `prompts.ts:81-87`, driven by `includeResearchTools: false` at `streaming.ts:189`. This is the exact prompt an upstream user with `legal_research_us = false` receives. Zero hand-editing. |

> **Phase-1 caveat.** The one-entry strip-list above is the *target* state
> (Phase 2, §7 steps 11–13). Because our serving side has no executors for
> `generate_excel`, `generate_ppt`, or `replicate_document` yet, **Phase 1 also
> strips their three clauses** — `prompts.ts:48`, `:49`, and the
> `REPLICATING A DOCUMENT:` block of `projectChat.ts:32-33` — under the same
> rule ("clauses referencing tools absent from the LAB surface"). This is
> tracked as deviation **D10** and is closed by Phase 2, at which point the
> strip-list returns to the single CourtListener entry. Phase-1 and Phase-2
> hashes are both pinned (§7 step 1) so which state a run used is never
> ambiguous.

**Nothing else is stripped.** In particular, these clauses stay in, and the
reasoning for each:

- **`ask_inputs` clause** (`prompts.ts:11`) — the tool exists natively and is in
  the arm's tool set. See §4.5 for the run-termination hazard it creates and why
  we keep it anyway.
- **Workflow clause** (`prompts.ts:10`, "If the user selects a workflow with
  `[Workflow: <title> (id: <id>)]`…") — `WORKFLOW_TOOLS` are *unconditionally*
  in `baseTools` at `2266446b:backend/src/lib/chat/streaming.ts:191`. The tools
  are exposed with an empty workflow store, so `list_workflows` returns `[]`.
  The clause is inert because no LAB user message carries a `[Workflow: …]` tag.
  Keeping it is strictly more faithful than removing it.
- **`generate_excel` / `generate_ppt` clauses** (`prompts.ts:48-49`) — both tools
  are natively present in `TOOLS` and stay in the arm's tool set.
- **`fetch_documents` references throughout** — present in the project
  composition (§2.8.1). Kept.
- **`- Cite the exact document or fetched opinion passage for evidence-backed
  claims.`** (`prompts.ts:76`, inside `SYSTEM_PROMPT_AFTER_RESEARCH`) —
  **"fetched opinion" is a dangling reference to CourtListener that upstream
  leaves in place even when research tools are off.** It is *not* stripped,
  because stripping it would deviate from what upstream actually sends. Flagged
  here as an upstream inconsistency worth reporting back, not as something for
  us to fix in a baseline.

#### 2.8.1 Route composition decision: use the **project-chat** composition

Upstream has two native document-chat routes, and they differ in tools and
prompt. The arm should use the **project** composition. Reasoning, with the
evidence:

- The base prompt references `fetch_documents` five times
  (`prompts.ts:9`, `:11` region, `:57`, and the AVAILABLE DOCUMENTS trailer at
  `contextBuilders.ts:152`), but the **general** chat route never passes
  `extraTools` (`2266446b:backend/src/routes/chat.ts:582-595`), so
  `fetch_documents`, `list_documents`, and `replicate_document` are **absent**
  from the general-chat tool set (`streaming.ts:191-194`). The general
  composition is therefore internally inconsistent: the model is instructed to
  use a tool it does not have. Benchmarking that inconsistency would measure an
  upstream bug rather than upstream behaviour.
- The project route passes `extraTools: PROJECT_EXTRA_TOOLS`
  (`2266446b:backend/src/routes/projectChat.ts:203`), which supplies exactly the
  three tools the prompt assumes.
- LAB tasks hand the model a *set* of documents for one matter — semantically a
  project, not a single ad-hoc attachment.

The cost of this choice is one extra prompt block
(`PROJECT_SYSTEM_PROMPT_EXTRA`, §2.5) and three extra tools. Both are pinned
upstream text and pinned upstream schemas, so fidelity is preserved. Record the
choice in the arm's receipt so a reviewer can see which of the two native
compositions was measured. If a reviewer prefers the general composition, it is
a one-line change (drop `systemPromptExtra` and `PROJECT_EXTRA_TOOLS`); both
hashes are pinned in §2.7 / §3.9 so either is reproducible.

---

## 3. Native tool inventory at pin, verbatim

### 3.1 Composition and ordering

`2266446b:backend/src/lib/chat/streaming.ts:189-194`:

```ts
const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
const mcpTools = await buildUserMcpTools(userId, db);
const baseTools = [...TOOLS, ...researchTools, ...WORKFLOW_TOOLS];
const activeTools = extraTools?.length
  ? [...baseTools, ...mcpTools, ...extraTools]
  : [...baseTools, ...mcpTools];
```

Tool arrays are OpenAI-shaped and converted per provider by `toClaudeTools`
(`2266446b:backend/src/lib/llm/tools.ts:15-21`): `{name, description,
input_schema}` where `input_schema` is `normalizeSchema(parameters)` — a
recursive pass that only guarantees `properties` on objects and `items` on
arrays. **No fields are dropped**; `minItems`, `maxItems`, `minimum`, `maximum`,
and `enum` all survive to the wire (`tools.ts:54-74`).

With `includeResearchTools: false` and no MCP connectors, the two possible
compositions are:

| Composition | Order (exact) | sha256 of the OpenAI-shaped array |
| --- | --- | --- |
| General | `ask_inputs, read_document, find_in_document, generate_docx, generate_excel, generate_ppt, edit_document, list_workflows, read_workflow` | `5d9bab944b53d1bfdaa12515a7fb9c510cf9e3cf31beb8ef370b2e9fb3ea08cb` |
| **Project (arm)** | `ask_inputs, read_document, find_in_document, generate_docx, generate_excel, generate_ppt, edit_document, list_workflows, read_workflow, list_documents, fetch_documents, replicate_document` | `8617531e5a9d966ce3f4f4460bccbc26f97d44797914db27711d36a28083f261` |

Ordering is load-bearing for reproducibility (and our repo already has a
precedent for preserving upstream tool order — commit `db2be44a`). Pin the
project sha in the conformance gate.

### 3.2 `read_document`

**Schema** — `2266446b:backend/src/lib/chat/tools/toolSchemas.ts:205-222`:

```json
{
  "type": "function",
  "function": {
    "name": "read_document",
    "description": "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, citing from, or editing a document, but call it at most once per document/version in a single response. After this returns, use the prior tool result or find_in_document for targeted checks instead of reading the same document/version again.",
    "parameters": {
      "type": "object",
      "properties": {
        "doc_id": {
          "type": "string",
          "description": "The document ID to read (e.g. 'doc-0', 'doc-1')"
        }
      },
      "required": ["doc_id"]
    }
  }
}
```

**Confirmed: `doc_id` only. There is no windowing, offset, limit, range, or
pagination parameter at pin.** The brief's suspicion is correct.

**Executor** — `2266446b:backend/src/lib/chat/tools/toolDispatcher.ts:626-662`,
calling `readDocumentContent`
(`2266446b:backend/src/lib/chat/tools/documentOps.ts:1404-1579`).

**Response serialization the model sees.** The tool result content is a **plain
string**, not JSON:

```
<citationReminder(doc_id, filename)>
<blank line>
<full extracted document text>
```

built at `toolDispatcher.ts:656-662`:

```ts
toolResults.push({
  role: "tool",
  tool_call_id: tc.id,
  content: filename
    ? `${citationReminder(docId, filename)}\n\n${content}`
    : content,
});
```

`citationReminder` — `2266446b:backend/src/lib/chat/tools/documentOps.ts:33-47`
— is five newline-joined lines (non-spreadsheet variant shown):

```text
[Citation requirement for doc-0 ("Master Services Agreement.docx")]:
If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.
Every citation entry for this document MUST use "doc_id": "doc-0".
Use this citation object shape: {"ref": 1, "doc_id": "doc-0", "quotes": [{"page": 1, "quote": "exact verbatim text from the document"}]}. Include top-level "page" and "quote" too only if they match the first quote.
Do not use "marker" or "text" keys in the citation block; use "ref" and "quotes".
```

The spreadsheet variant swaps line 4 for the `sheet`/`cell` shape
(`documentOps.ts:38`).

**⚠️ Correction to the brief: `read_document` does NOT return `sections[]` JSON.**
There is no `sections[]` serialization of a document anywhere in the read path
at pin. The `sections[]` shape exists **only** as the *input* schema of
`generate_docx` (§3.5). What `read_document` returns is the extraction
plane, per file type (`documentOps.ts:1494-1562`):

| `file_type` | Extractor | Page markers? | Shape |
| --- | --- | --- | --- |
| `pdf` | `extractPdfText` (`documentOps.ts:49-81`) | **Yes** — `[Page N]\n<text>` per page, pages joined by `\n\n` (`:74,:77`) | Flat text |
| `docx` | `extractDocxBodyText` (`2266446b:backend/src/lib/docxTrackedChanges.ts:719-750`) | **No** | Paragraphs joined by a single `\n`; `w:tbl`/`w:tr`/`w:tc`/`w:sdt` are recursed into and their paragraphs flattened into the same line stream. Falls back to `mammoth.extractRawText` if empty (`documentOps.ts:1508-1520`) |
| xlsx/xlsm/xls | `spreadsheetToLLMText` | No (uses `## Sheet:` markdown tables with a `Row` column) | Cell-addressed markdown |
| `pptx` | `extractPresentationText` | No | Flat text |
| legacy Office (`doc`, `ppt`) | `docxToPdf` → `extractPdfText` | **Yes** (via the PDF detour) | Flat text |
| anything else | `mammoth.extractRawText` | No | Flat text |

So for the DOCX-centric LAB corpus, the native plane is **flat paragraph text
with no page markers and no structural annotation** — the same string the
`edit_document` anchor matcher operates on, by design
(`documentOps.ts:1502-1504`: "Use the same flattening as the edit_document
matcher so the LLM sees exactly the characters it can anchor against").
Consequence: the citation rule "omit `page` … when none is present"
(`prompts.ts:33`) is the operative branch for DOCX tasks.

**⚠️ Size cap: confirmed NONE at pin.** `readDocumentContent` ends with a bare
`return text;` (`documentOps.ts:1567`) — no slice, no truncation, no byte
budget. `toolDispatcher.ts` pushes the string through unmodified. A grep for
`MAX_`, `_LIMIT`, `slice(0,`, `substring(0,`, `truncat` across the pinned
`toolDispatcher.ts` and `documentOps.ts` returns only (a) `ask_inputs` field
length normalization (`toolDispatcher.ts:113-160`) and (b) the
`truncated:` *flag* in the `find_in_document` payload
(`documentOps.ts:1764`) — never a cap on document text. **The whole document
goes to the model, always.**

**Failure strings** (verbatim, plain text, no JSON wrapper):
`"Document not found."` (`documentOps.ts:1420`), `"Document could not be read."`
(`:1480`, `:1577`).

**Version resolution:** reads prefer the current tracked-changes version
(`documentOps.ts:1450-1466`), falling back to the original upload path.

### 3.3 `fetch_documents`

**Schema** — `2266446b:backend/src/lib/chat/tools/toolSchemas.ts:11-30`:

```json
{
  "type": "function",
  "function": {
    "name": "fetch_documents",
    "description": "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
    "parameters": {
      "type": "object",
      "properties": {
        "doc_ids": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])"
        }
      },
      "required": ["doc_ids"]
    }
  }
}
```

**Executor** — `toolDispatcher.ts:710-755`. **Response serialization:** one
plain-text blob, per-document parts joined by `\n\n`, each part:

```
--- <filename> (<doc_id>) ---
<citationReminder(doc_id, filename)>

<full extracted text>
```

(`toolDispatcher.ts:743-745`). Duplicate-suppressed documents get the same
`--- header ---` followed by the JSON refusal object (§4.2), inlined into the
text blob (`:725-729`). Also no size cap.

### 3.4 `find_in_document`

**Schema** — `toolSchemas.ts:223-255`:

```json
{
  "type": "function",
  "function": {
    "name": "find_in_document",
    "description": "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
    "parameters": {
      "type": "object",
      "properties": {
        "doc_id": { "type": "string", "description": "The document ID to search (e.g. 'doc-0')." },
        "query": { "type": "string", "description": "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'." },
        "max_results": { "type": "integer", "description": "Maximum number of matches to return (default 20). Use a smaller value for common terms." },
        "context_chars": { "type": "integer", "description": "Characters of surrounding context to include on each side of a match (default 80)." }
      },
      "required": ["doc_id", "query"]
    }
  }
}
```

**Matching semantics** — `documentOps.ts:1588-1660`:

- `normalizeWithMap` (`:1588-1607`) builds a lowercased copy in which every run
  of `\s` collapses to a single space, plus an index map back to original
  offsets. `normalizeQuery` (`:1609-1611`) trims, collapses `\s+` → `" "`, and
  lowercases. Matching is a plain `indexOf` over the normalized plane
  (`:1635`), so it is **case-insensitive and whitespace-tolerant but not
  fuzzy** — no stemming, no diacritic folding, no punctuation tolerance.
- Advance step is `pos + max(1, needle.length)` (`:1656`) — non-overlapping.
- `excerpt` is sliced from the **original** text via the index map (`:1648`), so
  it is exactly quotable. `context` is the ±`context_chars` window with
  whitespace collapsed and `…` ellipses when clipped (`:1649-1652`).
- `totalMatches` counts **all** matches; only the first `max_results` are
  materialized as hits (`:1643`, `:1655`).
- Internally re-reads the whole document through `readDocumentContent` on every
  call (`:1710-1717`), with `emitEvents: false`. Server-side cost only — it does
  **not** register in `turnReadState`, so it never trips duplicate suppression
  and can be called unlimited times on the same document.

**Response serialization** (JSON string) — `documentOps.ts:1758-1766`:

```json
{
  "ok": true,
  "filename": "Master Services Agreement.docx",
  "query": "termination for convenience",
  "total_matches": 4,
  "returned": 4,
  "truncated": false,
  "hits": [
    { "index": 0, "excerpt": "Termination for Convenience", "context": "…10.2 Termination for Convenience. Either party may…" }
  ]
}
```

Error shapes: `{"ok":false,"error":"Empty query."}` (`:1688`),
`{"ok":false,"error":"Document 'doc-9' not found."}` (`:1693-1696`),
`{"ok":false,"filename":"…","error":"Document could not be read."}`
(`:1727-1731`), `{"ok":false,"error":"Empty query after normalization."}`
(`:1736-1739`).

### 3.5 `generate_docx` — the DOCX generation tool

**Schema** — `toolSchemas.ts:256-327`, verbatim:

```json
{
  "type": "function",
  "function": {
    "name": "generate_docx",
    "description": "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
    "parameters": {
      "type": "object",
      "properties": {
        "title": { "type": "string", "description": "Document title (used as filename and heading)" },
        "landscape": { "type": "boolean", "description": "Set to true for landscape page orientation. Default is portrait." },
        "sections": {
          "type": "array",
          "description": "List of document sections. Each section may contain a heading, prose content, or a table.",
          "items": {
            "type": "object",
            "properties": {
              "heading": { "type": "string", "description": "Optional section heading" },
              "level": { "type": "integer", "description": "Heading level: 1, 2, or 3" },
              "content": { "type": "string", "description": "Prose text content (paragraphs separated by double newlines)" },
              "pageBreak": { "type": "boolean", "description": "Set to true to start this section on a new page. Use for contract signature pages." },
              "table": {
                "type": "object",
                "description": "Optional table to render in this section",
                "properties": {
                  "headers": { "type": "array", "items": { "type": "string" }, "description": "Column header labels" },
                  "rows": { "type": "array", "items": { "type": "array", "items": { "type": "string" } }, "description": "Array of rows, each row is an array of cell strings matching the headers order" }
                },
                "required": ["headers", "rows"]
              }
            }
          }
        }
      },
      "required": ["title", "sections"]
    }
  }
}
```

Notes on the shape: `sections[]` items have **no** `required` array — every
field is optional, and a section may legitimately be heading-only,
content-only, table-only, or a bare `{pageBreak:true}`. `level` is documented as
"1, 2, or 3" but the renderer supports four levels (§3.5.1). There is no
nesting: `sections` is a **flat** list; hierarchy is expressed solely by `level`
and by the renderer's inference from text.

**Renderer semantics** — `generateDocx`, `documentOps.ts:83-582`. This is the
grammar an arm must reproduce byte-for-byte if it renders deliverables itself.

#### 3.5.1 Renderer, field by field

- **Document title** (`:114-129`): always emitted first as
  `HeadingLevel.TITLE`, centered, **uppercased**, bold, Times New Roman 11pt
  (`FONT = "Times New Roman"`, `SIZE = 22` half-points, `:109-110`).
- **`pageBreak`** (`:321-323`): emits a standalone `Paragraph` containing a
  `PageBreak` **before** the section's heading/table/content.
- **`heading`** (`:324-358`):
  - `stripManualNumbering` (`:234-243`) strips a leading `1.2.3` / `1.2.3.` /
    `1.2.3)` prefix and *derives the level from the dot count*
    (`levelFromPrefix = parts.length - 1`).
  - `isUnnumberedHeading` (`:280-298`) forces no numbering for: empty headings,
    `signatures`/`signature`, a first heading that matches the document title
    (`isTitleLikeFirstHeading`, `:266-278` — exact match, or title-contains-heading
    plus a `agreement|contract|deed|terms|policy|notice|nda|disclosure` keyword),
    and a first heading matching
    `^(agreement|contract|mutual non disclosure agreement|non disclosure agreement|employment agreement|service level agreement)$`.
  - A title-like first heading is **dropped entirely** (`skipHeading`, `:327-330`,
    `:340`) — the prompt rule "Do not repeat the document title as the first
    section heading" is enforced in the renderer, not just requested.
  - Effective index: `min(levelFromPrefix ?? (level ?? 1) - 1, 3)` (`:331-334`) —
    so a manual `2.1 Foo` prefix **overrides** the `level` field.
  - Level-0 headings are **uppercased** (`:336-339`); all headings are bold.
  - Numbering is `legalNumbering(idx)` unless unnumbered (`:344`).
- **`table`** (`:359-423`): `normalizeTable` (`:213-233`) drops the table
  entirely if `headers` is missing/empty after trimming; each row is
  padded/truncated to exactly `headers.length` cells and non-string cells become
  `""`. Header row is shaded `F2F2F2`, bold; all cells get 1pt `CCCCCC`
  borders; table width 100%. An empty paragraph follows the table (`:422`).
- **`content`** (`:424-473`): split on **`\n`** (single newline), blank lines
  skipped. **Note the mismatch with the schema description**, which says
  "paragraphs separated by double newlines" — the renderer treats every
  non-blank line as its own paragraph. Per line:
  - `^[-•*]\s+` bullet marker detected (`:434`);
  - `parseManualListMarker` (`:244-258`) detects `(a)` / `a.` / `a)` /
    `(iv)` style markers and yields `levelOffset` 3 for roman, 2 otherwise;
  - `stripManualNumbering` handles numeric prefixes;
  - inferred level (`:443-454`): `undefined` (no numbering) when
    `currentClauseLevel === null` or the section looks like a signature block;
    else `currentClauseLevel + 2` for bullets, `currentClauseLevel + levelOffset`
    for manual list markers, `levelFromPrefix` for numeric prefixes, otherwise
    `currentClauseLevel + 1` for the section's first numbered body paragraph and
    `currentClauseLevel + 2` for subsequent ones.
  - `looksLikeSignatureBlock` (`:301-309`): ≥2 lines matching
    `^(?:by|name|title|date):\s*` suppresses numbering for the whole section.
- **Numbering scheme** `legal-clause-numbering` (`:144-212`): L0 `%1.` decimal
  bold, L1 `%1.%2` decimal, L2 `(%3)` lower-letter, L3 `(%4)` lower-roman, L4
  `(%5)` upper-letter; indents 720/720/1440/1440/2520 twips with matching
  hanging indents.
- **`landscape`** (`:476-478`): sets `PageOrientation.LANDSCAPE` on the section
  properties.
- **Post-pack validation** (`:492-504`): the produced zip must contain
  `[Content_Types].xml`, `word/document.xml`, `word/_rels/document.xml.rels`,
  else it returns `{error: "Generated DOCX is missing required package part: …"}`.
- **Filename** (`:506-511`): `title.replace(/[^a-zA-Z0-9 -]/g,"").trim().slice(0,64)`
  or `"document"`, plus `.docx`.

#### 3.5.2 `generate_docx` response serialization

`registerGeneratedDocument` — `toolDispatcher.ts:505-578`. `download_url` and
`storage_path` are **stripped** from the payload before it reaches the model
(`:560`), and a new `doc-N` label is minted for the generated file and inserted
into `docIndex`/`docStore` so it becomes immediately readable (`:521-535`).
The model sees:

```json
{
  "filename": "Mutual Non-Disclosure Agreement.docx",
  "document_id": "…uuid…",
  "version_id": "…uuid…",
  "version_number": 1,
  "message": "Document 'Mutual Non-Disclosure Agreement.docx' has been generated successfully.",
  "doc_id": "doc-2",
  "next_required_action": "Before writing your final response, call read_document with doc_id \"doc-2\". Base your description on the generated document's actual returned text, not on memory of what you intended to generate. Do not include download links, URLs, or markdown links to the document in your prose response; the document card is shown automatically by the UI. Give a concise description of the generated document and, if you make factual claims about its contents, cite it with [N] markers and a final <CITATIONS> block using doc_id \"doc-2\", not any source/template document."
}
```

(`next_required_action` is the four strings at `:565-570` joined by `" "`.)

**This is a round-consuming instruction**: upstream tells the model to read back
every document it generates. Combined with the 10-round cap (§4.1) it is a real
budget item, and it means a faithful arm must serve `read_document` on the
*generated* file too — the deliverable must be re-readable, not just written to
disk.

### 3.6 `edit_document` — the document editing tool

**Schema** — `toolSchemas.ts:419-470`:

```json
{
  "type": "function",
  "function": {
    "name": "edit_document",
    "description": "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first unless this same document/version has already been read in the current response. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
    "parameters": {
      "type": "object",
      "properties": {
        "doc_id": { "type": "string", "description": "Document slug (e.g. 'doc-0')." },
        "edits": {
          "type": "array",
          "description": "List of precise substitutions.",
          "items": {
            "type": "object",
            "properties": {
              "find": { "type": "string", "description": "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed)." },
              "replace": { "type": "string", "description": "Replacement text. Empty string = pure deletion." },
              "context_before": { "type": "string", "description": "~40 chars immediately preceding `find`, used to disambiguate." },
              "context_after": { "type": "string", "description": "~40 chars immediately following `find`." },
              "reason": { "type": "string", "description": "Short explanation shown to the user on the card." }
            },
            "required": ["find", "replace", "context_before", "context_after"]
          }
        }
      },
      "required": ["doc_id", "edits"]
    }
  }
}
```

**Executor** — `toolDispatcher.ts:1378-1540`, calling `runEditDocument`
(`documentOps.ts:1106-…`), which applies OOXML tracked changes via
`applyTrackedEdits`. Anchors are matched against the **same** flattened plane
`read_document` returns (`extractDocxBodyText`) — this is why the read plane and
the edit plane must never diverge.

Turn-scoped version collapsing: multiple `edit_document` calls in one turn reuse
one `document_versions` row via `turnEditState`
(`streaming.ts:214`, `toolDispatcher.ts:1452`, `:1461-1465`). On success the
tool also **invalidates the read guard** for that document
(`clearTurnReadsForDocument`, `toolDispatcher.ts:1467`) so a post-edit
verification read is permitted, and repoints `docIndex`/`docStore` at the new
version (`:1470-1487`).

**Response serialization** (`toolDispatcher.ts:1502-1526`):

```json
{
  "ok": true,
  "doc_id": "doc-0",
  "document_id": "…uuid…",
  "version_id": "…uuid…",
  "version_number": 2,
  "applied": 7,
  "errors": [],
  "next_required_action": "The edited document remains available as doc_id \"doc-0\". Before making factual claims about the edited document's final contents, call read_document with doc_id \"doc-0\" and base the response on that returned text. Do not include download links or URLs in your prose response; the edited document card is shown automatically by the UI. If you describe specific content from the edited document, cite it with [N] markers and a final <CITATIONS> block using doc_id \"doc-0\"."
}
```

Failure: `{"ok": false, "error": "<message>"}` (`:1521-1525`). `errors[]` carries
per-edit `{index, reason}` for anchors that could not be located, while other
edits still apply — a partial-success contract worth measuring.

### 3.7 Inventory presentation: `list_documents`

**Schema** — `toolSchemas.ts:1-10`:

```json
{
  "type": "function",
  "function": {
    "name": "list_documents",
    "description": "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
    "parameters": { "type": "object", "properties": {} }
  }
}
```

**Executor + serialization** — `toolDispatcher.ts:699-709`. A JSON array, in
`docStore` insertion order:

```json
[{"doc_id":"doc-0","filename":"Master Services Agreement.docx","file_type":"docx"}]
```

Note this is *redundant* with the AVAILABLE DOCUMENTS prompt block (§2.6), which
already lists `doc_id` + filename; `list_documents` adds only `file_type`.
Upstream ships both. Keep both.

### 3.8 Remaining native tools (complete inventory)

| Tool | Schema | Executor | Response the model sees |
| --- | --- | --- | --- |
| `ask_inputs` | `toolSchemas.ts:121-204` | `toolDispatcher.ts:620-624` | **None.** Produces an `ask_inputs` event and **no `tool_result`**; the turn is aborted (§4.5). Fields are length-clamped at `toolDispatcher.ts:105-160` (`id`≤80, `question`≤500, `value`≤500, ≤8 options, ≤8 doc types, ≤12 items). |
| `generate_excel` | `toolSchemas.ts:328-374` — `{title, sheets:[{name, columns, rows}]}` | `toolDispatcher.ts:1821-1840` → `generateExcel` (`documentOps.ts:1030`) | Same `registerGeneratedDocument` envelope as §3.5.2 |
| `generate_ppt` | `toolSchemas.ts:375-418` — `{title, slides:[{title, bullets, notes?}]}` | `toolDispatcher.ts:1841-1860` → `generatePpt` (`documentOps.ts:1056`) | Same envelope |
| `replicate_document` | `toolSchemas.ts:31-60` — `{doc_id, count?≤20, new_filename?}` | `toolDispatcher.ts:1541-…` | Byte-for-byte copies; returns new `doc_id` slugs |
| `list_workflows` | `toolSchemas.ts:91-100` | `toolDispatcher.ts:756-767` | `JSON.stringify([{id,title}])` — `[]` with an empty store |
| `read_workflow` | `toolSchemas.ts:101-118` | `toolDispatcher.ts:768-781` | Raw `skill_md` string, or `"Workflow '<id>' not found."` |
| `read_table_cells` | `toolSchemas.ts:63-89` | `toolDispatcher.ts:782-…` | Tabular-review surface only; **not** in either chat composition (never in `baseTools`) |
| `courtlistener_*` (4) | `courtlistenerTools.ts:92-197` | `toolDispatcher.ts:831-1377` | **Excluded from the arm** (§2.8) |

Dead-code note for an upstream report: `COURTLISTENER_TOOL_NAMES.searchCaseLaw`
(`courtlistenerTools.ts:65`) has a dispatcher branch
(`toolDispatcher.ts:831`) and an event type (`:3`) but **no schema in
`COURTLISTENER_TOOLS`** — the model can never call it.

**Unknown-tool fallback** — `streaming.ts:494-506`: any `tool_use` that produced
no result is answered with
`{"error":"Tool '<name>' is not available."}` so every `tool_use` always has a
matching `tool_result`.

### 3.9 Hashes to pin in the conformance gate

| Artifact | sha256 |
| --- | --- |
| `buildSystemPrompt(false)` | `461e218471918ddce08d5630847ac80aaf59049a5cf7729e6728848c28a6eb49` |
| `PROJECT_SYSTEM_PROMPT_EXTRA` | `00642ff87f0ca95a8671150ba8b9a6a0a049b9c8783bc1fb8b22787d9a89c88f` |
| Tool array, project composition (`JSON.stringify`, order-sensitive) | `8617531e5a9d966ce3f4f4460bccbc26f97d44797914db27711d36a28083f261` |
| Tool array, general composition | `5d9bab944b53d1bfdaa12515a7fb9c510cf9e3cf31beb8ef370b2e9fb3ea08cb` |

---

## 4. Native loop mechanics at pin

### 4.1 The ≤10 tool-round cap

**Where it is set** — `2266446b:backend/src/lib/chat/streaming.ts:341`:

```ts
      tools: activeTools as OpenAIToolSchema[],
      maxIterations: 10,
      apiKeys,
      enableThinking: true,
```

(The brief's "~line 349" is the `origin/main` line number; at pin it is **341**.
`origin/main:backend/src/lib/chat/streaming.ts:349` confirms the drift.)

**Where it is enforced** — `2266446b:backend/src/lib/llm/claude.ts:116` and
`:128`:

```ts
  const maxIter = params.maxIterations ?? 10;
  …
    for (let iter = 0; iter < maxIter; iter++) {
```

The default is also 10 in the other two adapters
(`2266446b:backend/src/lib/llm/openai.ts:219`,
`2266446b:backend/src/lib/llm/gemini.ts:172`), so 10 is the surface-wide
constant, not a chat-route special case.

**What counts as a round.** One iteration = **one provider request** plus, at
most, **one batch of tool calls**. Every `tool_use` block in a single assistant
message is executed in the same batch (`runTools(toolCalls)` receives the whole
array, `claude.ts:243`), so N parallel calls cost **one** round. This is exactly
what the prompt's "Batch independent tool calls" instruction is buying.

**⚠️ What happens at the cap — a hard, silent truncation.** `claude.ts:239-257`:

```ts
      if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
        break;
      }

      const results = await runTools(toolCalls);
      throwIfAborted(params.abortSignal);

      messages.push({ role: "assistant", content: assistantBlocks });
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      });
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
```

If the model still requests tools on iteration 9 (the 10th), the tools **do
execute** — side effects and all — the results are appended to `messages`, the
`for` condition then fails, and the function **returns**. There is:

- **no injected "you have run out of rounds" message**,
- **no tool refusal**,
- **no forced final synthesis turn**,
- **no error, no flag, no event**.

The turn simply ends with whatever prose the model happened to emit before its
last tool call, and the 10th batch's results are computed and thrown away. The
`≤10` line in the prompt (`prompts.ts:7`) is the model's *only* protection
against producing no final answer. There are no verbatim cap strings to
reproduce, because upstream emits none.

**Benchmark consequence (important and favourable):** a `generate_docx` issued
on round 10 still writes the deliverable. Deliverable capture must therefore
hook the **tool call**, not the final assistant message.

### 4.2 `turnReadState` duplicate-read suppression

**State** — `streaming.ts:216-218`, one `Map` per assistant turn:

```ts
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
```

**Key** — `getTurnReadIdentity` (`documentOps.ts:1332-1372`): prefers
`` `${documentId}:${activeVersion.id}` `` (`:1354`), falling back to
`` `${documentId ?? docLabel}:${docInfo.storage_path}` `` (`:1365`). The guard is
therefore **per document *version***, not per label — editing a document mints a
new version and naturally re-permits a read.

**Trigger conditions.**

| Tool | Sets the guard | Checks the guard | Clears the guard |
| --- | --- | --- | --- |
| `read_document` | yes — `toolDispatcher.ts:652-654` (after a successful read) | yes — `:635` | — |
| `fetch_documents` | yes — `:740-742`, per document | yes — `:723`, per document | — |
| `find_in_document` | **no** | **no** | — |
| `edit_document` | — | — | yes on success — `clearTurnReadsForDocument`, `:1467` |

So `find_in_document` is unlimited and free of the guard, `read_document` and
`fetch_documents` share one guard namespace (a `fetch_documents` read blocks a
later `read_document` of the same version and vice-versa), and only
`edit_document` reopens it.

**Verbatim suppression payload the model sees** —
`duplicateReadDocumentResult`, `documentOps.ts:1374-1392`. For
`read_document` it is the entire tool result; for `fetch_documents` it is
inlined per document under the `--- filename (doc-N) ---` header:

```json
{
  "ok": true,
  "already_read": true,
  "doc_id": "doc-0",
  "filename": "Master Services Agreement.docx",
  "document_id": "…uuid…",
  "version_id": "…uuid…",
  "content": "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.",
  "next_required_action": "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document."
}
```

Note `"ok": true` — the suppression is a *success* result, not an error. The
model is not penalized, just not re-fed.

### 4.3 Provider call parameters at pin

`2266446b:backend/src/lib/llm/claude.ts:130-148`:

```ts
      const stream = anthropic.messages.stream({
        model,
        system: systemPrompt,
        messages: messages as Anthropic.MessageParam[],
        tools: claudeTools.length
          ? (claudeTools as unknown as Tool[])
          : undefined,
        max_tokens: MAX_TOKENS,
        // Claude 4.x models require `thinking.type: "adaptive"` and
        // drive effort via `output_config.effort` rather than a fixed
        // token budget. We only opt in when the caller requested it.
        ...(enableThinking
          ? ({
              thinking: { type: "adaptive" },
              output_config: { effort: "high" },
            } as unknown as Record<string, unknown>)
          : {}),
        // Extended thinking requires temperature to be default (omitted).
      });
```

| Parameter | Value at pin | Citation |
| --- | --- | --- |
| `max_tokens` | `16384` (`const MAX_TOKENS = 16384;`) | `claude.ts:22`, `:137` |
| `temperature` | **omitted entirely** — never sent | `claude.ts:147` (comment), absence at `:130-148` |
| `top_p` / `top_k` | not sent | absence |
| `tool_choice` | **not sent** — provider default (`auto`) | absence |
| `thinking` | `{type: "adaptive"}` | `claude.ts:142` |
| `output_config` | `{effort: "high"}` | `claude.ts:143` |
| `enableThinking` | `true` for chat | `streaming.ts:343` |
| `stream` | yes (`messages.stream`) | `claude.ts:130` |
| default model | `DEFAULT_MAIN_MODEL = "gemini-3-flash-preview"`, overridden per request | `2266446b:backend/src/lib/llm/models.ts:31`; `resolveModel` at `:58-61`; `streaming.ts:332` |

Claude main models allowed at pin: `claude-fable-5`, `claude-opus-4-8`,
`claude-opus-4-7`, `claude-sonnet-4-6` (`models.ts:7-12`).

Transcript shape: messages are `{role, content}` with `content` a string for the
initial turns (`streaming.ts:201-206` flattens everything non-system into
`user`/`assistant` strings), then native content-block arrays for the
assistant/tool_result pairs the loop appends (`claude.ts:249-257`).

### 4.4 How a turn ends naturally

`claude.ts:239-241` — the loop breaks when the model's `stop_reason` is anything
other than `tool_use`, or it emitted no `tool_use` blocks, or no `runTools`
callback was supplied. In the normal case the model stops calling tools, emits
its final prose plus the `<CITATIONS>` block, and the loop exits on the next
`break`.

Post-loop, `runLLMStream` parses `<CITATIONS>` out of the accumulated text
(`streaming.ts:527-538`) and emits a final `citations` SSE frame plus
`data: [DONE]` (`:547-550`). The `<CITATIONS>` block is stripped from the
user-visible stream as it arrives (`streamVisibleContent`, `:255-292`) — the
model's citation JSON never appears in the rendered prose.

### 4.5 `ask_inputs` terminates the turn

`streaming.ts:484-486`:

```ts
        if (askInputsEvents.length > 0) {
          throw new AssistantStreamAskInputsPause();
        }
```

caught at `:509-513` with the comment "Stop this assistant turn here so the
model does not add redundant prose telling the user to answer the picker".
Crucially, `ask_inputs` produces **no `tool_result`**
(`toolDispatcher.ts:620-624` `continue`s without pushing), so the throw happens
before the model could ever see one.

**Benchmark hazard:** in a non-interactive harness there is no user to answer.
If the model calls `ask_inputs`, the run ends immediately with no deliverable.
**Recommendation: keep it native.** It is real upstream behaviour on an
under-specified prompt, and suppressing it would hide a genuine
harness-vs-product difference. Instrument it: record `ask_inputs_terminated` as
a first-class run outcome so the rate is visible rather than silently folded
into "failed".

### 4.6 Other loop-shaping behaviour

- **Per-response read-once is guidance in three places and enforcement in one.**
  Guidance: `prompts.ts:8` (core rule), the `read_document`/`fetch_documents`
  tool descriptions (`toolSchemas.ts:210`, `:16`), and the AVAILABLE DOCUMENTS
  trailer (`contextBuilders.ts:152`). Enforcement: `turnReadState` (§4.2) —
  which does not refuse, it substitutes a short success payload.
- **Tool results are keyed by `tool_call_id`, never by index**
  (`streaming.ts:494-506`), with the "not available" fallback, so a missing
  branch can never desynchronize the transcript.
- **Abort** propagates via `AbortSignal` at `claude.ts:129`, `:205`, `:212`,
  `:244` and `streaming.ts:379`, `:418`.
- **No retry, no backoff, no reflection step** anywhere in the loop.

---

## 5. Gap analysis: our LAB surface vs native

All working-tree line numbers below were read directly and verified for this
document. **Note on line endings:** `backend/src/lib/chat/upstreamMikeBenchmarkSurface.ts`
is stored with **CRLF** terminators. JS/TS template literals normalize `\r\n` →
`\n` at parse time, so the runtime prompt strings are LF — but any tooling that
hashes or diffs the *file bytes* rather than the *runtime string* must normalize
first, or every comparison silently fails. (This bit the first pass of this
analysis; it is the same class of defect as the CRLF span bug that corrupted an
earlier benchmark.)

### 5.1 Headline: our current LAB prompt keeps 30% of the native prompt

`UPSTREAM_MIKE_LAB_SYSTEM_PROMPT`
(`C:\Users\elias\Desktop\MikeOSS Fork\backend\src\lib\chat\upstreamMikeBenchmarkSurface.ts:719-746`)
is **2550 bytes**. The pinned native prompt with research off is **6997 bytes**,
plus **1471 bytes** of `PROJECT_SYSTEM_PROMPT_EXTRA` = **8468 bytes**.

Line-by-line verdict (22 non-blank lines; "NATIVE" = the line appears verbatim
in the pinned text):

| File line | Verdict | Line |
| --- | --- | --- |
| `:719` | NATIVE | `You are Mike, an AI legal assistant…` |
| `:721`–`:723` | NATIVE | `CORE RULES:` / `- Be precise…` / `- Do not fabricate…` |
| `:724` | NATIVE | `- Use at most 10 tool-use rounds per response…` |
| `:725` | NATIVE | `- Read each relevant document/version at most once per response…` |
| `:727`, `:728`, `:730` | NATIVE | `PROJECT CONTEXT:` + its first two paragraphs |
| `:732`–`:738` | NATIVE | `DOCX GENERATION:` + 6 of the 9 native bullets |
| `:740` | NATIVE | `DOCUMENT NAMES IN PROSE:` |
| `:741` | **BEAVER** | `- Document IDs are internal. Use them only in tool arguments.` |
| `:742` | **BEAVER** | `- Refer to documents by filename or a natural description.` |
| `:744` | NATIVE | `GENERAL GUIDANCE:` |
| `:745` | **BEAVER** | `- Cite the exact document passage for evidence-backed claims.` |
| `:746` | NATIVE | `- Do not use emojis.` |

So the brief's premise — "lean guidance clauses at ~712-728 are already
verbatim-native" — is **confirmed for the round-cap and read-once clauses**
(`:712`/`:724` and `:713`/`:725` are byte-identical to
`2266446b:backend/src/lib/chat/prompts.ts:7` and `:8`), and confirmed for the
DOCX and PROJECT CONTEXT blocks. Three lines are Beaver rewrites: `:741`, `:742`
compress the native three-bullet `DOCUMENT NAMES IN PROSE` block, and `:745`
drops "or fetched opinion" from the native `GENERAL GUIDANCE` bullet.

**Whole native blocks absent from our LAB prompt** (verified by substring
search):

| Native block | Pin location | Bytes |
| --- | --- | --- |
| `DOCUMENT CITATIONS:` — the entire citation contract, the `<CITATIONS>` schema, and all 13 citation rules | `prompts.ts:13-45` | ~3400 |
| `DOCUMENT EDITING:` — the renumber/cross-reference discipline | `prompts.ts:57-64` | ~700 |
| `REASONING TRACE SAFETY:` | `prompts.ts:71-74` | ~450 |
| The workflow clause (`[Workflow: <title> (id: <id>)]` → `read_workflow`) | `prompts.ts:10` | ~180 |
| The `ask_inputs` clause | `prompts.ts:11` | ~470 |
| `generate_excel` / `generate_ppt` / `edit_document` DOCX bullets | `prompts.ts:48-50` | ~330 |
| `REPLICATING A DOCUMENT:` | `projectChat.ts:32-33` | ~640 |
| `- If no documents are provided, answer from legal knowledge.` | `prompts.ts:77` | 60 |

The existing arm is therefore a **lean-prompt** arm, not a native-prompt arm.
That is a legitimate experiment, but it is not the baseline the upstream
comparison needs — most consequentially, **our LAB arms have never been given
the native citation contract at all**, so no LAB result to date says anything
about upstream's citation behaviour.

### 5.2 Element-by-element mapping table

| # | Native element (pin) | What our code has now | Exact change needed for `mike_upstream_native_v1` |
| --- | --- | --- | --- |
| 1 | System prompt = `buildSystemPrompt(false)`, 6997 B (`2266446b:prompts.ts:81-87`) | `UPSTREAM_MIKE_LAB_SYSTEM_PROMPT`, 2550 B (`upstreamMikeBenchmarkSurface.ts:719-746`) | **New** const `UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT` carrying the full pinned text minus the strip-list. Do **not** edit the existing const — other arms hash it. |
| 2 | `PROJECT_SYSTEM_PROMPT_EXTRA`, 1471 B (`2266446b:projectChat.ts:27-33`) | Paragraphs 1–2 only, inlined at `upstreamMikeBenchmarkSurface.ts:727-730`; `REPLICATING A DOCUMENT:` absent | Include the full block (Phase 2) / paragraphs 1–2 (Phase 1, when `replicate_document` is absent) as a separate const so the composition is auditable |
| 3 | Inventory block: `\n\n---\nAVAILABLE DOCUMENTS:\n- doc-N: <filename>\n` + read-once trailer + `---\n` (`2266446b:contextBuilders.ts:144-152`) | `chat.ts:1192-1200` — `\n\nAVAILABLE DOCUMENTS:\n- doc-N: <filename> (<file_type>)\n`. **No `---` fences, adds a `(file_type)` suffix the native block never emits, and omits the entire read-once trailer.** Mirrored at `lab-beaver-arm.ts:169-181` (whose comment claims byte-identity with `chat.ts`, which is true of each other but **not** of upstream) | Add a native-shaped inventory builder behind the arm flag in `chat.ts`, and a matching reproducer in `lab-beaver-arm.ts:169-181`, so the preflight sha still matches |
| 4 | Tool set: 12 tools, fixed order (§3.1), sha `8617531e…` | 5 tools — `UPSTREAM_MIKE_LAB_TOOLS` (`upstreamMikeBenchmarkSurface.ts:202-205`): `read_document, find_in_document, list_documents, fetch_documents, generate_docx` | New array `UPSTREAM_NATIVE_MIKE_LAB_TOOLS` in native order (§7 step 2). Phase 1 = 9 tools, sha `ea440d44…`; Phase 2 = 12, sha `8617531e…` |
| 5 | `read_document` = `{doc_id}` only, **no cap** (`2266446b:toolSchemas.ts:205-222`, `documentOps.ts:1567`) | Same schema is already frozen at `upstreamMikeBenchmarkSurface.ts:118-127`. Serving: `localAssistantTools.ts:6210`. The 64k cap `MAX_TOOL_RESULT_CHARS` (`localAssistantTools.ts:5126-5128`) is **already inert** for this path — `upstreamMikeResult` (`:5754-5760`) returns raw content without going through `result()` | **No change to the cap** — verified already bypassed. Set `MIKE_TOOL_RESULT_CAP: ""` in the arm env anyway so the receipt reads 0 and the gate can assert it |
| 6 | `read_document` returns **flat extracted text** with `citationReminder` prefix; DOCX has **no page markers** (`documentOps.ts:1504`, `docxTrackedChanges.ts:719-750`) | Markdown plane when `MIKE_READ_DOCX_MARKDOWN=1` (`localAssistantTools.ts:885-887`, `servedDraftingText` `:5843-5889`); SECT-INDEX prepend when `MIKE_STRUCTURE_INDEX=1` | Arm sets `MIKE_READ_DOCX_MARKDOWN=0` and `MIKE_STRUCTURE_INDEX=0`. Verify the fallback (`extractLocalDocument`, `:6043`) yields the native flat plane; if it inserts page markers or structure, add a native-plane branch |
| 7 | Duplicate-read suppression, per document **version**, `{"ok":true,"already_read":true,…}` (`documentOps.ts:1374-1392`) | `SUPPRESS_DUPLICATE_WHOLE_READS` (`localAssistantTools.ts:937-938`), default ON | Keep ON. Verify the payload matches the native JSON field-for-field (`ok`, `already_read`, `doc_id`, `filename`, `document_id`, `version_id`, `content`, `next_required_action`); align if it differs |
| 8 | `edit_document` clears the read guard on success (`toolDispatcher.ts:1467`) | `turnEditState`/`turnReadState` are already threaded into `runLocalAssistantTools` (`localAssistantTools.ts:6686-6700`) | Wire the new `edit_document` executor to clear the read guard on success, matching native |
| 9 | `generate_docx` renders `sections[]` → OOXML directly (`documentOps.ts:83-582`) | **No direct renderer exists in the tree.** `upstreamMikeSectionsMarkdown` (`localAssistantTools.ts:5778-5818`) converts `sections[]` → Markdown, then `renderMarkdownDocx` → docx. The Python harness has a second, *divergent* bridge (`benchmarks\harvey-labs\harness\mike_workbench.py:179-214`) that emits `\newpage` where the TS one emits `---` | See §6 D6. Either accept the bridge as a declared deviation, or port `generateDocx` (`2266446b:documentOps.ts:83-582`) as a self-contained arm-only renderer. **Recommended: port it** — the renderer is where upstream's numbering/heading/signature discipline actually lives, and grading the DOCX through a different renderer measures our renderer, not upstream's |
| 10 | `generate_docx` reply strips `download_url`/`storage_path`, mints a `doc-N` for the generated file, and appends the 4-sentence `next_required_action` (`toolDispatcher.ts:560-577`) | `localAssistantTools.ts:6966-7005` — different envelope; generated docs are not necessarily re-readable under a fresh `doc-N` | Reproduce the native envelope exactly, including registering the new `doc-N` so the mandated read-back works |
| 11 | 10-round cap, hard stop, no injected text (`streaming.ts:341` → `claude.ts:116`,`:128`) | **Unbounded.** `claudeP.ts:472` `const maxIter = params.maxIterations;` with `:502` `for (let iter = 0; maxIter === undefined \|\| iter < maxIter; iter++)`, and `chat.ts` never passes `maxIterations` | Pass `maxIterations: 10` from the chat route **for this arm only**. Must be a consumers-only change gated on the arm flag — every other arm stays unbounded and byte-identical |
| 12 | Turn ends when the model stops calling tools (`claude.ts:239-241`) | Same (`claudeP.ts:709`) **plus** the terminal-authoring exit (`chat.ts:2718-2732` → `claudeP.ts:716`), on for every LAB arm except `upstream` | Arm sets `MIKE_TERMINAL_AUTHORING: "0"`. Native has no such exit |
| 13 | Provider params: `max_tokens: 16384`, no `temperature`, no `tool_choice`, `thinking: adaptive` + `effort: high` (`claude.ts:22`,`:130-148`) | `claude -p` CLI transport — no `max_tokens`/`temperature`/`tool_choice` exist on this lane; `--effort` from `params.reasoningEffort` (`claudeP.ts:168`) | Unavoidable (§6 D1). Set `--effort max` to approximate `effort: "high"`; record the mapping in the receipt |
| 14 | `ask_inputs` aborts the turn with no tool result (`streaming.ts:484-486`) | `ASK_INPUTS_DISABLED` via `MIKE_DISABLE_ASK_INPUTS=1` (`localAssistantTools.ts:861-862`), with a parity note | Set `MIKE_DISABLE_ASK_INPUTS: "0"` and implement the native abort. Record `ask_inputs_terminated` as an outcome (§4.5) |
| 15 | Leak guard equivalent: none upstream | `chat.ts:1141-1184` — hardcodes the 5-tool expected list at `:1154-1160`, and rejects any prompt containing `Grep`/`Glob`/`Beaver`/`library_`/… | **Must be extended** or the arm throws on startup. Add a third branch with the native tool list. The native prompt contains none of the forbidden Beaver terms, so the text guard passes unchanged — verify, don't assume |
| 16 | — | `chat.ts:1102-1125` prompt ternary | Add one branch for the arm flag. Note the guard at `:1141` runs **before** the inventory append at `:1192`, so inventory text is never leak-scanned |
| 17 | — | `chat.ts:2511-2610` `benchmark_surface` receipt | Add `upstream_native_shape: boolean` (and `max_iterations`) or the conformance gate cannot assert the arm |
| 18 | — | `lab-beaver-arm.ts:106-164` `armExpectedSurface` | Add a branch. **Required** — `--preflight-only` refuses arms it does not know (`:1156-1158`), and the prompt-sha gate no-ops when it returns `null` |
| 19 | — | `lab-beaver-arm.ts:1416-1936` conformance gates. The prompt-sha gate (`:1570-1580`) currently guards **only the 5 markdown arms** | Add a gate block for the new arm **including a prompt-sha check** modelled on `:1570-1580`. This is the receipt that proves the other arms are byte-identical |
| 20 | — | `lab-beaver-arm.ts:1907-1936` docx-only deliverable gate | Add the arm to the list at `:1908-1923`. Native `generate_excel`/`generate_ppt` would violate it — a second reason to stage them into Phase 2 |
| 21 | — | `lab-beaver-arm.ts:1044-1067` `harnessSourceFiles` | Add any new source file so the run fingerprint binds it |
| 22 | Sealed corpus | `benchmarks/harvey-labs/tasks/` = open tier only; sealed 997 is off-machine (`benchmarks\harvey-labs\PROVENANCE.md:7-12`) | No change; exposure recorded as usual |

### 5.3 Where `sections[]` still lives today (port sources)

- **Frozen native schema:** `upstreamMikeBenchmarkSurface.ts:129-200`
  (`UPSTREAM_MIKE_GENERATE_DOCX_TOOL`) — byte-compatible with
  `2266446b:toolSchemas.ts:256-327`. Reuse it directly; do not re-type it.
- **TS `sections[]` → Markdown bridge:** `localAssistantTools.ts:5778-5818`,
  selected by the ternary at `:6972-6980`.
- **Python `sections[]` → Markdown bridge:** `benchmarks\harvey-labs\harness\mike_workbench.py:179-214`,
  called at `:550-556`, rendered by Pandoc at `:622-633`.
  **The two bridges disagree on `pageBreak`** (`---` vs `\newpage`) — a live
  confound if TS-terminal and Python-harness runs are ever compared.
- **The native OOXML renderer to port from:** `2266446b:backend/src/lib/chat/tools/documentOps.ts:83-582`.
- Other live carriers of the `sections[]` schema:
  `upstreamMikeBenchmarkSurface.ts:202-205`, `:453-461` (`ADAPTIVE_…` spreads the
  native tool), `:463-469`, `:664`, and the selector at
  `localAssistantTools.ts:1928-1944`.

### 5.4 Siloed-experiment hygiene for this arm

- **One env flag:** `MIKE_UPSTREAM_NATIVE=1`. It selects the prompt, the tool
  array, the leak-guard branch, the inventory shape, and `maxIterations=10`.
  Every one of those is a *consumer*; no detector, extractor, or shared parsing
  module is touched.
- **Do not reuse `MIKE_TOOL_SHAPE`.** Adding a value there would force edits to
  the `ORIGIN_MIKE_TOOL_SHAPE` disjunction
  (`localAssistantTools.ts:948-955`) and the `ORIGIN_MIKE_ACTIVE_TOOLS` ternary
  (`:1928-1944`), both read by every other arm. A separate boolean flag keeps the
  blast radius to added branches only. `ORIGIN_MIKE_TOOL_SHAPE` must still become
  true for the arm (it gates the leak guard and the inventory append), so add
  `UPSTREAM_NATIVE_MIKE_SHAPE` as one more disjunct at `:948-955` — an added
  term that is `false` under every existing arm's env, so every existing arm is
  provably unaffected.
- **Unique non-colliding markers:** `UPSTREAM_NATIVE_DELTA =
  "upstream-native-full-surface-v1"`; receipt key `upstream_native_shape`;
  arm key `mike_upstream_native_v1`. None collide with the tags at
  `upstreamMikeBenchmarkSurface.ts:353-366`, `:402-407`, `:471-480`, `:855-856`.
- **Byte-identity proof for all other arms:** the prompt-sha conformance gate.
  Because the arm adds only *new* constants and *new* ternary branches, every
  existing arm's `system_prompt_sha256` and `tool_schema_sha256` must be
  unchanged. Run `--preflight-only` for each registered arm before and after the
  change and diff the JSON — that diff **is** the receipt (§7 step 10).

---

## 6. Unavoidable-deviations ledger

Every item is forced by the LAB context, not chosen for convenience. An upstream
reviewer should be able to read this list and agree the comparison is fair.

| # | Deviation | Why it is forced | Expected effect on the comparison |
| --- | --- | --- | --- |
| **D1** | Provider lane is `claude -p` (`backend\src\lib\llm\claudeP.ts`), not upstream's Anthropic SDK loop (`2266446b:backend/src/lib/llm/claude.ts`) | Flat-rate only; no per-token API spend is permitted for LAB runs. The `backend/.env` Anthropic key is a stub | `max_tokens`, `temperature`, and `tool_choice` cannot be set on this transport. Upstream sends `max_tokens: 16384`, omits `temperature`, and omits `tool_choice`; two of three therefore match by construction (omission), and the third (`max_tokens`) is a CLI-side default we cannot pin. Reasoning effort is approximated by `--effort max` ≈ `output_config.effort: "high"` |
| **D2** | Round cap must be re-implemented (`maxIterations: 10` passed from the route) rather than inherited | Our chat route never sets `maxIterations`, so `claudeP.ts:502` runs unbounded. Without the explicit pass-through the arm would silently be an *uncapped* arm | None if implemented — the semantics (10 provider calls, batch = 1 round, hard stop with no injected message) are reproduced exactly. This deviation is *the absence of a default*, and correcting it restores fidelity |
| **D3** | ~~Document-inventory prompt injection~~ — **not a deviation** | Upstream injects `AVAILABLE DOCUMENTS` into the system prompt natively (`2266446b:contextBuilders.ts:143-153`) | The brief listed this as a deviation. It is not. What *is* a deviation is our current block's **shape** (`chat.ts:1192-1200`: no `---` fences, extra `(file_type)`, missing read-once trailer) — and §7 fixes that, converting a real deviation into none |
| **D4** | Deliverable capture by the harness (native `generate_docx` call → file in `results/<run>/output/`) instead of upstream's Supabase persistence + signed download URL | LAB has no Supabase, no storage bucket, no download-token service. `2266446b:documentOps.ts:526-568` writes three DB rows per generated document | Behavioural surface is preserved: the tool still returns the native envelope minus `download_url`/`storage_path` — which upstream **already strips** before the model sees it (`toolDispatcher.ts:560`). The model therefore sees an identical payload; only the bytes' destination differs |
| **D5** | CourtListener research ladder and its 4 tools are absent, and the `US CASE LAW RESEARCH:` prompt block is removed | LAB is offline; the tools require live CourtListener API access | **Minimal.** Upstream ships a first-class switch for exactly this (`buildSystemPrompt(false)` + `includeResearchTools: false`), so the arm reproduces the real configuration of any upstream user with `legal_research_us = false`. Note the dangling `"or fetched opinion"` reference at `prompts.ts:76` is *kept*, because upstream keeps it |
| **D6** | `generate_docx` deliverable is rendered by a `sections[]` → Markdown → DOCX bridge (`localAssistantTools.ts:5778-5818` + `renderMarkdownDocx`) rather than upstream's direct `sections[]` → OOXML renderer | No direct renderer exists in our tree today | **Material, and it should be closed.** Upstream's numbering scheme, title-heading suppression, signature-block detection, and manual-marker inference (§3.5.1) all live in that renderer; grading through ours measures ours. Recommended: port `2266446b:documentOps.ts:83-582` as an arm-only module (§7 step 6). Until then this must be declared on every result |
| **D7** | No untrusted-content nonce fencing | The mechanism does not exist at the pin (§1.3); it is a post-pin `origin/main` addition | None at this pin. Becomes a real element if we ever re-pin forward |
| **D8** | Single-turn runs (`lab-beaver-arm.ts:1306-1312`, `turn_count: 1`) | The LAB driver issues one `POST /chat` per task | Upstream's per-turn scoping (`turnReadState`, `turnEditState`, the ≤10 cap) is all **within**-turn, so single-turn measurement exercises the whole mechanism. `enrichWithPriorEvents` and the cross-turn "you do NOT retain document content" rule are simply never exercised |
| **D9** | `list_documents` / `fetch_documents` / `replicate_document` come from the **project**-chat composition, not general chat | The general composition is internally inconsistent — its prompt instructs the model to use `fetch_documents`, which that route does not expose (§2.8.1) | Documented choice, not an accident. Both compositions' hashes are pinned (§3.9) so either is reproducible |
| **D10** | Phase 1 omits `generate_excel`, `generate_ppt`, `replicate_document` and their prompt clauses | No executors exist on our serving side, and the LAB deliverable gate (`lab-beaver-arm.ts:1929`) requires all deliverables be `.docx`, so they could never be exercised in the current task matrix | Small: three tools the current tasks cannot reward. Phase 2 ports the pinned implementations (`2266446b:documentOps.ts:1030`, `:1056`) and restores full 12-tool fidelity, re-pinning the sha to `8617531e…` |
| **D11** | The Anthropic model is `claude-sonnet-4-6` via `claude-p`, whereas upstream's default is `gemini-3-flash-preview` (`2266446b:models.ts:31`) | Flat-rate lane; also the arm must hold the model constant against our other LAB arms | Model is held constant *across arms*, which is the comparison that matters. Upstream's default model is a product choice, not a surface property; `claude-sonnet-4-6` is in upstream's own allowed set (`models.ts:11`) |
| **D12** | `ask_inputs` can terminate a run with no deliverable | Native behaviour with no user present | Kept deliberately (§4.5). Instrumented as `ask_inputs_terminated` rather than suppressed, so the rate is reported rather than hidden |

---

## 7. Ordered implementation plan

Ten steps, each independently verifiable before the next. All line anchors are
in the **current working tree**. Nothing in this plan edits a detector, an
extractor, or any shared parsing module — every touch is a consumer, and every
touch is an *added branch* guarded by `MIKE_UPSTREAM_NATIVE`.

**Before starting:** capture the baseline receipt (§7 step 10 compares against
it).

```
for arm in upstream upstream_terminal_v1 mike_markdown_swap_v1 mike_markdown_e2e_v1 \
           mike_markdown_e2e_index_v1 mike_markdown_e2e_floor_v1 \
           mike_markdown_e2e_index_floor_v1 mike_compact_author_v1 \
           lean_batch_v1 lean_batch_hardrefs_v1 mike_grep_v1 \
           mike_structure_paths_v1 grounded_structure_v1 grounded_structure_outline_v1; do
  npx tsx backend/scripts/lab-beaver-arm.ts --arm "$arm" --task <t> --preflight-only \
    > /tmp/preflight-before-$arm.json
done
```

---

### Step 1 — Pin the native prompt constants
**File:** `backend\src\lib\chat\upstreamMikeBenchmarkSurface.ts` (append after
`:746`; do **not** modify `:719-746`).

Add, as template literals carrying the §2.2/§2.3/§2.5 text verbatim:

- `UPSTREAM_NATIVE_MIKE_BASE_PROMPT` — `SYSTEM_PROMPT_BEFORE_RESEARCH` +
  `"\n\n"` + `SYSTEM_PROMPT_AFTER_RESEARCH`, **minus** the `generate_excel` and
  `generate_ppt` bullets (Phase 1).
- `UPSTREAM_NATIVE_MIKE_PROJECT_EXTRA` — `PROJECT_SYSTEM_PROMPT_EXTRA`
  paragraphs 1–2 (Phase 1; `REPLICATING A DOCUMENT:` omitted with
  `replicate_document`).
- `UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT` =
  `` `${BASE}\n\n${PROJECT_EXTRA}` ``.
- `UPSTREAM_NATIVE_DELTA = "upstream-native-full-surface-v1"`.

**Verify:** a throwaway node script hashes the runtime string (normalize CRLF
first — §5 preamble) and reproduces:

| Const | Bytes | sha256 |
| --- | --- | --- |
| Phase-1 base | 6770 | `39355be587e6d44dd35a65b5ceda2968d44a07d69886020a31b7d609f46e3228` |
| Phase-1 project extra | 827 | `3a8da67b3fb25227249882955c3540e949ca7ce85ab933bce5c151b74df62d94` |
| Phase-2 base (full, no strip beyond CourtListener) | 6997 | `461e218471918ddce08d5630847ac80aaf59049a5cf7729e6728848c28a6eb49` |
| Phase-2 project extra | 1471 | `00642ff87f0ca95a8671150ba8b9a6a0a049b9c8783bc1fb8b22787d9a89c88f` |

A mismatch means a transcription error — fix before proceeding.

---

### Step 2 — Pin the native tool array
**File:** same, after step 1's constants.

Reuse `UPSTREAM_MIKE_GENERATE_DOCX_TOOL` (`:129-200`) unchanged, and add the
schemas absent from our tree (`ask_inputs`, `edit_document`, `list_workflows`,
`read_workflow`) verbatim from §3.6/§3.8/`2266446b:toolSchemas.ts`. Then:

```ts
export const UPSTREAM_NATIVE_MIKE_LAB_TOOLS: OpenAIToolSchema[] = [
  ASK_INPUTS_TOOL,        // native TOOLS order
  READ_DOCUMENT_TOOL,
  FIND_IN_DOCUMENT_TOOL,
  UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
  EDIT_DOCUMENT_TOOL,
  LIST_WORKFLOWS_TOOL,    // WORKFLOW_TOOLS
  READ_WORKFLOW_TOOL,
  LIST_DOCUMENTS_TOOL,    // PROJECT_EXTRA_TOOLS
  FETCH_DOCUMENTS_TOOL,
];
```

Order is load-bearing — the same reason recorded at `:116-117` and `:342-343`.

**Verify:** `sha256(JSON.stringify(UPSTREAM_NATIVE_MIKE_LAB_TOOLS))` ===
`ea440d44c5be6e55ceb3a453252994406c554c9a65295043ea6199d5d13116a4`.

---

### Step 3 — Introduce the single flag and wire tool selection
**File:** `backend\src\lib\chat\localAssistantTools.ts`.

- After `:946`, add
  `export const UPSTREAM_NATIVE_MIKE_SHAPE = process.env.MIKE_UPSTREAM_NATIVE === "1";`
- `:948-955` — append `|| UPSTREAM_NATIVE_MIKE_SHAPE` to the
  `ORIGIN_MIKE_TOOL_SHAPE` disjunction (needed so the leak guard and inventory
  append fire).
- `:1928-1944` — add the **outermost** branch of `ORIGIN_MIKE_ACTIVE_TOOLS`:
  `UPSTREAM_NATIVE_MIKE_SHAPE ? UPSTREAM_NATIVE_MIKE_LAB_TOOLS : <existing>`.

**Verify:** with the flag unset, `node -e` importing the module reports the same
`ORIGIN_MIKE_ACTIVE_TOOLS` names as before for each existing `MIKE_TOOL_SHAPE`
value. With `MIKE_UPSTREAM_NATIVE=1`, it reports the 9 native names in order.

---

### Step 4 — Route wiring: prompt, leak guard, inventory
**File:** `backend\src\routes\chat.ts`.

1. **Prompt ternary `:1102-1125`** — add the outermost branch:
   `UPSTREAM_NATIVE_MIKE_SHAPE ? UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT : <existing chain>`.
2. **Leak guard `:1142-1160`** — add a first branch to `expected`:
   ```ts
   const expected = UPSTREAM_NATIVE_MIKE_SHAPE
     ? ["ask_inputs","read_document","find_in_document","generate_docx",
        "edit_document","list_workflows","read_workflow",
        "list_documents","fetch_documents"]
     : LEAN_BATCH_FAMILY_TOOL_SHAPE ? … ;
   ```
   Leave the term list at `:1170-1180` untouched — the native prompt contains
   none of those strings. **Verify this, don't assume:** grep the assembled
   native prompt for `Beaver`, `library_`, `describe_tools`, `mike-evidence`,
   `library evidence`, `progressive disclosure`, `Glob`, `Grep`. (It does not
   contain them; the check is one command and it is the guard's whole point.)
3. **Inventory `:1192-1200`** — branch on the flag to emit the **native** block:
   ```ts
   systemPrompt += UPSTREAM_NATIVE_MIKE_SHAPE
     ? "\n\n---\nAVAILABLE DOCUMENTS:\n" +
       documents.map((d,i) => `- doc-${i}: ${d.filename}`).join("\n") + "\n" +
       "\nYou do NOT retain document content between conversation turns. …\n---\n"
     : <existing block>;
   ```
   Trailer text verbatim from `2266446b:contextBuilders.ts:152` (§2.6).
4. **Receipt `:2521-2537`** — add `upstream_native_shape: UPSTREAM_NATIVE_MIKE_SHAPE`
   and `max_iterations: UPSTREAM_NATIVE_MIKE_SHAPE ? 10 : null`.

**Verify:** boot the server with the flag and capture the `benchmark_surface`
receipt; `system_prompt_sha256` must equal the sha of
`UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT + nativeInventoryFor(docs)` computed
offline.

---

### Step 5 — Enforce `maxIterations = 10`
**File:** `backend\src\routes\chat.ts`, at the `streamChatWithTools`/provider
call site; **not** in `claudeP.ts`.

Pass `maxIterations: UPSTREAM_NATIVE_MIKE_SHAPE ? 10 : undefined`.
`claudeP.ts:502` already implements the exact native semantics
(`for (let iter = 0; maxIter === undefined || iter < maxIter; iter++)`), and
`:709`/`:716` provide the natural break — so **no change to `claudeP.ts` is
needed or wanted**. Every other arm keeps `undefined` → unbounded → byte-identical.

Also set `MIKE_TERMINAL_AUTHORING: "0"` in the arm env (step 8) so the
`chat.ts:2718-2732` terminal exit never fires — native has no such exit.

**Verify:** run one task with a deliberately tool-hungry prompt and confirm the
receipt shows exactly 10 `context_rounds`, that the run ends with no final
assistant message, and that a round-10 `generate_docx` still produces the file
(the native behaviour documented in §4.1).

---

### Step 6 — Port the native `sections[]` → OOXML renderer (closes D6)
**New file:** `backend\src\lib\chat\upstreamNativeDocxRenderer.ts`, a
self-contained port of `2266446b:backend/src/lib/chat/tools/documentOps.ts:83-582`
with the Supabase/storage tail (`:505-578`) replaced by "return the buffer".

Call it from `localAssistantTools.ts:6972-6980` under a new outermost branch:
`UPSTREAM_NATIVE_MIKE_SHAPE ? renderUpstreamNativeDocx(args.title, args.sections, {landscape: args.landscape}) : <existing ternary>`.

**Verify (differential oracle):** feed the fixture from
`benchmarks\harvey-labs\tests\test_mike_workbench.py:254-269` plus a
signature-block/table/`pageBreak` fixture through both the new renderer and the
existing Markdown bridge, and diff the extracted text + numbering. Differences
are expected — record them; they are the size of D6 and the justification for
this step.

---

### Step 7 — Native tool-result envelopes
**File:** `backend\src\lib\chat\localAssistantTools.ts`.

Under the flag, make each executor return the pinned serialization:

| Tool | Serving line today | Target (§ reference) |
| --- | --- | --- |
| `read_document` | `:6210` | `citationReminder + "\n\n" + text` (§3.2) |
| `fetch_documents` | `:6438` | `--- <file> (<doc-N>) ---\n<reminder>\n\n<text>` joined by `\n\n` (§3.3) |
| `find_in_document` | `:6579` | `{ok,filename,query,total_matches,returned,truncated,hits[{index,excerpt,context}]}` (§3.4) |
| `list_documents` | `:6141` | `[{doc_id,filename,file_type}]` (§3.7) |
| `generate_docx` | `:6966-7005` | strip `download_url`/`storage_path`, mint `doc-N`, append the 4-sentence `next_required_action` (§3.5.2) |
| `edit_document` | new; adapt `library_revise_docx` (`:7107`, schema shares `edits` at `:803-838`) | `{ok,doc_id,document_id,version_id,version_number,applied,errors,next_required_action}` and clear the read guard (§3.6) |
| duplicate read | `:937-938` | `{ok:true,already_read:true,…}` (§4.2) |
| `ask_inputs` | `:861-862`, `LOCAL_ASK_INPUTS_TOOLS` `:843` | no tool result; abort the turn; record `ask_inputs_terminated` (§4.5) |

Also confirm `MIKE_READ_DOCX_MARKDOWN=0` yields the native flat plane (no page
markers for DOCX) — `servedDraftingText` (`:5843-5889`) returns `null` when the
flag is off, so the fallback at `:6043` is what serves; inspect one real result.

**Verify:** one run per tool, diffing the captured tool-result strings against
the shapes in §3.

---

### Step 8 — Register the arm
**File:** `backend\scripts\lab-beaver-arm.ts`.

1. `armExpectedSurface` `:109-163` — add the first branch:
   ```ts
   arm === "mike_upstream_native_v1"
     ? { systemPrompt: UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT,
         tools: UPSTREAM_NATIVE_MIKE_LAB_TOOLS }
     : …
   ```
2. `inventoryPromptFor` `:169-181` — branch on the arm to reproduce the **native**
   block byte-for-byte (fences, no `(file_type)`, read-once trailer). Update the
   comment at `:166-168`, which currently claims byte-identity with upstream.
3. `armEnvironment` `:500` — add:
   ```ts
   mike_upstream_native_v1: {
     MIKE_UPSTREAM_NATIVE: "1",
     MIKE_NAV_SHAPE: "legacy",
     MIKE_TOOL_SHAPE: "",
     MIKE_RETRIEVAL_EXPERIMENT: "",
     MIKE_PROGRESSIVE_DISCLOSURE: "0",
     MIKE_TERMINAL_AUTHORING: "0",
     MIKE_READ_DOCX_MARKDOWN: "0",
     MIKE_STRUCTURE_INDEX: "0",
     MIKE_COMPLETENESS_FLOOR: "0",
     MIKE_DISABLE_ASK_INPUTS: "0",
     MIKE_TOOL_RESULT_CAP: "",
   },
   ```
   Model: `--model claude-p:claude-sonnet-4-6`, `--effort max`.
4. `:941` — extend the unknown-arm error text.
5. `:1044-1067` `harnessSourceFiles` — add
   `backend/src/lib/chat/upstreamNativeDocxRenderer.ts`.
6. `:2714+` / `:3235-3280` — add `upstream_native_delta` to `config.json` and
   `beaver-receipts.json`.

**Verify:** `--preflight-only` prints
`system_prompt_sha256` matching the offline hash and `tool_schema_sha256`
matching the Responses-encoded 9-tool array, with
`tool_names` in native order.

---

### Step 9 — Conformance gate
**File:** `backend\scripts\lab-beaver-arm.ts`, new block modelled on `:1416-1456`
and **including** the prompt-sha check from `:1570-1580` (which today guards only
the markdown arms — that omission is exactly the miswiring class the comment at
`:1566-1569` describes).

Assert: `upstream_native_shape === true`; every other shape flag `false`
(`upstream_mike_shape`, `adaptive_mike_shape`, markdown/index/floor, grep family,
lean batch); `progressive_disclosure === false`; `trajectory_mode ===
"continuous"`; `context_handoff === false`; `continuous_evidence === false`;
`sla_workflow === false`; `greenfield_review === false`;
`model_coverage_routing === false`; `whole_read_max_chars === 0`;
`suppress_duplicate_whole_reads === true`; **`terminal_authoring === false`**;
**`max_iterations === 10`**; `resident_tools` deep-equals the 9-name array in
order; `deferred_tools.length === 0`; and `system_prompt_sha256` equals the
recomputed expected hash.

Add `mike_upstream_native_v1` to the deliverable-matrix list at `:1908-1923`.

**Verify:** deliberately break one env value (e.g. `MIKE_TERMINAL_AUTHORING: "1"`)
and confirm the gate throws. Restore.

---

### Step 10 — Prove every other arm is byte-identical
Re-run the baseline preflight sweep from the top of §7 and diff:

```
for arm in <the 14 arms>; do
  npx tsx backend/scripts/lab-beaver-arm.ts --arm "$arm" --task <t> --preflight-only \
    > /tmp/preflight-after-$arm.json
  diff /tmp/preflight-before-$arm.json /tmp/preflight-after-$arm.json || echo "DRIFT: $arm"
done
```

Zero diffs is the receipt that the arm is siloed. Any drift means a shared
constant was mutated instead of a new one added — go back to step 1.

Then run one pilot task end-to-end on `mike_upstream_native_v1` with
`--model claude-p:claude-sonnet-4-6`, and record in the run notes: round count,
whether the 10-round cap was hit, `ask_inputs_terminated`, deliverable bytes, and
the D6 renderer status.

---

### Phase 2 (fidelity completion, after the arm is measuring)

11. Port `generateExcel` (`2266446b:documentOps.ts:1030` + `buildXlsxWorkbook`
    `:630-750`) and `generatePpt` (`:1056` + `buildPptxPresentation` `:772-935`),
    and add `replicate_document` (byte copy).
12. Restore the three stripped prompt clauses (`prompts.ts:48-49` and the
    `REPLICATING A DOCUMENT:` block), returning the strip-list to **one** entry.
13. Re-pin: base prompt sha → `461e218471918dd…`, project extra sha →
    `00642ff87f0ca95a…`, tool array sha → `8617531e5a9d966c…`, and relax the
    docx-only deliverable gate for this arm.

At that point the arm is the full pinned native surface minus only the
CourtListener block — the exact configuration an upstream user with
`legal_research_us = false` receives.
