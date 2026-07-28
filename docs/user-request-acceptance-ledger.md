# Beaver user-request and acceptance ledger

Status: authoritative requirements record; implementation is paused

Last reconciled: 2026-07-27

This records the product the user asked for across this working session. It is
not evidence that any item works. An item remains unaccepted until the current
production build, local services, durable restart behavior, and generated
artifacts pass the relevant checks below. Source changes, focused unit tests,
agent reports, and screenshots of a fixture are supporting evidence only.

`beaver-master-plan.md` continues to own priority and status. This ledger owns
request traceability and the detailed acceptance language that must not be
lost during compaction or delegation.

## Control rules

- Do not ask the user to repeat a requirement already recorded here.
- The newest specific instruction overrides an older conflicting instruction.
- Do not report a fix from an unbuilt worktree or a stale running process.
- Verify the exact live build the user can see.
- Treat repeated visual complaints as a design-system regression class, not a
  queue of isolated CSS symptoms.
- Compare changed workflows with the named reference implementations before
  inventing a replacement.
- Keep one canonical implementation of each workflow.
- Remove dead, legacy, compatibility, and speculative code. There are no
  external Beaver users whose compatibility must be preserved.
- Preserve useful warmup. Performance work must be a measured strict win, not a
  loading trick that makes the interface feel worse.
- Do not push to a remote unless the user gives fresh authorization. Local
  commits are required as coherent checkpoints.

## Final product and architecture decisions

- The product name is **Beaver**.
- Account-free local mode is first-class.
- Cloud, Supabase, and R2 compatibility remains; local mode does not delete the
  cloud path.
- Local documents, databases, downloads, indexes, and caches use the shared
  `OpenLegalData` AppData contract.
- SQLite is the normal runtime data format. Bulk import dependencies such as
  DuckDB, PyArrow, and Parquet readers stay optional.
- ALR Quote Verifier remains an independently maintainable product. Port small,
  neutral, tested algorithms; do not import its private modules or create
  brittle runtime coupling.
- `universal-legal-pdf-engine` owns neutral legal-PDF structure.
- Beaver remains a modular monolith. Add a process/provider/repository boundary
  only for a genuine external boundary or independently owned subrepository.
- Models and effort levels come from provider capabilities. Do not hardcode a
  reduced catalog and do not reject valid values such as `max`.
- Pinpoints, URL fragments, exact lookups, citation splitting, simple Word
  mutations, and durable receipts are deterministic tools rather than prose the
  model must hand-roll.
- The legal ontology, saved-case labels, research maps, and flowchart viewer
  share one renderer-independent graph backbone.

## Product-wide visual and interaction contract

### Simplicity and hierarchy

- The interface is plain, high-contrast, compact, and lawyer-grade.
- Remove gradients, glass effects, decorative animations, skeuomorphic clutter,
  redundant cards, redundant headings, and explanatory prose that repeats the
  visible control.
- Only links use blue. Beaver accents are Canadian red; generated legal
  documents are black except for hyperlinks and deliberate review marks.
- Typography has an intentional hierarchy. Large text means primary
  information, not a missing-source row or a low-priority option.
- Controls in a row align to a consistent grid.
- Dropdowns, inputs, buttons, checkboxes, and labels have proportionate sizes.
- Text never breaks mid-word, gets crowded out, or requires horizontal scrolling
  merely to reveal a title.
- The default interface is larger and more legible than the earlier undersized
  UI, without wasting viewport space.
- Descriptive copy such as “These choices are used by the automatic workflow”
  is removed. Necessary explanation belongs in concise, accessible help.

### Redundancy audit

- Audit every primary route and reusable panel for adjacent text that conveys
  the same fact twice: repeated filenames, `Selected:`/`Current:` restatements,
  type or capability badges, headings echoed by card titles, counts repeated in
  labels, and helper prose that merely expands the visible control label.
- Delete the duplicate rather than rephrasing it. Keep supporting copy only
  when it explains a material consequence, tradeoff, recovery step, or
  unfamiliar legal concept.
- A badge survives only when it communicates otherwise unavailable,
  actionable state. File type, deterministic implementation, workspace name,
  and obvious selection state are not badges.
- Validate the audit with actual desktop and narrow screenshots of the live
  product. Source review alone is not acceptance.

### Unbounded-collection audit

- Audit every dropdown, menu, tab strip, and eager list whose options can grow
  with user or provider data. Document versions, projects, chats, workflows,
  sources, labels, authorities, and histories must be assumed to reach hundreds
  or thousands of entries.
- Replace unbounded dropdowns with a searchable list or panel that supports
  keyboard navigation, bounded rendering, recent/relevant ordering, and
  pagination or incremental loading from the durable store.
- Keep true dropdowns only for small, closed vocabularies. A current fixture
  containing four entries is not evidence that the collection is bounded.
- Test large fixtures for render cost, search, selection, focus return, and
  stable geometry at desktop and narrow widths.

### Zero-jitter geometry

- Navigation, route changes, option loading, model loading, workflow loading,
  question prompts, reasoning state, document panes, and embedded Authorities
  preserve their final geometry from the first rendered frame.
- No element changes width because it becomes active, gains a caret, receives a
  count, changes label, or finishes loading.
- No sidebar section expands or collapses in a way that moves the target the
  user just clicked.
- No view inserts a banner, progress bar, question panel, model stub, iframe, or
  status row into normal flow after first paint.
- Reserve dimensions for images, document pages, embedded apps, and async
  content. Use stable shells, not blank-then-populated regions.
- Preserve shared layouts and component identity across navigation. Do not
  remount the whole shell or cancel an assistant request because another tab
  was selected.
- Measure layout shifts in production navigation and first interaction. A
  regression test must fail when stable control/tab geometry changes.

### Pop-ups, dialogs, panels, and help

- Escape closes dialogs, menus, and non-destructive pop-ups.
- Dialogs trap focus, restore focus to the opener, remain within the viewport,
  and use internal scrolling for long content.
- No dropdown or pop-up extends to the top or bottom edge of the screen.
- Menus choose an initial direction based on available space and have a bounded
  height.
- Arbitrarily growing collections such as projects are not dropdowns. Use a
  searchable list/modal.
- `(i)` help has a visible hit target and predictable hover, focus, click,
  Escape, outside-click, and focus-return behavior. It must not flicker,
  reposition surrounding controls, obscure the option being explained, or be
  mouse-only.
- The Document Actions surface is a floating, minimizable, dockable panel, not
  a modal that monopolizes the app.
- The Questions surface has a stable compact height, never covers the composer,
  and is no wider than its content requires.

### Controls

- Native checkboxes are visually consistent, at least 18 px, with at least a
  36 px target, visible focus, and a real indeterminate state where needed.
- Every select-like control has an obvious caret.
- The caret, label, and selected value do not alter control width.
- Option labels describe the outcome a human receives. Internal names and
  abstract implementation modes are not user-facing language.
- Parent-child choices such as provider/model/effort should not become three
  unrelated dropdowns. Model choice is coherent; effort remains a separate,
  prominent control.
- Keyboard shortcuts form a small consistent language, including Escape,
  search focus, new-item actions, and documented navigation shortcuts.

### Icons and motion

- Use simple flat symbols or restrained Unicode where raster icons do not read
  clearly. Do not use colourful platform emoji.
- Folder icons must unmistakably look like folders everywhere.
- The only assistant waiting animation is a simple red thinking spinner in the
  ALR/Claude spirit. No maple-leaf loading animation.
- Respect reduced motion. Remove animations that do not communicate state.

## Performance and maintainability

- Beaver must remain usable on weak hardware (“run on a potato”).
- Profile build, bundle, startup, route navigation, interaction latency,
  document rendering, first assistant token, Library loading, and Authorities
  creation before and after structural changes.
- Keep only measured strict wins.
- Remove duplicate implementations, dead branches, compatibility shims,
  test-only production query switches, excessive comments, speculative
  wrappers, one-use interfaces, and route-global heavy imports.
- Use native browser behavior, the standard library, and existing dependencies
  before adding a package.
- Lazy-load truly route-only heavy code, but do not defer ordinary controls or
  useful warmup in a way that creates pop-in or slower first use.
- Prefetch likely navigation using the framework’s stable shared-layout model.
- Do not cancel work when the user changes tabs.
- Build times should be dramatically shorter through less code and cleaner
  boundaries, not version-number churn or skipped verification.
- The backend must be responsive, single-flight expensive work where
  appropriate, cache durable results, and avoid repeatedly parsing the same
  source.
- Record production build and interaction measurements; do not claim “5x” or
  any other improvement without comparable before/after medians.

## Local runtime, storage, and repositories

- Clone and maintain Beaver locally with coherent local Git commits.
- Keep the independent subrepositories pinned and commit nested repositories
  before updating bundles, lock records, and root gitlinks.
- Do not commit credentials, AppData, model traces, downloaded corpora, caches,
  generated authorities, or managed runtimes.
- One launcher starts backend, frontend, and Authorities, diagnoses ports and
  dependencies, reports owning PIDs, and stops only its own processes.
- Missing dependencies such as `duckdb` must not appear randomly. Optional bulk
  readers do not load in the normal runtime.
- The normal UI does not expose “local runtime,” data-directory paths, DuckDB
  implementation details, or other operator internals.
- A clean supported machine can run the local product without an account.

## Branding, navigation, onboarding, and settings

- Use the Beaver name, a maple-leaf identity mark, and restrained red accents.
- Assistant history lives under Assistant. Authorities history lives under
  Authorities. Other feature history is scoped to its feature.
- Sidebar targets do not move when a section is selected.
- Settings is one normal bounded modal/surface. “API keys” is not a persistent
  bottom navigation item; it lives inside Settings.
- Local Settings reports configured provider credentials without displaying
  secret values. Cloud Settings preserves editable encrypted keys.
- An optional future profile onboarding asks what legal work the user does and
  offers editable presets. A litigator preset may foreground Authorities.
- Do not ship solicitor/litigator presets until implemented capabilities make
  the distinction meaningful.

## Assistant model, provider, session, and reasoning contract

- Keep local Codex authentication and Codex-based model selection.
- Do not present a redundant “Codex local” option beside the same models.
- Enumerate the full available Codex model and effort catalog dynamically.
- Effort is a separate control, not buried in model controls.
- Wire DeepSeek from its environment credential.
- Support OpenAI, Claude, Gemini, Codex, DeepSeek, OpenRouter, and Muse Spark
  where credentials and provider capability are real.
- Do not call Gemini when the selected model is not Gemini; an invalid Gemini
  key must not randomly break another provider.
- Remove duplicate Luna/model entries.
- The selected model is visible on refresh before first interaction.
- Preserve Mike’s useful session semantics while bridging Codex continuation,
  caching, and persistent sessions in a defensible way.
- Compare session and cache behavior against official OpenAI/Codex guidance and
  OpenCode rather than assuming equivalence.
- Keep provider sessions where they save tokens/latency without making provider
  state the sole durable legal record.
- Expose only tools the selected provider/model can actually use.

### Reasoning and activity display

- Add an experiment in which the model does not narrate a reasoning trace.
  Instead, translate actual tool calls and durable state changes
  deterministically into concise human-readable activity.
- The collapsed `Working…` row shows the current reasoning/tool activity, not a
  generic label or a redundant “Analyzed request.”
- Expanded activity shows one chronological bullet list under one disclosure,
  not many one-step cards.
- Never expose raw tool IDs, raw Markdown, internal validation failures, or
  generator-specific implementation language.
- Model text must not be truncated between tool steps or concatenated without
  punctuation.
- The waiting indicator/message stub/red circle must be visually simple and
  integrated rather than floating as an ugly separate object.

## Assistant work-product behavior

- Assume the user is producing work for a client unless they say otherwise;
  encode that as a small stable instruction, not repeated prompt bloat.
- When asked to draft an agreement or legal instrument, generally create an
  editable Word document rather than dumping the whole draft into chat.
- Use modern Word content controls for editable fields.
- Weak models must be able to produce the supported draft representation
  without repeated validation failures or giving up on content controls.
- The model does not respond with suggestions when the request is to revise or
  redline a selected document. It performs the revision and shows real-time
  redlining in the document view.
- Restore the original Mike real-time Word redlining experience, including
  accept/reject and durable versions.
- Changing tabs does not cancel drafting/redlining.
- “Start chat in project” works, and each existing sidebar chat can be moved
  into or out of a project through a bounded non-dropdown project chooser.
- Agent-invoked Authorities, supra repair, citation hyperlinking, and later
  document automations appear as one durable **Automation run** contract in
  Assistant: a compact inline status that can dock into the Assistant side
  panel. It reports actual tool stages/results and never navigates away without
  an explicit user action.
- In-app deep links can point to any relevant Beaver content.

## Chat history and deletion

- Every chat deletion presents a warning before any destructive API call.
- Normal deletion is a soft delete into an Assistant `Recycling bin`.
- Deleted chats remain restorable for 30 days.
- At 30 days they are purged and no longer restorable.
- Manual permanent deletion is available only inside the bin and requires a
  second explicit warning.
- Soft deletion aborts an active turn and prevents a stale turn from writing
  into or resurrecting the tombstone.
- Local versioned chat JSON migrates without losing existing histories.
- Cloud chat rows use the same active/deleted contract.
- Project single deletion, project bulk deletion, sidebar deletion, and
  current-chat deletion use the same warning and lifecycle.
- Deleted project chats retain sufficient project context in the bin.
- History is a readable list, not a dropdown or a hostile tiny scrollbar.

## Projects, Library, workflows, and tabular reviews

### Projects

- Projects use textual controls such as an expanded Search field and
  `Create project +`, not mystery icon-only controls.
- Project creation populates the created date.
- Project rows use real folder icons.
- Rename and Delete need not hide behind an ugly three-dot control when there
  is room for clear actions.
- Project filter pills are not clipped.
- An empty folder is a valid empty state, never “Something unexpected
  happened.”
- Single click selects a Library item; double-click or an explicit View action
  opens it.
- “Click on a document to display here” must actually display the selected
  document.
- Project chat/document/review context is always obvious and contains no
  redundant prose restating the current folder.

### Library

- Local upload/import works without cloud storage.
- Keep cloud storage compatibility.
- Use one generic Upload document action rather than redundant Open PDF/Open
  DOCX/Open Text actions.
- Workflow capsules receive the selected document programmatically. “Extract
  text” must not ask the user to provide a document that is already selected.
- Templates and default Mike workflows are available locally so the product’s
  intended capabilities can be exercised.

### Workflows and tabular reviews

- Workflow browsing is fast, stable, and free of hover rectangles/pop-in.
- Project tabular reviews work in local mode.
- Project selection uses a searchable list rather than an unbounded dropdown.
- Tabular/Authorities/history state persists in the feature where it belongs.

## DOCX drafting, schema, display, and deterministic editing

### Authoring representation

- Use one semantic Markdown-to-DOCX pipeline; do not retain a separate legacy
  `sections[]` path after it is superseded.
- The model emits the smallest legal drafting representation that preserves
  necessary structure:
  - headings and heading levels;
  - paragraphs and clauses;
  - ordered/unordered/legal nested lists;
  - tables;
  - footnote references and footnote bodies;
  - citations/source handles;
  - defined editable fields/content controls; and
  - only the formatting decisions that genuinely require legal judgment.
- Deterministic rendering handles numbering, spacing, styles, pagination,
  cross-references, fields, headers/footers, and Word XML mechanics.
- A pre-baked precedent can be genericized with the lightest possible model
  transformation while deterministic code preserves the document’s structure
  and styles.

### Lawyer-grade output

- Default Word output uses a restrained professional legal template sourced
  from established legal/document conventions, not invented blue-heading
  styling.
- No raw Markdown, `{-}`, escaped underscores, duplicate numbering, or
  generator markers appear in output.
- Legal clauses and nested list items have correct indentation and numbering.
- Headings are black unless a template explicitly requires otherwise.
- Footnotes appear at the correct references and pages.
- Fields are declared and validated before generation so the assistant does
  not retry/fail in front of the user.
- Multiple pinpoints to the same authority do not repeat the whole citation
  unnecessarily.

### Display fidelity

- Port the relevant pagination/footnote/image logic from
  `Coding\Docx to html\Current\Convert to HTML [current]`.
- Display saved page breaks and visible page boundaries.
- Footnotes appear on the right pages.
- The footnote list exposes every footnote; it must not stop at four.
- Embedded and floating images render with correct dimensions.
- Tables, lists, headers, footers, styles, italics, and tracked changes render.
- The display remains fast on large documents and weak hardware.
- Unsupported Office vector formats use the most faithful existing
  Office-to-PDF path rather than silently disappearing.

### Deterministic actions

- Prefer find/replace, style application, spacing normalization, cross-reference
  repair, and other bounded mutations over model-authored full rewrites.
- Expose common actions directly in the dockable Document Actions panel and
  finer actions as model tools.
- Include configurable single/double spacing after periods and other standard
  Word cleanup operations.
- Port useful generic deterministic functions from the supplied ALR macro,
  such as supra repair, while excluding law-review-only niche machinery.
- Allow creation and maintenance of Word content controls and linked objects.
- Keep document version, accepted/proposed edit state, and mutation receipts
  durable.

### Document-version semantics

- Preserve the proven Mike model: the original upload is a durable version; a
  later user upload, generated replacement, or one consolidated assistant-edit
  turn may create the next durable file version.
- Multiple edit tool calls in one assistant turn reuse that turn's version.
  Accepting or rejecting individual tracked changes updates the same working
  version and its edit receipts; it does not create a version per click.
- Autosaves, viewer state, selected history entries, parse artifacts, and
  accept/reject UI state are not user-facing document versions.
- Audit the local and cloud stores, APIs, labels, history UI, downloads,
  redlining, and restoration against the original Mike behavior before
  changing the definition or terminology.

## Legal PDF structure and universal parsing

- For digital-born or embedded-text PDFs, deterministically build:
  - page and line structure;
  - headings and heading hierarchy;
  - sections, subsections, paragraphs, subparagraphs, clauses, and lists;
  - tables and legislative indentation;
  - footnote references and footnote bodies;
  - footnote-to-proposition pairing; and
  - exact source coordinates and hashes.
- Use `.docx` files in ALR Quote Verifier as ground truth for PDF equivalents.
- Export deliberately poorer/less rich PDFs and measure what can still be
  reconstructed; do not assume a good PDF export.
- Port the proven improvements from ALR’s experimental PDF adapter and its
  page/page-range handling, including `[page n]`.
- For difficult structure, use a bounded cheap Luna/Codex r=1 moving-context
  repair rather than whole-document model parsing.
- Benchmark multiple real models on the structural repair task using real
  calls.
- Reach the authorized remote desktop/E: benchmark data when necessary.
- Build two portable modes:
  - a weak-hardware deterministic local parser; and
  - the same parser with bounded Codex calls for hard cases.
- Search for and test a diverse, licensed set of American, Canadian, and UK
  legal PDFs. Improve robustness without exploding code size or complexity.
- Benchmark claims fail closed: automatic, provisional, duplicate, or
  derivative labels are not human gold.

## Legal-source retrieval, structure, and links

- Integrate A2AJ as a first-class legal source.
- Port ALR’s reconstruction of sections, paragraphs, and pages when A2AJ output
  does not natively provide them.
- Handle sections, subsections, paragraphs, subparagraphs, clauses, schedules,
  rules, articles, and provider-specific variants skilfully.
- Use provider-native structure whenever available; reconstruct only what is
  absent.
- Cover A2AJ, CourtListener, CanLII-relevant sources, SCC, Ontario decisions,
  TNA Find Case Law, GOV.UK, employment tribunals, GovInfo, and journal
  articles.
- Support lawful bulk data for CourtListener and any other provider that offers
  it.
- Use `public_endpoint.db` for journal articles and give the model exact
  passage/page lookup.
- Share downloaded source/cache files across Beaver, Authorities, and ALR
  through AppData without coupling their codebases.
- A model can request one paragraph, section, page, footnote, or passage without
  parsing the full document.
- The lookup result automatically appends a direct pinpoint:
  - native `#par`, `#sec`, or provider anchor where supported;
  - text-fragment URL otherwise;
  - multi-text directive for multiple excerpts on one target; and
  - local durable viewer link when no suitable public URL exists.
- The model asks for the desired locator and never spends output tokens
  constructing the URL.
- Always offer the original source webpage and an online source PDF when one can
  be resolved.
- Citations inserted into DOCX work products carry these precise links.
- Exact lexical/pinpoint retrieval is authoritative. Vector embeddings/TurboVec
  may generate candidates but cannot replace exact evidence.
- Retrieval over bulk legal data and `public_endpoint.db` must be measured for
  recall, precision, cost, and latency.

## Legal Library and galley viewer

- Port substantially more of the visual language and formatting grammar from
  the Text Fidelity/Open Legal Journals galley viewer.
- Do not use an asinine paragraph-by-paragraph side table of contents or a
  “select paragraphs” dropdown.
- Render cases and legislation consistently while respecting their different
  structures.
- Apply heading grammar, legislative list indentation, tables, snippets,
  italics (`em` and equivalent source tags), and native A2AJ formatting.
- Remove diagnostics and raw Markdown from the reader.
- Provide jurisdiction, court, date, source, and other filters informed by
  A2AJ Law, CanLII, and the providers’ actual metadata.
- Offer `View` without forcing `Save and open`.
- Allow saving/marking sources per project with hierarchical labels based on
  the useful ideas in CanLII Rememberer.
- Marking/tagging and ontology graph nodes share one durable data model.
- A Library source is normally a pointer into bulk/cache data, not a copied
  durable blob.
- The viewer can open in an existing pane or a separate tab without duplicating
  artifacts.
- Source reference/opening must feel seamless.

## Authorities: canonical end-to-end acceptance contract

This section is deliberately explicit. The old standalone Python GUI, ALR
splitter behavior, the Table of Authorities machinery, and the user’s stated
workflow are the specification. Do not invent a replacement workflow.

### Embedded/standalone visual integration

- The Beaver tab is named **Authorities**.
- The standalone and embedded browser UI use the same maintained code.
- The embedded view does not render a second, mismatched app banner inside the
  Beaver shell.
- The Authorities top bar, spacing, typography, red accent, and surface
  geometry match the rest of Beaver.
- The iframe/service surface reserves its final viewport before readiness; no
  initial pop-in tax.
- Switching into Authorities does not load blank, flash a different banner, or
  resize the shell.
- Authorities view tabs have fixed widths. Active state, counts, carets,
  loading, and label changes produce zero horizontal movement.
- All tabs and panes fit the viewport with sensible internal scroll areas at
  desktop, narrow width, browser zoom, and 320 CSS pixels.
- Authorities is not needlessly wide when given a large viewport.
- Text never becomes tiny merely to fit the viewport.

### Setup and source mode

- Opening Authorities shows Automatic, Manual, Settings, and History with a
  clear Create action. Create opens Setup for each new workflow unless the user
  has explicitly selected **Remember for future workflows**.
- It explains the workflow before the main pane and uses small native visual
  previews of the resulting book.
- The setup state is explicit, versioned, and can be reopened from Settings;
  it must not disappear because an unrelated previous session set an opaque
  browser flag.
- Primary workflow choice is **Automatic** or **Manual**, using those words.
- The document currently being operated on is always named and visible.
- Import and review are one stage, not two artificial steps.
- Insert/add source PDFs is part of Build because it fills missing material
  before final assembly.
- Source-PDF strategy uses human outcome labels and explicitly offers:
  1. use original source PDFs where available and reconstruct missing sources;
  2. use original source PDFs where available and insert clearly labelled
     stubs for missing sources;
  3. reconstruct every source into a consistent local rendering.
- Do not offer “stubs only.” A labelled missing-source page is a fallback for
  an unavailable original, not a useful whole-book strategy.
- “Use originals when available” alone is not an adequate label because it
  does not say what happens when an original is missing.
- The setup visually shows what each source strategy changes in the final book.

### Options and help

- Options has an obvious caret and an appropriately sized stable control.
- Opening Options never clips at the viewport edge, extends to the top of the
  screen, or changes surrounding width/height.
- “Build outputs” appears before the detailed settings that affect it.
- **Book of Authorities** versus **Table of Authorities** is a primary choice.
- Default is a standalone Book of Authorities.
- Resolve names defaults on.
- Every label says what will happen in the final artifact. Do not expose
  internal names such as “render,” “combined,” “reference mode,” or similarly
  abstract shorthand without a plain outcome.
- Use concise `(i)` help only where a label cannot carry the explanation.
- Help is keyboard accessible, stable, bounded, and does not occlude the
  associated control.
- Local runtime, database path, and storage path are not options.
- Human-editable fields show normal labels and values, not internal shorthand.
- The source-marking choices are shown with simple visual samples:
  - default: right-margin marker for a cited paragraph plus highlight only on
    exact quoted text;
  - optional: highlight the whole cited paragraph even without an exact quote;
  - optional: exact quote only; and
  - optional: no marks.

### Review workflow

- Use the proven review interaction:
  - select text and mark it as authority;
  - select text and mark it as pinpoint;
  - split at cursor;
  - merge with previous;
  - click an Ibid/supra to link it to its authority; and
  - clear an incorrect link.
- Do not replace this with generic CRUD fields, source-type forms, save state,
  “Reviewed/Needs review,” or a newly invented workflow.
- Authority and pinpoint marks are visually distinct without red underlining.
- Selection/current row is clear without adding another decoration language.
- The footnote/citation list scrolls and exposes every item. It must not stop
  after four, clip the bottom item, or hide later footnotes.
- A browser test must load more than ten citations/footnotes, navigate to the
  last item, and verify it remains reachable at desktop, narrow width, and zoom.
- The current citation, footnote number/location, and source document are
  obvious without repeating the same citation in several panels.
- Citation is primary text; footnote/location is secondary text.
- List scrolling is normal and visually quiet; history is not a dropdown.
- Manual and automatic review preserve the same citation state.
- Deterministic splitting recognizes the full proven ALR subsequent-history
  family, including straight/curly `rev'g`, `rev'd`, `aff'g`, `aff'd`, and
  `cited by`.
- `2023 SCC 14, rev’g 2021 BCCA 222 [Hansman].` must split deterministically
  into the two supported authorities with exact offsets.
- Supra/Ibid and repeated names resolve deterministically where unambiguous.
- Use the bounded ALR-style model splitting fallback only for genuinely
  unresolved citation units.

### Textless PDF decision

- The textless-PDF prompt explains in plain language:
  - what was found;
  - why exact text is unavailable;
  - the practical difference between using the image original, OCR/rebuilding,
    and inserting a stub;
  - time/quality implications; and
  - whether the choice affects search, highlights, or clickable contents.
- Include a small simple diagram/example rather than a wall of prose.
- The user can make the decision per source and apply a choice to similar
  sources.
- The modal is bounded, scrollable, keyboard accessible, and does not lose the
  build state.

### Build and progress

- Progress belongs at the top/with the active Build step, not detached at the
  bottom.
- The progress label and bar describe the same current operation.
- Remove mojibake from progress and every Authorities string.
- Avoid vague copy such as “Merging authority PDFs behind the clickable
  contents.” Say the concrete result in ordinary language.
- Starting a build does not cause a large layout shift or tab-width change.
- Authorities creation is highly performant and resumable.
- A fresh standalone session does not preload yesterday’s document.
- Beaver project-scoped Authorities sessions persist in the appropriate
  project/history.

### Source PDFs and formatting

- Compact counts use a stable adjacent label/value layout. Never create giant
  dead gaps such as `PDFs                     0`.
- Missing-source rows are compact. A missing citation does not receive the
  largest type on the page.
- Do not repeat the same citation name in the source-PDF pane.
- Direct source webpage and online PDF links are available where resolved.
- Use source/native structures to restore headings, lists, tables, italics,
  paragraph numbers, and legislative indentation.
- Do not highlight an entire case because no pinpoint was specified.
- Exact text spans are highlighted only when an exact quote is known.
- Default paragraph reference is a narrow right-margin marker that cannot
  overlap text.
- Whole-paragraph highlighting is opt-in.

### Final artifact

- Automatic Books group authorities by source type and alphabetize within each
  group. Manual Books preserve user order. A court-specific profile overrides
  this only when supported by an explicit current direction; see
  [Book of Authorities ordering research](book-of-authorities-ordering-research.md).
- Default build creates one Book of Authorities, not three unrelated output
  files.
- Do not involve a DOCX output when the user asked only for a Book of
  Authorities.
- The cover title is **Book of Authorities**, not “Input book of authorities.”
- Remove diagnostic cover copy, internal reconstruction counts, and redundant
  kickers.
- The generated Table/Book is black and grayscale. Only hyperlinks may be blue.
- No random blue highlights, headings, accents, or generated table cells.
- Contents and source references are clickable.
- The UI exposes one clear download icon for the whole book. Do not add
  individual download buttons for every generated intermediate tab.
- Preserve original PDF pages/images when used.
- Reconstructed pages preserve tables, lists, headings, italics, paragraph
  numbering, and page geometry.

## Deterministic citation linking and document cleanup

- When asked to add links to citations in a document, do not make the main model
  reason through every footnote.
- Route by a brief deterministic assessment and then call the bounded ALR-style
  splitting/linking worker using the ultra-economy strategy.
- If routing costs more than it saves, call the bounded worker directly.
- Match the proven ALR model/effort setting or demonstrate an equivalent model
  on real ALR DOCX files and its internal benchmarks.
- Table/Book of Authorities can call the same bounded model fallback where
  deterministic splitting is insufficient.
- Do not duplicate full citations merely to represent multiple pinpoints.
- Deterministic macro-like cleanup (including supra repair) gets first pass;
  the model fills only the unresolved gap.

## Legal ontology and research artifacts

- Build durable graphs for legal tests, factors, subfactors, and
  sub-subfactors.
- Each node can expand to exact passages from cases, legislation, and journal
  articles with displayed pinpoints and direct fragment/native links.
- Distinguish passages that define/colour a test from examples that apply it.
- Permit further fractal treatment: what another decision says about a
  particular passage or factor.
- Store the artifact in Library and generate linked research memos from it.
- Use a standard lightweight graph/flowchart renderer only as a projection;
  the JSON/SQLite ontology remains usable without it.
- The same graph backbone supports project case tags and hierarchical labels.

## Context, memory, compaction, prompt diet, and RAG

- Compare Mike’s memory/session behavior with open-source Codex and OpenCode.
- Study official OpenAI session/caching/compaction guidance.
- Independently compare the proposed context strategy with research papers.
- Preserve raw transcripts and a durable exact legal ledger.
- Compact automatically based on the assembled request budget while reserving
  output/tool space.
- Preserve exact quotes, pinpoints, qualifiers, negation, exceptions, dates,
  defined terms, party identity, instructions, accepted/proposed edits,
  versions, receipts, and unresolved decisions.
- Isolate clients and matters.
- Keep recent verbatim turns plus a lossy task summary; the summary is never the
  legal source of truth.
- Keep tool schemas and system prompts lean. Do not let new tools cause prompt
  bloat or context rot.
- Bound tool outputs and rehydrate exact evidence on demand.
- Evaluate lexical/pinpoint retrieval versus optional vector candidate
  generation over bulk data and `public_endpoint.db`.
- Produce a clear report on pinpoint retrieval versus embeddings.

## Research and benchmarks

- Compare the current Beaver baseline against changed context/compaction
  methods with all other constants held fixed.
- Research Canadian and American legal benchmarks.
- Verify Semantic Legal Bench by Marty Rudolf, COLIEE, LegalBench,
  LegalBench-RAG, suitable Canadian RAG benchmarks, and Harvey’s published legal
  benchmark materials.
- Do not claim product-level parity with Harvey when only public benchmark
  materials are available.
- Test a Caveman-repository directive as an independent factorial treatment,
  including a legal-safe concise variant.
- Benchmark provider/model choices, structural repair, document drafting,
  citation splitting, retrieval, and compaction with versioned prompts and
  reproducible metrics.
- Use diverse real DOCX files from Downloads, but select one upstream,
  less-edited version of each work rather than duplicates/derivatives.
- Vet every gold label with independent review; do not treat automatic output
  as human ground truth.
- Keep a self-contained HTML research reader with simple graphics.
- Research how KeyCite/Shepard’s-like systems assess subsequent treatment and
  good law, including citator limits and human/editorial inputs.

## Multimodal work

- The assistant can invoke image-capable models for selected legal images,
  scanned pages, exhibits, tables, stamps, signatures, and diagrams.
- Send only the necessary image/page regions.
- Preserve OCR/region coordinates and source provenance.
- Test real multimodal calls and compare them with deterministic OCR/cropping.

## Accessibility

- Target WCAG 2.2 AA across Beaver and Authorities.
- Keyboard-only operation covers navigation, Library import, Assistant,
  model/effort selection, Authorities review/build/download, Settings,
  Recycling bin, document actions, and graph viewers.
- Visible focus, focus return, target size, high contrast, zoom/reflow,
  text-spacing, reduced motion, screen-reader status, and non-colour-only
  meaning are release gates.
- Test at 320 CSS pixels and common browser zoom levels.
- Run automated checks plus manual keyboard, Windows high contrast, NVDA, and a
  second screen-reader/browser combination.

## Parked or conditional work

- The proposed legal-move/genre ledger is parked. Record it as an experiment,
  but do not implement it until the semantic Markdown/DOCX pipeline and baseline
  benchmark are complete.
- Role presets/onboarding are deferred until real solicitor versus litigator
  capabilities justify them.
- Vector retrieval is optional until a held-out benchmark proves a strict win.
- A new graph database is unnecessary for the first ontology implementation.

## Required release proof

Before telling the user a broad UI or product pass is ready:

1. Build backend and frontend from the exact current worktree.
2. Restart all local services from those builds.
3. Confirm the running process/build identity.
4. Run backend/frontend focused and full gates in proportion to the change.
5. Run the launcher smoke path with Authorities.
6. Exercise the real local UI at desktop, narrow width, zoom, keyboard, and
   refresh/restart.
7. Capture and inspect screenshots of every changed state, including first
   paint and transitions rather than only settled screenshots.
8. Measure layout shift and stable geometry for shared shell, tabs, dialogs,
   async content, Questions, activity, document panes, and Authorities.
9. Use a real model call for the affected assistant drafting/redlining path.
10. Inspect generated DOCX/PDF pages visually and structurally.
11. Confirm local persistence after restart and cloud compatibility tests.
12. Record exact commits, test results, measurements, and known limitations.

No item is accepted merely because an agent said it was complete.
