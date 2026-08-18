# Grounded drafting integrity

Status: **Implemented; deterministic acceptance complete**

Implemented with the tool-runtime v2 replacement on 2026-08-17. Live
provider-behaviour checks remain an explicitly authorized evaluation step;
they are not a condition for deterministic release because this plan does not
authorize metered model calls.

This plan makes a generated legal document locally verifiable without turning
drafting into a second research pipeline. It keeps Beaver's existing evidence
handles, semantic Markdown, DOCX renderer, and Library events. The required
changes are narrower evidence units, an exact-quotation gate, a separate
unmarked-copy guard, and cleaner host/model boundaries.

## Contract

A grounded support unit is one independently checkable sentence, clause, or
list item followed by the evidence handles that support it. It may rely on more
than one handle. A handle must identify the smallest native source block that
Beaver can address, not an arbitrary range returned by a broad read.

The host guarantees:

- every citation points to text that was actually returned in the turn;
- every quoted passage maps to the cited source text;
- every alteration within quoted language is visibly disclosed;
- substantial verbatim language is not presented as a paraphrase; and
- the rendered pinpoint and viewer highlight come from the same evidence span.

The host does **not** claim to prove that a paraphrase is entailed by a source,
that a quotation is fair in context, or that a legal conclusion is correct.
Those are judgment questions. The existing experimental semantic checkers stay
out of production.

These are three separate contracts:

| Problem | Production method | What it does not prove |
| --- | --- | --- |
| Citation granularity | Claim-local child receipts selected before prose | That the claim correctly paraphrases the receipt |
| Exact quotation fidelity | Deterministic source alignment for marked quotes | That the quote is fair in its wider context |
| Paraphrase integrity | Detect substantial unmarked copying; compose real paraphrases from selected narrow evidence | Semantic entailment by deterministic string comparison |

None is implemented as a side effect of another. Narrow evidence helps a model
write and a lawyer inspect a paraphrase, but quote matching does not decide
citation scope and citation scope does not certify paraphrase accuracy.

## 1. Citation granularity

### Make the source block the citable unit

`Read` may return a broad window for navigation, but the parent window is not
citable when its native child blocks are known. Register one evidence receipt
for each available source unit:

- case paragraph;
- statutory provision;
- journal paragraph or page block;
- CourtListener provider paragraph or star page;
- DOCX paragraph;
- PDF paragraph or page when no finer proven structure exists; and
- tabular cell.

If a source has no native structure, use the existing bounded SourceDoc slice.
Do not add a new parser or an arbitrary two-paragraph cap.

### Locator ladder

Every returned passage is internally addressable by source hash and character
offset. That does not make every coordinate a proper legal pinpoint. Keep the
two concepts separate in the receipt:

- `span`: Beaver's exact internal text range and viewer highlight; and
- `locator`: the source's best honest, human-facing pinpoint, if one exists.

Choose the locator without inventing structure:

1. **Legislation:** use the deepest native provision that contains the support
   (`section`, `subsection`, `paragraph`, and so on). A read spanning several
   provisions returns several child receipts.
2. **Paragraph-numbered cases:** use the provider's paragraph number. Keep an
   exact text span inside that paragraph for highlighting.
3. **Page-only cases:** use proven reporter, star-page, or provider page
   boundaries. A proposition crossing pages may cite several page receipts,
   which the renderer may display as an adjacent range.
4. **No public paragraph or page:** use a bounded SourceDoc passage receipt for
   selection, validation, and the local viewer. Render the authority without a
   fabricated pinpoint and open directly on the exact highlighted passage.

A PDF leaf number is not a reporter page. It may be shown as a document-viewer
coordinate for a Library file, but it becomes a legal pinpoint only when the
source proves that it corresponds to printed, provider, reporter, or other
citable pagination. Prefer a verified external text fragment when the provider
can express the span; otherwise use Beaver's local viewer.

Page boundaries may divide a sentence. Preserve the exact span across the two
page receipts rather than moving text, assigning it to the wrong page, or
minting a synthetic paragraph. Multiple reporter paginations remain distinct
locator systems. Bind each page locator to the reporter/provider citation that
defines it; never print that page beside a different parallel citation. Select
or translate pagination only through a proven reporter mapping.

A claim may cite several child handles. The renderer may collapse adjacent
selected locators into a display range, but the evidence store retains the
individual children. Thus a read of paragraphs 48-74 can support a claim with
paragraph 49, another with paragraph 69, or one claim with both; it cannot mint
one indiscriminate paragraphs 48-74 receipt.

This follows the same granularity principle as Anthropic's custom citation
content blocks: the supplied block is the minimum citable unit, and a response
text block carries the citations supporting that claim. See
[Anthropic's citation contract](https://platform.claude.com/docs/en/build-with-claude/citations).

Implementation uses the existing evidence registry. In particular:

- replace the single range receipt in `createA2AJLookupEvidence` with receipts
  derived from the existing SourceDoc blocks contained by that range;
- stop Library `Read` from reducing disjoint exposed segments to one
  minimum-start/maximum-end receipt; and
- keep `claims[{ text, evidence_ids }]` and DOCX `[@evidence]` markers as the
  only model-facing citation forms.

### Render one host-owned citation

The model selects evidence; Beaver supplies the citation. One backend
presenter must turn a source receipt into:

```ts
type CitationPresentation = {
  authority: InlineToken[];
  shortAuthority: InlineToken[];
  locator: { separator: " at " | ", "; text: string } | null;
  sourceUrl: string | null;
  passageUrl: string | null;
};
```

Chat pills, tool activity, grounded-answer events, and DOCX footnotes consume
that value. They do not join `name`, `citation`, and locator strings
independently.

Use McGill syntax by default:

- case paragraph: `at para 12` or `at paras 12–14`;
- case or journal page: `at 47` or `at 47–49`;
- legislation: `, s 4` or `, ss 4–5`; and
- footnote: `at n 7` or `at nn 7–9`.

The locator formatter therefore owns both the marker and its separator. Remove
the periods from `para`, `paras`, `s`, `ss`, `n`, and `nn`; do not print `p` or
`pp` before a page. This follows the current McGill article pattern and the
Alberta courts' adoption of the McGill Guide. See the
[McGill Guide](https://lawjournal.mcgill.ca/cite-guide/) and the
[Alberta citation guideline](https://www3.albertacourts.ca/kb/resources/citation-guidelines).

When a receipt has an exact internal span but no honest public locator, chat
still renders the ordinary authority pill and opens the highlighted span. With
DOCX links enabled, render `Authority at [link]`, where only the literal
`[link]` is linked to the exact passage. With links disabled, render only
`Authority`. `[link]` is a transparent digital pinpoint; it must not masquerade
as a page or paragraph and the model must never author its destination.

Journal authority text is built once from structured metadata:

```text
Author, “Title” (Year) Volume:Issue JournalAbbrev FirstPage
```

Use an ampersand for two or three authors and the first author plus `et al` for
more than three. Append a page pinpoint as `at 47`.

The journal database is the authority for this metadata. Query `authors`,
`name_en`, `document_date_en`, `volume`, `issue`, `journal_abbrev`, and
`first_page` and format those fields directly. An empty `issue` is not missing
metadata: it means that the journal does not use an issue number for that
article, so render `Volume JournalAbbrev` rather than `Volume:Issue
JournalAbbrev`. Do not infer an issue, parse one from prose, fetch metadata from
another source, or branch to a second citation representation.

Beaver currently does not select `issue`, and its display function treats an
empty `citation_en` as a reason to construct a second, incomplete citation. It
then prepends `name` to that constructed string, causing the duplicated title.
Remove that branch. Build the one citation from the database fields, store that
one authority on the journal document/result/receipt, and never concatenate
the title with it again downstream.

The citation pill displays that one finished authority. A long journal
citation stays fully visible inside one compact, multi-line pill: constrain it
to its parent, allow last-resort wrapping with `overflow-wrap: anywhere`, and
use a modest rounded rectangle rather than a capsule on wrapped text. Do not
truncate it, clip it, reduce the font, or repeat the title in a tooltip-like
second line.

### Cite only model-visible evidence

An authentic receipt in server state is not enough. Use the existing
`LegalEvidenceTurnState.evidence` map as the turn- and agent-scoped capability
set; do not add a second ledger. Register a receipt there only when its exact
source text is serialized into that model's context. `submit_grounded_answer`
and `Write` may use only handles in that map.

- Search results, snippets, filenames, remembered citations, and handles the
  model guessed are never citable.
- A tool read activates only the child blocks actually returned to the model,
  not the unread remainder of the source or a parent range.
- A subagent may cite evidence it read in its own response. The orchestrator
  may cite that evidence only if the handoff includes the exact source block
  and receipt in the orchestrator's context; a subagent's characterization or
  bare handle is insufficient.
- Prior-turn, post-compaction, and subagent evidence qualifies only through the
  existing prior-evidence prompt, which re-emits the exact passage and receipt.
  If a passage is omitted from that prompt, do not register its handle. No
  redundant `Read` is required when the host has already rehydrated the exact
  text.
- Evidence is bound to the source version/hash returned with the read. A newer
  version requires a new read and receipt.

The important boundary is what source text the drafting model could actually
inspect, not which process happened to issue the underlying fetch. Couple
registration to existing tool-result and prior-evidence serialization; the
model does not report or attest to its own reading.

### Select evidence, then write the support unit

The drafting instruction becomes:

1. select the smallest returned source block or blocks that support the next
   proposition;
2. write one natural support unit from those blocks; and
3. attach their handles immediately after that unit.

This is an instruction within the existing model turn, not another model call,
planner, or intermediate schema. It follows the established
[Attribute First, then Generate](https://aclanthology.org/2024.acl-long.182/)
pattern: select local source segments first, then condition a sentence on those
segments so the selection is also its attribution. The deterministic validator
remains a backstop, not the normal drafting loop.

Do not require every grammatical clause to be isolated. Split where a lawyer
would need different evidence to verify a proposition. One citation may support
several closely connected propositions when the same narrow block genuinely
supports them; different paragraphs require different handles.

## 2. Exact quotation fidelity

Run one deterministic quote gate before `submit_grounded_answer` succeeds and
before `Write` persists grounded DOCX prose. The chat `claim` or DOCX prose
ending at `[@evidence]` defines the support unit. A marked quotation in that
unit must align to one of its attached receipts. Quotation marks used for an
uncited defined term or ordinary document drafting are not treated as source
quotations merely because they are quotation marks.

### Source alignment

Extract inline quotation marks and Markdown block quotations. Each quoted span
must map monotonically to a cited child receipt in one of two states:

1. `verbatim`: source characters match after representation-only
   normalization; or
2. `editorially_altered`: every departure is visibly represented by brackets
   or an ellipsis and the remaining source tokens map in order.

Representation-only normalization is deliberately narrow: Unicode composition,
Word run boundaries, non-breaking/ordinary spaces, line-wrap whitespace, and
equivalent quotation-mark glyphs. Case, words, numbers, punctuation, negation,
and modal verbs are not silently normalized. A soft line-break hyphen may be
ignored only when SourceDoc recorded it as an extraction artifact.

Prefer the source's words unchanged. Legal editorial forms remain available
when grammar requires them. For example, source `busybody` may be rendered as
`busybod[ies]` only if reverse alignment proves that the unbracketed source
characters and the bracketed replacement describe that one source token.
Unmarked `busybodies` inside quotation marks fails.

Brackets and ellipses disclose provenance; they do not prove that an alteration
preserved meaning. The rule therefore follows conventional legal quotation
practice—alterations are bracketed and omissions are marked—without awarding a
semantic-verification label. See the
[Cornell legal quotation guidance](https://www.law.cornell.edu/citation/6-100)
and the Government of Canada's
[quotation-alteration guidance](https://our-languages.canada.ca/en/writing-tips-plus/quotations-insertions-and-alterations).

Port only the small token/offset alignment and bracket-diff primitives from the
ALR Quote Verifier into Beaver's existing `quoteRepair` path. Do not add a
Python runtime, a second matcher, or a model-visible similarity score.

### Failure response

A failed quote returns only:

- the offending draft quote;
- the exact source window;
- the attached evidence handle; and
- where possible, a minimal visibly bracketed candidate.

The model must choose the source wording, a visibly altered quotation, or a
real paraphrase, then retry. Beaver never accepts a fuzzy match, rewrites a
quotation automatically, or presents a similarity percentage as legal
assurance.

## 3. Paraphrase integrity

This is independent of quote validation. It has two parts: prevent verbatim
source language from being formatted as original prose, then make genuine
paraphrases easier to write and verify.

### 3.1 Prevent unmarked verbatim borrowing

After removing explicit quotations, block quotations, citation markers, source
titles, and renderer-owned boilerplate, compare the remaining prose with the
entire set of evidence text visible to that model:

1. build normalized 25-character windows from the small current-turn evidence
   set as cheap candidate seeds;
2. expand overlapping candidates into maximal exact token runs;
3. require at least eight consecutive lexical tokens and 51 normalized
   characters; and
4. reject the support unit if the resulting maximal span is not marked as a
   quotation and attached to a matching evidence receipt.

Twenty-five characters is an established quotation-membership *candidate*
scale rather than an invented trigram heuristic. QUIP uses character
25-grams—roughly five words—because smaller units are too common and larger
ones miss useful copied language. It also distinguishes exact lexical
quotation from the much harder semantic-grounding problem. See
[QUIP](https://aclanthology.org/2024.eacl-long.140/) and
[Verifiable by Design](https://aclanthology.org/2025.naacl-long.191/).
The 25-character seed is not itself a legal rule. Text-reuse research cautions
that automatic thresholds must be set empirically because domain terminology
and conventional phrases create coincidental matches. See the
[scientific text-reuse dataset's methodology](https://pmc.ncbi.nlm.nih.gov/articles/PMC9879940/).
Beaver therefore expands a seed to the actual common run and applies the more
conservative eight-token/51-character gate. Short terms of art do not trigger
it, and the corpus check below prevents conventional legal phrasing or repeated
boilerplate from turning the gate into a quotation factory.

Before enabling rejection, freeze the eight-token/51-character boundary against
real Beaver outputs and public legal prose from the local case and journal
corpora. The gate must catch the observed unmarked factual-vacuum sentence and
produce no false rejection in the reviewed sample. If it does not, change the
single boundary before shipping; do not add exceptions, a phrase stop-list, or
a probabilistic classifier.

The 2026-08-17 local freeze rejected the initially proposed 8/40 boundary:
three of 31 historical claims were false rejections. The smallest reviewed
replacement was 8/51: it caught the 13-token factual-vacuum witness, retained
five of six reviewed true positives, and produced no false rejection. The
reproducible sample and threshold sweep are recorded in
[`experiments/grounded_drafting_copy_gate/RESULTS.md`](../experiments/grounded_drafting_copy_gate/RESULTS.md).

The runtime is a linear scan over evidence already in memory. Bloom filters and
a corpus index solve a different problem: membership testing against an
enormous pre-training corpus. Trigrams would produce intolerable false
positives; edit-distance thresholds would allow legally decisive substitutions
such as `may`/`must`.

This gate catches omitted quotation formatting and omitted citation attachment,
including copying from visible evidence other than the receipt the model tried
to cite. It does not decide whether wording below the conservative boundary is
distinctive enough to quote; the drafting instruction still tells the model to
quote source-specific language where the wording matters.

### 3.2 Faithful genuine paraphrases

There is no deterministic equivalent of exact source alignment for a genuine
paraphrase. QUIP expressly separates lexical quotation from semantic grounding,
and citation benchmarks evaluate support with learned NLI or human judgment
rather than prove it. [ALCE](https://aclanthology.org/2023.emnlp-main.398/)
likewise treats citation correctness, completeness, and quality as separate
evaluation dimensions.

The production method is therefore preventive and inspectable:

1. expose narrow source blocks with readable handles;
2. have the model select the supporting block or blocks before writing the
   support unit;
3. keep each independently checkable proposition next to those handles; and
4. render the selected source span as the citation's viewer highlight.

This is the established locally attributable generation pattern, not a second
LLM verifier. Direct quotation remains preferred when precise source language
matters. A real paraphrase remains model-authored legal work that a lawyer can
verify against one short highlighted source unit. The rejected experimental
semantic checker is not revived and no deterministic `verified` label is
attached to a paraphrase.

The unmarked-copy gate may cause a local retry, but select-first drafting should
make that exceptional. It must not be used to repair coarse citations; citation
granularity is solved in section 1 before prose is generated.

## 4. Rich Word footnotes without a new language

Semantic Markdown already supports authored footnote bodies, and its inline
parser already accepts citation handles inside them. Document and test that
existing form:

```markdown
The public-interest standing test is flexible.[^standing]

[^standing]: [@p49] (the claim was “far from frivolous”); [@p69] (the factors are not “hard and fast requirements”).
```

The renderer creates one ordinary Word footnote containing the commentary and
both citations. It does not create a footnote inside a footnote. Reuse the
existing citation sequencer so the first reference is full, an immediately
repeated authority may use `Ibid`, and a later authority receives the existing
short form. Parenthetical commentary remains model-authored; authority names,
pinpoints, links, and source highlights remain host-owned.

No new footnote JSON, citation DSL, or recursive-footnote representation is
needed.

## 5. Generated documents are host artifacts, not URLs

`Write` returns a typed execution outcome with separate model-visible content
and host-only events. The model-visible result is deliberately smaller than
the durable artifact event.

The model sees only a turn-local result such as:

```json
{"ok":true,"artifact":"draft-1","filename":"Standing memo.docx"}
```

Document/version UUIDs, resource URIs, and download URLs remain in the typed
`doc_created` event carried by `BeaverOutcome`; they are never parsed back out
of model-visible JSON. A turn-local handle may be passed to `Edit`;
it is not a durable public route.

The frontend renders one compact monochrome Library pill from `doc_created`.
Selecting it opens the document in the existing Library side panel. Remove the
duplicate download block, do not say “Downloading,” and never let the model
construct an application URL.

## 6. Drafting questions and content controls

Put one rule in the production coding prompt, where it is currently missing:

- use `ask_inputs` for questions that genuinely block the requested document;
- ask all blockers in that call and do not issue a prose questionnaire; and
- represent missing names, addresses, dates, amounts, and similar particulars
  with native content controls, reusing the same field id for repeated values.

For an Alberta lease, residential versus commercial may change the governing
document and is a fair blocker. The address, parties, dates, rent, and contact
details are fields, not reasons to delay drafting. After the blocker is
answered, generate the document without asking the same question again.

## 7. Journal routing and one activity presentation path

`note_up` is already a resident main-agent tool and already returns judicial
discussion plus journal analysis. Its schema is not the problem. Add the
missing routing rule to the production research prompt:

- when research starts from a known Canadian decision or asks how that
  decision has been discussed, use `note_up` first;
- use journal-filtered `search_sources` for topic-led scholarship or to broaden
  beyond commentary tied to one decision; and
- for an open-ended doctrinal or explanatory question, normally make one small
  journal search early to learn the vocabulary, leading authorities, and
  competing accounts, then verify dispositive current-law propositions in the
  applicable primary sources.

Skip that orientation search for a source-specific request, a narrow current
statute lookup, or an express primary-sources-only instruction. This is modest
routing guidance, not a journal quota and not another speech in each tool
description.

Main-agent and subagent activity now use one backend `ToolActivity` contract
and one frontend renderer:

```ts
type ToolActivity = {
  id: string;
  tool: string;
  status: "running" | "completed" | "error" | "interrupted";
  label: string;
  source?: CitationPresentation;
};
```

The initial event may have a provisional label. The result event with the same
id enriches it from the discovered source/evidence receipt. Both main and
subagent views therefore say, for example, `Reading R v Jordan, 2016 SCC 27`,
`Reading “Article Title” from Alta L Rev`, or `Noting up R v Jordan, 2016 SCC
27`. Provider names and source titles come from the same source presentation;
neither frontend nor agent path decodes resource ids or UUIDs. Delete the
subagent-only formatter rather than retaining two implementations.

## 8. Acceptance matrix

### Reproduce the observed failure

Replay the public-interest-standing memo request that read paragraphs 48-74:

- no generated citation may use the undifferentiated 48-74 receipt when native
  paragraphs are available;
- the distinct propositions use their actual paragraph handles;
- quoted `busybodies` fails against source `busybody`;
- exact `busybody` and proven `busybod[ies]` forms pass;
- the unmarked source phrase about deciding constitutional issues in a factual
  vacuum fails once it crosses the threshold; and
- every pill, footnote pinpoint, click target, and viewer highlight resolves to
  the same selected text.

### Citation granularity and eligibility

- A2AJ range reads expose child receipts.
- Disjoint Library reads do not collapse to a minimum/maximum span.
- A fabricated, unread-sibling, omitted-after-compaction, stale-version, or
  subagent-summary-only evidence handle is rejected even if a receipt with that
  id exists elsewhere in server state.
- A subagent handoff containing the exact source block and receipt makes only
  that block visible to the orchestrator.
- CourtListener provider paragraphs, statutes, journals, DOCX, PDF, and tabular
  cells preserve their best native locator.
- A page-only decision cites proven reporter/provider pages, including a
  cross-page span; it never prints a raw PDF leaf as though it were reporter
  pagination.
- An unpaginated and unnumbered decision remains internally addressable and
  opens on its exact passage. Chat retains its citation pill; a linked DOCX
  renders `Authority at [link]`, and an unlinked DOCX renders `Authority`.
- Legislation read across multiple provisions produces provision-level child
  receipts and renders the deepest applicable section/subsection/paragraph
  locators.

### Citation presentation

- Cases, legislation, and journals render McGill joiners and locator markers
  from the same backend presenter in chat and DOCX.
- A journal with complete metadata renders once as `Author, “Title” (Year)
  Volume:Issue JournalAbbrev FirstPage at Pinpoint`; two/three-author and
  four-plus-author cases follow their McGill forms.
- A database row without an issue renders `Volume JournalAbbrev`; a row with
  an issue renders `Volume:Issue JournalAbbrev`. Neither path infers or fetches
  metadata, and neither produces a placeholder, duplicated title, or malformed
  punctuation.
- A real long journal citation in a narrow chat column wraps inside its pill;
  ChromeDriver verifies that the pill's `scrollWidth` does not exceed its
  available width and a screenshot verifies the multi-line shape.
- A citation pill, DOCX footnote, activity source, and viewer highlight for the
  same receipt carry one authority identity and one passage destination.

### Journal routing and activities

- A request to inspect commentary about a named Canadian case reaches
  `note_up` before generic journal search.
- An open-ended doctrinal question performs a bounded journal orientation
  search unless the request fits an explicit skip condition.
- The same completed case or journal `Read` produces the same enriched activity
  label in main-agent and subagent views; raw resource ids and generic
  `journal corpus` labels do not survive completion.
- Running, completed, error, and interrupted activities retain one id and one
  visible row rather than disappearing or becoming a second label.

### Exact quotations

- Exact, straight/curly-quote, line-wrap, `[T]he`, `trial[s]`,
  `busybod[ies]`, and monotonic ellipsis cases pass as specified.
- An unmarked word, number, punctuation, negation, or modal substitution inside
  a marked quotation fails.
- Fuzzy similarity never turns a failed quote into a passing quote.

### Paraphrases

- An eight-token/51-character copied span fails when unquoted;
  individual words, trigrams, short terms of art, and repeated boilerplate do
  not.
- A genuine paraphrase may pass the overlap guard, but neither its receipt nor
  its viewer highlight is labelled as semantic verification.
- Each independently checkable paraphrased proposition carries its selected
  child receipt or receipts; a broad read range is not substituted for them.

### DOCX and artifact handoff

- One authored footnote can contain commentary and two citations without a
  nested Word footnote; full/`Ibid`/short-form sequencing remains correct.
- Model-visible artifact results contain no UUID, resource URI, or URL; the
  host event retains them and its pill opens the Library side panel.

### Live provider checks

After deterministic tests pass and live model calls are separately authorized,
run the same small matrix on Luna Low through the flat-rate Codex provider and
on Gemini Flash. Include an Alberta lease request: the assistant must ask only
the residential/commercial blocker through `ask_inputs`, then draft one DOCX
with linked content controls and no prose intake list. This implementation run
did not make those calls.

## Rejected designs

- No trigrams or individual-word borrowing gate.
- No fuzzy quote acceptance or edit-distance score shown to the model.
- No automatic quote repair.
- No claim that substring verification proves entailment or contextual
  fairness.
- No production NLI judge or second LLM verifier.
- No broad parent receipt when native children exist.
- No second model call solely to plan evidence.
- No parallel footnote or citation language.
- No model-authored document URL.
- No journal-citation fallback, metadata inference, or network lookup.
