# Beaver Research Overhaul — Product and Interaction Specification

Status: normative product specification for the research-set / Sources / Tabular Review / Chat interoperability work.

This document consolidates the design decisions made during the September 6, 2026 research-overhaul discussion and the behavior subsequently implemented through the research foundation, Sources/Table cleanup, and interoperability PRs. Where implementation and this specification disagree, this specification is the intended product contract unless a later explicit decision supersedes it.

---

## 1. Product goal

Beaver research should behave like one portable body of legal research viewed through several working surfaces, not several parallel products that happen to share documents.

A user should be able to:

1. explore and synthesize in **Chat**;
2. curate and organize in **Sources**;
3. compare systematically in **Tabular Review**;
4. draft in **Memo**;
5. move among those surfaces without discarding the intellectual work already completed.

The central principle is:

> **One set of research objects; several ways of working with them.**

Interoperability is successful when work performed in one surface materially reduces work required in another. Merely transferring document IDs into a blank table is not sufficient.

---

## 2. YAGNI / scope guard

The research system must stay deliberately small.

Do **not** introduce:

- a generalized ontology service;
- a graph database;
- a second research store;
- global Library research labels;
- a primary or canonical research workspace attached to a Library file or folder;
- separate pen/category concepts;
- colour inheritance or per-highlight colour overrides;
- an `Unsorted`, `Unclassified`, or equivalent synthetic classification;
- automatic synchronization that silently rewrites tables when research labels later change;
- automatic promotion of model reads into curated highlights;
- a special Organize mode that duplicates ordinary label operations;
- parallel representations of the same evidence merely because it appears in Sources, Chat, Table, and Memo.

The system should prefer existing source, evidence, research-file, table, chat, selection, history, and proposal primitives.

---

## 3. Core data model

A research set contains:

```text
Research Set
├─ Sources
│  └─ Source labels
├─ Saved highlights
│  └─ Highlight types
├─ Grounded findings / outputs
├─ Read + query history
└─ Memo / notes
```

### 3.1 Source

A source is a case, statute, article, Library document, or other research item referenced by stable source identity and, where applicable, a pinned version.

A source can have zero, one, or many source labels.

### 3.2 Source label

A source label classifies the source **as a whole** relative to the research question.

A label has:

- stable ID;
- name;
- optional parent;
- ordering;
- optional presentation colour if the existing primitive requires it.

Source labels are research-set-local. They do not alter the Library object's global representation.

### 3.3 Highlight

A highlight is an **intentionally saved passage**.

It has:

- stable evidence ID;
- source identity;
- exact quote / evidence receipt;
- locator;
- one highlight type;
- optional note if supported by the existing research primitive.

A highlight is not equivalent to a read receipt and is not created merely because the model cited or encountered the passage.

### 3.4 Highlight type

A highlight type is one object:

```text
Highlight type = name + colour + optional parent
```

The type **is the pen** and **is the passage category**. There is no independent colour decision.

Examples:

```text
● Test
   ● Statement
   ● Element 1
   ● Element 2

● Application
   ● Supports
   ● Distinguishes

● Useful language
```

A user may also keep the scheme extremely simple:

```text
● Highlight
```

or:

```text
● Rule
● Application
● Useful
```

### 3.5 Read receipt

A read means a passage or source was encountered by a human/model research operation.

Reads are retained because they are useful for:

- continuation;
- retrieval context;
- deduplication;
- provenance;
- understanding what has already been checked.

A read is **not** a highlight.

### 3.6 Grounded support / finding

Grounded support records evidence actually used to support a generated answer, table cell, or other output.

The distinction is:

```text
Read              = encountered
Grounded support  = used to justify an answer
Highlight         = intentionally saved research passage
```

Grounded support does not automatically become a coloured highlight.

---

## 4. Library neutrality

The Library is not a research ontology.

A Library file or folder must not have:

- a primary research workspace;
- a canonical research label set;
- research classifications that affect its global appearance;
- a hidden `libraryLabelsId` / ontology workspace or equivalent ownership pointer.

The same Library document may participate in multiple research sets and be classified differently in each:

```text
Library document
   ├─ Injunction research → C › X
   ├─ Charter research    → Not relevant
   └─ Damages research    → Mitigation
```

The only intended Library interaction is explicit placement into a research set, e.g. **Add to research…**. If the user invokes that action while browsing a selected virtual source-label folder, Beaver may offer that folder as the destination context.

That assignment remains local to the selected research set.

---

## 5. Source labels and highlights solve different problems

The two systems must remain semantically independent.

### 5.1 Source labels answer

> “What is this case, broadly, for this research question?”

Example:

```text
B
├─ C
│  ├─ X
│  └─ Y
├─ D
└─ E
```

A case could be classified as `B › C › X`.

### 5.2 Highlights answer

> “Which exact passages are worth preserving, and what kind of passages are they?”

For the same case:

```text
● Test › Element 2
● Application › Supports
● Useful language
```

Those passages need not be evidence for the source's `B › C › X` classification.

A source may therefore have:

- labels but no highlights;
- highlights but no labels;
- both;
- neither.

No special synthetic category is required to explain those states.

### 5.3 Optional support relationship

Where product value justifies it, a passage may be explicitly linked as support for a source classification:

```text
Case: C › X
  ↳ supporting passage e_123
```

This relationship must be explicit. Beaver must not infer it merely because the case has both the label and the highlight.

---

## 6. Sources workspace

The workspace retains Beaver's existing reader-left / dock-right architecture.

The default Sources experience should be quiet and progressively disclosed.

### 6.1 One canonical source list

There is exactly one main source list.

Source labels are folder-like navigation over that list, not containers that render duplicate source lists.

Conceptually:

```text
Workspace: Termination clauses
────────────────────────────────────

Labels
All sources                         18
▾ Integrated scheme                  7
   ▾ Invalid even if unused          4
   Distinguished / valid             3
▸ Saving clause                      5

────────────────────────────────────

Integrated scheme / Invalid even if unused
4 sources

Case A                     2 highlights
Case B                     3 highlights
Case C
Case D                     1 highlight
```

### 6.2 Folder behavior

Source labels should feel like virtual folders:

- click to browse;
- expand/collapse hierarchy;
- drag source onto label to assign;
- drag labels to nest/reorder;
- keyboard alternatives for nesting/reorder;
- parent browse includes descendants;
- a multi-labelled source appears only once in the source list;
- source may retain multiple labels.

### 6.3 All sources

`All sources` is the root.

There is no `Unsorted` or `Unclassified` pseudo-folder.

A source with no labels simply appears under `All sources`.

`No source labels`, `Has highlights`, `No highlights`, or highlight-type constraints may exist as filters, not fake classifications.

### 6.4 Saved passages under sources

Saved highlights stay visibly subordinate to their source:

```text
▾ Case A
  Integrated scheme › Invalid if unused

  ● Rule
    “The termination provisions must be read together...”  ¶42

  ● Application
    “Although the employer never relied on...”             ¶47
```

Clicking the highlight opens the exact source passage.

Avoid permanent paragraph-by-paragraph up/down navigation controls and redundant per-highlight Cite buttons.

### 6.5 Search and filters

Search remains available without becoming a second navigation system.

Filters may include:

- source label;
- no source labels;
- highlight type;
- has / lacks saved highlights;
- source metadata where already supported.

Applying a filter must **intersect** a narrower inherited selection. It must not silently broaden a scope handed off from Chat/Table.

---

## 7. Highlight-type interaction

The ordinary reading workflow must require almost no scheme management.

### 7.1 Active picker

The reader exposes one compact control:

```text
[ Highlight: ● Application › Supports ▾ ]
```

Choosing a type chooses both its meaning and colour.

Selecting a type does **not** filter the source list.

### 7.2 Creating a type

Creating a type asks for essentially one meaningful field:

```text
Name   [ Application ]
Colour [ ● ]   ← sensible muted colour preselected
```

The normal workflow is: type a name, press Enter.

### 7.3 Hierarchy editor

Advanced organization is available on demand:

```text
Highlight types

● Test
   ● Statement
   ● Element 1
   ● Element 2

● Application
   ● Supports
   ● Distinguishes

● Useful language

[ + Highlight type ]
```

Operations:

- inline rename;
- change colour;
- add child;
- drag to nest/reorder;
- keyboard/menu alternative;
- delete.

Deleting a type must not delete the underlying evidence. The implementation may move saved marks to the default `Highlight` type if necessary to preserve the one-type invariant.

No colour inheritance or override logic.

---

## 8. Memo

Memo should feel like a normal writing surface.

Example:

```text
The Court treated the inquiry as contextual and fact-specific.¹

Later cases applied the same approach...

¹ Case A, 2024 ONCA 123 at para 42.
```

Requirements:

- no inline `Cite` chips;
- citations render as ordinary linked text;
- dragging/inserting a highlight may create a normal citation;
- citation retains the exact evidence/source identity underneath;
- renaming/recolouring labels or highlight types does not mutate memo citation text unless the citation itself is edited;
- preserve Markdown/rich-text round trip, autosave, and conflict behavior;
- Memo remains an existing workspace tab, not another always-visible panel.

---

## 9. Tabular Review UI

Tabular Review remains a systematic-comparison surface over the same research objects.

### 9.1 Header

The title gets its own line and room to breathe.

```text
Termination-clause cases
Compare why Ontario courts found provisions valid or invalid.

[▣ Docs]   [Sources]   [Filter]                   [+ Column]
```

Controls should be compact and use a muted palette.

### 9.2 Column headers

Column titles wrap fully. Prompt/format/menu controls appear separately rather than truncating the substantive title.

### 9.3 Remove redundant clutter

Remove / avoid:

- Organize mode;
- duplicate OG Mike `Cited` presentation;
- high-contrast multicoloured toolbar icons;
- overly verbose buttons;
- unbounded inspector contents;
- permanent receipt/debug information in the primary reading flow.

### 9.4 Cell inspector

The hierarchy is:

```text
Answer

Evidence
  Case A · ¶42
  “...”
  [Open]

Explanation

More details ▸
```

The inspector must:

- fit inside the viewport;
- have a real keyboard/mouse scrollable content region;
- keep close/regenerate/document controls fixed outside that scroller;
- keep receipts/query/run/model/debug metadata collapsed under `More details`;
- show actual claim-support evidence by default, not every passage the model read;
- preserve mobile modal behavior, Escape, and focus restoration.

Opening evidence must follow the cited source and pinned version, including cross-source evidence, rather than falling back to the table row's document.

---

## 10. Interoperability: governing rule

> **Share objects and identities directly when possible; transform them only when the user is asking for a different representation.**

Source IDs, evidence IDs, labels, highlight types, grounded findings, and exact receipts are reused across surfaces.

Avoid conversion chains that duplicate the same fact into several unrelated stores.

---

## 11. Sources / Chat → Tabular Review

This is the key interoperability requirement.

### 11.1 Not acceptable

This is not sufficient:

```text
Open in Table
→ blank rows containing eight case names
```

That is transport, not useful interoperability.

### 11.2 Desired flow

Example research question:

> **In Ontario, when will a court hold an employment termination clause unenforceable because some part of the agreement violates the ESA?**

A research set might already contain:

```text
Source labels
─────────────
Integrated scheme
Invalid even if unused
Distinguished / valid

Highlight types
───────────────
● Rule
● Application
● Drafting language
```

The user chooses **Open as Table**.

Beaver should preview a useful review:

```text
Build review from “Termination clauses”

16 sources · 27 saved passages

Describe what you want to compare:
[ Compare why each provision was valid or invalid,
  especially the wording and treatment of for-cause clauses. ]

Existing research can seed:
- source classifications;
- saved passages;
- grounded answers;
- prior research questions.

[ Suggest layout ]   [ Open review ]
```

A resulting schema could be:

```text
Case
Outcome
Reason
Problematic wording
Treatment of for-cause clause
Treatment of earlier cases
```

### 11.3 Reuse rules

Existing work should be reused rather than regenerated:

- source label branches may seed categorical/classification cells;
- saved `Drafting language` passages may seed evidence for a wording column;
- grounded Chat/Table findings may seed answers and supporting receipts;
- unresolved questions remain pending extraction.

Missing classification must not be interpreted as `No`.

A saved passage is evidence, not automatically a model-authored answer.

Conflicting prior findings should remain visibly conflicting rather than being silently collapsed.

### 11.4 Preview before acceptance

The conversion preview is read-only.

It should clearly distinguish:

- reused classification;
- reused saved evidence;
- reused grounded answer;
- pending extraction / unanswered.

The user accepts a reviewed mapping. Acceptance must not invoke the model again.

### 11.5 Freeze accepted review inputs

When the user accepts:

- row membership is frozen;
- reused cell values are copied/snapshotted with their references/receipts;
- later label edits do not silently rewrite the table;
- later highlight deletion/recolouring does not silently rewrite existing copied results.

An explicit refresh/remap is required to bring later research changes into an existing review.

### 11.6 Semantic layout assistance

`Suggest layout` may use the configured LLM to:

- consolidate overlapping concepts;
- propose column names/prompts;
- map existing research items to columns;
- split a grounded answer into claim-level cells where exact claim references exist.

The adapter must reject:

- invented item IDs;
- cross-row assignments unsupported by the original finding;
- fabricated scalar values;
- overlapping whole-answer and claim mappings that duplicate the same fact;
- unsupported evidence.

---

## 12. Chat → Sources

Chat is exploratory. Converting Chat into Sources should preserve the deliberate research product, not every incidental operation.

Example:

```text
Chat searched: 31 cases
Chat read:     74 passages
Grounded answer actually used:
  4 cases
  6 passages
```

`Open as → Sources` should carry over materially used sources / grounded passages, not 31 sources plus 74 fake highlights.

Beaver may optionally propose organization based on the answer:

```text
Suggested source labels
  Integrated scheme
  Invalid even if unused
  Distinguished / valid

Suggested highlight types
  ● Rule
  ● Application
  ● Distinguishing language
```

The sources/evidence are deterministic. The proposed organization is semantic assistance and requires user acceptance.

Ordinary read receipts remain background history.

---

## 13. Sources → Chat

Chat should inherit the active research scope.

Examples:

```text
C › X
8 sources
```

Opening Chat means those eight sources are the context.

Or:

```text
● Test › Element 2
14 saved highlights
```

Opening Chat means those exact highlights are the context.

The user should not need to restate “these cases” or “these passages.”

Narrow inherited scope must be preserved when later filters are applied.

---

## 14. Chat → Tabular Review

A long grounded conversation should become a structured review without rerunning the research from scratch.

Example:

```text
Chat research contains:
9 materially used cases
17 grounded passages
3 substantive patterns

Suggested review:
Outcome
Saving-clause treatment
Reason
Key wording

Existing findings can seed 24 cells.
```

The review conversion should preserve original answers and receipts where reusable.

Do not make a blank table of every document the model read.

---

## 15. Tabular Review → Sources

Tabular Review can enrich the research set.

### 15.1 Column → source labels

A categorical column such as:

```text
Saving-clause treatment
No effect
Effective
Not considered
```

may offer:

```text
Create source labels from this column
```

and propose:

```text
Saving clause
├─ No effect
├─ Effective
└─ Not considered
```

Exact categorical mappings are deterministic.

Messy free text should offer semantic organization rather than creating dozens of junk labels.

### 15.2 Cell evidence → highlight

A grounded cell may offer:

```text
Save evidence as highlight → ● Drafting language
```

Only the actual supporting passages are saved, with their original evidence IDs.

Do not save unrelated read receipts or the row source's entire context.

---

## 16. Tabular Review → Chat

A selected cell/column/row scope may be discussed in Chat.

Chat receives:

- selected completed result references;
- underlying support receipts;
- selected row scope;
- relevant source identity/version.

It does not receive only a flattened prose rendering of the table.

`All columns` means all columns **within the chosen rows/table scope**, not every finding in the workspace.

---

## 17. Deterministic vs model-assisted operations

Use deterministic operations when the mapping is exact:

```text
selected source label → source filter
selected highlights   → evidence scope
categorical value      → source label proposal
saved evidence         → table evidence
accepted preview       → frozen table snapshot
```

Use LLM assistance when semantic judgment is genuinely required:

```text
merge messy labels
reorganize a hierarchy
turn free-text values into useful categories
rewrite column prompts
propose a comparison schema
map ambiguous findings to a new structure
```

Assistant proposals should be reversible and reviewable where they change research organization.

There is no generalized ontology editor.

---

## 18. Proposal behavior

Semantic restructuring should look like ordinary product operations proposed in a batch.

Example:

```text
Proposed source labels

Relevance
├─ Directly applicable
└─ Analogous

Reason
├─ Evidentiary failure
└─ Legal threshold

[ Accept changes ]   [ Keep existing ]
```

Or:

```text
Proposed highlight types

● Test
   ● Statement
   ● Element 1
   ● Element 2

● Application
   ● Supports
   ● Distinguishes

18 highlights will move

[ Accept ]
```

The assistant should call the same underlying research operations as the human UI.

---

## 19. Evidence and identity invariants

The following must survive round trips:

- source ID;
- source/provider identity;
- Library document version where applicable;
- evidence ID;
- exact receipt / quote / locator;
- grounded finding reference;
- table cell evidence relationship;
- memo citation evidence relationship.

Renaming a label or highlight type must not rewrite evidence identity.

Changing a highlight colour must not rewrite evidence identity.

Deleting a visible highlight mark must not destroy a receipt still required by a citation or prior grounded result.

A later read of the same passage must not resurrect a deleted highlight automatically.

---

## 20. Error and stale-state behavior

Prefer explicit failure to partial or fabricated conversion.

Examples:

- stale conversion preview → require refresh;
- missing supporting receipt → fail rather than silently drop evidence;
- oversized conversion → fail visibly rather than truncate;
- cross-account evidence → deny;
- unsupported semantic mapping from model → reject;
- failed layout suggestion → preserve the last useful preview;
- no completed values in a column → do not create empty label structures.

Accepted review previews should be fingerprinted/version-checked before write.

---

## 21. Scale limits

Current bounded conversion behavior may impose explicit limits such as:

- maximum 500 rows;
- maximum 25,000 inventory items;
- smaller bounded semantic-layout payload.

These limits must be visible failures, not silent dropping.

Large-workspace performance should be measured separately rather than solved by hidden truncation.

---

## 22. Accessibility / interaction expectations

All major interactions require keyboard-accessible alternatives:

- label hierarchy navigation;
- nesting/reordering;
- highlight-type selection;
- table inspector scrolling;
- modal Escape/focus restoration;
- source/evidence opening.

Desktop and narrow/mobile layouts must avoid horizontal page overflow for primary dialogs.

Long result panes need real focusable scrolling regions.

---

## 23. Implementation status

As of September 6, 2026, the major pieces have been implemented through merged PRs corresponding to:

1. research semantic foundation;
2. Sources/Memo simplification;
3. Tabular Review cleanup;
4. populated Sources/Chat → Table conversion;
5. grounded Chat reuse and Table → Sources/Chat interoperability.

The remaining verification/hardening work is not a new semantic system. It consists primarily of:

- full app/native-reader round-trip smoke;
- live-model quality evaluation for semantic layout proposals;
- large-workspace performance checks;
- final thin Library interaction polish;
- cleanup of obsolete/dead remnants if discovered;
- regression verification that reads never become highlights implicitly.

---

## 24. Acceptance scenarios

### Scenario A — simple source classification only

A user adds 20 cases and creates:

```text
Relevant
Not relevant
```

They never highlight anything.

Expected: Sources remains completely usable; no synthetic passage state appears.

### Scenario B — highlight-only research

A user saves passages under:

```text
● Test
● Application
```

and never assigns source labels.

Expected: all sources remain visible under All sources; no Unsorted label appears.

### Scenario C — deep classification and orthogonal highlights

Case A is `B › C › X`, but its highlights are `Test › Element 2` and `Useful language`.

Expected: no inferred relationship between those systems.

### Scenario D — Chat exploration → Sources

Chat reads 74 passages but grounds its answer in six.

Expected: the 74 reads remain background history; the six grounded passages may be transferred as grounded material; only explicit save creates coloured highlights.

### Scenario E — Sources → populated Table

The set contains source labels and saved `Drafting language` passages.

Expected: conversion preview reuses those classifications/evidence; unanswered new questions remain pending extraction.

### Scenario F — Table → Sources

A categorical Table column produces `Effective / No effect / Not considered`.

Expected: user can propose source labels for the selected rows. A grounded wording cell can save only its supporting passages as `● Drafting language`.

### Scenario G — Table → Chat

User selects three rows where saving clauses were effective and asks why.

Expected: Chat receives those rows, completed findings, and their evidence receipts; it does not receive all workspace findings.

### Scenario H — accepted table remains stable

After conversion, the user reorganizes source labels in Sources.

Expected: the existing review remains unchanged until explicitly refreshed/remapped.

---

# Appendix A — Design conversation transcript

This appendix preserves the product-design discussion that established the specification above. Tool-only implementation status chatter is omitted where it did not change product intent. Image-generation turns are represented as `[image mockup generated]`. The transcript below contains the text available in the conversation context; no hidden chain-of-thought is included.

---

## A.1 Initial simplification / ontology concern

**User**

> HANDOFF-research-overhaul.md Finish this task off. @GitHub Create a PR for it. One thing you may have to clean up: we need a YAGNI ponytail mindset on this one. Cleaning up UI clutter in workspaces, tabular review is important. I also have decided I don't want library folders to have any concept of having a primary "workspace" or label that applies to them -- I think a given research set/workspace should be able to label them, and for that to be the same substance as tabular review, but aside from that there's no need to get into a "slot" on the library files themselves that will affect their representation in all library tasks for all purposes, if that makes sense. Before you do the PR, just show me that you get what I'm saying.

**User**

> Yes, I agree. I am also worried that some of my comments about ontology may have been misinterpreted and expanded into some sort of system beyond what was needed to accomplish my research interopability goal. So, can you show me that you understand the overall goals here, what was done by the prior agents in the handoff plan, and how it would all tie together with a simplified but still powerful UI?

**User**

> Ok, I generally agree. But I'd also like you to mock how the UI would look in ASCII for me, if you could, so we can make sure we're on the same page about how this would look. Challenges include: the research set/workspace UI. Beyond the simplification I've already discussed at length and that I hope made it into the changes thus far: One thing that I think got badly mistranslated what the Memo portion. it caused the agent to write in these weird Cite chips, which was total clutter. we also at some point got this awkward paragraph by paragraph up/down nav thing going on in sources. Not good. Also, Tabular review got cluttered in a bunch of ways -- not only the previously canvassed "organize" interaction (which I never wanted to be the way it is as this weird extra jank thing), but also, the UI got super cluttured with buttons, tbuttons like the docuemnts upload button should be truncated to "[icon] Docs", these icon colours should be less changed to be less ugly or multicoloured or so high contrast (a much more muted palette, these bright ass cyans and purples are not good), add columns should just be +Column, and the title shoudl be given its own line so it has room to breathe because right now a column of any height pretty much just gets truncated. And we seem to have left in a duplicate "cited" pattern from OG mike that looks really ugly and does not gel at all with our current system. and the reciepts/view you see when inspecting a cell in tabular review completely lack a working scvroll and it just sprawls all this information at you in this totally slopped up non-unififed ugly way, which is only compound by the weird extra "cited" thing at the top. And also I have the sneaking susupicion that we are treating literally every passage READ in a chat research sesssion as though it were the same as a model-chosen highlighted passage, which is not correct. we save reads because we want to be able to use that information later, such as in filling a model that is continuing or building on research what's been read already in a compact way, or somethign like that. but we certainly should not treat any read as though it were the same quality of thing as a model's grounded answer or a human's selected passage. got that? And to be clear, we still want a way to use deterministic and nondeterministic (LLMs) assistance to smooth out interopability where apt or requested by the user or to reorganize columns, column prompts or labelling systems.

**User**

> Ok, you generally get me, but one thing I want to get rid of is "unsorted" , but I'm not sure how to do it. here's the rub: we might have a case that has labels, but no highlights, or highlights but no labels, so what do we do with those? Unsorted was all I could think of. Maybe that's inevitable, but is there a way to try to unify these features or make this all more beautiful visually without sacrificing depth? Show me a mockup (ascii or image, whatever works0

**User**

> how is something a research source if it lacks neither? I think the ascii is not cutting it. let's see what you can do with images.

**Assistant**

> [image mockup generated]

---

## A.2 Source labels vs. saved passages

**User**

> Hmm. So here's what I was originally thinking when I first made this labels and passages thing. The idea behind labels is that you want to be able to sort an entire case (or other source, but mainly a case) as follows: I've got my research question, and this entire case, broadly, say B about this principle. But you mind want to know why it held that -- was it for C, D, or E, and if it was C, then was it X or Y, etc.  Highlights solve a different problem: You might want to either (1) highlight the exact passages that are relevant to why it's C, D or E, OR, (2) you might have a more orthogonal task where you just want to mark the parts of all the decisions that discuss this part of a legal test or principle, and you might want to split that up into: this part of the case states the test, this part, a child highlight, tells us about this aspect of the test, or the other aspect of the test, etc. So they solve different problems, and your highlights are not always in support of your label, they might be pretty unrelated to a label (which could just be a binary y/n for if the case is relevant to what you were trying to look for, and if it's not relevant, maybe you highlight to show why, or maybe you just do no highlights at all). The only way I could see to get that depth was to have these be two different labelling systems, but maybe there's a simpler model or way to attack these problems that would retain that same depth of interaction while also allowing the simple use cases for labelling. Do you see my dilemma?

**Assistant**

> Yes. The dilemma is real, and I think trying to collapse the two systems into one taxonomy would actually lose information.
>
> What you have are **two different questions about research**:
>
> - **Source classification:** “What is this case, at the level of the research question?”
> - **Passage annotation:** “What exactly in this case is worth preserving, and what kind of passage is it?”
>
> Those can correlate, but they absolutely do not have to.
>
> Your example makes the distinction clear. Suppose the research question is whether a doctrine applies.
>
> A case might be classified:
>
> `B → C → X`
>
> That is a proposition about the **case as a whole**: broadly B; the reason is C; more specifically X.
>
> Inside the same case, you may save passages like “Statement of the governing test”, “Meaning of element 2”, “Application to unusual facts”, or “Why the argument failed”. Those aren't necessarily evidence *for* `B → C → X`. They are useful passages for completely different future operations.
>
> And conversely, you can classify a case `Not relevant` without highlighting anything whatsoever.
>
> So I would **keep two semantic layers**. I would just stop making them feel like two competing “labelling systems.”
>
> Source labels remain hierarchical and classify the case. Highlights have their own lightweight hierarchy. There is **no automatic semantic relationship** between the two. A passage can optionally be explicitly linked as support for a case label, but that relationship is optional.
>
> The underlying model can stay extremely small:
>
> ```text
> Research set
> │
> ├── sources
> │     └── source labels
> │
> ├── saved passages
> │     └── highlight categories
> │
> └── optional support links
>       source label ← passage
> ```
>
> Not a unified semantic ontology, arbitrary typed entities, relation graph, scoped inherited concepts, or universal classification system.
>
> A user can use only source labels, only highlights, or both. Nothing forces sophistication onto the simple workflow.
>
> The collection itself answers “what sources are in this research?” Labels answer “how have I classified them?” Highlights answer “what passages have I intentionally preserved?” Those are three separate facts.

---

## A.3 Compact model and failed over-complex mockup

**User**

> Ok, well I still need you to translate this into a compact statement of what we're going to do, and a mockup of what it could look like. Let's start with a mockup and a brief explanation.

**Assistant**

> The compact model is: **case labels classify whole sources; passage categories organize saved excerpts; they stay independent unless the user explicitly links a passage as support for a case label.** A source can belong to the research set without being forced into an “Unsorted” category; absence of classification simply remains absence of classification.
>
> [image mockup generated]

**User**

> This is pretty unconnected from hwo beaver looks currently. I think you'll need to anchor it more in what we've already got.

**Assistant**

> Agreed. I need to base the mockup on Beaver’s **actual current component structure, spacing, typography, controls, and dock behavior**, not invent a new design language. I’m going to inspect the current Sources/Tabular Review UI and any existing screenshots/tests, then I’ll redraw this as a targeted evolution of what’s already there rather than a replacement product.

**Assistant**

> I found the useful anchor in the current implementation: Beaver already has the right basic shape — the **400px Workspace dock**, the `Labels / Search / Memo` subtabs, an `All sources` row, then separate **Labels** and **Passage categories** trees, with the actual saved-source list underneath. The part I’d change is much smaller than my last mockup: remove `Unsorted` / `Unclassified` as pseudo-labels, keep `All sources` as the complete canonical list, and let the two trees act as independent filters/organization over that list.

**User**

> Ok, this is a total mess dude. this is just the opposite of a unification. this is a nightmare to look at

**Assistant**

> Yes — I overcomplicated it. I turned two classification layers into **three competing navigation systems**, duplicated the cases, and then added a details pane on top. That is exactly the opposite of unification.
>
> The cleaner answer is: **There should be one canonical list of sources.** Labels never become containers that duplicate sources. They are a **filter/classification control over that list**. Highlights live **inside their source** because passages belong to sources. Passage categories organize those highlights locally or across the current filtered set.
>
> No `Cases | Passages` mode switch, no separate `All sources` tree duplicating the labelled tree, no `Unsorted`, no separate full-page passage taxonomy sitting beside the source taxonomy, no permanent source-inspector panel, and no Memo consuming half the screen.
>
> Passage categories should mostly appear on the passages themselves, not as another permanent tree. If you want to work across passages globally, a small filter control can expose them. So `No case labels` is a **query**, not a fake folder called `Unsorted`.
>
> The mental model becomes: **Sources are the spine. Labels classify sources. Highlights belong to sources. Passage categories classify highlights. Both classification systems filter the same source list rather than creating separate copies of it.**

---

## A.4 Labels as virtual folders

**User**

> Alright. But what about when I want to look at labels as if they were like folders or soemthing. that's kind of important, it's a basic thing that makes this intuitive and helpful in the first place

**Assistant**

> Yes — and I think that **folder-like browsing is the right interaction for source labels**. I was overcorrecting when I tried to flatten them too much.
>
> The key is to distinguish **“labels behave like folders in the UI”** from **“labels are actual folders / exclusive locations in the data model.”**
>
> A source label tree can absolutely look and behave like nested folders. Click `C → X`, and below it you simply see the sources in that selection. That is essentially a folder browser.
>
> It should support intuitive folder interactions: drag a case onto a label to assign it; drag/reorder labels; expand/collapse branches; multi-label a case if necessary; clicking a parent includes descendants. A case can appear when browsing multiple labels because labels are virtual folders rather than exclusive locations.
>
> At the root you see **All sources**. Select a label and the source list changes. So the label tree is navigation and the source list is content — exactly like a folder sidebar plus file list.
>
> Highlights should not get equal permanent real estate beside those folders. They remain nested under their source, and passage categories can be optional filters across the research set.
>
> This kills `Unsorted`: at the root, unlabeled cases simply appear in All sources. `No case labels`, `Has saved passages`, and `No saved passages` are filters, not fake folders.
>
> Compact rule: **Source labels are virtual folders. The selected label controls which sources are shown. Highlights remain nested under their sources, and passage categories are optional filters over those highlights.**

---

## A.5 Concise product direction

**User**

> Ok, got it. Now weave that into a concise statement of all the planned features we've been discussing.

**Assistant**

> Research should revolve around a **portable research set**: an ordinary Library/project file containing references to sources, intentionally saved passages, lightweight organization, notes, grounded outputs, and an optional memo. Library itself remains neutral: files and folders have no primary workspace, permanent research classification, or globally visible research labels. A document can participate in any number of research sets, each organizing it differently.
>
> Within a research set, **source labels and saved passages solve different problems**. Source labels classify a case or other source as a whole and should behave like **virtual folders**: nested, draggable, browsable, and useful for filtering the single canonical source list. They are not exclusive filesystem locations, so a source may have several labels. There is no `Unsorted` pseudo-folder; sources without labels simply remain visible under **All sources**, with “no labels” available as a filter when needed.
>
> **Highlights are intentional saved passages**, not another version of source labels. They remain attached to their source and may optionally have their own nested passage categories. A source may have labels but no highlights, highlights but no labels, both, or neither. Passage categories can filter the same source list when needed rather than becoming a competing permanent navigation tree. Where useful, a passage may be explicitly linked as support for a source classification, but Beaver must never infer that relationship merely because both happen to exist.
>
> A **read** is weaker than a saved passage. Beaver should retain read history for continuation, retrieval, deduplication, and provenance, but ordinary reads should not appear as highlights or curated evidence. Human/model-selected passages and evidence explicitly supporting grounded answers or table cells are intentional research artifacts; read history is primarily background state.
>
> The **Sources workspace** should become substantially quieter: one label/folder navigator, one source list, the reader, and lightweight passage interaction. Remove `Unsorted`/`Unclassified`, the old Organize interaction, paragraph-by-paragraph navigation controls, unnecessary metadata decoration, and other duplicated controls. The Memo should behave like a normal rich-text memo with normal-looking citations—not inline “Cite” chips or research-object clutter. Search, History, passage-category filtering, and other advanced tools should remain available through progressive disclosure rather than dominate the default view.
>
> **Tabular Review** is another projection over the same research, not a separate ontology. It should import sources or deliberately selected passages, retain evidence links, and allow source labels and passage categories to define scopes or grouping where useful. Its UI should be aggressively decluttered: the review title gets its own line; controls become compact (`[icon] Docs`, `+ Column`); the palette becomes muted; the obsolete Organize interaction and duplicate OG Mike “Cited” treatment go away; and the cell inspector becomes a bounded, scrolling, unified view ordered roughly as **Answer → Evidence → Explanation → More details**, with receipt/debug metadata collapsed by default.
>
> **Chat, Sources, and Tabular Review should operate on the same primitives.** Deterministic transformations should be used where mappings are exact; LLM assistance remains important where semantics are fuzzy. These should be reversible proposals where judgment is required, not justification for a larger generalized ontology system.
>
> Governing rule: **keep the data model small and the interaction deep**.

---

## A.6 Highlight colour/type simplification

**User**

> Ok, loosk pretty good I think, but now sketch out some of the specifics of the UI, including how we're fixing some of these difficult points of interaction/interopability and what else we're cleaning up. You also have to address how a user will assemble a highlight colour set or hierarchy

**Assistant**

> The remaining hard part is making **highlight colour, passage hierarchy, and source labels feel related without conflating them**. I’d keep the default workspace sparse, then put the complexity into two compact editors: one for source-label folders, one for the passage/highlight scheme.
>
> [The assistant proposed a separate colour + category model with optional default colours and inheritance.]

**User**

> "or change the active category while retaining the pen colour." Ok now this is kinda fucked tho lol. now we're mixing shit too much. too complicated. colours and categories should be one and the same. and having overrides is crazy. you see how this is actually just NOT simple. you are aasking me to imagine a world where Im spending more time fuckingg around with pens than researching

**Assistant**

> Yes. I overdesigned it. **There should not be “colour” and “category” as two independent decisions at all.**
>
> The right primitive is simply a **highlight type**:
>
> ```text
> Highlight type = name + colour + optional parent
> ```
>
> Each dot is its colour. **That is the pen. That is the category. Same object.**
>
> When you're reading, the toolbar is just:
>
> ```text
> [ Highlight: ● Element 2 ▾ ]
> ```
>
> Select text → it becomes an `Element 2` highlight in that colour.
>
> No choose-colour + choose-category + inheritance + override workflow.
>
> A new research set can start with one ordinary yellow pen: `● Highlight`. If the user wants distinctions, they add `● Relevant passage`, `● Test`, `● Application`. Beaver should automatically offer the next pleasant muted colour so normally the user only types **Application** and hits Enter.
>
> If the user needs depth, they drag/nest exactly as with source labels. There is **no separate colour-set editor**. The hierarchy *is* the colour set.
>
> A tiny menu gives Rename, Change colour, Add child, Delete. The colour dot and category name describe **one thing**, not two metadata systems.

---

## A.7 Interoperability — first clarification

**User**

> Ok, much better. Now get into specifics about interopability.

**Assistant**

> The interoperability rule I’d use is: **everything shares identities, but nothing silently changes meaning.** A source, saved passage, source label, and highlight type should be reusable across Sources, Table, Chat, and Memo without being copied into parallel representations.

**User**

> Your explanation makes 0 sense to me. Restate more concisely and clearly.

**Assistant**

> The simple version is: **A research set has four things: Sources, Source labels, Highlights, Highlight types. Everything else — Chat, Table, Memo — works on those same things.**
>
> If you are browsing a source label, Chat can inherit those sources. If you are browsing a highlight type, Chat can inherit those highlights. A table column can explicitly create labels. A highlight is one stable object that can appear in Sources, be given to Chat, become table evidence, or be cited in Memo.
>
> A model read is not a model save. Reads remain background history; saved highlights are intentional; citations are evidence used to support an answer.
>
> AI belongs in messy semantic transformations; exact mappings stay deterministic.

**User**

> "you can create a table from those 8 cases.  " BUT WHAT DOES THAT MEAN? to "Create a table". Is this a blank table with those 8 cases in there? That's not really interopability in any meanginful sense.

**Assistant**

> You're right. A blank table with eight case rows is basically just **transport**, not meaningful interoperability.
>
> What interoperability should mean is: **the organization and research work you've already done becomes useful table structure and pre-populated information instead of being discarded.**
>
> If Sources already contains classifications and saved passages, **Open in Tabular Review** should offer a useful schema and carry over what is already known. Existing labels can seed classification cells; saved highlights can seed evidence; grounded findings can seed answers. New columns that ask genuinely new questions remain for extraction.
>
> The payoff is: **Tabular Review starts where the research left off instead of starting over.**
>
> The reverse direction matters too: a useful categorical column can become source labels, and grounded cell evidence can be explicitly saved as a highlight. The assistant is the adapter only where the shapes do not line up cleanly.

---

## A.8 Concrete employment-law research example

**User**

> I don't think you're quite there. Give me an example with an actual research question to shwo me how you think someone would use this. And don't forget about the chat conversion interopability

**Assistant**

> Use a real research shape:
>
> **Research question:** In Ontario, when will a court hold an employment termination clause unenforceable because some part of the agreement violates the ESA?
>
> A lawyer might start in **Chat**, not Sources.
>
> Chat searches and reads many cases/passages, but its grounded answer materially uses only a smaller set. Those incidental reads do **not** become research artifacts.
>
> **Chat → Sources:** choosing Sources means “turn the useful product of this chat into a research set,” not “dump everything Chat touched into a folder.” Beaver can deterministically bring over the cited cases, supporting passages, and grounded answer. Because the answer has semantic structure, Beaver may offer a lightweight source-label / highlight-type organization, but that organization is LLM-assisted and optional.
>
> The lawyer then continues manually in Sources, adding cases, classifying them, and highlighting Rule / Application / Drafting language passages.
>
> **Sources → Tabular Review:** once the lawyer understands the rough doctrinal landscape and wants systematic comparison, Open as Table should not produce a blank table. Beaver should use the research question plus existing organization to propose a table such as Case / Outcome / Reason / Problematic wording / Treatment of for-cause clause / Treatment of earlier cases. Existing labels and highlights seed parts of it; genuinely unanswered cells remain for extraction.
>
> **Table → Sources:** if systematic review discovers a useful new classification like Saving-clause treatment → Effective / No effect / Not considered, the user can turn that categorical result into source labels. A particularly good grounded wording passage can be saved back as `● Drafting language`.
>
> **Table → Chat:** if the user filters to the three cases where saving clauses worked and asks “Why did these work?”, Chat receives those sources, relevant table results, grounded evidence, highlights, and labels — not a flattened summary that loses provenance.
>
> **Chat → Table directly:** a long grounded conversation can become a structured review using the materially used cases, grounded passages, and substantive patterns, with existing findings seeding cells rather than rerunning everything.
>
> Principle: **Chat is good at exploration and synthesis. Sources is good at curating and organizing research. Tabular Review is good at systematic comparison. Interoperability means that moving between them preserves and reuses the intellectual work already done, rather than merely preserving the document list.**

---

## A.9 PR implementation plan

**User**

> Ok, now I think you've got it. Propose how you would tackle implementing this, in a series of PRs. (This is not hypothetical, I will be turning you up to pro and making you do this in the next turn).

**Assistant**

> I’d split it so each PR establishes one stable product contract and leaves the app usable. The first PR should **simplify the underlying semantics before we polish UI or build conversion flows**, otherwise we risk cementing the ontology/`Unsorted` mistakes into more code.
>
> The plan was:
>
> 1. **Research semantics:** remove Library-wide ontology/ownership, separate reads from saved passages and grounded support, enforce one highlight type, remove Unsorted.
> 2. **Sources workspace:** virtual-folder labels, one source list, nested highlights, compact highlight-type editor, Memo cleanup.
> 3. **Tabular Review UI:** compact controls, title/column layout, muted palette, remove Organize/Cited clutter, scrolling inspector.
> 4. **Sources ↔ Table:** reuse classifications, evidence, and grounded findings; reverse promotion of categorical columns and cell evidence.
> 5. **Chat interoperability:** Chat → Sources, Sources → Chat, Chat → Table, Table → Chat using deliberate grounded work rather than reads.
> 6. **Library integration / hardening:** thin Library interaction, dead-code cleanup, stable-ID round trips, persistence/reload, full smoke and regression checks.
>
> Scope guard: if a feature requires inventing another ontology, hidden workspace, classification system, or parallel evidence representation, first see whether source / source-label / highlight-type / grounded-evidence primitives already solve it.

---

## A.10 Final outstanding-work consolidation

**User**

> Which work remains to be done?

**Assistant**

> The remaining substantive work is basically **PRs 4–6 from the original plan**. PRs 1–3 have now been implemented as the semantic-foundation PR plus the combined Sources/Memo + Tabular Review UI PR.
>
> The big missing piece is **real interoperability** rather than UI cleanup:
>
> - Sources ↔ Tabular Review should propose useful structure and prepopulate existing work rather than create blank rows.
> - Chat ↔ Sources ↔ Table should preserve the *intellectual work*: materially used sources, grounded passages, selected scopes, underlying evidence.
> - deterministic + LLM-assisted organization should smooth fuzzy mappings without creating a hidden ontology.
> - final integration should keep Library shallow, preserve stable IDs across round trips, prevent reads from becoming highlights, prevent silent table mutation, and run full browser/native smoke where possible.
>
> In practical terms, the next PR should be the interoperability core, followed by a final hardening pass.

**User**

> Ok, take that on.

**User**

> Just do all remaining outstanding work as the next PR.

**Assistant**

> [Implementation followed; the resulting interoperability PR implemented populated conversion previews, grounded Chat reuse, explicit highlight promotion, table-to-label proposals, selected-result Chat handoffs, stale-preview protection, and focused validation.]

---

# Appendix B — Decision summary

For quick review, the final decisions are:

```text
Library
  ordinary files/folders only
  no global research classification
        │
        ▼
Research Set
├─ Sources
│  └─ Source labels = virtual folders over whole sources
│
├─ Highlights
│  └─ Highlight type = name + colour + optional parent
│
├─ Grounded outputs
├─ Read/query history (background)
└─ Memo

Sources / Chat / Table / Memo
        │
        └── use the same source/evidence identities
```

And the non-negotiable semantic distinctions are:

```text
Read              ≠ Highlight
Grounded support  ≠ Highlight
Source label      ≠ Highlight type
Library folder    ≠ Research workspace
Blank rows        ≠ Meaningful interoperability
```

The system should stay boring internally and deep in interaction: **small primitives, stable evidence, explicit user intent, deterministic reuse where exact, model assistance only where semantic judgment is actually useful.**
