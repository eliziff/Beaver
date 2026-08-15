# Mike fork capability survey

Date of finding: 2026-08-14

## Purpose and scope

This note surveys public GitHub forks and acknowledged hard forks of
Open-Legal-Products/Mike for capabilities that Beaver might reuse. The search
covered the GitHub fork network, repository and code searches for Canadian
signals, and prominent renamed descendants. README claims were checked against
implementation files where a candidate looked material.

The general finding is uninspiring: most forks are untouched copies, rebrands,
deployment substitutions, jurisdiction-specific prompts, or thin live-source
adapters. Beaver already has stronger local persistence, legal-source
structure, evidence, PDF, DOCX, citation, and Table of Authorities machinery
than nearly all of them. A few bounded ideas remain worth recording.

## Canadian-specific results

Only two substantive Mike forks in the public fork network explicitly target
Canada:

1. [Beaver](https://github.com/eliziff/Beaver), this repository.
2. [ROSS](https://github.com/ranade-oss/ROSS-RanadeOSS), an Ontario-focused
   operated-beta fork.

No third Canadian Mike product with an independent implementation emerged from
searches for A2AJ, CanLII, Canadian citations, provincial sources, Justice Laws,
and Canadian descriptions. A separate, non-Mike project,
[ca-eli-mcp](https://github.com/matematicsolutions/ca-eli-mcp), is relevant as a
small reference implementation for bilingual federal legislation retrieval.

### ROSS

ROSS adds several concrete Ontario capabilities:

- direct Ontario e-Laws and federal Justice Laws adapters with canonical URLs,
  bilingual links, consolidation metadata, source hashes, and section parsing;
- a versioned registry of Ontario civil and Small Claims procedure sources and
  official form catalogues;
- a narrow deterministic calculator for the counting conventions in Ontario
  Civil Rule 3.01 and Small Claims Rule 3.01;
- five Ontario litigation workflow prompts: pleadings issue extraction,
  documentary discovery review, affidavit fact checking, factum
  authority/record cross-checking, and Small Claims intake;
- upload quarantine and ClamAV scanning for the hosted product; and
- extensive source-health, release, approval, and public-beta governance.

The useful borrowing boundary is narrow. Beaver should consider official-source
refresh adapters, the procedural-source catalogue, and the Rule 3.01 calculator.
The adapters should feed a validated `OpenLegalData` snapshot rather than add a
second request-time research path. The daily live-source canaries and most of
the release-governance apparatus solve ROSS's operated-service concerns, not
Beaver's legal-research architecture.

### ca-eli-mcp

`ca-eli-mcp` retrieves Canadian federal Acts and regulations from the official
Justice Laws XML source. It returns English/French metadata, official links,
in-force status, last-consolidated dates, and full XML text. It is federal-only,
has no case law, and cannot do general free-text search; callers must know an Act
or regulation code or a supported short title.

Beaver does not need the MCP process or Python package. Its title/code alias
catalogue and official XML retrieval rules may be useful inputs to a small
`OpenLegalData` importer.

## Broader fork findings

## Low-value comparison — `eyecite` / `eyecite-ts`

Finding date: **2026-08-14**.

Closer review of Beaver's shared grammar tables, provider-grounded alias graph,
Table of Authorities, DOCX linking, and legal-PDF footnote machinery reversed
the initial assessment. Eyecite's headline features mostly duplicate Beaver or
solve U.S.-specific citation problems. In particular, Canadian subsequent
citations ordinarily use a case name or Ibid, not a neutral-citation or
reporter-only shorthand.

The only plausible differences are structured host/child relationships for
citations nested in explanatory parentheticals and generic maps from normalized
HTML back to original coordinates. Neither has a demonstrated Beaver failure or
high-value Canadian use case. Reporter catalogues, U.S. citation classes,
reporter-short-form resolution, confidence scores, and high-scale tokenizers do
not justify a dependency or experiment.

The corrected findings and reviewed Beaver implementation are recorded in the
[eyecite comparison note](eyecite-grammar-mining-note-2026-08-14.md).

## Wider Canadian legal-tech search — 2026-08-14

This follow-up searched beyond Mike forks for Canadian legal skills, MCP
servers, open-source applications, government repositories, datasets and
benchmarks. The useful results are concentrated in official/bulk data and
evaluation infrastructure. Most application repositories are familiar RAG
wrappers with little machinery Beaver should copy.

### High-signal sources

#### Justice Canada `laws-lois-xml`

Justice Canada publishes the consolidated federal Acts and regulations as
structured bilingual XML. The records expose substantially more than rendered
text: stable LIMS identifiers, point-in-time/current dates, in-force and enacted
dates, amendment dates, definitions and definition references, internal and
external cross-references, enabling authorities, historical notes, repeals,
schedules and recent-amendment records.

This is a good external source, but **not a new Beaver discovery**. Beaver's
existing source-gate fixtures already identify A2AJ federal `source_url` values
as Justice's raw `laws-lois` XML and distinguish them from the human section
URLs. The master plan already covers source-native markup and point-in-time
legal structure. The repository may still be useful as upstream documentation
and fixtures, but this search found no unowned feature here.

Source: <https://github.com/justicecanada/laws-lois-xml>

#### A2AJ citation network and expanded bulk corpus

The current A2AJ data advertises roughly 225,000 decisions and 22,785
legislation/regulation records, with API, Parquet, Hugging Face and MCP access.
Case records now include `cases_cited`, `cases_citing` and
`citing_cases_count`. The network is extracted from neutral citations and is
explicit about its blind spots: older reporter citations, docket-style
citations and courts outside corpus coverage.

Beaver already does more than merely use A2AJ bulk data. Its importer persists
`cases_cited_*`, `cases_citing_*` and `citing_cases_count`; its graph builder
prefers the provider graph; and its citator tests exercise those columns through
the real build script. The earlier provider-richness audit had already identified
this exact opportunity and the implementation subsequently absorbed it. This
search therefore supplies current upstream confirmation, not a candidate.

Source: <https://github.com/a2aj-ca/canadian-legal-data>

#### Justice Canada Otto

Otto is Justice Canada's AGPL Django platform for internal legal research and
analysis tools. Its public tree shows legislation loading, document libraries,
Q&A with highlighted answer sources, saved/shared presets, translation with
uploaded glossaries, source-citation UI, document filters, cost warnings,
evaluation fixtures and asynchronous ingestion. Infrastructure code and the
department's actual private applications are omitted.

There is no compelling engine to transplant wholesale. Two modest product
ideas are worth recording: translation glossaries as a first-class matter
artifact, and editable team-scoped task presets. Both are more concrete than a
large stochastic skill registry, but neither outranks current deterministic
document work.

Source: <https://github.com/justicecanada/otto>

#### Canadian citation parser

`646e62/legal-citation-parser` deterministically parses Canadian neutral,
S.C.R. and CanLII citations into style of cause, year, decision number,
jurisdiction, court and URL, with optional CanLII metadata/citator lookup. It is
small and conceptually sound, but GPL-3.0 and apparently dormant since 2024.

Beaver already covers the supposed gap. `citationKey.ts` detects neutral,
S.C.R., provincial reporter and CanLII-shaped citations; `caselawCitator` treats
parallel neutral/reporter citations as aliases; and the real graph tests include
`2015 SCC 5` / `[2015] 1 SCR 331` equivalence plus pre-neutral S.C.R. fixtures.
This project is, at most, an external comparison corpus. It is not a feature
lead.

Source: <https://github.com/646e62/legal-citation-parser>

#### Canadian legal evaluation data

- **CanLegalRAGBench** evaluates retrieval-augmented generation on Canadian
  case law and reports that retrieval design materially changes performance;
  it is a candidate external benchmark for Beaver's search, not a feature.
- **AsyLex** contains Canadian refugee-status decisions, expert-labelled legal
  entities and outcome labels. The entity annotations could supply fixtures for
  dates, countries, claims, procedural posture and outcomes without adopting
  its predictive-outcome framing.
- **Prinzbench** is a private-question benchmark for difficult legal research
  and public-web search. Its public scores are interesting model-routing
  evidence, but private questions prevent independent use as a durable gate.

Sources: <https://arxiv.org/abs/2605.30497>,
<https://github.com/clairebarale/AsyLex>, and
<https://github.com/prinz-ai/prinzbench>.

### Low-signal or duplicative projects

Several CanLII MCP servers expose lists and metadata for courts, cases,
legislation and citation relationships. The better-maintained Vaquill fork adds
bring-your-own-key HTTP authentication, per-key rate limiting and a hosted
endpoint, but correctly warns that CanLII's API supplies metadata rather than
full decision text. Beaver's bulk local corpus and evidence system make these
connectors regressions, not features.

`LegalNexus` combines case workspaces, CanLII scraping, FAISS, LangGraph,
model-graded relevance, model-graded hallucination checking and web fallback.
It is an ambitious conventional RAG application, but its core quality controls
are additional model opinions rather than deterministic evidence. Beaver has
little to borrow beyond the already-owned concept of matter isolation.

OpenJustice/MyOpenCourt describe guided questionnaires and lawyer-authored
decision pathways before an LLM turn. That is directionally better than pure
prompting and supports Beaver's rule-pack thesis, but the discoverable public
material did not expose a reusable current code or rule corpus.

Sources: <https://github.com/Alhwyn/canlii-mcp>,
<https://github.com/Vaquill-AI/canlii-mcp>,
<https://github.com/daniel-debrun/LegalNexus>, and
<https://openjustice.ai/>.

### Canadian-specific shortlist delta: none

After tracing the findings through Beaver rather than comparing by repository
name, this search adds **no justified implementation item**:

- Justice raw XML was already known to the source-ingestion/gate work;
- A2AJ's provider citation graph is already persisted, compiled and tested; and
- neutral, S.C.R., reporter and CanLII citation identities already have shared
  parsers, aliases and fixtures.

Otto's translation glossary and team-preset UX remain minor product references.
CanLegalRAGBench and AsyLex remain possible external evaluation material, not
features. Everything else found was another metadata connector or generic RAG
stack below Beaver's present architecture.

This correction matters: the external search validated that Beaver had already
harvested the strongest Canadian primitives. It did not produce a fresh
shortlist, and the earlier version of this section overstated novelty because it
did not inspect the project deeply enough.

### High-value bounded candidates

#### Tamper-evident matter export — tritium-legal/mike

[Tritium's fork](https://github.com/tritium-legal/mike) exports a canonical
project manifest containing SHA-256 hashes for document versions, the
accept/reject trail, deleted-version records, a digest of the canonical
manifest body, and an optional Ed25519 signature. The verification key is
published separately so replacing an embedded key cannot masquerade as
provenance.

This is the cleanest borrowing candidate. Beaver already owns document hashes,
versions, evidence, and receipts. A signed export should be a final projection
over that durable state, not a new ledger or event subsystem.

#### Microsoft Word task pane — augment-cro/Eulex-desk

[Eulex Desk](https://github.com/augment-cro/Eulex-desk) includes an Office.js
Word add-in with streaming chat, project selection, current-selection context,
open-DOCX byte upload, native Word tracked-change operations, comments, and a
one-time account-pairing flow.

The product shape is valuable because lawyers work in Word. The implementation
is only a reference: it stores a bearer token in task-pane local storage and
admits that some assistant writes strip rich formatting. A Beaver add-in should
reuse Beaver's versioned document session and deterministic mutation receipts,
with Word selection/range IDs as another projection over those operations.

#### Runtime deployment configuration — Altien/mikeOssAzure

[Mike for Azure](https://github.com/Altien/mikeOssAzure) moves tenant-specific
browser settings behind a backend `GET /config` endpoint and builds one static
frontend/backend/LibreOffice container. The useful idea is a verified frontend
artifact that can run against different deployment compositions without
rebuilding `NEXT_PUBLIC_*` values. Its Entra, Azure Blob, Azure OpenAI, and
installer machinery should not be imported unless Beaver actually adopts those
deployment targets.

#### Optional local models — tritium-legal/mike

Tritium dynamically lists installed Ollama models. Tool-capable models receive
the assistant tool surface; other models fall back to plain chat. A narrow
OpenAI-compatible local provider could be useful for confidential plain chat,
cheap extraction, and experiments. It should remain optional and must not be
advertised as a legal agent merely because an endpoint returns tokens.

#### Desktop packaging details — rafal-fryc/mikelocal

[Mike Local](https://github.com/rafal-fryc/mikelocal) supplies an Electron
shell, workspace-folder selection, random local ports, startup health gating,
an NSIS installer, path-bound filesystem access, and optional LibreOffice
bundling. Beaver already has the important local SQLite/filesystem composition
without Mike Local's Supabase compatibility shim. Possible references are a
portable workspace selector, installer construction, and secret-scrubbed child
process environments.

Its lock screen is not encryption: the database, documents, and model keys
remain readable from the workspace. It should not be copied or described as
protecting data at rest.

### Jurisdictional adapters with limited transferable value

- [EU-Mike](https://github.com/lucianschw-dev/eumike) resolves CELEX, ECLI, and
  ELI identifiers through EUR-Lex.
- [MikeNL](https://github.com/Jeroen1991z/mikeNL) retrieves Dutch judgments and
  legislation and highlights the cited passage in a side panel.
- [Michi](https://github.com/beniauer/michi) queries Swiss cases, statutes, and
  commentary through OpenCaseLaw.
- [RapidAct](https://github.com/fikriberkyuce/RapidAct) adds Turkish litigation
  workflows and a legal-source connector.
- [Patron](https://github.com/matematicsolutions/patron) bundles Polish and EU
  legal-source MCP servers.

The transferable lesson is the normalization of jurisdiction-native
identifiers, language variants, canonical URLs, and verification states. Beaver
already has the better destination for that work in `OpenLegalData`,
`SourceDoc`, and its evidence contracts. A separate MCP process per source
would add deployment and schema overhead without improving fidelity.

### Already surpassed by Beaver

The following fork features should not be imported:

- Mike Redline's CriticMarkup-like insertion, deletion, and comment markers;
  Beaver already has a broader governed DOCX projection and fidelity corpus.
- MikeNL's passage-highlighted side panel; Beaver already generates native
  pinpoints and deterministic text fragments for a structured source viewer.
- generic MCP support, provider selection, workflow templates, local SQLite,
  local file storage, and source-grounded chat;
- Case.dev's metered storage, RAG, skills, model gateway, and legal-research
  services, which duplicate Beaver-owned capabilities and introduce a mandatory
  external dependency; and
- wholesale rewrites such as MikeRust's Rust/Axum/Tauri/Svelte stack. MikeRust
  may be an interesting independent product, but adopting it would replace
  Beaver rather than improve it.

## Louis Legal's 983-skill router

The provenance audit, exhaustive 983-file measurements, merger with the prior
Lawve/Lawvable audit, and current-code-aware deterministic shortlist now live in
the canonical
[legal skills ecosystem comparison](legal-skills-ecosystem-comparison.md).
This section retains the fork-survey summary only.

[Louis Legal](https://github.com/sboghossian/louis-legal) is the exceptional
fork because its architecture is both unattractive as a runtime and valuable as
a requirements mine.

### What it actually is

Louis contains an auto-generated registry reporting 983 Markdown skill files:
982 marked `drafted` and one marked `stub` as of this survey. Earlier inventory
documentation describes a smaller hand-authored core plus imported prompt
packs, but the current registry has promoted almost everything to `drafted`.
That status should not be confused with implemented or validated behavior.

Each skill is a Markdown file with small YAML frontmatter and a prompt body.
Examples include:

- `review.cross-reference-integrity`;
- `review.definitions-consistency`;
- `efirm-finance.trust-account-reconciliation`;
- `casesim.settlement-vs-trial-EV-calculator`;
- `tool.date-tool-deadline-calculator`;
- `draft.MSA`;
- drafting and review templates for many document types;
- firm operations, billing, intake, research, safety, evaluation, marketing,
  product documentation, integrations, and simulated advocacy.

Most files are not tools. They do not contain executable logic, authoritative
law, structured validation, or a test oracle. They are short checklists or
instructions telling a model how to behave and what result shape to imitate.

### How routing works

The runtime flow is approximately:

```text
user message
    |
    +-- keyword/regex intent, document-type, language and jurisdiction guesses
    |
    +-- optional cheap-model classifier
            |
            +-- practice area and narrow intent
            +-- confidence and risk
            +-- recommended model tier
    |
intensity governor: quick / standard / thorough
    |
select roughly 5 / 9 / 13 skill cards
    |
concatenate Markdown bodies into one system-prompt suffix
    |
run an ordinary model turn
```

The loader recursively reads every frontmatter-bearing Markdown file into a
process-wide map. The router begins with always-on persona, conversation,
safety, jurisdiction, and arithmetic cards. It adds cards selected by regexes
for drafting, review, research, comparison, summarization, translation,
calculation, and advice. An optional classifier supplies a practice area,
intent, confidence, model recommendation, and playbook. A cost governor then
chooses `quick`, `standard`, or `thorough`, which determines model/effort tier
and caps the number of selected skills at approximately 5, 9, or 13. The final
implementation simply concatenates the chosen Markdown bodies under `SKILL`
headings.

Louis therefore has two stochastic control layers before the substantive
stochastic task:

1. a model or heuristic guesses which prompt fragments matter; and
2. the main model interprets those fragments and performs the work.

The catalog also mixes fundamentally different things under one abstraction:
legal tasks, output formats, safety rules, product marketing, CRM connectors,
personas, tutorials, internal engineering notes, firm finance, and supposed
tools. Several cards name integrations such as Westlaw or LexisNexis without
making the named service exist. `status: drafted` consequently says little
about operational capability.

### Why this is poor coding-agent architecture

Coding agents work best with a small stable resident surface and executable
tools loaded by explicit capability name. Louis instead asks a classifier to
rank a very large prompt library and hopes that the resulting prompt mixture
causes the model to simulate the right tool or workflow. The weaknesses are:

- nondeterministic capability availability;
- silent routing misses and false positives;
- overlapping or contradictory prompt cards;
- schema and token cost proportional to prompt composition;
- no compiler-enforced connection between a named skill and executable code;
- no durable output contract or evidence receipt merely because a card asks
  for JSON-like output;
- difficult regression testing across 983 interacting prompt fragments; and
- inflated capability claims: a filename such as `deadline-calculator` or
  `trust-account-reconciliation` does not implement arithmetic, calendars,
  accounting constraints, or jurisdictional rules.

This is the opposite of Beaver's approved direction: a small resident registry,
explicit exact-name specialist loading, deterministic tools for deterministic
work, and model calls reserved for genuine ambiguity.

### Why the corpus is still useful

The catalog is a broad, if noisy, survey of things lawyers and legal teams may
ask an LLM to do. It is valuable as a crib sheet for product discovery, not as
production prompt infrastructure. Some cards identify operations that are good
candidates for deterministic or hybrid implementations:

| Louis card or family | Better Beaver implementation |
| --- | --- |
| Cross-reference integrity | Parse clause, schedule, exhibit, bookmark, and page-reference targets; resolve them against the document graph; report broken and ambiguous edges. |
| Definitions consistency | Build a definition/use index with exact anchors; detect undefined, unused, duplicate, variant, and use-before-definition terms; ask a model only about semantic contradiction. |
| Numbers and dates double-check | Reconcile typed numeric/date anchors against source spans and derived values; produce exact mismatch receipts. |
| Deadline calculator | Encode only named jurisdictional counting rules, holidays, service adjustments, and explicit refusal cases; show every included/excluded date. |
| Trust-account reconciliation | Import ledgers, enforce three-way equality and per-client non-negative balances, and emit auditable exceptions; never ask a model to perform the reconciliation. |
| Settlement-versus-trial expected value | Deterministic scenario and sensitivity calculator over user-supplied probabilities and costs; keep the probability estimate and strategic advice explicitly human/model supplied. |
| Signature-page detector | Deterministic document-structure and visual candidates with exact pages; model review only for ambiguous signature context. |
| Missing schedules and exhibits | Compare references against package inventory and document relationships. |
| Clause and document drafting cards | Treat as intake/checklist candidates and test corpora, not trusted clauses. Generate through Beaver's document tools with jurisdiction/source requirements and human approval. |
| Billing narrative cleanup | Preserve time, amount, matter, actor, and activity anchors; permit bounded wording transformation while refusing changes to economic facts. |
| Conflict check | Normalize parties and related entities, search authoritative matter/contact indexes, return candidate matches; require human disposition. |
| Citation and quotation checks | Use Beaver's source resolution, exact passages, pinpoints, hashes, and receipts rather than prompt instructions. |
| Contract review families | Convert recurring checks into typed analyzers only where precision can be demonstrated; leave commercial judgment to the model or lawyer with cited clauses. |

The correct harvesting process is:

1. Export only the skill ID, category, required inputs, claimed outputs, and
   checklist—not the runtime router.
2. Remove marketing, product documentation, personas, unsupported connectors,
   duplicate cards, and jurisdictionally irrelevant material.
3. Cluster the remainder by underlying operation rather than document label.
   For example, dozens of agreement-review cards may reduce to definition,
   cross-reference, party, date, amount, obligation, option, consent,
   termination, and citation primitives.
4. Map every cluster to an existing Beaver primitive before proposing code.
5. Classify the residual operation as deterministic, bounded hybrid, model-only,
   or not worth building.
6. Require a real caller, a typed contract, and a fidelity or behavioral test
   before promotion into production.
7. Keep the harvested catalogue and experiments outside production until a
   capability proves useful.

The important opportunity is contraction: 983 prompt labels may collapse into
dozens of durable primitives plus a smaller set of user-visible workflows. The
catalog should help Beaver discover missing work, not persuade Beaver to build
its own semantic skill router.

## Ranked borrowing shortlist

1. Signed matter/project export manifest from Tritium.
2. Official Justice Laws and Ontario e-Laws refresh adapters informed by ROSS
   and `ca-eli-mcp`.
3. Small Ontario procedure/form registry and narrow Rule 3.01 calculator.
4. Harvest Louis's skill filenames and checklists into an experimental legal-
   work capability inventory, then reduce them to deterministic primitives.
5. Office.js Word task pane built on Beaver's own mutation contracts.
6. Runtime frontend configuration from the Azure fork.
7. Optional capability-gated Ollama/OpenAI-compatible local model adapter.
8. Portable workspace selection and installer details from Mike Local.

Only the first four are plausible near-term research or implementation work.
The rest should wait until Beaver's canonicalization is complete. The survey
must not become another justification for adding parallel runtimes, adapters,
or registries.
