// ALR Quote Verifier operations: .docx in, "[CHECKED] <stem>.xlsx" out, and CanLII PDFs the reader
// downloads re-checking the rows that cite them. Composition only; every capability is a Beaver primitive.
import { matchFolderPdf } from "mike/shared/folder-pdf-match.mjs";
import { sequenceOpcodes } from "mike/shared/sequence-diff.mjs";
import { useA2AJCorpus, type A2AJCorpusInput } from "../legalSources/a2aj";
import { structureNative } from "../structureNative";
import { alrDocument, parseDocx, type InlineQuote } from "./document";
import { engine, isIbid, referenceInfo } from "./engine";
import { createLinker } from "./links";
import { alrLlm, type AlrLlmClient, type LlmCache } from "./llm";
import { buildFootnoteParts } from "./parts";
import { alternateSupplement, checkRowQuotes } from "./quoteChecks";
import { applyChainOrigins, resolveReferenceChains } from "./references";
import { buildRows, type AlrRow } from "./rows";
import { alrSettings, footnoteFilter, type AlrSettings } from "./settings";
import { beaverSources, judgmentDocument, type AlrSources, type SourceDocument } from "./sources";
import { canliiLookupUrl, isCanlii, isUsableLink, splitUrl, stripInvalidPageFragment } from "./urls";
import { exportWorkbook, sidecarName } from "./workbook";

export type AlrPhase = "read" | "analyze" | "journal" | "supra" | "quotes" | "write";
export type AlrProgress = (event: { document: string; phase: AlrPhase; done?: number; total?: number; message?: string }) => void;
export type MissingSource = { key: string; citation: string; canliiPageUrl: string; canliiPdfUrl: string; rows: number };
export type AlrRunState = { version: 1; runId: string; name: string; settings: AlrSettings; rows: AlrRow[];
  quotes: Array<[number, InlineQuote[]]>; attached: string[] };
export type AlrDocumentResult = { name: string; workbookName: string; workbook: Uint8Array; sidecarName: string;
  sidecar: Record<string, unknown> | null; rows: AlrRow[]; summary: ReturnType<typeof summarize>;
  missingSources: MissingSource[]; state: AlrRunState; usage: Record<string, number>; modelCalls: number;
  sourceFailures: string[] };

export type AlrDeps = { sources?: AlrSources; llmCache?: LlmCache;
  pdfPages?: (bytes: Uint8Array) => Promise<string[]> };

const workbookName = (name: string) => `[CHECKED] ${name.replace(/\.[^.]+$/u, "")}.xlsx`;
const JOURNAL_KINDS = new Set(["journal", "book", "report", "essay_collection"]);

function summarize(rows: AlrRow[], footnotes: number) {
  const checked = rows.filter((row) => row.quote_check_status);
  return { footnotes, parts: rows.length, quotes: checked.length,
    perfect: checked.filter((row) => row.quote_check_status.includes("MATCH") && !row.quote_check_status.includes("NO_MATCH")).length,
    partial: checked.filter((row) => row.quote_check_status.includes("PARTIAL")).length,
    noMatch: checked.filter((row) => row.quote_check_status === "NO_MATCH" && row._quote_source_tag).length,
    // A source the run should have read but could not; quotations from other material are not checkable.
    unavailable: checked.filter((row) => row.quote_check_status === "NO_MATCH" && !row._quote_source_tag &&
      row.quote_check_notes.startsWith("No source text found")).length,
    notCheckable: checked.filter((row) => row.quote_check_status === "NO_MATCH" && !row._quote_source_tag &&
      !row.quote_check_notes.startsWith("No source text found")).length };
}

/** Python's char-level SequenceMatcher ratio on normalized titles. */
function titleRatio(a: string, b: string) {
  const normalize = (value: string) => value.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s]/gu, "").replace(/\s+/gu, " ").trim();
  const [x, y] = [[...normalize(a)], [...normalize(b)]];
  if (!x.length && !y.length) return 1;
  const matched = sequenceOpcodes(x, y).filter(([tag]) => tag === "equal").reduce((sum, [, a0, a1]) => sum + a1 - a0, 0);
  return (2 * matched) / (x.length + y.length);
}
function quotedTitles(text: string) {
  const titles: string[] = [], seen = new Set<string>();
  for (const pattern of [/["“]([^"“”]+?)["”]/gu, /['‘]([^'‘’]+?)['’]/gu]) for (const match of text.matchAll(pattern)) {
    const title = match[1].trim(), key = title.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").replace(/\s+/gu, " ").trim();
    if (title && key && !seen.has(key)) { seen.add(key); titles.push(title); }
  }
  return titles;
}

/** Journal, book and report citations matched to the journals database by title (its galley link). */
async function resolveJournalLinks(rows: AlrRow[], sources: AlrSources) {
  const cache = new Map<string, Awaited<ReturnType<typeof journalHit>>>();
  const journalHit = async (verbatim: string) => {
    let best: { score: number; hit: Awaited<ReturnType<AlrSources["journals"]>>[number] } | null = null;
    for (const title of quotedTitles(verbatim)) for (const hit of await sources.journals(title, 5)) {
      const score = titleRatio(title, hit.title);
      if (!best || score > best.score) best = { score, hit };
    }
    return best && best.score >= 0.7 ? best.hit : null;
  };
  for (const row of rows) {
    if (!JOURNAL_KINDS.has(row.citation_part_kind) || !row.citation_part_text) continue;
    if (!cache.has(row.citation_part_text)) cache.set(row.citation_part_text, await journalHit(row.citation_part_text));
    const hit = cache.get(row.citation_part_text);
    if (hit) {
      row._journal_article_id = hit.articleId;
      if (hit.galleyUrl) {
        row.citation_part_link = hit.galleyUrl; row._journal_link_resolved = true;
        row.journal_match_info = `Journal: ${hit.title.slice(0, 60)} [${hit.journal.slice(0, 20)}]`;
      } else row.journal_match_info = `Matched, no galley_url: ${hit.title.slice(0, 60)} [${hit.journal.slice(0, 20)}]`;
    } else {
      const title = quotedTitles(row.citation_part_text)[0];
      row.journal_match_info = title ? `No match: "${title.slice(0, 80)}"` : "No title extracted";
    }
  }
}

/** Notes a filter names, plus the notes their supra and ibid references point at. */
function expandFilter(ids: Set<number>, footnotes: Map<number, string>) {
  const expanded = new Set(ids), queue = [...ids];
  while (queue.length) {
    const id = queue.shift()!, text = footnotes.get(id) ?? "";
    const targets = referenceInfo(text).notes.map(Number).filter((n) => Number.isInteger(n) && footnotes.has(n));
    if (isIbid(text)) { const previous = Math.max(...[...footnotes.keys()].filter((key) => key < id)); if (Number.isFinite(previous)) targets.push(previous); }
    for (const target of targets) if (!expanded.has(target)) { expanded.add(target); queue.push(target); }
  }
  return expanded;
}

/** Page pinpoints become #page=N on the citation link (journal page map, else from the first page). */
async function appendPageLinks(rows: AlrRow[], pdfPage: (articleId: string, label: number) => Promise<number | null>) {
  for (const row of rows) {
    const cleaned = stripInvalidPageFragment(row.citation_part_link);
    row.citation_part_link = cleaned;
    const pages = JSON.parse(row.page_pinpoints || "[]") as number[];
    if (!pages.length || !isUsableLink(cleaned)) continue;
    const first = Number(pages[0]);
    if (!Number.isInteger(first)) continue;
    let page = row._journal_article_id ? await pdfPage(row._journal_article_id, first) : null;
    if (page === null) {
      const start = Number(row.first_page);
      if (!row.first_page || !Number.isInteger(start)) continue;
      page = first - start + 1;
    }
    if (page < 1) continue;
    row.citation_part_link = `${cleaned.split("#")[0]}#page=${page}`;
  }
}

/** Case and legislation sources with quotations the run could not read: the reader fetches these from CanLII. */
function missingSources(rows: AlrRow[]): MissingSource[] {
  const found = new Map<string, MissingSource>();
  for (const row of rows) {
    row._missing_source_key = "";
    if (row.quote_check_status !== "NO_MATCH" || row._quote_source_tag) continue;
    // Any row whose working link is a CanLII decision or law page can be checked from that page's PDF.
    const [base] = splitUrl(canliiLookupUrl(row._check_link ?? row.citation_part_link));
    if (!isCanlii(base) || !/\/(?:doc|laws)\/.*\.html$/iu.test(base)) continue;
    row._missing_source_key = base;
    const citation = row.ref_chain_origin_citation_part_text || row.citation_with_style || row.citation_part_text;
    const entry = found.get(base) ?? { key: base, citation, canliiPageUrl: base, canliiPdfUrl: base.replace(/\.html$/iu, ".pdf"), rows: 0 };
    entry.rows++;
    found.set(base, entry);
  }
  return [...found.values()];
}

export function createAlrVerifierOperations(deps: AlrDeps = {}) {
  const pdfPages = deps.pdfPages ?? (async (bytes: Uint8Array) =>
    structureNative().pdfPageTexts(await structureNative().derivePdfDocument(Buffer.from(bytes), {})));

  async function finish(state: AlrRunState, sources: AlrSources, footnotes: number, extra: Partial<AlrDocumentResult> = {}) {
    const name = workbookName(state.name);
    const exported = await exportWorkbook(state.rows, name, state.settings.export_detail);
    return { name: state.name, workbookName: name, workbook: exported.workbook, sidecarName: sidecarName(name),
      sidecar: exported.sidecar, rows: state.rows, summary: summarize(state.rows, footnotes),
      missingSources: missingSources(state.rows), state, usage: {}, modelCalls: 0, sourceFailures: [...sources.failures],
      ...extra } satisfies AlrDocumentResult;
  }
  const journalPdfPage = (sources: AlrSources) => async (articleId: string, label: number) => {
    const document = await sources.document({ provider: "journal", id: articleId, kind: "journal" });
    const index = document?.blocks.filter((block) => block.kind === "page").findIndex((block) => block.label === `page ${label}`) ?? -1;
    return index >= 0 ? index + 1 : null;
  };

  async function checkQuotes(rows: AlrRow[], quotes: Map<number, InlineQuote[]>, settings: AlrSettings, sources: AlrSources,
    linker: ReturnType<typeof createLinker>, attached: Map<string, SourceDocument>, report: (done: number, total: number) => void) {
    const pending = rows.filter((row) => quotes.get(row.footnote_id)?.length);
    let done = 0;
    for (const row of pending) {
      row._check_link = row.citation_part_link;
      const source = await checkRowQuotes(row, quotes.get(row.footnote_id)!, { sources, linker, a2aj: settings.a2aj,
        fragmentMode: settings.frag_mode, attached, journalPages: journalPdfPage(sources) });
      if (source) alternateSupplement(row, quotes.get(row.footnote_id)!, source);
      report(++done, pending.length);
    }
    await appendPageLinks(rows, journalPdfPage(sources));
    // Checking used the working link; the workbook's Citation link is the author's own URL.
    for (const row of rows) if (row._author_provided_link.trim()) row.citation_part_link = row._author_provided_link.trim();
  }

  async function runDocument(document: { name: string; bytes: Uint8Array }, settings: AlrSettings,
    client: AlrLlmClient | undefined, sources: AlrSources, runId: string, progress: AlrProgress) {
    const report = (phase: AlrPhase, done?: number, total?: number, message?: string) =>
      progress({ document: document.name, phase, done, total, message });
    report("read");
    if (!/\.docx$/iu.test(document.name)) throw new Error(`${document.name}: add a Word (.docx) file.`);
    const model = alrDocument(await parseDocx(document.bytes), settings.proposition_mode);
    let order = model.order;
    const filter = footnoteFilter(settings.fn_filter);
    if (filter) { const expanded = expandFilter(filter, model.footnotes); order = order.filter((id) => expanded.has(id)); }
    const llm = settings.run_mode === "free" || !client ? null
      : alrLlm(client, settings.llm_cache ? deps.llmCache : undefined);
    const linker = createLinker(sources, { a2aj: settings.a2aj, usUk: settings.us_uk_case_lookup && !settings.local_only });
    const built = await buildFootnoteParts(model, order, settings, linker, llm, (done, total) => report("analyze", done, total));
    const rows = buildRows(model, built.rows);
    report("journal");
    await resolveJournalLinks(rows, sources);
    report("supra");
    resolveReferenceChains(rows, model.footnotes, built.partsPerNote, model.displayNumberToId, model.displayIds);
    applyChainOrigins(rows);
    await checkQuotes(rows, model.quotes, settings, sources, linker, new Map(), (done, total) => report("quotes", done, total));
    report("write");
    const state: AlrRunState = { version: 1, runId, name: document.name, settings, rows,
      quotes: [...model.quotes].filter(([id]) => order.includes(id)), attached: [] };
    return finish(state, sources, order.length, { usage: llm?.usage ?? {}, modelCalls: llm?.calls ?? 0 });
  }

  return {
    async run(input: { documents: Array<{ name: string; bytes: Uint8Array }>; settings?: Partial<Record<keyof AlrSettings, unknown>>;
      llm?: AlrLlmClient; corpus?: A2AJCorpusInput; signal?: AbortSignal }, progress: AlrProgress = () => undefined) {
      const settings = alrSettings(input.settings ?? {});
      if (settings.a2aj) await useA2AJCorpus(input.corpus, { localOnly: settings.local_only });
      const runId = crypto.randomUUID(), documents: AlrDocumentResult[] = [];
      for (const document of input.documents) {
        input.signal?.throwIfAborted();
        documents.push(await runDocument(document, settings, input.llm, deps.sources ?? beaverSources({ localOnly: settings.local_only }), runId, progress));
      }
      return { runId, documents };
    },

    /** A CanLII PDF the reader downloaded: verified by its opening citation, then the rows citing it re-checked. */
    async attachSource(input: { runId?: string; state: AlrRunState; pdf: { name: string; bytes: Uint8Array } },
      progress: AlrProgress = () => undefined) {
      const state = structuredClone(input.state);
      const missing = missingSources(state.rows);
      if (!missing.length) return { refused: "Every source in this run already has its text." };
      const texts = await pdfPages(input.pdf.bytes);
      const pages = texts.slice(0, 2).map((text) => ({ lines: text.split(/\r?\n/u).map((line) => ({ text: line })) }));
      const call = (method: string, request: unknown) => engine(method, request);
      const records = missing.map((entry) => ({ ...entry, aliases: [entry.citation] }));
      let match: Awaited<ReturnType<typeof matchFolderPdf<typeof records[number]>>>;
      try { match = await matchFolderPdf(input.pdf.name, pages, records, call); }
      catch (error) { return { refused: (error as Error).message }; }
      if (!match) return { refused: `${input.pdf.name} does not open with the citation of a source this run is missing.` };
      const key = match.record.key;
      progress({ document: state.name, phase: "quotes", message: `Checking quotations against ${match.record.citation}` });
      const native = await structureNative().derivePdfDocument(Buffer.from(input.pdf.bytes), {});
      const attached = new Map([[key, judgmentDocument(native)]]);
      const sources = deps.sources ?? beaverSources({ localOnly: true });
      const linker = createLinker(sources, { a2aj: false, usUk: false });
      const affected = state.rows.filter((row) => row._missing_source_key === key);
      for (const row of affected) {
        Object.assign(row, { citation_part_link: row._check_link ?? row.citation_part_link, quote_check_status: "",
          quote_corrected_citation: "", quote_check_notes: "", quote_match_pinpoint: "", quote_match_link: "",
          matched_source: "", matched_source_fragment: "", alternate_matched_source_fragment: "", _quote_source_tag: "",
          _alternate_quote_check_notes: "", _alternate_quote_corrected_citation: "", _corrected_link: undefined });
      }
      const quotes = new Map(state.quotes);
      await checkQuotes(affected, quotes, { ...state.settings, a2aj: false }, sources, linker, attached, () => undefined);
      state.attached.push(key);
      progress({ document: state.name, phase: "write" });
      return { key, documents: [await finish(state, sources, new Set(state.rows.map((row) => row.footnote_id)).size)] };
    },
  };
}
export type AlrVerifierOperations = ReturnType<typeof createAlrVerifierOperations>;
