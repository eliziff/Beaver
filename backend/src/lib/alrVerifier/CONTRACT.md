# ALR verifier operations (contract for the app and eval agents)

`createAlrVerifierOperations(deps)` in `operations.ts`. `deps` (all optional):
- `sources`: Beaver's legal-source operations (`resolve`, `readPassage`, `search`); default
  `legalSourceOperations` (A2AJ local sqlite then api.a2aj.ca, journals, CourtListener/TNA/govinfo).
  The browser runtime passes its own (direct A2AJ / parquet corpus) with the same shape.
- `journals`: `{ search(citationText) → { articleId, title, journal, firstPage, galleyUrl } | null,
  articleText(articleId) → string }`; default reads Beaver's journal provider.
- `pdfText(bytes) → Promise<string[]>` (page texts) for attachSource; default native PDF reader.

## run
`run({ documents: [{ name, bytes }], settings, llm?, corpus?, signal? }, progress?)`
- `settings`: Python `DEFAULT_GUI_SETTINGS` keys (`settings.ts`); unknown values fall back.
- `llm`: `{ complete(messages, { schema }) → Promise<{ text, usage? }> }`, required only for
  `high_accuracy`, `economy`, `ultra_economy` (free mode never calls it).
- `corpus`: passed through to `deps.sources` factories when given (`deps.sourcesFor(corpus)`).
- `progress({ document, phase, done?, total?, message? })`, phase one of
  `read | analyze | journal | supra | quotes | write`.
- returns `{ runId, documents: [{ name, workbook: Uint8Array, workbookName: "[CHECKED] <stem>.xlsx",
  sidecar: object | null, sidecarName, rows, summary: { footnotes, parts, quotes, perfect, partial,
  noMatch, unavailable, notCheckable }, missingSources: [{ key, citation, canliiPageUrl, canliiPdfUrl, rows }],
  state }] }`. `sidecar` is set only for `export_detail: "display-json"`.
- `noMatch`: source read, quotation not found; `unavailable`: a case, legislation or matched journal
  source the run could not read (local-only miss, offline, CanLII-only); `notCheckable`: quotations from
  material no provider holds (websites, books, unlinked notes).
- `state` is plain JSON (survives a page reload); pass it back to `attachSource`.

## attachSource
`attachSource({ runId, state, pdf: { name, bytes } }, progress?)`
- Matches the PDF by its opening citation (shared/folder-pdf-match.mjs) against `state`'s missing
  sources; returns `{ refused: "<reason>" }` for a wrong or unverifiable PDF.
- Otherwise re-checks only the rows citing that source and returns
  `{ key, documents: [{ name, workbook, workbookName, sidecar, rows, summary, missingSources, state }] }`.

## CLI
`npm exec --offline --no -- tsx --tsconfig tsconfig.dev.json scripts/alr-verify.ts --input <docx|folder>
--out <dir> --mode <run_mode> [--llm <module path exporting default llm>] [--a2aj-live <n>]
[--setting key=value ...]`. A2AJ HTTP answers are recorded/replayed under
`benchmarks/local-data/alr-verifier/a2aj-http-cache/`; `--a2aj-live` caps new live lookups (default 0).
