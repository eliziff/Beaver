/**
 * Nav-shape A/B on LegalBench-RAG-mini: AGENTIC retrieval.
 *
 * The question: does the "address" navigation surface (MIKE_NAV_SHAPE=address —
 * `at` everywhere, head/tail `from`, page schemes, `follow`/`depth` on find, and
 * the library_links cross-reference graph; 5,006 schema chars over 4 tools) buy
 * anything over the "legacy" surface (section/offset reads, unscoped find;
 * 2,809 chars over 3 tools) when a model must navigate to the answer ITSELF?
 *
 * Nothing is pre-injected. Each cell hands the model one document id and one
 * question; the document is far too long to read whole (median 26k chars, max
 * 500k, against a 24k default read window and a 64k tool-result ceiling), so
 * the model must use the surface. The arms differ ONLY in which tool schema is
 * shown; handlers, prompt, model, effort, iteration ceiling and corpus are
 * identical. NAV_TOOL_SHAPE is read at module load, so each arm is its own
 * process with MIKE_NAV_SHAPE set.
 *
 * BED SOUNDNESS. Upstream ships an `answer` string beside every gold span, so
 * the coordinate space is decidable rather than assumed (a CRLF/LF defect
 * silently corrupted 25% of this bed for five stages). Two oracles run before
 * any model call and both must be 100%:
 *   1. `text.slice(start,end) === answer` on the corpus loader's normalized
 *      bytes  (scripts/legalbench-gold-oracle-check.ts).
 *   2. the text the LIBRARY SURFACE hands the model — extractLocalDocument
 *      over the ingested DOCX — is byte-identical to those same bytes, so the
 *      model navigates the exact space gold indexes into (`ingest` below).
 *
 * The library surface has no .txt parser, so the corpus is ingested as DOCX
 * with one w:p per LF line; extractDocxBodyText joins paragraphs with "\n",
 * which is why round-trip equality is reachable — and asserted, never assumed.
 *
 * Usage (from backend/):
 *   npx tsx scripts/nav-shape-rag.ts ingest
 *   npx tsx scripts/nav-shape-rag.ts arms                  # per-arm schema census
 *   npx tsx scripts/nav-shape-rag.ts sample --n 160
 *   npx tsx scripts/nav-shape-rag.ts schema-tokens         # measured, per arm
 *   MIKE_NAV_SHAPE=address npx tsx scripts/nav-shape-rag.ts run \
 *     --arm address --form asis --rep 1 --n 160 --concurrency 3
 *   npx tsx scripts/nav-shape-rag.ts report
 *
 * Receipts are private and append-only (LOCALAPPDATA experiments dir); the bed
 * library is a throwaway MIKE_LOCAL_DATA_DIR and never touches the real one.
 */
import "../src/lib/loadEnv";

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  LEGALBENCH_RAG_DATA_DIR,
  SOURCE_BENCHMARKS,
  normalizeCorpusText,
  sanitizeCorpusPath,
  upstreamBenchmarkSchema,
  type SourceBenchmark,
} from "../src/lib/legalbenchRag";

// ---------------------------------------------------------------------------
// Paths. The bed library is a scratch MIKE_LOCAL_DATA_DIR set before the store
// module is ever imported, so the user's real Library is untouchable from here.
// ---------------------------------------------------------------------------

const EXPERIMENT_HOME = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
  "OpenLegalData",
  "experiments",
);
const BED_LIBRARY = path.join(EXPERIMENT_HOME, "nav-shape-rag-bed", "library");
const BED_MAP = path.join(EXPERIMENT_HOME, "nav-shape-rag-bed", "documents.json");
const RECEIPTS = path.join(EXPERIMENT_HOME, "legal-grounding", "2026-07-30");

process.env.MIKE_LOCAL_DATA_DIR ??= BED_LIBRARY;
process.env.MIKE_DISABLE_ASK_INPUTS = "1";
process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";

const BED_USER = "nav-shape-rag-bed";
const NAV_TOOLS = new Set([
  "library_read",
  "library_find",
  "library_outline",
  "library_links",
]);

const flag = (name: string, fallback?: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < process.argv.length) return process.argv[at + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
};

// ---------------------------------------------------------------------------
// Bed: tests, gold, corpus.
// ---------------------------------------------------------------------------

type Gold = { start: number; end: number; answer: string };
type Cell = {
  id: string;
  source: SourceBenchmark;
  document: string;
  query: string;
  /** Everything after the leading "Consider <descriptor>; " — the question
   * with the document name removed. Asserted to exist on every query. */
  stripped: string;
  gold: Gold[];
};

const corpusCache = new Map<string, string>();
function corpusText(filePath: string): string {
  const hit = corpusCache.get(filePath);
  if (hit !== undefined) return hit;
  const text = normalizeCorpusText(
    readFileSync(
      path.join(LEGALBENCH_RAG_DATA_DIR, "mini", "corpus", sanitizeCorpusPath(filePath)),
    ).toString("utf8"),
  );
  corpusCache.set(filePath, text);
  return text;
}

/**
 * Every mini query is "Consider <document descriptor>; <question>". Stripping
 * the descriptor is what separates navigation from name-matching, so the split
 * is fail-closed: a query without the separator aborts the run rather than
 * silently entering the stripped arm with its document name intact.
 */
function stripDocumentName(query: string): string {
  const at = query.indexOf("; ");
  if (at < 0) throw new Error(`query has no "; " separator: ${query.slice(0, 80)}`);
  const tail = query.slice(at + 2).trim();
  if (!tail) throw new Error(`query strips to nothing: ${query.slice(0, 80)}`);
  return tail;
}

function loadCells(): Cell[] {
  const cells: Cell[] = [];
  for (const source of SOURCE_BENCHMARKS) {
    const file = path.join(LEGALBENCH_RAG_DATA_DIR, `mini/benchmarks/${source}.json`);
    if (!existsSync(file)) continue;
    const parsed = upstreamBenchmarkSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    parsed.tests.forEach((test, index) => {
      const documents = new Set(test.snippets.map((s) => s.file_path));
      if (documents.size !== 1) {
        throw new Error(`${source}:${index} spans ${documents.size} documents`);
      }
      cells.push({
        id: `${source}:${String(index).padStart(3, "0")}`,
        source,
        document: test.snippets[0].file_path,
        query: test.query,
        stripped: stripDocumentName(test.query),
        gold: test.snippets.map((s) => ({
          start: s.span[0],
          end: s.span[1],
          answer: String((s as { answer?: unknown }).answer ?? ""),
        })),
      });
    });
  }
  return cells;
}

/** Deterministic, seeded, stratified by source. Documents stay whole-ish by
 * construction only in expectation; the bootstrap clusters on document, which
 * is what the dependence actually needs. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = "nav-shape-rag-2026-07-31";

function sampleCells(all: Cell[], perSource: number): Cell[] {
  const out: Cell[] = [];
  for (const source of SOURCE_BENCHMARKS) {
    const pool = all.filter((cell) => cell.source === source);
    // Seed off the full source NAME, not a property of it: mixing in
    // `source.length` collided cuad with maud (both 4 chars) and drew the
    // identical index list for two of the four strata.
    const seed = Number.parseInt(
      createHash("sha256").update(`${SEED}|${source}`).digest("hex").slice(0, 8),
      16,
    );
    const rand = mulberry32(seed);
    const order = pool.map((cell, index) => ({ cell, key: rand(), index }));
    order.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key));
    out.push(...order.slice(0, perSource).map((entry) => entry.cell));
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Ingest: corpus .txt -> minimal DOCX (one w:p per LF line) -> bed Library,
// then the round-trip oracle.
// ---------------------------------------------------------------------------

const xmlEscape = (value: string) =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");

async function docxFromText(text: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  // One w:p per LF line, xml:space="preserve" so leading/trailing spaces
  // survive. extractDocxBodyText joins paragraphs with "\n", which is what
  // makes byte-identity with the LF corpus text reachable.
  const body = text
    .split("\n")
    .map((line) =>
      line
        ? `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
        : "<w:p/>",
    )
    .join("");
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Corpus path -> a Library filename that keeps the source benchmark visible
 * and stays legal on Windows. */
const bedFilename = (corpusPath: string) =>
  `${corpusPath.replace(/[\\/]/gu, "__").replace(/[<>:"|?*]/gu, "_").replace(/\.txt$/iu, "")}.docx`;

async function ingest() {
  const { createLocalDocument } = await import("../src/lib/localDocumentStore");
  const { extractLocalDocument } = await import("../src/lib/chat/localAssistantTools");
  const cells = loadCells();
  const documents = [...new Set(cells.map((cell) => cell.document))].sort();
  mkdirSync(path.dirname(BED_MAP), { recursive: true });

  const map: Record<string, { document_id: string; filename: string; chars: number }> = {};
  let identical = 0;
  const drift: string[] = [];
  for (const [index, corpusPath] of documents.entries()) {
    const text = corpusText(corpusPath);
    const bytes = await docxFromText(text);
    const filename = bedFilename(corpusPath);
    const created = await createLocalDocument({
      userId: BED_USER,
      kind: "file",
      filename,
      bytes,
    });
    const extracted = await extractLocalDocument(BED_USER, created.id);
    const seen = extracted?.text ?? "";
    if (seen === text) identical += 1;
    else {
      let at = 0;
      while (at < Math.min(seen.length, text.length) && seen[at] === text[at]) at += 1;
      drift.push(
        `${corpusPath}: surface ${seen.length} chars vs corpus ${text.length}; first divergence at ${at} ` +
          `(corpus ${JSON.stringify(text.slice(at, at + 40))} vs surface ${JSON.stringify(seen.slice(at, at + 40))})`,
      );
    }
    map[corpusPath] = { document_id: created.id, filename, chars: text.length };
    if ((index + 1) % 10 === 0) console.log(`  ingested ${index + 1}/${documents.length}`);
  }
  writeFileSync(BED_MAP, JSON.stringify(map, null, 2));

  console.log(`\nround-trip oracle: ${identical}/${documents.length} documents byte-identical through the library surface`);
  for (const line of drift.slice(0, 5)) console.log(`  ${line}`);

  // Second oracle, on the bytes the MODEL will be handed: every gold span must
  // still slice to its answer out of the surface's text.
  let ok = 0;
  let total = 0;
  const bySource: Record<string, [number, number]> = {};
  for (const cell of cells) {
    const surface = corpusText(cell.document);
    for (const gold of cell.gold) {
      total += 1;
      const pair = (bySource[cell.source] ??= [0, 0]);
      pair[1] += 1;
      if (surface.slice(gold.start, gold.end) === gold.answer) {
        ok += 1;
        pair[0] += 1;
      }
    }
  }
  for (const [source, [pass, count]] of Object.entries(bySource))
    console.log(`gold-span oracle ${source.padEnd(12)} ${pass}/${count}${pass === count ? "" : "  <-- FAIL"}`);
  console.log(`gold-span oracle overall ${ok}/${total}`);
  if (identical !== documents.length || ok !== total) {
    console.error("BED NOT SOUND — stopping before any model call.");
    process.exit(1);
  }
  console.log("bed OK");
}

// ---------------------------------------------------------------------------
// Arm census + measured schema token cost.
// ---------------------------------------------------------------------------

async function navSchemas() {
  const mod = await import("../src/lib/chat/localAssistantTools");
  return {
    shape: mod.NAV_TOOL_SHAPE,
    tools: mod.LOCAL_ASSISTANT_TOOLS.filter((entry) => NAV_TOOLS.has(entry.function.name)),
  };
}

async function arms() {
  const { shape, tools } = await navSchemas();
  let chars = 0;
  for (const entry of tools) {
    const json = JSON.stringify(entry);
    chars += json.length;
    const props = Object.keys(
      ((entry.function.parameters as Record<string, unknown>)?.properties ?? {}) as object,
    );
    console.log(`${entry.function.name.padEnd(16)} ${String(json.length).padStart(5)} chars  ${props.join(", ")}`);
  }
  console.log(`\nMIKE_NAV_SHAPE=${shape}  tools=${tools.length}  schema_chars=${chars}`);
}

/**
 * Provider-measured schema cost: the same trivial turn with and without the
 * arm's tools attached. Subtracting an estimate would put a tokenizer guess
 * inside the headline "tokens excluding the schema" number.
 */
async function schemaTokens() {
  const { streamChatWithTools } = await import("../src/lib/llm");
  const { shape, tools } = await navSchemas();
  const ask = async (withTools: boolean) => {
    const r = await streamChatWithTools({
      model: MODEL,
      reasoningEffort: EFFORT,
      enableThinking: false,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "ping" }],
      ...(withTools ? { tools, runTools: async () => [] } : {}),
      maxIterations: 1,
    });
    return r.usage?.inputTokens ?? 0;
  };
  const bare = await ask(false);
  const armed = await ask(true);
  console.log(
    JSON.stringify({ shape, tools: tools.length, bare_input_tokens: bare, armed_input_tokens: armed, schema_tokens: armed - bare }),
  );
}

// ---------------------------------------------------------------------------
// Scoring. Token-F1 is the scorer already used by the grounding stages
// (scripts/legal-grounding-experiment.ts tokenF1) — reused verbatim, not
// rewritten, so this bed's numbers stay comparable to theirs.
// ---------------------------------------------------------------------------

const terms = (text: string) => text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];

function tokenF1(expected: string, actual: string) {
  const wanted = terms(expected);
  const got = terms(actual);
  if (!wanted.length || !got.length) return 0;
  const counts = new Map<string, number>();
  wanted.forEach((term) => counts.set(term, (counts.get(term) ?? 0) + 1));
  let overlap = 0;
  for (const term of got) {
    const available = counts.get(term) ?? 0;
    if (!available) continue;
    overlap += 1;
    counts.set(term, available - 1);
  }
  const precision = overlap / got.length;
  const recall = overlap / wanted.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

/** Recall of the gold tokens in the answer, unpenalised for extra text — the
 * "did it come back with the passage at all" reading of a cell. */
function tokenRecall(expected: string, actual: string) {
  const wanted = terms(expected);
  const got = terms(actual);
  if (!wanted.length) return 0;
  const counts = new Map<string, number>();
  wanted.forEach((term) => counts.set(term, (counts.get(term) ?? 0) + 1));
  let overlap = 0;
  for (const term of got) {
    const available = counts.get(term) ?? 0;
    if (!available) continue;
    overlap += 1;
    counts.set(term, available - 1);
  }
  return overlap / wanted.length;
}

// ---------------------------------------------------------------------------
// The agentic cell.
// ---------------------------------------------------------------------------

/**
 * Arm-neutral by construction: names no tool, no parameter and no addressing
 * vocabulary, so neither arm is prompted toward its own affordances.
 */
const SYSTEM_PROMPT =
  "You are answering a question about one document in the user's Beaver Library. " +
  "Use the available tools to navigate the document and locate the passage that answers the question. " +
  "The document is long and cannot be read in full — find the relevant part. " +
  "When you have located it, reply with ONLY the verbatim text of that passage, copied exactly from the document: " +
  "no preamble, no commentary, no citation. If the document does not answer the question, reply exactly: NOT FOUND.";

const MODEL = process.env.NAV_SHAPE_MODEL || "codex:gpt-5.6-sol";
const EFFORT = process.env.NAV_SHAPE_EFFORT || "low";
const MAX_ITERATIONS = Number(process.env.NAV_SHAPE_MAX_ITERATIONS || 10);

type ToolTrace = {
  name: string;
  arg_keys: string[];
  /** Argument names this arm's schema does not declare. Nonzero means the
   * model reached for the other arm's vocabulary and the handler — which is
   * shared — may have honoured it. */
  off_schema_keys: string[];
  /** For `at`/`section`/`offset`/`page`: what kind of address was named. */
  address: string | null;
  follow: string | null;
  depth: number | null;
  from: string | null;
  ok: boolean;
  result_chars: number;
  /** Document coordinates of text this call put in front of the model. */
  spans: [number, number][];
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function classifyAddress(args: Record<string, unknown>): string | null {
  const at = typeof args.at === "string" ? args.at.trim() : "";
  if (at) {
    if (/^(pdf|printed):/iu.test(at)) return `page:${at.split(":")[0].toLowerCase()}`;
    if (/^off:/iu.test(at)) return "offset";
    return "provision";
  }
  if (typeof args.section === "string" && args.section.trim()) return "provision(section=)";
  if (typeof args.page === "string" && args.page.trim()) return "page(page=)";
  if (typeof args.offset === "number") return "offset(offset=)";
  if (typeof args.pages === "string" && args.pages.trim()) return "page(pages=)";
  return null;
}

/** Char ranges of the document that a tool result exposed. library_read gives
 * `offset` + verbatim `text`; library_find gives per-hit `at` + excerpt, with
 * the context window either side. Anything unlocatable is skipped rather than
 * guessed. */
function spansFromResult(
  name: string,
  args: Record<string, unknown>,
  payload: unknown,
  text: string,
): [number, number][] {
  const body = asRecord(payload);
  if (body.ok !== true) return [];
  const spans: [number, number][] = [];
  if (name === "library_read") {
    const chunk = typeof body.text === "string" ? body.text : "";
    if (!chunk) return [];
    const declared = typeof body.offset === "number" ? body.offset : null;
    const start =
      declared !== null && text.startsWith(chunk, declared) ? declared : text.indexOf(chunk);
    if (start >= 0) spans.push([start, start + chunk.length]);
    return spans;
  }
  if (name === "library_find") {
    const context = Math.min(2000, Math.max(40, Number(args.context_chars) || 500));
    for (const raw of Array.isArray(body.hits) ? body.hits : []) {
      const hit = asRecord(raw);
      const at = typeof hit.at === "number" ? hit.at : null;
      const excerpt = typeof hit.excerpt === "string" ? hit.excerpt.length : 0;
      if (at === null) continue;
      spans.push([Math.max(0, at - context), Math.min(text.length, at + excerpt + context)]);
    }
  }
  return spans;
}

const overlaps = (spans: [number, number][], gold: Gold) =>
  spans.some(([start, end]) => Math.min(end, gold.end) > Math.max(start, gold.start));

type Row = Record<string, unknown>;

async function runCell(args: {
  cell: Cell;
  documentId: string;
  filename: string;
  arm: string;
  form: "asis" | "stripped";
  rep: number;
  tools: Awaited<ReturnType<typeof navSchemas>>["tools"];
  schemaChars: number;
  runLocalAssistantTools: typeof import("../src/lib/chat/localAssistantTools").runLocalAssistantTools;
  streamChatWithTools: typeof import("../src/lib/llm").streamChatWithTools;
}): Promise<Row> {
  const { cell, documentId, tools } = args;
  const text = corpusText(cell.document);
  const traces: ToolTrace[] = [];
  const declared = new Map(
    tools.map((entry) => [
      entry.function.name,
      new Set(
        Object.keys(
          ((entry.function.parameters as Record<string, unknown>)?.properties ?? {}) as object,
        ),
      ),
    ]),
  );
  const allowed = new Set([documentId]);
  let modelTurns = 1;
  const startedAt = Date.now();
  let answer = "";
  let error: string | null = null;
  let usage: import("../src/lib/llm").NormalizedLlmUsage | null = null;

  try {
    const outcome = await args.streamChatWithTools({
      model: MODEL,
      reasoningEffort: EFFORT,
      enableThinking: false,
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            document_id: documentId,
            ...(args.form === "asis" ? { filename: args.filename } : {}),
            question: args.form === "asis" ? cell.query : cell.stripped,
          }),
        },
      ],
      tools,
      maxIterations: MAX_ITERATIONS,
      runTools: async (calls) => {
        modelTurns += 1;
        const results = await args.runLocalAssistantTools(
          BED_USER,
          calls,
          undefined,
          undefined,
          undefined,
          undefined,
          allowed,
        );
        calls.forEach((call, index) => {
          const input = asRecord(call.input);
          const known = declared.get(call.name);
          let payload: unknown = null;
          try {
            payload = JSON.parse(results[index]?.content ?? "null");
          } catch {
            payload = results[index]?.content ?? null;
          }
          traces.push({
            name: call.name,
            arg_keys: Object.keys(input),
            off_schema_keys: known
              ? Object.keys(input).filter((key) => !known.has(key))
              : Object.keys(input),
            address: classifyAddress(input),
            follow: typeof input.follow === "string" ? input.follow : null,
            depth: typeof input.depth === "number" ? input.depth : null,
            from: typeof input.from === "string" ? input.from : null,
            ok: asRecord(payload).ok === true,
            result_chars: (results[index]?.content ?? "").length,
            spans: spansFromResult(call.name, input, payload, text),
          });
        });
        return results;
      },
    });
    answer = outcome.fullText.trim();
    usage = outcome.usage ?? null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const goldAll = cell.gold.map((g) => g.answer).join(" ");
  const seen = traces.flatMap((trace) => trace.spans);
  return {
    schema_version: "navshape-rag-1",
    coords: "lf",
    ts: new Date().toISOString(),
    test_id: cell.id,
    source: cell.source,
    document: cell.document,
    document_chars: text.length,
    arm: args.arm,
    form: args.form,
    rep: args.rep,
    model: MODEL,
    effort: EFFORT,
    schema_chars: args.schemaChars,
    tools_offered: tools.length,
    query: args.form === "asis" ? cell.query : cell.stripped,
    gold_snippets: cell.gold.length,
    gold_chars: cell.gold.reduce((n, g) => n + (g.end - g.start), 0),
    status: error ? "error" : "completed",
    error,
    answer,
    not_found: /^NOT FOUND\b/iu.test(answer),
    // Composition: how well the reply reproduces gold.
    f1_all: error ? 0 : tokenF1(goldAll, answer),
    f1_best: error ? 0 : Math.max(0, ...cell.gold.map((g) => tokenF1(g.answer, answer))),
    recall_all: error ? 0 : tokenRecall(goldAll, answer),
    // Navigation: did the model's own calls ever put gold in front of it?
    reached_any: cell.gold.some((g) => overlaps(seen, g)),
    reached_all: cell.gold.every((g) => overlaps(seen, g)),
    reached_fraction: cell.gold.length
      ? cell.gold.filter((g) => overlaps(seen, g)).length / cell.gold.length
      : 0,
    n_tool_calls: traces.length,
    n_model_turns: modelTurns,
    tool_calls: traces,
    usage,
    latency_ms: Date.now() - startedAt,
  };
}

async function run() {
  const arm = flag("arm");
  const form = flag("form", "asis") as "asis" | "stripped";
  const rep = Number(flag("rep", "1"));
  const perSource = Number(flag("n", "40"));
  const concurrency = Number(flag("concurrency", "3"));
  const { shape, tools } = await navSchemas();
  if (shape !== arm) {
    throw new Error(`--arm ${arm} but NAV_TOOL_SHAPE=${shape}; set MIKE_NAV_SHAPE before the process starts`);
  }
  if (!existsSync(BED_MAP)) throw new Error("bed not ingested; run `ingest` first");
  const map = JSON.parse(readFileSync(BED_MAP, "utf8")) as Record<
    string,
    { document_id: string; filename: string }
  >;
  const schemaChars = tools.reduce((n, entry) => n + JSON.stringify(entry).length, 0);
  const cells = sampleCells(loadCells(), perSource);
  const { runLocalAssistantTools } = await import("../src/lib/chat/localAssistantTools");
  const { streamChatWithTools } = await import("../src/lib/llm");

  mkdirSync(RECEIPTS, { recursive: true });
  const output = path.join(RECEIPTS, `navshape-rag-${arm}-${form}-r${rep}.jsonl`);
  // Resume on COMPLETED rows only. A transport failure (the Codex backend
  // 429s under too much concurrency) writes an error row, and treating that
  // as done would bake a scored zero into the arm mean for a cell the model
  // never got to answer. Receipts are append-only, so the retry appends a
  // second row for that cell and the report keeps the completed one.
  const done = new Set(
    existsSync(output)
      ? readFileSync(output, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Row)
          .filter((row) => row.status === "completed")
          .map((row) => String(row.test_id))
      : [],
  );
  // Round-robin the work across sources. The sample is stratified but sorted
  // by test id, so a run that stops early would leave a source-ORDERED prefix
  // (all contractnli, no privacy_qa) — a partial result that is no longer
  // stratified. Interleaving keeps every prefix balanced, so an interrupted
  // condition is still a usable stratified sample.
  const pending = cells.filter((cell) => !done.has(cell.id));
  const queues = SOURCE_BENCHMARKS.map((source) =>
    pending.filter((cell) => cell.source === source),
  );
  const todo: Cell[] = [];
  for (let at = 0; todo.length < pending.length; at += 1) {
    for (const queue of queues) if (at < queue.length) todo.push(queue[at]);
  }
  console.log(
    `arm=${arm} form=${form} rep=${rep} shape=${shape} tools=${tools.length} schema_chars=${schemaChars} cells=${todo.length}/${cells.length} -> ${output}`,
  );

  let index = 0;
  let completed = 0;
  const worker = async () => {
    for (;;) {
      const at = index++;
      if (at >= todo.length) return;
      const cell = todo[at];
      const entry = map[cell.document];
      if (!entry) throw new Error(`document not ingested: ${cell.document}`);
      const row = await runCell({
        cell,
        documentId: entry.document_id,
        filename: entry.filename,
        arm,
        form,
        rep,
        tools,
        schemaChars,
        runLocalAssistantTools,
        streamChatWithTools,
      });
      appendFileSync(output, `${JSON.stringify(row)}\n`);
      completed += 1;
      if (completed % 10 === 0 || completed === todo.length) {
        console.log(`  ${completed}/${todo.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  console.log("done");
}

// ---------------------------------------------------------------------------
// Report: paired differences with a cluster bootstrap over documents.
// ---------------------------------------------------------------------------

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function clusterBootstrap(
  units: { document: string; value: number }[],
  draws = 2000,
): { mean: number; lo: number; hi: number; sd: number } {
  const byDoc = new Map<string, number[]>();
  for (const unit of units) {
    const bucket = byDoc.get(unit.document);
    if (bucket) bucket.push(unit.value);
    else byDoc.set(unit.document, [unit.value]);
  }
  const clusters = [...byDoc.values()];
  if (!clusters.length) return { mean: 0, lo: 0, hi: 0, sd: 0 };
  const rand = mulberry32(0x5eed);
  const samples: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    let sum = 0;
    let count = 0;
    for (let pick = 0; pick < clusters.length; pick += 1) {
      const cluster = clusters[Math.floor(rand() * clusters.length)];
      for (const value of cluster) {
        sum += value;
        count += 1;
      }
    }
    samples.push(count ? sum / count : 0);
  }
  samples.sort((a, b) => a - b);
  const point = mean(units.map((unit) => unit.value));
  const sd = Math.sqrt(mean(samples.map((value) => (value - mean(samples)) ** 2)));
  return {
    mean: point,
    lo: samples[Math.floor(0.025 * samples.length)],
    hi: samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))],
    sd,
  };
}

/**
 * Append-only receipts can hold a retried cell twice (a 429 error row plus the
 * completed retry). Scoring keeps the completed row and counts the error rows
 * separately as an instrument-failure rate — an error row scored as f1=0 would
 * be a transport fault masquerading as an arm's answer.
 */
function loadRows(): { rows: Row[]; transportErrors: number; duplicates: number } {
  if (!existsSync(RECEIPTS)) return { rows: [], transportErrors: 0, duplicates: 0 };
  const all = readdirSync(RECEIPTS)
    .filter((name) => /^navshape-rag-.*\.jsonl$/u.test(name))
    .flatMap((name) =>
      readFileSync(path.join(RECEIPTS, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row),
    );
  const best = new Map<string, Row>();
  let duplicates = 0;
  for (const row of all) {
    const k = `${row.arm}|${row.form}|${row.rep}|${row.test_id}`;
    const held = best.get(k);
    if (!held) best.set(k, row);
    else {
      duplicates += 1;
      if (held.status !== "completed" && row.status === "completed") best.set(k, row);
    }
  }
  return {
    rows: [...best.values()],
    transportErrors: all.filter((row) => row.status === "error").length,
    duplicates,
  };
}

const key = (row: Row) => `${row.form}|${row.rep}|${row.test_id}`;
const METRICS = ["f1_all", "f1_best", "recall_all", "reached_any", "reached_all", "n_tool_calls", "latency_ms"] as const;
const num = (value: unknown) => (typeof value === "number" ? value : value === true ? 1 : value === false ? 0 : 0);

/** Registered at the Stage 21 amendment: a cell counts as solved at
 * f1_best >= 0.5. Cells no arm ever solves are a signal-absence class, not
 * evidence of arm equality, so they are counted and reported, never dropped. */
const SOLVED = 0.5;
const solved = (row: Row) => num(row.f1_best) >= SOLVED;

/**
 * Stricter navigation metric, derived from the stored traces (no re-run).
 * `reached_any` counts library_find's +/-context window, which on a 10k
 * document a couple of finds can blanket — it saturates at 1.000 and stops
 * discriminating. `reached_by_read` asks the sharper question: did a
 * library_read — the model committing to a location — land on gold?
 */
function reachedByRead(row: Row, goldSpans: [number, number][]): boolean {
  const reads = ((row.tool_calls as ToolTrace[]) ?? [])
    .filter((trace) => trace.name === "library_read")
    .flatMap((trace) => trace.spans);
  return goldSpans.some(([gs, ge]) =>
    reads.some(([rs, re]) => Math.min(re, ge) > Math.max(rs, gs)),
  );
}

/**
 * Shortcut census bands. library_read's default window is 24,000 chars and
 * the tool-result ceiling is 64,000, so a short enough document can be read
 * whole and scored without the navigation surface doing any work.
 */
const sizeBand = (chars: number) =>
  chars <= 24_000
    ? "A <=24k default-read-whole"
    : chars <= 60_000
      ? "B 24k-60k one-deliberate-read"
      : chars <= 200_000
        ? "C 60k-200k"
        : "D >200k nav-mandatory";

/** test_id -> gold spans, for the derived `reached_by_read` metric. */
const goldByTest = () =>
  new Map(
    loadCells().map((cell) => [
      cell.id,
      cell.gold.map((g) => [g.start, g.end] as [number, number]),
    ]),
  );

function pairedTable(rows: Row[], schemaTokensByArm: Record<string, number>) {
  const gold = goldByTest();
  const byArm = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    const bucket = byArm.get(String(row.arm)) ?? new Map<string, Row>();
    if (!byArm.has(String(row.arm))) byArm.set(String(row.arm), bucket);
    bucket.set(key(row), row);
  }
  const legacy = byArm.get("legacy") ?? new Map();
  const address = byArm.get("address") ?? new Map();
  const shared = [...legacy.keys()].filter((k) => address.has(k));

  console.log(`\npaired cells (same test, form, replicate, both arms): ${shared.length}`);
  const forms = [...new Set(shared.map((k) => k.split("|")[0]))].sort();
  for (const form of forms) {
    const keys = shared.filter((k) => k.startsWith(`${form}|`));
    console.log(`\n--- form=${form}  paired n=${keys.length} ---`);
    console.log("metric          legacy   address     diff    95% CI (cluster bootstrap over documents)");
    for (const metric of METRICS) {
      const units = keys.map((k) => ({
        document: String(legacy.get(k)!.document),
        value: num(address.get(k)![metric]) - num(legacy.get(k)![metric]),
      }));
      const band = clusterBootstrap(units);
      const a = mean(keys.map((k) => num(legacy.get(k)![metric])));
      const b = mean(keys.map((k) => num(address.get(k)![metric])));
      const fmt = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(4));
      console.log(
        `${metric.padEnd(14)} ${fmt(a).padStart(8)} ${fmt(b).padStart(9)} ${fmt(band.mean).padStart(8)}   [${fmt(band.lo)}, ${fmt(band.hi)}]`,
      );
    }
    // Stricter navigation metric: did a committed library_read land on gold?
    {
      const units = keys.map((k) => ({
        document: String(legacy.get(k)!.document),
        value:
          (reachedByRead(address.get(k)!, gold.get(String(address.get(k)!.test_id)) ?? []) ? 1 : 0) -
          (reachedByRead(legacy.get(k)!, gold.get(String(legacy.get(k)!.test_id)) ?? []) ? 1 : 0),
      }));
      const band = clusterBootstrap(units);
      const rate = (side: Map<string, Row>) =>
        mean(keys.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `reached_by_read ${rate(legacy).toFixed(4).padStart(8)} ${rate(address).toFixed(4).padStart(9)} ${band.mean.toFixed(4).padStart(8)}   [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]`,
      );
    }

    // Tokens, with and without the arm's schema. The schema is re-sent every
    // model turn, so its cost is per-turn, not per-cell.
    console.log("\ntokens          legacy   address");
    for (const [label, pick] of [
      ["input_total", (r: Row) => num(asRecord(r.usage).inputTokens)],
      ["output_total", (r: Row) => num(asRecord(r.usage).outputTokens)],
      ["input_ex_schema", (r: Row) =>
        num(asRecord(r.usage).inputTokens) - (schemaTokensByArm[String(r.arm)] ?? 0) * num(r.n_model_turns)],
      ["model_turns", (r: Row) => num(r.n_model_turns)],
    ] as const) {
      const a = mean(keys.map((k) => pick(legacy.get(k)!)));
      const b = mean(keys.map((k) => pick(address.get(k)!)));
      console.log(`${label.padEnd(14)} ${a.toFixed(1).padStart(8)} ${b.toFixed(1).padStart(9)}`);
    }
    // Per source.
    console.log("\nper source (f1_best / reached_any / tool calls)");
    for (const source of SOURCE_BENCHMARKS) {
      const subset = keys.filter((k) => legacy.get(k)!.source === source);
      if (!subset.length) continue;
      const cell = (metric: (typeof METRICS)[number], side: Map<string, Row>) =>
        mean(subset.map((k) => num(side.get(k)![metric])));
      const rbr = (side: Map<string, Row>) =>
        mean(subset.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `  ${source.padEnd(12)} n=${String(subset.length).padStart(3)}  ` +
          `f1_best ${cell("f1_best", legacy).toFixed(3)} -> ${cell("f1_best", address).toFixed(3)}   ` +
          `read-hit ${rbr(legacy).toFixed(3)} -> ${rbr(address).toFixed(3)}   ` +
          `calls ${cell("n_tool_calls", legacy).toFixed(2)} -> ${cell("n_tool_calls", address).toFixed(2)}`,
      );
    }

    // Amendment 1: never-solved cells are signal absence, not arm equality.
    const neverSolved = keys.filter((k) => !solved(legacy.get(k)!) && !solved(address.get(k)!));
    const eitherSolved = keys.filter((k) => solved(legacy.get(k)!) || solved(address.get(k)!));
    console.log(
      `\nnever solved by either arm (f1_best < ${SOLVED}): ${neverSolved.length}/${keys.length} ` +
        `(${((100 * neverSolved.length) / Math.max(1, keys.length)).toFixed(1)}%)`,
    );
    for (const source of SOURCE_BENCHMARKS) {
      const all = keys.filter((k) => legacy.get(k)!.source === source);
      if (!all.length) continue;
      const none = all.filter((k) => !solved(legacy.get(k)!) && !solved(address.get(k)!));
      console.log(`  ${source.padEnd(12)} ${none.length}/${all.length}`);
    }
    if (eitherSolved.length && eitherSolved.length < keys.length) {
      console.log(`\nsame metrics over cells at least one arm solved (n=${eitherSolved.length})`);
      for (const metric of ["f1_best", "reached_any", "n_tool_calls"] as const) {
        const units = eitherSolved.map((k) => ({
          document: String(legacy.get(k)!.document),
          value: num(address.get(k)![metric]) - num(legacy.get(k)![metric]),
        }));
        const band = clusterBootstrap(units);
        const a = mean(eitherSolved.map((k) => num(legacy.get(k)![metric])));
        const b = mean(eitherSolved.map((k) => num(address.get(k)![metric])));
        console.log(
          `${metric.padEnd(14)} ${a.toFixed(4).padStart(8)} ${b.toFixed(4).padStart(9)} ${band.mean.toFixed(4).padStart(8)}   [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]`,
        );
      }
    }

    // Amendment 2: does document length predict the arm difference? Band A/B
    // cells can be read whole, so the surface has nothing to decide there.
    console.log("\nby document-size band (the read-it-whole shortcut)");
    const bands = [...new Set(keys.map((k) => sizeBand(num(legacy.get(k)!.document_chars))))].sort();
    for (const label of bands) {
      const subset = keys.filter((k) => sizeBand(num(legacy.get(k)!.document_chars)) === label);
      const units = subset.map((k) => ({
        document: String(legacy.get(k)!.document),
        value: num(address.get(k)!.f1_best) - num(legacy.get(k)!.f1_best),
      }));
      const band = clusterBootstrap(units);
      const callsA = mean(subset.map((k) => num(legacy.get(k)!.n_tool_calls)));
      const callsB = mean(subset.map((k) => num(address.get(k)!.n_tool_calls)));
      const rbr = (side: Map<string, Row>) =>
        mean(subset.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `  ${label.padEnd(30)} n=${String(subset.length).padStart(3)}  ` +
          `f1_best ${mean(subset.map((k) => num(legacy.get(k)!.f1_best))).toFixed(3)} -> ${mean(subset.map((k) => num(address.get(k)!.f1_best))).toFixed(3)}  ` +
          `diff ${band.mean.toFixed(4)} [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]  ` +
          `read-hit ${rbr(legacy).toFixed(3)} -> ${rbr(address).toFixed(3)}  calls ${callsA.toFixed(1)} -> ${callsB.toFixed(1)}`,
      );
    }
    // How often a single read actually swallowed the document — the shortcut
    // taken, not merely available.
    for (const [label, side] of [["legacy", legacy], ["address", address]] as const) {
      const whole = keys.filter((k) => {
        const row = side.get(k)!;
        const traces = (row.tool_calls as ToolTrace[]) ?? [];
        return traces.some(
          (trace) =>
            trace.name === "library_read" &&
            trace.spans.some(([start, end]) => end - start >= 0.95 * num(row.document_chars)),
        );
      });
      console.log(
        `  shortcut TAKEN (one read covered >=95% of the document), ${label}: ${whole.length}/${keys.length}`,
      );
    }
  }
}

/** Within-arm replicate floor: the same arm, same form, same test, different
 * replicate. Any between-arm difference smaller than this is stochasticity. */
function replicateFloor(rows: Row[]) {
  console.log("\n--- within-arm replicate floor (|rep1 - rep2|, same arm/form/test) ---");
  console.log("arm      form      n   metric        mean|diff|   paired diff 95% CI");
  const byCell = new Map<string, Row[]>();
  for (const row of rows) {
    const k = `${row.arm}|${row.form}|${row.test_id}`;
    const bucket = byCell.get(k) ?? [];
    if (!byCell.has(k)) byCell.set(k, bucket);
    bucket.push(row);
  }
  const groups = new Map<string, { document: string; rows: Row[] }[]>();
  for (const [k, bucket] of byCell) {
    if (bucket.length < 2) continue;
    const [arm, form] = k.split("|");
    const group = groups.get(`${arm}|${form}`) ?? [];
    if (!groups.has(`${arm}|${form}`)) groups.set(`${arm}|${form}`, group);
    group.push({ document: String(bucket[0].document), rows: bucket });
  }
  for (const [k, group] of [...groups].sort()) {
    const [arm, form] = k.split("|");
    for (const metric of ["f1_best", "reached_any", "n_tool_calls"] as const) {
      const abs = group.map((entry) => Math.abs(num(entry.rows[0][metric]) - num(entry.rows[1][metric])));
      const signed = group.map((entry) => ({
        document: entry.document,
        value: num(entry.rows[1][metric]) - num(entry.rows[0][metric]),
      }));
      const band = clusterBootstrap(signed);
      console.log(
        `${arm.padEnd(8)} ${form.padEnd(9)} ${String(group.length).padStart(3)}  ${metric.padEnd(13)} ` +
          `${mean(abs).toFixed(4).padStart(9)}   ${band.mean.toFixed(4)} [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]`,
      );
    }
  }
}

/** What arm B's extra affordances were actually used for. A capability nobody
 * calls is a finding. */
function affordances(rows: Row[]) {
  console.log("\n--- affordance census (all rows, per arm) ---");
  for (const arm of ["legacy", "address"]) {
    const subset = rows.filter((row) => row.arm === arm);
    if (!subset.length) continue;
    const traces = subset.flatMap((row) => (row.tool_calls as ToolTrace[]) ?? []);
    const byName = new Map<string, number>();
    const address = new Map<string, number>();
    const offSchema = new Map<string, number>();
    let follow = 0;
    let depth = 0;
    let fromEnd = 0;
    let failed = 0;
    for (const trace of traces) {
      byName.set(trace.name, (byName.get(trace.name) ?? 0) + 1);
      if (trace.address) address.set(trace.address, (address.get(trace.address) ?? 0) + 1);
      for (const k of trace.off_schema_keys) offSchema.set(k, (offSchema.get(k) ?? 0) + 1);
      if (trace.follow && trace.follow !== "none") follow += 1;
      if (trace.depth !== null) depth += 1;
      if (trace.from === "end") fromEnd += 1;
      if (!trace.ok) failed += 1;
    }
    console.log(`\n${arm}: ${subset.length} rows, ${traces.length} tool calls (${failed} returned ok:false)`);
    console.log(`  by tool     : ${[...byName].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join("  ") || "(none)"}`);
    console.log(`  address kind: ${[...address].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join("  ") || "(none — every call unaddressed)"}`);
    console.log(`  follow fired: ${follow}   depth passed: ${depth}   from=end: ${fromEnd}`);
    if (arm === "address") {
      // The whole point of the arm: which of the extra affordances earned
      // their schema chars. Denominators are the calls that COULD have used
      // each one, so a zero here means "offered and declined", not "no data".
      const finds = traces.filter((t) => t.name === "library_find").length;
      const reads = traces.filter((t) => t.name === "library_read").length;
      const scopedFinds = traces.filter((t) => t.name === "library_find" && t.address).length;
      const pct = (n: number, d: number) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : "0/0");
      console.log("  arm-B-only affordance uptake:");
      console.log(`    library_links called          : ${pct(byName.get("library_links") ?? 0, traces.length)} of all tool calls`);
      console.log(`    find follow= actually walked   : ${pct(follow, finds)} of find calls`);
      console.log(`    find at= scoped the search     : ${pct(scopedFinds, finds)} of find calls`);
      console.log(`    read from="end" (tail)         : ${pct(fromEnd, reads)} of read calls`);
      console.log(`    read at= named a PAGE          : ${pct([...address].filter(([k]) => k.startsWith("page")).reduce((n, [, c]) => n + c, 0), reads)} of read calls`);
    }
    console.log(`  OFF-SCHEMA params (the other arm's vocabulary, which the shared handler still honours): ${[...offSchema].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join("  ") || "(none)"}`);
  }
}

function report() {
  const { rows, transportErrors, duplicates } = loadRows();
  if (!rows.length) {
    console.log("no receipts yet");
    return;
  }
  console.log(`scored cells: ${rows.length}  (${duplicates} retried cell(s) de-duplicated)`);
  const cells = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.arm}|${row.form}|r${row.rep}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  for (const [k, count] of [...cells].sort()) console.log(`  ${k}: ${count}`);
  const stillErrored = rows.filter((row) => row.status === "error");
  console.log(
    `  transport failures written to receipts (Codex 429 under concurrency): ${transportErrors}` +
      `; still unrecovered after retry: ${stillErrored.length}`,
  );

  const tokensFile = path.join(RECEIPTS, "navshape-rag-schema-tokens.json");
  const schemaTokensByArm: Record<string, number> = existsSync(tokensFile)
    ? JSON.parse(readFileSync(tokensFile, "utf8"))
    : {};
  if (!Object.keys(schemaTokensByArm).length)
    console.log("  (no measured schema-token file; input_ex_schema will equal input_total)");

  pairedTable(rows, schemaTokensByArm);
  replicateFloor(rows);
  affordances(rows);
}

// ---------------------------------------------------------------------------

async function main() {
  const command = process.argv[2];
  if (command === "ingest") return ingest();
  if (command === "arms") return arms();
  if (command === "schema-tokens") return schemaTokens();
  if (command === "sample") {
    const cells = sampleCells(loadCells(), Number(flag("n", "40")));
    const byDoc = new Set(cells.map((cell) => cell.document));
    for (const source of SOURCE_BENCHMARKS) {
      const subset = cells.filter((cell) => cell.source === source);
      console.log(
        `${source.padEnd(12)} n=${subset.length} docs=${new Set(subset.map((c) => c.document)).size}`,
      );
    }
    console.log(`total n=${cells.length} documents=${byDoc.size} seed=${SEED}`);
    console.log(cells.map((cell) => cell.id).join(","));
    return;
  }
  if (command === "run") return run();
  if (command === "report") return report();
  throw new Error("usage: ingest | arms | schema-tokens | sample | run | report");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
