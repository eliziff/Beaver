/**
 * Nav-shape A/B on LegalBench-RAG-mini: AGENTIC retrieval.
 *
 * The question: which navigation grammar lets the same model retrieve exact
 * passages most accurately and cheaply? Arms may be library legacy, library
 * address, or coding (Glob/Grep/Read); every arm calls the same handlers.
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
 *   NAV_SHAPE_MODEL=claude-p:claude-sonnet-4-6 NAV_SHAPE_EFFORT=low \
 *     npx tsx scripts/nav-shape-rag.ts schema-tokens       # diagnostic, per arm
 *   MIKE_NAV_SHAPE=address NAV_SHAPE_MODEL=claude-p:claude-sonnet-4-6 \
 *     NAV_SHAPE_EFFORT=low npx tsx scripts/nav-shape-rag.ts run \
 *     --arm address --form asis --rep 1 --n 160 --concurrency 3
 *   MIKE_NAV_SHAPE=address MIKE_TOOL_SHAPE=coding ... run \
 *     --arm coding --form stripped --rep 1 --n 40
 *   npx tsx scripts/nav-shape-rag.ts report --compare address,coding
 *   # Full-catalog ablation: --surface full --no-disclosure
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

import type {
  NormalizedLlmUsage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../src/lib/llm/types";
import { findTextMatches } from "../src/lib/chat/tools/documentOps";
import {
  UPSTREAM_MIKE_COMMIT,
  UPSTREAM_MIKE_SCHEMA_SHA256,
} from "../src/lib/chat/upstreamMikeBenchmarkSurface";

import {
  LEGALBENCH_RAG_DATA_DIR,
  SOURCE_BENCHMARKS,
  normalizeCorpusText,
  sanitizeCorpusPath,
  upstreamBenchmarkSchema,
} from "../src/lib/legalbenchRag";

// ---------------------------------------------------------------------------
// Paths. The bed library is a scratch MIKE_LOCAL_DATA_DIR set before the store
// module is ever imported, so the user's real Library is untouchable from here.
// ---------------------------------------------------------------------------

type BedKind = "legalbench" | "docx-targets" | "beaver-can-pinpoint";
const bedFlagAt = process.argv.indexOf("--bed");
const requestedBed = (
  bedFlagAt >= 0 ? process.argv[bedFlagAt + 1] : process.env.NAV_SHAPE_BENCH
)?.trim() || "legalbench";
if (
  requestedBed !== "legalbench" &&
  requestedBed !== "docx-targets" &&
  requestedBed !== "beaver-can-pinpoint"
) {
  throw new Error(`unknown --bed ${requestedBed}`);
}
const BED_KIND = requestedBed as BedKind;

const EXPERIMENT_HOME = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
  "OpenLegalData",
  "experiments",
);
const BED_HOME =
  process.env.NAV_SHAPE_BED_DIR?.trim() ||
  path.join(
    EXPERIMENT_HOME,
    BED_KIND === "legalbench"
      ? "nav-shape-rag-bed"
      : BED_KIND === "docx-targets"
        ? "nav-shape-rag-docx-targets-bed"
        : "nav-shape-rag-beaver-can-pinpoint-bed",
  );
const BED_LIBRARY = path.join(BED_HOME, "library");
const BED_MAP = path.join(BED_HOME, "documents.json");
const BED_MANIFEST = path.join(BED_HOME, "benchmark.json");
const RECEIPTS =
  process.env.NAV_SHAPE_RECEIPTS_DIR?.trim() ||
  path.join(EXPERIMENT_HOME, "legal-grounding", "2026-07-30");

const IMPLEMENTATION_FILES = [
  __filename,
  path.resolve(__dirname, "../src/lib/chat/localAssistantTools.ts"),
  path.resolve(__dirname, "../src/lib/legalTextSkeleton.ts"),
  path.resolve(__dirname, "../src/lib/legalDocumentNavigator.ts"),
  path.resolve(__dirname, "../src/lib/legalCrossReference.ts"),
  path.resolve(__dirname, "../src/lib/legalRetrievalHybrid.ts"),
  path.resolve(__dirname, "../src/lib/legalStructureSidecar.ts"),
  path.resolve(__dirname, "../src/lib/beaverCan.ts"),
  path.resolve(__dirname, "../src/lib/sourceDoc.ts"),
  path.resolve(__dirname, "../src/lib/chat/tools/documentOps.ts"),
  path.resolve(__dirname, "../src/lib/llm/codexApi.ts"),
  path.resolve(__dirname, "../src/lib/llm/index.ts"),
];

function implementationIdentity() {
  const files = Object.fromEntries(
    IMPLEMENTATION_FILES.map((file) => [
      path.relative(path.resolve(__dirname, ".."), file).replace(/\\/gu, "/"),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  return {
    files,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

process.env.MIKE_LOCAL_DATA_DIR ??= BED_LIBRARY;
// Stage 21 (`--surface nav`) sent four nav tools and muted everything else.
// Stage 22 (`--surface full`) prices the DISCLOSURE bet, so the research
// organs must be present — they are most of what arm B defers. Muting them
// here would delete the very thing under test and quietly hand arm A a
// smaller surface than the product ships.
if (!process.argv.includes("full")) {
  process.env.MIKE_DISABLE_ASK_INPUTS = "1";
  process.env.MIKE_DISABLE_RESEARCH_TOOLS = "1";
}

const BED_USER = "nav-shape-rag-bed";
const LIBRARY_NAV_TOOLS = new Set([
  "library_read",
  "library_find",
  "library_outline",
  "library_links",
]);
// Pure coding baseline. Project-native graph navigation belongs in the
// post-baseline hybrid arms, not in the condition meant to establish what
// familiar file tools can do on their own.
const CODING_NAV_TOOLS = new Set(["Glob", "Grep", "Read"]);
const RETRIEVAL_EXPERIMENT_ARMS = new Set([
  "p0-pure-coding",
  "c0-routed-coding",
  "h1-contact",
  "h2-document-map",
  "h3-reference-impact",
  "h4-legal-grep",
  "d0-generic",
  "d1-routed",
  "d2-concrete",
]);

/** Will Chen's upstream project-retrieval surface, frozen from origin/main at
 * the commit below. This comparator lives only in the harness: production
 * Beaver does not gain a second implementation of document retrieval. */
const UPSTREAM_MIKE_TOOL_DECLARATIONS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
          },
        },
        required: ["doc_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, citing from, or editing a document, but call it at most once per document/version in a single response. After this returns, use the prior tool result or find_in_document for targeted checks instead of reading the same document/version again.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to read (e.g. 'doc-0', 'doc-1')",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_document",
      description:
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description:
              "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of surrounding context to include on each side of a match (default 80).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
];

// Upstream sends base tools before project-extra tools. Preserve that order:
// provider tool order can affect selection and prompt-cache identity even
// when the four schemas are otherwise byte-identical.
const upstreamToolByName = new Map(
  UPSTREAM_MIKE_TOOL_DECLARATIONS.map((entry) => [
    entry.function.name,
    entry,
  ]),
);
const UPSTREAM_MIKE_TOOLS = [
  "read_document",
  "find_in_document",
  "list_documents",
  "fetch_documents",
].map((name) => {
  const entry = upstreamToolByName.get(name);
  if (!entry) throw new Error(`missing frozen upstream tool ${name}`);
  return entry;
});

// Upstream sends base tools before project-extra tools. Preserve that order:
// provider tool order can affect selection and prompt-cache identity even
// when the four schemas are otherwise byte-identical.
const flag = (name: string, fallback?: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  if (at !== -1 && at + 1 < process.argv.length) return process.argv[at + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
};

// ---------------------------------------------------------------------------
// Bed: tests, gold, corpus.
// ---------------------------------------------------------------------------

type Gold = {
  start: number;
  end: number;
  answer: string;
  /** Human locator that attests this exact slice in derived pinpoint beds. */
  label?: string;
};
type Cell = {
  id: string;
  source: string;
  document: string;
  query: string;
  /** Everything after the leading "Consider <descriptor>; " — the question
   * with the document name removed. Asserted to exist on every query. */
  stripped: string;
  gold: Gold[];
  /** `alternatives` means any one gold span satisfies the retrieval request. */
  gold_mode?: "all" | "alternatives";
  tags?: string[];
};

type StoredBed = {
  schema_version: "navshape-bed-1";
  bed: "docx-targets" | "beaver-can-pinpoint";
  documents: Record<
    string,
    {
      text: string;
      text_sha256: string;
      bytes_sha256: string;
    }
  >;
  cells: Cell[];
};

let storedBedCache: StoredBed | null = null;
function storedBed(): StoredBed {
  if (storedBedCache) return storedBedCache;
  if (!existsSync(BED_MANIFEST)) {
    throw new Error(
      `${BED_KIND} bed not ingested: ${BED_MANIFEST}. Run ingest --bed ${BED_KIND} first.`,
    );
  }
  const parsed = JSON.parse(readFileSync(BED_MANIFEST, "utf8")) as StoredBed;
  if (
    parsed.schema_version !== "navshape-bed-1" ||
    parsed.bed !== BED_KIND ||
    !parsed.documents ||
    !Array.isArray(parsed.cells)
  ) {
    throw new Error(`invalid ${BED_KIND} bed manifest: ${BED_MANIFEST}`);
  }
  storedBedCache = parsed;
  return parsed;
}

const corpusCache = new Map<string, string>();
function corpusText(filePath: string): string {
  const hit = corpusCache.get(filePath);
  if (hit !== undefined) return hit;
  const text =
    BED_KIND !== "legalbench"
      ? storedBed().documents[filePath]?.text
      : normalizeCorpusText(
          readFileSync(
            path.join(
              LEGALBENCH_RAG_DATA_DIR,
              "mini",
              "corpus",
              sanitizeCorpusPath(filePath),
            ),
          ).toString("utf8"),
        );
  if (typeof text !== "string") {
    throw new Error(`document text missing from ${BED_KIND} bed: ${filePath}`);
  }
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
  if (BED_KIND !== "legalbench") {
    const cells = storedBed().cells;
    for (const cell of cells) {
      const text = corpusText(cell.document);
      if (!cell.stripped.trim() || cell.query !== cell.stripped) {
        throw new Error(`${cell.id}: ${BED_KIND} question is not title-free`);
      }
      if (
        cell.gold_mode !== undefined &&
        cell.gold_mode !== "all" &&
        cell.gold_mode !== "alternatives"
      ) {
        throw new Error(`${cell.id}: invalid gold_mode ${cell.gold_mode}`);
      }
      for (const gold of cell.gold) {
        if (text.slice(gold.start, gold.end) !== gold.answer) {
          throw new Error(`${cell.id}: stored gold span drifted`);
        }
      }
    }
    return cells;
  }
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

const benchmarkSources = (cells: Cell[]) =>
  BED_KIND === "legalbench"
    ? [...SOURCE_BENCHMARKS]
    : [...new Set(cells.map((cell) => cell.source))].sort();

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

const SEED = `nav-shape-rag-2026-07-31|${BED_KIND}`;

function sampleCells(
  all: Cell[],
  perSource: number,
  skipPerSource = 0,
): Cell[] {
  const out: Cell[] = [];
  for (const source of benchmarkSources(all)) {
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
    out.push(
      ...order
        .slice(skipPerSource, skipPerSource + perSource)
        .map((entry) => entry.cell),
    );
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

/** Corpus path -> an opaque Library filename. The stripped condition removes
 * the descriptor from the query, so Glob/Grep/Read must not hand it straight
 * back through a descriptive filename. */
const bedFilename = (corpusPath: string) =>
  `doc-${createHash("sha256").update(corpusPath).digest("hex").slice(0, 16)}.docx`;

const DOCX_TARGETS = [
  {
    id: "spa-cap-and-crossrefs",
    source: "cross-reference",
    question:
      "Return every exact current passage that sets or repeats the vendor's indemnity ceiling of two million dollars; exclude the separate supplier-claim amount.",
  },
  {
    id: "spa-delete-and-renumber",
    source: "cross-reference",
    question:
      "Return every exact current passage that would have to change if the purchaser-indemnity clause in Article VIII were deleted and the remaining clauses and all inbound references were renumbered.",
  },
  {
    id: "spa-schedule-c-notice",
    source: "structural-location",
    question:
      "Return the exact disclosure-schedule entry for the Larkspur distribution agreement's termination notice.",
  },
  {
    id: "letter-rate-increase",
    source: "unstructured-discrimination",
    question:
      "Return every exact occurrence that states Devon Achebe's current hourly rate.",
  },
  {
    id: "transcript-page-boundary",
    source: "structural-location",
    question:
      "Return the exact answer passage that begins at the bottom of page 12 and continues onto page 13 where the witness gives the delivery date; exclude the site-meeting date.",
  },
  {
    id: "credit-execution-page",
    source: "structural-location",
    question:
      "Return the exact signature-page line naming Dana Whitfield and her current officer title.",
  },
  {
    id: "credit-heading-and-toc",
    source: "structural-location",
    question:
      "Return both exact heading strings for Article 3: the table-of-contents entry and operative article heading; exclude clause-body uses of Fees.",
  },
  {
    id: "bylaw-directors-notice",
    source: "unstructured-discrimination",
    question:
      "Return the exact clause that states how much notice each director receives before a board meeting; exclude the members' notice clause.",
  },
  {
    id: "bylaw-signing-limit-table",
    source: "table-bilingual",
    question:
      "Return the complete treasurer row of the signing-authority table, including both thresholds.",
  },
  {
    id: "bilingual-cure-period",
    source: "table-bilingual",
    question:
      "Return all exact passages that state the cure period in the English clause, French clause, and bilingual summary table; exclude payment and renewal periods.",
  },
  {
    id: "ferry-remission-claim-window",
    source: "table-bilingual",
    question:
      "Return both exact language-version passages that state the claim deadline following importation; exclude the effective-date provisions.",
  },
] as const;

async function ingestDocxTargets() {
  const { taskById } = await import("../../benchmarks/docx_edit/src/tasks");
  const { fixtureBytes, fixtureText } = await import(
    "../../benchmarks/docx_edit/src/fixtures"
  );
  const { createLocalDocument } = await import("../src/lib/localDocumentStore");
  const { extractLocalDocument } = await import("../src/lib/chat/localAssistantTools");
  const tasks = DOCX_TARGETS.map((spec) => ({ spec, task: taskById(spec.id) }));
  const fixtureIds = [
    ...new Set(tasks.map(({ task }) => task.target_fixture)),
  ].sort();
  const tableFixtures = new Set(["crossbridge-bylaw", "bilingual-notice"]);
  const pagedFixtures = new Set(["northwind-credit", "discovery-transcript"]);
  const map: Record<
    string,
    { document_id: string; filename: string; chars: number }
  > = {};
  const documents: StoredBed["documents"] = {};
  const fixtureKey = new Map<string, string>();
  mkdirSync(BED_HOME, { recursive: true });

  for (const fixtureId of fixtureIds) {
    const bytes = await fixtureBytes(fixtureId);
    const expectedText = await fixtureText(fixtureId);
    const filename = bedFilename(`docx-targets:${fixtureId}`);
    const created = await createLocalDocument({
      userId: BED_USER,
      kind: "file",
      filename,
      bytes,
    });
    const extracted = await extractLocalDocument(BED_USER, created.id);
    if (!extracted || extracted.text !== expectedText) {
      throw new Error(`${fixtureId}: native DOCX text did not round-trip`);
    }
    if (tableFixtures.has(fixtureId) && !extracted.tableCells.length) {
      throw new Error(`${fixtureId}: native table cells were lost during ingest`);
    }
    if (pagedFixtures.has(fixtureId) && !extracted.pages.pages.length) {
      throw new Error(`${fixtureId}: page markers were lost during ingest`);
    }
    fixtureKey.set(fixtureId, filename);
    documents[filename] = {
      text: extracted.text,
      text_sha256: createHash("sha256").update(extracted.text).digest("hex"),
      bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    map[filename] = {
      document_id: created.id,
      filename,
      chars: extracted.text.length,
    };
  }

  const cells: Cell[] = [];
  let goldCount = 0;
  for (const { spec, task } of tasks) {
    if (task.expected !== "edit" || !task.reference_edits.length) {
      throw new Error(`${task.id}: retrieval projection requires reference edits`);
    }
    const document = fixtureKey.get(task.target_fixture);
    if (!document) throw new Error(`${task.id}: target fixture was not ingested`);
    const text = documents[document].text;
    const gold: Gold[] = [];
    for (const edit of task.reference_edits) {
      const target = edit.fixture ?? task.target_fixture;
      if (target !== task.target_fixture) {
        throw new Error(`${task.id}: cross-document edit is outside this bed`);
      }
      const starts: number[] = [];
      for (
        let at = text.indexOf(edit.find);
        at >= 0;
        at = text.indexOf(edit.find, at + Math.max(1, edit.find.length))
      ) {
        starts.push(at);
      }
      if (!starts.length || (edit.count !== undefined && starts.length !== edit.count)) {
        throw new Error(
          `${task.id}: ${JSON.stringify(edit.find)} occurs ${starts.length}, expected ${edit.count ?? "at least one"}`,
        );
      }
      for (const start of starts) {
        gold.push({
          start,
          end: start + edit.find.length,
          answer: edit.find,
        });
      }
    }
    goldCount += gold.length;
    cells.push({
      id: `docx-targets:${task.id}`,
      source: spec.source,
      document,
      query: spec.question,
      stripped: spec.question,
      gold,
      tags: [...task.categories],
    });
  }
  if (fixtureIds.length !== 7 || cells.length !== 11 || goldCount !== 26) {
    throw new Error(
      `docx-targets census drift: ${fixtureIds.length} docs, ${cells.length} tasks, ${goldCount} gold spans`,
    );
  }
  const manifest: StoredBed = {
    schema_version: "navshape-bed-1",
    bed: "docx-targets",
    documents,
    cells,
  };
  writeFileSync(BED_MAP, JSON.stringify(map, null, 2));
  writeFileSync(BED_MANIFEST, JSON.stringify(manifest, null, 2));
  storedBedCache = manifest;
  for (const cell of cells) {
    const text = documents[cell.document].text;
    for (const gold of cell.gold) {
      if (text.slice(gold.start, gold.end) !== gold.answer) {
        throw new Error(`${cell.id}: gold-slice oracle failed after serialization`);
      }
    }
  }
  console.log(
    `docx-targets bed OK: ${fixtureIds.length}/${fixtureIds.length} native documents text-plane identical, ` +
      `${goldCount}/${goldCount} exact gold spans, opaque filenames only`,
  );
}

/**
 * Project the existing Beaver-CAN human pinpoint annotations into exact
 * passage-retrieval cells. This does not create new human gold: one cell asks
 * for the passage supporting one already-defined proposition, and every
 * acceptable human pinpoint is retained as an alternative exact answer.
 */
async function ingestBeaverCanPinpoints() {
  const { BEAVER_CAN_DEV_TASKS_DIR, loadBeaverCanTaskDir } = await import(
    "../src/lib/beaverCan"
  );
  const { createLocalDocument } = await import("../src/lib/localDocumentStore");
  const { extractLocalDocument } = await import(
    "../src/lib/chat/localAssistantTools"
  );

  const taskDirs = readdirSync(BEAVER_CAN_DEV_TASKS_DIR, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(BEAVER_CAN_DEV_TASKS_DIR, entry.name))
    .sort();
  const documents: StoredBed["documents"] = {};
  const map: Record<
    string,
    { document_id: string; filename: string; chars: number }
  > = {};
  const filenameByTextHash = new Map<string, string>();
  const cells: Cell[] = [];
  let exactSpans = 0;

  mkdirSync(BED_HOME, { recursive: true });
  for (const taskDir of taskDirs) {
    const loaded = loadBeaverCanTaskDir(taskDir);
    const bySource = new Map(
      loaded.sources.map((source) => [source.source_id, source]),
    );
    for (const authority of loaded.gold.required_authorities) {
      const source = bySource.get(authority.source_id);
      if (!source?.doc) {
        throw new Error(
          `${loaded.task.id}:${authority.proposition_id}: required source has no compiled pinpoint map`,
        );
      }
      if (source.doc.text !== source.text) {
        throw new Error(
          `${loaded.task.id}:${authority.proposition_id}: SourceDoc text differs from packet text`,
        );
      }

      const textHash = createHash("sha256").update(source.text).digest("hex");
      let filename = filenameByTextHash.get(textHash);
      if (!filename) {
        filename = bedFilename(`beaver-can-pinpoint:${textHash}`);
        const bytes = await docxFromText(source.text);
        const created = await createLocalDocument({
          userId: BED_USER,
          kind: "file",
          filename,
          bytes,
        });
        const extracted = await extractLocalDocument(BED_USER, created.id);
        if (!extracted || extracted.text !== source.text) {
          throw new Error(
            `${loaded.task.id}:${authority.source_id}: native DOCX text did not round-trip`,
          );
        }
        filenameByTextHash.set(textHash, filename);
        documents[filename] = {
          text: extracted.text,
          text_sha256: textHash,
          bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        map[filename] = {
          document_id: created.id,
          filename,
          chars: extracted.text.length,
        };
      }

      const gold = authority.acceptable_pinpoints.map((pinpoint) => {
        const label =
          typeof pinpoint === "number" ? `par${pinpoint}` : `sec${pinpoint}`;
        const block = source.doc!.blocks.find(
          (candidate) => candidate.label === label,
        );
        if (!block) {
          throw new Error(
            `${loaded.task.id}:${authority.proposition_id}: ${label} did not resolve`,
          );
        }
        const raw = source.text.slice(block.start, block.end);
        const answer = raw.trim();
        const relativeStart = raw.indexOf(answer);
        if (!answer || relativeStart < 0) {
          throw new Error(
            `${loaded.task.id}:${authority.proposition_id}: ${label} is empty`,
          );
        }
        const start = block.start + relativeStart;
        const exact = {
          start,
          end: start + answer.length,
          answer,
          label,
        };
        if (source.text.slice(exact.start, exact.end) !== exact.answer) {
          throw new Error(
            `${loaded.task.id}:${authority.proposition_id}: ${label} exact-slice oracle failed`,
          );
        }
        return exact;
      });
      const uniqueGold = [
        ...new Map(
          gold.map((entry) => [
            `${entry.start}:${entry.end}:${entry.answer}`,
            entry,
          ]),
        ).values(),
      ];
      const definition = loaded.gold.definitions[authority.proposition_id];
      const question =
        "Return the exact passage in this source that supports this proposition: " +
        definition;
      if (
        !definition ||
        question.toLocaleLowerCase("en-US").includes(
          source.citation.toLocaleLowerCase("en-US"),
        ) ||
        question.includes(filename)
      ) {
        throw new Error(
          `${loaded.task.id}:${authority.proposition_id}: question leaks its source identity`,
        );
      }
      exactSpans += uniqueGold.length;
      cells.push({
        id: `${loaded.task.id}:${authority.proposition_id}`,
        source: `beaver-can-${source.doc.docType}`,
        document: filename,
        query: question,
        stripped: question,
        gold: uniqueGold,
        gold_mode: "alternatives",
        tags: [
          loaded.task.task_type,
          source.doc.docType ?? "unknown",
          "human-gold-derived",
          uniqueGold.length > 1 ? "multiple-pinpoints" : "single-pinpoint",
        ],
      });
    }
  }

  if (taskDirs.length !== 8 || cells.length !== 19) {
    throw new Error(
      `beaver-can-pinpoint census drift: ${taskDirs.length} tasks, ${cells.length} required-authority cells`,
    );
  }
  const manifest: StoredBed = {
    schema_version: "navshape-bed-1",
    bed: "beaver-can-pinpoint",
    documents,
    cells,
  };
  writeFileSync(BED_MAP, JSON.stringify(map, null, 2));
  writeFileSync(BED_MANIFEST, JSON.stringify(manifest, null, 2));
  storedBedCache = manifest;
  console.log(
    `beaver-can-pinpoint bed OK: ${cells.length} human-gold-derived cells, ` +
      `${Object.keys(documents).length} opaque documents, ${exactSpans} exact alternative pinpoint spans`,
  );
}

async function ingest() {
  if (BED_KIND === "docx-targets") return ingestDocxTargets();
  if (BED_KIND === "beaver-can-pinpoint") return ingestBeaverCanPinpoints();
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

/** Remove first-arm cache-warm bias after a structure-compiler version bump.
 * This is deterministic preprocessing only: no model, question, or gold is
 * involved. Native table coordinates come from the ingested DOCX artifact. */
async function prebakeBed() {
  if (!existsSync(BED_MAP)) throw new Error("bed not ingested; run `ingest` first");
  const map = JSON.parse(readFileSync(BED_MAP, "utf8")) as Record<
    string,
    { document_id: string; filename: string }
  >;
  const [{ extractLocalDocument }, { bakeStructure }] = await Promise.all([
    import("../src/lib/chat/localAssistantTools"),
    import("../src/lib/legalStructureSidecar"),
  ]);
  let baked = 0;
  let totalMs = 0;
  for (const [source, entry] of Object.entries(map).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const document = await extractLocalDocument(BED_USER, entry.document_id);
    if (!document) throw new Error(`could not extract ingested document: ${source}`);
    if (document.text !== corpusText(source)) {
      throw new Error(`prebake text oracle failed: ${source}`);
    }
    const report = await bakeStructure(document.text, entry.document_id, {
      tableCells: document.tableCells,
    });
    baked += 1;
    totalMs += report.skeletonMs + report.graphMs;
    console.log(
      `${entry.filename} chars=${report.chars} nodes=${report.nodes} edges=${report.edges} compute_ms=${Math.round(report.skeletonMs + report.graphMs)}`,
    );
  }
  console.log(`prebaked ${baked} documents in ${Math.round(totalMs)}ms`);
}

// ---------------------------------------------------------------------------
// Arm census + measured schema token cost.
// ---------------------------------------------------------------------------

async function navSchemas(requestedArm = "") {
  const mod = await import("../src/lib/chat/localAssistantTools");
  const mode = surfaceMode();
  const full = mode !== "nav";
  const inferredArm = mod.RETRIEVAL_EXPERIMENT_SHAPE
    ? mod.RETRIEVAL_EXPERIMENT_SHAPE
    : mod.CODING_TOOL_SHAPE
      ? "coding"
      : mod.NAV_TOOL_SHAPE;
  const arm = requestedArm || inferredArm;
  if (
    !["upstream", "legacy", "address", "coding"].includes(arm) &&
    !RETRIEVAL_EXPERIMENT_ARMS.has(arm)
  ) {
    throw new Error(`unknown preregistered arm: ${arm}`);
  }
  if (arm === "coding" && !mod.CODING_TOOL_SHAPE) {
    throw new Error("coding arm requires MIKE_TOOL_SHAPE=coding");
  }
  if (
    RETRIEVAL_EXPERIMENT_ARMS.has(arm) &&
    (!mod.CODING_TOOL_SHAPE ||
      mod.NAV_TOOL_SHAPE !== "address" ||
      mod.RETRIEVAL_EXPERIMENT_SHAPE !== arm)
  ) {
    throw new Error(
      `${arm} requires MIKE_NAV_SHAPE=address, MIKE_TOOL_SHAPE=coding, and MIKE_RETRIEVAL_EXPERIMENT=${arm}`,
    );
  }
  if (
    (arm === "address" || arm === "legacy") &&
    (mod.CODING_TOOL_SHAPE || mod.NAV_TOOL_SHAPE !== arm)
  ) {
    throw new Error(
      `${arm} arm requires MIKE_NAV_SHAPE=${arm} and no MIKE_TOOL_SHAPE`,
    );
  }
  if (arm === "upstream" && full) {
    throw new Error(`${arm} is a registered nav-only comparator`);
  }
  const { buildSystemPrompt } = await import("../src/lib/chat/prompts");
  // Stage 22 uses the PRODUCT prompt, because the prose cuts are part of the
  // disclosure bet being priced; Stage 21's arm-neutral prompt would hide
  // half of what arm B changed.
  const prose = full ? buildSystemPrompt(true) : "";
  let partition: {
    resident: OpenAIToolSchema[];
    deferred: OpenAIToolSchema[];
  };
  if (arm === "upstream") {
    const frozenBytes = JSON.stringify(UPSTREAM_MIKE_TOOLS);
    const frozenHash = createHash("sha256").update(frozenBytes).digest("hex");
    if (frozenHash !== UPSTREAM_MIKE_SCHEMA_SHA256) {
      throw new Error(
        `upstream Mike schema drift: ${frozenHash} (${frozenBytes.length} chars), expected ${UPSTREAM_MIKE_SCHEMA_SHA256}`,
      );
    }
    partition = { resident: UPSTREAM_MIKE_TOOLS, deferred: [] };
  } else {
    const experimentWithDisclosure =
      arm === "h2-document-map" || arm === "h3-reference-impact";
    const navTools = mod.CODING_TOOL_SHAPE
      ? CODING_NAV_TOOLS
      : LIBRARY_NAV_TOOLS;
    partition =
      experimentWithDisclosure
        ? mod.partitionTools(mod.LOCAL_ASSISTANT_TOOLS)
        : mode === "full-no-disclosure"
          ? { resident: mod.LOCAL_ASSISTANT_TOOLS, deferred: [] }
          : full
            ? mod.partitionTools(mod.LOCAL_ASSISTANT_TOOLS)
            : {
                resident: mod.LOCAL_ASSISTANT_TOOLS.filter((e) =>
                  navTools.has(e.function.name),
                ),
                deferred: [],
              };
  }
  const tools = partition.resident;
  return {
    arm,
    shape:
      arm === "upstream"
        ? `upstream@${UPSTREAM_MIKE_COMMIT.slice(0, 12)}`
        : mod.NAV_TOOL_SHAPE,
    tools,
    deferred: partition.deferred,
    prose,
    full,
    mode,
    promptHash: createHash("sha256")
      .update(prose ? `${prose}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT)
      .digest("hex"),
    /** Identity of everything the model can be shown: resident schemas,
     * deferred schemas, and prose. */
    hash: createHash("sha256")
      .update(
        JSON.stringify([
          tools,
          partition.deferred,
          prose,
          SYSTEM_PROMPT,
          arm === "upstream" ? UPSTREAM_MIKE_COMMIT : null,
        ]),
      )
      .digest("hex")
      .slice(0, 16),
  };
}

/**
 * Arm identity pin. Concurrent sessions share this tree, and on 2026-07-31 a
 * run was invalidated because both arms' schemas were edited by another
 * session mid-flight — arm A twice, arm B four times — and every process
 * silently picked up whatever the file said when IT started. Verifying the
 * arms once before the run was not enough.
 *
 * `--expect-hash <hex>` refuses to start unless the surface about to be sent
 * is byte-identical to the one the run registered. Every row also carries the
 * hash, so a drifted receipt stays detectable after the fact.
 */
function assertArmHash(actual: string) {
  const at = process.argv.indexOf("--expect-hash");
  if (at < 0) {
    console.log(`  (no --expect-hash given; arm hash is ${actual})`);
    return;
  }
  const expected = process.argv[at + 1];
  if (expected !== actual) {
    throw new Error(
      `ARM DRIFT: schema hash is ${actual}, run registered ${expected}. ` +
        `Another session edited the surface. Refusing to append rows that would ` +
        `average two different arms.`,
    );
  }
  console.log(`  arm hash ${actual} matches --expect-hash`);
}

async function arms() {
  const requested = process.argv.includes("--arm") ? flag("arm") : "";
  const { arm, shape, tools, deferred, mode, hash, promptHash } =
    await navSchemas(requested);
  let chars = 0;
  for (const entry of tools) {
    const json = JSON.stringify(entry);
    chars += json.length;
    const props = Object.keys(
      ((entry.function.parameters as Record<string, unknown>)?.properties ?? {}) as object,
    );
    console.log(`${entry.function.name.padEnd(16)} ${String(json.length).padStart(5)} chars  ${props.join(", ")}`);
  }
  console.log(
    `\narm=${arm} MIKE_NAV_SHAPE=${shape} surface=${mode} resident=${tools.length} deferred=${deferred.length} schema_chars=${chars} arm_hash=${hash} prompt_sha256=${promptHash}`,
  );
}

/**
 * Provider-measured schema cost: the same trivial turn with and without the
 * arm's tools attached. Subtracting an estimate would put a tokenizer guess
 * inside the headline "tokens excluding the schema" number.
 */
async function schemaTokens() {
  requireModelConfig();
  const { streamChatWithTools } = await import("../src/lib/llm");
  const requested = process.argv.includes("--arm") ? flag("arm") : "";
  const { arm, shape, tools, hash, mode, promptHash } =
    await navSchemas(requested);
  const ask = async (withTools: boolean) => {
    const r = await streamChatWithTools({
      model: MODEL,
      reasoningEffort: EFFORT,
      ...(SERVICE_TIER ? { serviceTier: SERVICE_TIER } : {}),
      enableThinking: false,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "ping" }],
      ...(withTools ? { tools, runTools: async () => [] } : {}),
      maxIterations: 1,
    });
    return {
      ...tokenAccounting(r.usage),
      provider_service_tier: r.serviceTier ?? null,
    };
  };
  const bare = await ask(false);
  const armed = await ask(true);
  console.log(
    JSON.stringify({
      arm,
      shape,
      surface: mode,
      schema_hash: hash,
      system_prompt_sha256: promptHash,
      tools: tools.length,
      requested_service_tier: SERVICE_TIER || null,
      bare,
      armed,
      schema_token_basis: "context_input_tokens",
      schema_tokens:
        armed.context_input_tokens - bare.context_input_tokens,
    }),
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

/** Diagnostic correctness gate for passage tasks. Whitespace is transport
 * formatting; everything else must occur verbatim in the answer. */
const exactText = (value: string) => value.replace(/\s+/gu, " ").trim();

// ---------------------------------------------------------------------------
// The agentic cell.
// ---------------------------------------------------------------------------

/**
 * Arm-neutral by construction: names no tool, no parameter and no addressing
 * vocabulary, so neither arm is prompted toward its own affordances.
 */
const SYSTEM_PROMPT = (
  "You are answering a question about one document in the user's Beaver Library. " +
  "Use the available tools to navigate the document and locate the passage that answers the question. " +
  "The document is long and cannot be read in full — find the relevant part. " +
  "When you have located it, reply with ONLY the verbatim text of the passage or passages, copied exactly from the document: " +
  "no preamble, no commentary, no citation. If more than one passage is requested, return all of them in document order. " +
  "If the document does not answer the question, reply exactly: NOT FOUND."
).replace(
  "The document is long and cannot be read in full",
  "The document may be long; navigate efficiently",
);

const MODEL = process.env.NAV_SHAPE_MODEL?.trim() || "";
const EFFORT = process.env.NAV_SHAPE_EFFORT?.trim() || "";
const SERVICE_TIER =
  process.env.NAV_SHAPE_SERVICE_TIER?.trim().toLowerCase() || "";
const MAX_ITERATIONS = Number(process.env.NAV_SHAPE_MAX_ITERATIONS || 10);

/** Claude reports cache reads/writes outside raw input; OpenAI-compatible
 * transports report cached input as a subset of input. Normalize both to the
 * actual context presented without losing the provider's raw counters. */
function tokenAccounting(usage: NormalizedLlmUsage | null | undefined) {
  const rawInput = usage?.inputTokens ?? 0;
  const rawOutput = usage?.outputTokens ?? 0;
  const cacheRead = usage?.cacheReadInputTokens ?? 0;
  const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
  const contextInput = MODEL.startsWith("claude-p:")
    ? rawInput + cacheRead + cacheWrite
    : rawInput;
  return {
    context_input_basis: MODEL.startsWith("claude-p:")
      ? "raw_plus_cache_read_plus_cache_write"
      : "raw_input_includes_cached_subset",
    raw_input_tokens: rawInput,
    raw_output_tokens: rawOutput,
    cache_read_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    context_input_tokens: contextInput,
    total_context_tokens: contextInput + rawOutput,
  };
}

function requireModelConfig() {
  if (!MODEL || !EFFORT) {
    throw new Error(
      "NAV_SHAPE_MODEL and NAV_SHAPE_EFFORT are required for run and schema-tokens",
    );
  }
  if (SERVICE_TIER && SERVICE_TIER !== "fast") {
    throw new Error("NAV_SHAPE_SERVICE_TIER must be empty or fast");
  }
  if (SERVICE_TIER && !MODEL.startsWith("codex:")) {
    throw new Error("NAV_SHAPE_SERVICE_TIER is only supported by codex models");
  }
}

/**
 * Stage 21 sent four nav tools and its own arm-neutral prompt, which is why
 * it could say nothing about the tool-count question. `--surface full` is
 * Stage 22: the WHOLE product surface and the product system prompt, so the
 * arms differ by the disclosure bet (43 resident tools vs 11 + a
 * `describe_tools` door) as well as the nav grammar.
 */
const surfaceMode = (): "nav" | "full" | "full-no-disclosure" => {
  const full =
    process.argv.includes("--surface") &&
    process.argv[process.argv.indexOf("--surface") + 1] === "full";
  return full
    ? process.argv.includes("--no-disclosure")
      ? "full-no-disclosure"
      : "full"
    : "nav";
};

type ToolTrace = {
  name: string;
  arg_keys: string[];
  /** Hash of the complete input for trajectory identity without depending on
   * truncated diagnostic previews. */
  input_sha256: string;
  /** Argument names this arm's schema does not declare. Nonzero means the
   * model reached for the other arm's vocabulary and the handler — which is
   * shared — may have honoured it. */
  off_schema_keys: string[];
  /** For `at`/`section`/`offset`/`page`: what kind of address was named. */
  address: string | null;
  /** Bounded local-receipt diagnostics. These receipts already contain the
   * benchmark question and answer; caps keep a malformed call/result from
   * turning one row into an accidental document dump. */
  locator: string | null;
  query: string | null;
  follow: string | null;
  depth: number | null;
  from: string | null;
  mode: string | null;
  offset: number | null;
  limit: number | null;
  max_chars: number | null;
  max_results: number | null;
  context_chars: number | null;
  head_limit: number | null;
  ok: boolean;
  error: string | null;
  result_chars: number;
  /** Executable Read recipes made visible by this result. */
  emitted_locator_count: number;
  /** For an addressed Read, whether that exact recipe appeared in a prior
   * tool result. Null for calls that are not addressed Reads. */
  locator_from_prior_result: boolean | null;
  /** Whether the addressed Read resolved. Null for calls that are not
   * addressed Reads. */
  locator_resolved: boolean | null;
  /** Document coordinates of text this call put in front of the model. */
  spans: [number, number][];
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const traceText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

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
  result: NormalizedToolResult,
  payload: unknown,
  text: string,
): [number, number][] {
  if (result.evidenceSpans?.length) {
    return result.evidenceSpans.filter(
      ([start, end]) =>
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end > start &&
        end <= text.length,
    );
  }
  const body = asRecord(payload);
  if (body.ok !== true) return [];
  const spans: [number, number][] = [];
  if (name === "library_read") {
    if (args.mode === "drafting" || args.mode === "redline") {
      // Both projection modes are whole-document views. They preserve the
      // document's text in semantic/redline markup rather than returning a
      // source-coordinate slice, so the exposure metric is the full text.
      return text ? [[0, text.length]] : [];
    }
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
      const at =
        typeof hit.offset === "number"
          ? hit.offset
          : typeof hit.at === "number"
            ? hit.at
            : null;
      const excerpt = typeof hit.excerpt === "string" ? hit.excerpt.length : 0;
      if (at === null) continue;
      spans.push([Math.max(0, at - context), Math.min(text.length, at + excerpt + context)]);
    }
  }
  return spans;
}

/** Canonical benchmark-only identity for an executable coding Read recipe.
 * File identity is omitted because every cell exposes exactly one document. */
function canonicalReadRecipe(value: unknown): string | null {
  const input = asRecord(value);
  const section =
    typeof input.section === "string" ? input.section.trim() : "";
  if (section) {
    // Some providers materialize the schema minima (offset=1, limit=1) even
    // when the model selected a section. Ignore those inert placeholders, but
    // distinguish model-added slicing: it is not an exact copy of a locator
    // that emitted only `section` and can change what the Read returns.
    const offset = Number.isFinite(input.offset)
      ? Math.trunc(Number(input.offset))
      : null;
    const limit = Number.isFinite(input.limit)
      ? Math.trunc(Number(input.limit))
      : null;
    const slicedOffset = offset !== null && offset > 1 ? `:offset:${offset}` : "";
    const slicedLimit = limit !== null && limit > 1 ? `:limit:${limit}` : "";
    return `section:${section}${slicedOffset}${slicedLimit}`;
  }
  if (!Number.isFinite(input.offset)) return null;
  const offset = Math.trunc(Number(input.offset));
  if (offset < 1) return null;
  const limit = Number.isFinite(input.limit)
    ? Math.trunc(Number(input.limit))
    : null;
  return limit !== null && limit >= 1
    ? `offset:${offset}:limit:${limit}`
    : `offset:${offset}`;
}

/** Recover only executable locator metadata, never document prose. H1 emits
 * recipes in plain Grep text; H2/H3 emit `{ read: ... }` JSON rows. */
function emittedReadRecipes(payload: unknown, content: string): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.read && typeof record.read === "object") {
      const recipe = canonicalReadRecipe(record.read);
      if (recipe) found.add(recipe);
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(payload);
  for (const match of content.matchAll(/Read section="([^"\r\n]+)"/gu)) {
    found.add(`section:${match[1]}`);
  }
  for (const match of content.matchAll(/Read offset=(\d+) limit=(\d+)/gu)) {
    found.add(`offset:${Number(match[1])}:limit:${Number(match[2])}`);
  }
  return found;
}

function toolResultOk(payload: unknown, content: string): boolean {
  const explicit = asRecord(payload).ok;
  if (typeof explicit === "boolean") return explicit;
  return !/^(?:document (?:not found|could not be read)|file (?:path is ambiguous|does not exist|could not be read)|regex parse error|pattern is required|section .* not found|\(offset .* (?:outside|past))/iu.test(
    content.trim(),
  );
}

/** Benchmark-only dispatcher for the four schemas frozen from upstream Mike.
 * The citation-reminder wrapper is deliberately omitted: this cell measures
 * retrieval, while the common prompt requires passage-only output. Full text,
 * duplicate-read suppression, Ctrl+F semantics and visible result shapes stay
 * faithful. Evidence spans are private scoring metadata, never shown to the
 * model. */
function runUpstreamMikeTool(params: {
  call: NormalizedToolCall;
  text: string;
  documentId: string;
  filename: string;
  read: Set<string>;
}): NormalizedToolResult {
  const { call, text, documentId, filename, read } = params;
  const args = asRecord(call.input);
  const resolves = (value: unknown) =>
    typeof value === "string" &&
    ["doc-0", documentId, filename].some(
      (candidate) => candidate.toLowerCase() === value.trim().toLowerCase(),
    );
  const response = (
    content: string,
    evidenceSpans: [number, number][] = [],
  ): NormalizedToolResult => ({
    tool_use_id: call.id,
    content,
    ...(evidenceSpans.length ? { evidenceSpans } : {}),
  });
  const duplicate = () =>
    JSON.stringify({
      ok: true,
      already_read: true,
      doc_id: "doc-0",
      filename,
      document_id: documentId,
      version_id: null,
      content:
        "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.",
      next_required_action:
        "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document.",
    });

  if (call.name === "list_documents") {
    return response(
      JSON.stringify([{ doc_id: "doc-0", filename, file_type: "docx" }]),
    );
  }
  if (call.name === "read_document") {
    if (!resolves(args.doc_id)) return response("Document not found.");
    if (read.has("doc-0")) return response(duplicate());
    read.add("doc-0");
    return response(text, text ? [[0, text.length]] : []);
  }
  if (call.name === "fetch_documents") {
    const ids = Array.isArray(args.doc_ids) ? args.doc_ids : [];
    const parts: string[] = [];
    let exposed = false;
    for (const id of ids) {
      const label = typeof id === "string" ? id : String(id);
      if (!resolves(id)) {
        parts.push(`--- ${label} (${label}) ---\nDocument not found.`);
      } else if (read.has("doc-0")) {
        parts.push(`--- ${filename} (doc-0) ---\n${duplicate()}`);
      } else {
        read.add("doc-0");
        exposed = true;
        parts.push(`--- ${filename} (doc-0) ---\n${text}`);
      }
    }
    return response(
      parts.join("\n\n"),
      exposed && text ? [[0, text.length]] : [],
    );
  }
  if (call.name === "find_in_document") {
    if (!resolves(args.doc_id)) {
      return response(
        JSON.stringify({
          ok: false,
          error: `Document '${String(args.doc_id ?? "")}' not found.`,
        }),
      );
    }
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) {
      return response(JSON.stringify({ ok: false, error: "Empty query." }));
    }
    const maxResults =
      typeof args.max_results === "number" ? args.max_results : 20;
    const contextChars =
      typeof args.context_chars === "number" ? args.context_chars : 80;
    const found = findTextMatches({
      text,
      query,
      maxResults,
      contextChars,
    });
    const spans: [number, number][] = [];
    let cursor = 0;
    for (const hit of found.hits) {
      const start = text.indexOf(hit.excerpt, cursor);
      if (start < 0) continue;
      const end = start + hit.excerpt.length;
      spans.push([
        Math.max(0, start - contextChars),
        Math.min(text.length, end + contextChars),
      ]);
      cursor = end;
    }
    return response(
      JSON.stringify({
        ok: true,
        filename,
        query,
        total_matches: found.totalMatches,
        returned: found.hits.length,
        truncated: found.totalMatches > found.hits.length,
        hits: found.hits,
      }),
      spans,
    );
  }
  return response(`Unknown tool: ${call.name}`);
}

const overlaps = (spans: [number, number][], gold: Gold) =>
  spans.some(([start, end]) => Math.min(end, gold.end) > Math.max(start, gold.start));

type Row = Record<string, unknown>;

async function runCell(args: {
  cell: Cell;
  documentId: string;
  filename: string;
  arm: string;
  navShape: string;
  form: "asis" | "stripped";
  rep: number;
  tools: Awaited<ReturnType<typeof navSchemas>>["tools"];
  deferred: Awaited<ReturnType<typeof navSchemas>>["deferred"];
  prose: string;
  surface: "nav" | "full" | "full-no-disclosure";
  schemaChars: number;
  schemaHash: string;
  promptHash: string;
  runIdentityHash: string;
  bedMapHash: string;
  bedDefinitionHash: string;
  implementationHash: string;
  runLocalAssistantTools: typeof import("../src/lib/chat/localAssistantTools").runLocalAssistantTools;
  toolsForDomains: typeof import("../src/lib/chat/localAssistantTools").toolsForDomains;
  streamChatWithTools: typeof import("../src/lib/llm").streamChatWithTools;
}): Promise<Row> {
  const { cell, documentId, tools } = args;
  const text = corpusText(cell.document);
  let traces: ToolTrace[] = [];
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
  const residentNames = new Set(tools.map((entry) => entry.function.name));
  const allowed = new Set([documentId]);
  // Stage 22 disclosure state. `live` is what the provider is shown; the
  // thunk hands it back at the top of every tool-loop iteration, so a schema
  // added here is callable on the very next turn.
  const live: typeof tools = [...tools];
  const deferredNames = new Set(args.deferred.map((e) => e.function.name));
  const opened = new Set<string>();
  const upstreamReads = new Set<string>();
  const priorReadRecipes = new Set<string>();
  const discloses: { turn: number; domains: string[]; opened: string[] }[] = [];
  const perTurnSchemaChars: number[] = [];
  const perTurnSchemaHashes: string[] = [];
  /** THE DISQUALIFIER: a deferred tool named before its domain was opened —
   * a failure the arm caused, not an ordinary miss. */
  let deferredCallsBeforeOpen = 0;
  let unservedCallsRefused = 0;
  let headlessCallsRefused = 0;
  let modelTurns = 1;
  const startedAt = Date.now();
  let answer = "";
  let error: string | null = null;
  let usage: import("../src/lib/llm").NormalizedLlmUsage | null = null;
  let providerServiceTier: string | null = null;

  /**
   * The Codex backend 429s in bursts once a few harness processes overlap.
   * Without backoff a burst is worse than slow: every queued cell fails in
   * milliseconds, so one storm consumes the whole pass and leaves a receipt
   * full of error rows. Retry the transport, never the scoring.
   */
  const attempt = async <T>(run: () => Promise<T>): Promise<T> => {
    let wait = 4_000;
    for (let tries = 0; ; tries += 1) {
      try {
        // A retried attempt is a fresh trajectory: discard the partial
        // trace and turn count, or a cell that 429'd mid-loop would report
        // one navigation as two.
        traces = [];
        modelTurns = 1;
        live.length = 0;
        live.push(...tools);
        for (const name of declared.keys()) {
          if (!residentNames.has(name)) declared.delete(name);
        }
        opened.clear();
        upstreamReads.clear();
        priorReadRecipes.clear();
        discloses.length = 0;
        perTurnSchemaChars.length = 0;
        perTurnSchemaHashes.length = 0;
        deferredCallsBeforeOpen = 0;
        unservedCallsRefused = 0;
        headlessCallsRefused = 0;
        return await run();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (tries >= 5 || !/\b429\b|rate limit/iu.test(message)) throw caught;
        await new Promise((resolve) => setTimeout(resolve, wait + Math.random() * wait));
        wait *= 2;
      }
    }
  };

  try {
    const outcome = await attempt(() => args.streamChatWithTools({
      model: MODEL,
      reasoningEffort: EFFORT,
      ...(SERVICE_TIER ? { serviceTier: SERVICE_TIER } : {}),
      enableThinking: false,
      systemPrompt: args.prose ? `${args.prose}

${SYSTEM_PROMPT}` : SYSTEM_PROMPT,
      resolveTools: () => {
        perTurnSchemaChars.push(live.reduce((n, e) => n + JSON.stringify(e).length, 0));
        perTurnSchemaHashes.push(
          createHash("sha256").update(JSON.stringify(live)).digest("hex"),
        );
        return live;
      },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            ...(args.arm === "upstream"
              ? { doc_id: "doc-0" }
              : { document_id: documentId }),
            // Both arms receive the same path handle. In the stripped arm the
            // filename is opaque, so it restores path-native ergonomics
            // without leaking the LegalBench document descriptor.
            file_path: args.filename,
            ...(RETRIEVAL_EXPERIMENT_ARMS.has(args.arm)
              ? {
                  document_chars: text.length,
                  document_lines: text.split(/\r?\n/u).length,
                }
              : {}),
            question: args.form === "asis" ? cell.query : cell.stripped,
          }),
        },
      ],
      tools: live,
      maxIterations: MAX_ITERATIONS,
      runTools: async (calls) => {
        modelTurns += 1;
        // Freeze the schema for this batch. A describe_tools call can open a
        // domain for the next model turn, never for a guessed sibling call.
        const callable = new Set(live.map((entry) => entry.function.name));
        const declaredThisBatch = new Map(declared);
        const executable = calls.filter(
          (call) => callable.has(call.name) && call.name !== "ask_inputs",
        );
        for (const call of calls) {
          if (call.name === "ask_inputs") headlessCallsRefused += 1;
          else if (!callable.has(call.name)) unservedCallsRefused += 1;
          if (deferredNames.has(call.name) && !opened.has(call.name))
            deferredCallsBeforeOpen += 1;
        }
        const executed = executable.length
          ? args.arm === "upstream"
            ? executable.map((call) =>
                runUpstreamMikeTool({
                  call,
                  text,
                  documentId,
                  filename: args.filename,
                  read: upstreamReads,
                }),
              )
            : await args.runLocalAssistantTools(
                BED_USER,
                executable,
                undefined,
                undefined,
                undefined,
                undefined,
                allowed,
              )
          : [];
        const byId = new Map(executed.map((entry) => [entry.tool_use_id, entry]));
        const results: NormalizedToolResult[] = calls.map((call) =>
          call.name === "ask_inputs"
            ? {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: false,
                  error: "ask_inputs is unavailable in this headless benchmark.",
                }),
              }
            : byId.get(call.id) ?? {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: false,
                  error: `Tool '${call.name}' is not loaded. Call describe_tools, then retry it on the next turn.`,
                }),
              },
        );
        const descriptions: string[][] = [];
        const recipesEmittedThisBatch = new Set<string>();
        calls.forEach((call, index) => {
          const input = asRecord(call.input);
          if (call.name === "describe_tools") {
            let payload: unknown = null;
            try {
              payload = JSON.parse(results[index]?.content ?? "null");
            } catch {
              payload = null;
            }
            const body = asRecord(payload);
            if (body.ok === true) {
              descriptions.push(
                Array.isArray(body.domains)
                  ? body.domains.filter(
                      (domain): domain is string => typeof domain === "string",
                    )
                  : [],
              );
            }
          }
          const known = declaredThisBatch.get(call.name);
          let payload: unknown = null;
          try {
            payload = JSON.parse(results[index]?.content ?? "null");
          } catch {
            payload = results[index]?.content ?? null;
          }
          const content = results[index]?.content ?? "";
          const ok = toolResultOk(payload, content);
          const calledRecipe =
            call.name === "Read" ? canonicalReadRecipe(input) : null;
          const emitted = emittedReadRecipes(payload, content);
          for (const recipe of emitted) recipesEmittedThisBatch.add(recipe);
          traces.push({
            name: call.name,
            arg_keys: Object.keys(input),
            input_sha256: createHash("sha256")
              .update(JSON.stringify(input))
              .digest("hex"),
            off_schema_keys: known
              ? Object.keys(input).filter((key) => !known.has(key))
              : Object.keys(input),
            address: classifyAddress(input),
            locator: traceText(
              input.at ??
                input.section ??
                input.page ??
                (typeof input.offset === "number" ? String(input.offset) : input.offset),
              200,
            ),
            query: traceText(input.query ?? input.pattern, 500),
            follow: typeof input.follow === "string" ? input.follow : null,
            depth: typeof input.depth === "number" ? input.depth : null,
            from: typeof input.from === "string" ? input.from : null,
            mode: typeof input.mode === "string" ? input.mode : null,
            offset: typeof input.offset === "number" ? input.offset : null,
            limit: typeof input.limit === "number" ? input.limit : null,
            max_chars:
              typeof input.max_chars === "number" ? input.max_chars : null,
            max_results:
              typeof input.max_results === "number" ? input.max_results : null,
            context_chars:
              typeof input.context_chars === "number"
                ? input.context_chars
                : null,
            head_limit:
              typeof input.head_limit === "number" ? input.head_limit : null,
            ok,
            error:
              traceText(asRecord(payload).error, 500) ??
              (!ok ? traceText(content, 500) : null),
            result_chars: content.length,
            emitted_locator_count: emitted.size,
            locator_from_prior_result: calledRecipe
              ? priorReadRecipes.has(calledRecipe)
              : null,
            locator_resolved: calledRecipe ? ok : null,
            spans: spansFromResult(call.name, input, results[index], payload, text),
          });
        });
        for (const recipe of recipesEmittedThisBatch) {
          priorReadRecipes.add(recipe);
        }
        for (const domains of descriptions) {
          const schemas = args.toolsForDomains(args.deferred, domains).filter(
            (entry) => !opened.has(entry.function.name),
          );
          for (const schema of schemas) {
            live.push(schema);
            opened.add(schema.function.name);
            declared.set(
              schema.function.name,
              new Set(
                Object.keys(
                  ((schema.function.parameters as Record<string, unknown>)?.properties ?? {}) as object,
                ),
              ),
            );
          }
          discloses.push({
            turn: modelTurns,
            domains,
            opened: schemas.map((entry) => entry.function.name),
          });
        }
        return results;
      },
    }));
    answer = outcome.fullText.trim();
    usage = outcome.usage ?? null;
    providerServiceTier = outcome.serviceTier ?? null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const alternatives = cell.gold_mode === "alternatives";
  const goldAll = cell.gold.map((g) => g.answer).join(" ");
  const exactAnswer = exactText(answer);
  const exactMatches = error
    ? []
    : cell.gold.filter((g) => exactAnswer.includes(exactText(g.answer)));
  const exactGoldPresent = alternatives
    ? Number(exactMatches.length > 0)
    : exactMatches.length;
  const bestGold = cell.gold.reduce(
    (best, candidate) =>
      tokenF1(candidate.answer, answer) > tokenF1(best.answer, answer)
        ? candidate
        : best,
    cell.gold[0],
  );
  const goldChars = alternatives
    ? bestGold.end - bestGold.start
    : cell.gold.reduce((n, g) => n + (g.end - g.start), 0);
  const seen = traces.flatMap((trace) => trace.spans);
  const reachedGold = cell.gold.filter((g) => overlaps(seen, g));
  const bestF1 = error
    ? 0
    : Math.max(0, ...cell.gold.map((g) => tokenF1(g.answer, answer)));
  const bestRecall = error
    ? 0
    : Math.max(0, ...cell.gold.map((g) => tokenRecall(g.answer, answer)));
  return {
    schema_version: "navshape-rag-6",
    coords: "lf",
    ts: new Date().toISOString(),
    test_id: cell.id,
    source: cell.source,
    document: cell.document,
    document_chars: text.length,
    arm: args.arm,
    nav_tool_shape: args.navShape,
    form: args.form,
    rep: args.rep,
    model: MODEL,
    effort: EFFORT,
    requested_service_tier: SERVICE_TIER || null,
    provider_service_tier: providerServiceTier,
    max_iterations: MAX_ITERATIONS,
    run_identity_sha256: args.runIdentityHash,
    bed_kind: BED_KIND,
    bed_map_sha256: args.bedMapHash,
    bed_definition_sha256: args.bedDefinitionHash,
    implementation_sha256: args.implementationHash,
    schema_chars: args.schemaChars,
    schema_hash: args.schemaHash,
    system_prompt_sha256: args.promptHash,
    ...(args.arm === "upstream"
      ? {
          upstream_mike_commit: UPSTREAM_MIKE_COMMIT,
          upstream_citation_wrapper: "omitted-for-retrieval-isolation",
        }
      : {}),
    surface: args.surface,
    bed_library: path.resolve(BED_LIBRARY),
    bed_map: path.resolve(BED_MAP),
    receipts_dir: path.resolve(RECEIPTS),
    deferred_offered: args.deferred.length,
    describe_tools_calls: discloses.length,
    describe_turns: discloses.map((d) => d.turn),
    domains_opened: [...new Set(discloses.flatMap((d) => d.domains))],
    tools_opened: opened.size,
    deferred_calls_before_open: deferredCallsBeforeOpen,
    unserved_calls_refused: unservedCallsRefused,
    headless_calls_refused: headlessCallsRefused,
    first_request_schema_chars: perTurnSchemaChars[0] ?? args.schemaChars,
    mean_per_turn_schema_chars: perTurnSchemaChars.length
      ? perTurnSchemaChars.reduce((a, b) => a + b, 0) / perTurnSchemaChars.length
      : args.schemaChars,
    per_turn_schema_chars: perTurnSchemaChars,
    per_turn_schema_sha256: perTurnSchemaHashes,
    tools_offered: tools.length,
    emitted_locator_count: traces.reduce(
      (total, trace) => total + trace.emitted_locator_count,
      0,
    ),
    addressed_read_calls: traces.filter(
      (trace) => trace.locator_from_prior_result !== null,
    ).length,
    addressed_reads_from_prior_result: traces.filter(
      (trace) => trace.locator_from_prior_result === true,
    ).length,
    addressed_reads_resolved: traces.filter(
      (trace) => trace.locator_resolved === true,
    ).length,
    query: args.form === "asis" ? cell.query : cell.stripped,
    tags: cell.tags ?? [],
    gold_mode: cell.gold_mode ?? "all",
    gold_snippets: cell.gold.length,
    gold_chars: goldChars,
    status: error ? "error" : "completed",
    error,
    answer,
    not_found: /^NOT FOUND\b/iu.test(answer),
    // Composition: how well the reply reproduces gold.
    f1_all: error ? 0 : alternatives ? bestF1 : tokenF1(goldAll, answer),
    f1_best: bestF1,
    recall_all: error
      ? 0
      : alternatives
        ? bestRecall
        : tokenRecall(goldAll, answer),
    exact_gold_present: exactGoldPresent,
    exact_gold_coverage: alternatives
      ? exactGoldPresent
      : cell.gold.length
        ? exactGoldPresent / cell.gold.length
        : 0,
    answer_gold_char_ratio: goldChars ? answer.length / goldChars : 0,
    // Navigation: did the model's own calls ever put gold in front of it?
    reached_any: reachedGold.length > 0,
    reached_all: alternatives
      ? reachedGold.length > 0
      : reachedGold.length === cell.gold.length,
    reached_fraction: alternatives
      ? Number(reachedGold.length > 0)
      : cell.gold.length
        ? reachedGold.length / cell.gold.length
        : 0,
    n_tool_calls: traces.length,
    n_failed_tool_calls: traces.filter((trace) => !trace.ok).length,
    failed_tool_call_rate: traces.length
      ? traces.filter((trace) => !trace.ok).length / traces.length
      : 0,
    tool_result_chars: traces.reduce(
      (total, trace) => total + trace.result_chars,
      0,
    ),
    n_model_turns: modelTurns,
    tool_calls: traces,
    usage,
    ...tokenAccounting(usage),
    latency_ms: Date.now() - startedAt,
  };
}

async function run() {
  requireModelConfig();
  const requestedArm = flag("arm");
  const form = flag("form", "asis") as "asis" | "stripped";
  const rep = Number(flag("rep", "1"));
  const perSource = Number(flag("n", "40"));
  const skipPerSource = Number(flag("skip", "0"));
  const concurrency = Number(flag("concurrency", "3"));
  if (form !== "asis" && form !== "stripped") {
    throw new Error("--form must be asis or stripped");
  }
  if (
    ![rep, perSource, skipPerSource, concurrency].every(Number.isInteger) ||
    rep < 1 ||
    perSource < 1 ||
    skipPerSource < 0 ||
    concurrency < 1
  ) {
    throw new Error(
      "--rep, --n, and --concurrency must be positive integers; --skip must be a non-negative integer",
    );
  }
  const { arm, shape, tools, hash, deferred, prose, mode, promptHash } =
    await navSchemas(requestedArm);
  if (arm !== requestedArm) {
    throw new Error(
      `--arm ${requestedArm} but loaded arm=${arm} (MIKE_NAV_SHAPE=${shape}, MIKE_TOOL_SHAPE=${process.env.MIKE_TOOL_SHAPE || "library"})`,
    );
  }
  assertArmHash(hash);
  if (!existsSync(BED_MAP)) throw new Error("bed not ingested; run `ingest` first");
  const bedMapBytes = readFileSync(BED_MAP);
  const bedMapHash = createHash("sha256").update(bedMapBytes).digest("hex");
  const map = JSON.parse(bedMapBytes.toString("utf8")) as Record<
    string,
    { document_id: string; filename: string }
  >;
  const schemaChars = tools.reduce((n, entry) => n + JSON.stringify(entry).length, 0);
  const cells = sampleCells(loadCells(), perSource, skipPerSource);
  const bedDefinitionHash = createHash("sha256")
    .update(
      JSON.stringify(
        cells.map(({ id, source, document, query, stripped, gold, gold_mode, tags }) => ({
          id,
          source,
          document,
          query,
          stripped,
          gold,
          gold_mode: gold_mode ?? "all",
          tags: tags ?? [],
          document_sha256: createHash("sha256")
            .update(corpusText(document))
            .digest("hex"),
        })),
      ),
    )
    .digest("hex");
  const sampleHash = createHash("sha256")
    .update(cells.map((cell) => cell.id).join(","))
    .digest("hex");
  const implementation = implementationIdentity();
  const identity = {
    schema_version: "navshape-rag-6",
    bed_kind: BED_KIND,
    arm,
    nav_tool_shape: shape,
    form,
    rep,
    model: MODEL,
    effort: EFFORT,
    requested_service_tier: SERVICE_TIER || null,
    max_iterations: MAX_ITERATIONS,
    per_source: perSource,
    skip_per_source: skipPerSource,
    seed: SEED,
    sample_sha256: sampleHash,
    surface: mode,
    schema_hash: hash,
    system_prompt_sha256: promptHash,
    bed_map_sha256: bedMapHash,
    bed_definition_sha256: bedDefinitionHash,
    implementation_sha256: implementation.sha256,
  };
  const runIdentityHash = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (process.argv.includes("--dry-run")) {
    console.log(
      JSON.stringify(
        {
          registration: identity,
          run_identity_sha256: runIdentityHash,
          tools: tools.map((entry) => entry.function.name),
          schema_chars: schemaChars,
          cells: cells.length,
          documents: new Set(cells.map((cell) => cell.document)).size,
          ...(process.argv.includes("--compact")
            ? {}
            : { implementation_files: implementation.files }),
          output: path.join(
            RECEIPTS,
            `navshape-rag-${arm}-${mode}-${form}-r${rep}.jsonl`,
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  const { runLocalAssistantTools, toolsForDomains } = await import(
    "../src/lib/chat/localAssistantTools"
  );
  const { streamChatWithTools } = await import("../src/lib/llm");

  mkdirSync(RECEIPTS, { recursive: true });
  const output = path.join(
    RECEIPTS,
    `navshape-rag-${arm}-${mode}-${form}-r${rep}.jsonl`,
  );
  const priorRows = existsSync(output)
    ? readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
  const drifted = priorRows.find(
    (row) => row.run_identity_sha256 !== runIdentityHash,
  );
  if (drifted) {
    throw new Error(
      `RUN DRIFT: ${output} already contains a different model, tier, sample, ` +
        `bed, or schema identity. Use a fresh receipts directory.`,
    );
  }
  // Resume on COMPLETED rows only. A transport failure (the Codex backend
  // 429s under too much concurrency) writes an error row, and treating that
  // as done would bake a scored zero into the arm mean for a cell the model
  // never got to answer. Receipts are append-only, so the retry appends a
  // second row for that cell and the report keeps the completed one.
  const done = new Set(
    priorRows
      .filter((row) => row.status === "completed")
      .map((row) => String(row.test_id)),
  );
  // Round-robin the work across sources. The sample is stratified but sorted
  // by test id, so a run that stops early would leave a source-ORDERED prefix
  // (all contractnli, no privacy_qa) — a partial result that is no longer
  // stratified. Interleaving keeps every prefix balanced, so an interrupted
  // condition is still a usable stratified sample.
  const pending = cells.filter((cell) => !done.has(cell.id));
  const queues = benchmarkSources(cells).map((source) =>
    pending.filter((cell) => cell.source === source),
  );
  const todo: Cell[] = [];
  for (let at = 0; todo.length < pending.length; at += 1) {
    for (const queue of queues) if (at < queue.length) todo.push(queue[at]);
  }
  console.log(
    `arm=${arm} form=${form} rep=${rep} shape=${shape} tier=${SERVICE_TIER || "default"} tools=${tools.length} schema_chars=${schemaChars} cells=${todo.length}/${cells.length} -> ${output}`,
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
      if (
        form === "stripped" &&
        !/^doc-[0-9a-f]{16}\.docx$/u.test(entry.filename)
      ) {
        throw new Error(
          `stripped run requires opaque bed filenames; re-run ingest (got ${entry.filename})`,
        );
      }
      const row = await runCell({
        cell,
        documentId: entry.document_id,
        filename: entry.filename,
        arm,
        navShape: shape,
        form,
        rep,
        tools,
        deferred,
        prose,
        surface: mode,
        schemaChars,
        schemaHash: hash,
        promptHash,
        runIdentityHash,
        bedMapHash,
        bedDefinitionHash,
        implementationHash: implementation.sha256,
        runLocalAssistantTools,
        toolsForDomains,
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
    const k = `${row.arm}|${row.surface || "nav"}|${row.form}|${row.rep}|${row.test_id}`;
    const held = best.get(k);
    if (!held) best.set(k, row);
    else {
      duplicates += 1;
      if (held.status !== "completed" && row.status === "completed") best.set(k, row);
    }
  }
  // A transport failure is NOT an answer. Scoring an unrecovered 429 as
  // f1=0 would let a rate limit masquerade as the arm failing the cell, and
  // it moves the arm mean by however many cells the network dropped. Error
  // rows leave the scored set entirely and are counted instead.
  const scored = [...best.values()].filter((row) => row.status === "completed");
  return {
    rows: scored,
    transportErrors: [...best.values()].length - scored.length,
    duplicates,
  };
}

const key = (row: Row) =>
  `${row.surface || "nav"}|${row.form}|${row.rep}|${row.test_id}`;
const METRICS = [
  "f1_all",
  "f1_best",
  "recall_all",
  "exact_gold_coverage",
  "answer_gold_char_ratio",
  "reached_any",
  "reached_all",
  "reached_fraction",
  "n_tool_calls",
  "n_failed_tool_calls",
  "failed_tool_call_rate",
  "emitted_locator_count",
  "addressed_reads_from_prior_result",
  "addressed_reads_resolved",
  "tool_result_chars",
  "n_model_turns",
  "first_request_schema_chars",
  "mean_per_turn_schema_chars",
  "raw_input_tokens",
  "raw_output_tokens",
  "cache_read_input_tokens",
  "cache_write_input_tokens",
  "context_input_tokens",
  "total_context_tokens",
  "latency_ms",
] as const;
const METRIC_WIDTH = 25;
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
/**
 * Union of every document char the cell put in front of the model. Guards the
 * obvious confound on `reached_by_read`: an arm could "navigate better" merely
 * by reading wider windows. Union, not sum, so overlapping reads are not
 * double-counted.
 */
function unionSpanWidth(spans: [number, number][]): number {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (const [s, e] of sorted.slice(1)) {
    if (s > end) {
      total += end - start;
      [start, end] = [s, e];
    } else if (e > end) end = e;
  }
  return total + (end - start);
}

function charsExposed(row: Row): number {
  const spans = ((row.tool_calls as ToolTrace[]) ?? []).flatMap((trace) => trace.spans);
  return unionSpanWidth(spans);
}

const isCommittedRead = (trace: ToolTrace) =>
  trace.name === "library_read" ||
  trace.name === "Read" ||
  trace.name === "read_document" ||
  trace.name === "fetch_documents";

/** Mean width of the windows a cell's committed read calls returned. */
function meanReadWidth(row: Row): number {
  // Coding Read records one evidence span per displayed line; address and
  // upstream reads usually record one span per call. Union inside each call
  // before averaging so line granularity cannot make coding windows look
  // dozens of times narrower than the text they actually exposed.
  const widths = ((row.tool_calls as ToolTrace[]) ?? [])
    .filter(isCommittedRead)
    .map((trace) => unionSpanWidth(trace.spans))
    .filter((width) => width > 0);
  return widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
}

function reachedByRead(row: Row, goldSpans: [number, number][]): boolean {
  const reads = ((row.tool_calls as ToolTrace[]) ?? [])
    .filter(isCommittedRead)
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

function pairedTable(rows: Row[], [leftArm, rightArm]: [string, string]) {
  const gold = goldByTest();
  const sources = benchmarkSources(loadCells());
  const byArm = new Map<string, Map<string, Row>>();
  for (const row of rows) {
    const bucket = byArm.get(String(row.arm)) ?? new Map<string, Row>();
    if (!byArm.has(String(row.arm))) byArm.set(String(row.arm), bucket);
    bucket.set(key(row), row);
  }
  const left = byArm.get(leftArm) ?? new Map();
  const right = byArm.get(rightArm) ?? new Map();
  const shared = [...left.keys()].filter((k) => right.has(k));

  console.log(`\npaired cells (same test, form, replicate, both arms): ${shared.length}`);
  const configurations = [
    ...new Set(shared.map((k) => k.split("|").slice(0, 2).join("|"))),
  ].sort();
  for (const configuration of configurations) {
    const [surface, form] = configuration.split("|");
    const keys = shared.filter((k) => k.startsWith(`${configuration}|`));
    console.log(
      `\n--- surface=${surface} form=${form} paired n=${keys.length} ---`,
    );
    console.log(
      `${"metric".padEnd(METRIC_WIDTH)} ${leftArm.padStart(8)} ${rightArm.padStart(9)}     diff    95% CI (cluster bootstrap over documents)`,
    );
    for (const metric of METRICS) {
      const units = keys.map((k) => ({
        document: String(left.get(k)!.document),
        value: num(right.get(k)![metric]) - num(left.get(k)![metric]),
      }));
      const band = clusterBootstrap(units);
      const a = mean(keys.map((k) => num(left.get(k)![metric])));
      const b = mean(keys.map((k) => num(right.get(k)![metric])));
      const fmt = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(4));
      console.log(
        `${metric.padEnd(METRIC_WIDTH)} ${fmt(a).padStart(8)} ${fmt(b).padStart(9)} ${fmt(band.mean).padStart(8)}   [${fmt(band.lo)}, ${fmt(band.hi)}]`,
      );
    }
    // Stricter navigation metric: did a committed library_read land on gold?
    {
      const units = keys.map((k) => ({
        document: String(left.get(k)!.document),
        value:
          (reachedByRead(right.get(k)!, gold.get(String(right.get(k)!.test_id)) ?? []) ? 1 : 0) -
          (reachedByRead(left.get(k)!, gold.get(String(left.get(k)!.test_id)) ?? []) ? 1 : 0),
      }));
      const band = clusterBootstrap(units);
      const rate = (side: Map<string, Row>) =>
        mean(keys.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `reached_by_read ${rate(left).toFixed(4).padStart(8)} ${rate(right).toFixed(4).padStart(9)} ${band.mean.toFixed(4).padStart(8)}   [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]`,
      );
    }

    // Exposure control: `reached_by_read` would be cheap to win by reading
    // wider, so the amount of document each arm had to look at is paired too.
    for (const [label, pick] of [
      ["chars_exposed", charsExposed],
      ["mean_read_width", meanReadWidth],
    ] as const) {
      const units = keys.map((k) => ({
        document: String(left.get(k)!.document),
        value: pick(right.get(k)!) - pick(left.get(k)!),
      }));
      const band = clusterBootstrap(units);
      const a = mean(keys.map((k) => pick(left.get(k)!)));
      const b = mean(keys.map((k) => pick(right.get(k)!)));
      console.log(
        `${label.padEnd(14)} ${a.toFixed(0).padStart(8)} ${b.toFixed(0).padStart(9)} ${band.mean.toFixed(0).padStart(8)}   [${band.lo.toFixed(0)}, ${band.hi.toFixed(0)}]`,
      );
    }

    // Per source.
    console.log("\nper source (f1_best / reached_any / tool calls)");
    for (const source of sources) {
      const subset = keys.filter((k) => left.get(k)!.source === source);
      if (!subset.length) continue;
      const cell = (metric: (typeof METRICS)[number], side: Map<string, Row>) =>
        mean(subset.map((k) => num(side.get(k)![metric])));
      const rbr = (side: Map<string, Row>) =>
        mean(subset.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `  ${source.padEnd(12)} n=${String(subset.length).padStart(3)}  ` +
          `f1_best ${cell("f1_best", left).toFixed(3)} -> ${cell("f1_best", right).toFixed(3)}   ` +
          `read-hit ${rbr(left).toFixed(3)} -> ${rbr(right).toFixed(3)}   ` +
          `calls ${cell("n_tool_calls", left).toFixed(2)} -> ${cell("n_tool_calls", right).toFixed(2)}`,
      );
    }

    // Amendment 1: never-solved cells are signal absence, not arm equality.
    const neverSolved = keys.filter((k) => !solved(left.get(k)!) && !solved(right.get(k)!));
    const eitherSolved = keys.filter((k) => solved(left.get(k)!) || solved(right.get(k)!));
    console.log(
      `\nnever solved by either arm (f1_best < ${SOLVED}): ${neverSolved.length}/${keys.length} ` +
        `(${((100 * neverSolved.length) / Math.max(1, keys.length)).toFixed(1)}%)`,
    );
    for (const source of sources) {
      const all = keys.filter((k) => left.get(k)!.source === source);
      if (!all.length) continue;
      const none = all.filter((k) => !solved(left.get(k)!) && !solved(right.get(k)!));
      console.log(`  ${source.padEnd(12)} ${none.length}/${all.length}`);
    }
    if (eitherSolved.length && eitherSolved.length < keys.length) {
      console.log(`\nsame metrics over cells at least one arm solved (n=${eitherSolved.length})`);
      for (const metric of ["f1_best", "reached_any", "n_tool_calls"] as const) {
        const units = eitherSolved.map((k) => ({
          document: String(left.get(k)!.document),
          value: num(right.get(k)![metric]) - num(left.get(k)![metric]),
        }));
        const band = clusterBootstrap(units);
        const a = mean(eitherSolved.map((k) => num(left.get(k)![metric])));
        const b = mean(eitherSolved.map((k) => num(right.get(k)![metric])));
        console.log(
          `${metric.padEnd(METRIC_WIDTH)} ${a.toFixed(4).padStart(8)} ${b.toFixed(4).padStart(9)} ${band.mean.toFixed(4).padStart(8)}   [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]`,
        );
      }
    }

    // Amendment 2: does document length predict the arm difference? Band A/B
    // cells can be read whole, so the surface has nothing to decide there.
    console.log("\nby document-size band (the read-it-whole shortcut)");
    const bands = [...new Set(keys.map((k) => sizeBand(num(left.get(k)!.document_chars))))].sort();
    for (const label of bands) {
      const subset = keys.filter((k) => sizeBand(num(left.get(k)!.document_chars)) === label);
      const units = subset.map((k) => ({
        document: String(left.get(k)!.document),
        value: num(right.get(k)!.f1_best) - num(left.get(k)!.f1_best),
      }));
      const band = clusterBootstrap(units);
      const callsA = mean(subset.map((k) => num(left.get(k)!.n_tool_calls)));
      const callsB = mean(subset.map((k) => num(right.get(k)!.n_tool_calls)));
      const rbr = (side: Map<string, Row>) =>
        mean(subset.map((k) => (reachedByRead(side.get(k)!, gold.get(String(side.get(k)!.test_id)) ?? []) ? 1 : 0)));
      console.log(
        `  ${label.padEnd(30)} n=${String(subset.length).padStart(3)}  ` +
          `f1_best ${mean(subset.map((k) => num(left.get(k)!.f1_best))).toFixed(3)} -> ${mean(subset.map((k) => num(right.get(k)!.f1_best))).toFixed(3)}  ` +
          `diff ${band.mean.toFixed(4)} [${band.lo.toFixed(4)}, ${band.hi.toFixed(4)}]  ` +
          `read-hit ${rbr(left).toFixed(3)} -> ${rbr(right).toFixed(3)}  calls ${callsA.toFixed(1)} -> ${callsB.toFixed(1)}`,
      );
    }
    // How often a single read actually swallowed the document — the shortcut
    // taken, not merely available.
    for (const [label, side] of [[leftArm, left], [rightArm, right]] as const) {
      const whole = keys.filter((k) => {
        const row = side.get(k)!;
        const traces = (row.tool_calls as ToolTrace[]) ?? [];
        return traces.some(
          (trace) =>
            isCommittedRead(trace) &&
            unionSpanWidth(trace.spans) >= 0.95 * num(row.document_chars),
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
  const gold = goldByTest();
  console.log("\n--- within-arm replicate floor (|rep1 - rep2|, same arm/form/test) ---");
  console.log("Read this FIRST: a between-arm difference smaller than the floor for the");
  console.log("same metric is UNDECIDED at this n, not null.");
  console.log(`arm      surface               form      n   ${"metric".padEnd(METRIC_WIDTH)} mean|diff|   paired diff 95% CI`);
  const byCell = new Map<string, Row[]>();
  for (const row of rows) {
    const k = `${row.arm}|${row.surface || "nav"}|${row.form}|${row.test_id}`;
    const bucket = byCell.get(k) ?? [];
    if (!byCell.has(k)) byCell.set(k, bucket);
    bucket.push(row);
  }
  const groups = new Map<string, { document: string; rows: Row[] }[]>();
  for (const [k, bucket] of byCell) {
    if (bucket.length < 2) continue;
    const [arm, surface, form] = k.split("|");
    const group = groups.get(`${arm}|${surface}|${form}`) ?? [];
    if (!groups.has(`${arm}|${surface}|${form}`))
      groups.set(`${arm}|${surface}|${form}`, group);
    group.push({ document: String(bucket[0].document), rows: bucket });
  }
  for (const [k, group] of [...groups].sort()) {
    const [arm, surface, form] = k.split("|");
    // Same metrics the between-arm table reports, so the two are comparable
    // line for line — including the derived navigation and exposure ones.
    const pickers: Record<string, (row: Row) => number> = {
      f1_best: (row) => num(row.f1_best),
      exact_gold_coverage: (row) => num(row.exact_gold_coverage),
      answer_gold_char_ratio: (row) => num(row.answer_gold_char_ratio),
      reached_any: (row) => num(row.reached_any),
      reached_fraction: (row) => num(row.reached_fraction),
      reached_by_read: (row) =>
        reachedByRead(row, gold.get(String(row.test_id)) ?? []) ? 1 : 0,
      n_tool_calls: (row) => num(row.n_tool_calls),
      n_failed_tool_calls: (row) => num(row.n_failed_tool_calls),
      failed_tool_call_rate: (row) => num(row.failed_tool_call_rate),
      emitted_locator_count: (row) => num(row.emitted_locator_count),
      addressed_reads_from_prior_result: (row) =>
        num(row.addressed_reads_from_prior_result),
      addressed_reads_resolved: (row) => num(row.addressed_reads_resolved),
      tool_result_chars: (row) => num(row.tool_result_chars),
      n_model_turns: (row) => num(row.n_model_turns),
      mean_per_turn_schema_chars: (row) => num(row.mean_per_turn_schema_chars),
      raw_input_tokens: (row) => num(row.raw_input_tokens),
      raw_output_tokens: (row) => num(row.raw_output_tokens),
      cache_read_input_tokens: (row) => num(row.cache_read_input_tokens),
      cache_write_input_tokens: (row) => num(row.cache_write_input_tokens),
      context_input_tokens: (row) => num(row.context_input_tokens),
      total_context_tokens: (row) => num(row.total_context_tokens),
      latency_ms: (row) => num(row.latency_ms),
      chars_exposed: charsExposed,
    };
    for (const [metric, pick] of Object.entries(pickers)) {
      const abs = group.map((entry) => Math.abs(pick(entry.rows[0]) - pick(entry.rows[1])));
      const signed = group.map((entry) => ({
        document: entry.document,
        value: pick(entry.rows[1]) - pick(entry.rows[0]),
      }));
      const band = clusterBootstrap(signed);
      const fmt = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(4));
      console.log(
        `${arm.padEnd(8)} ${surface.padEnd(21)} ${form.padEnd(9)} ${String(group.length).padStart(3)}  ${metric.padEnd(METRIC_WIDTH)} ` +
          `${fmt(mean(abs)).padStart(9)}   ${fmt(band.mean)} [${fmt(band.lo)}, ${fmt(band.hi)}]`,
      );
    }
  }
}

/** What arm B's extra affordances were actually used for. A capability nobody
 * calls is a finding. */
function affordances(rows: Row[]) {
  console.log("\n--- affordance census (all rows, per arm/surface) ---");
  const configurations = [
    ...new Set(
      rows.map((row) => `${String(row.arm)}|${String(row.surface || "nav")}`),
    ),
  ].sort();
  for (const configuration of configurations) {
    const [arm, surface] = configuration.split("|");
    const subset = rows.filter(
      (row) => row.arm === arm && String(row.surface || "nav") === surface,
    );
    if (!subset.length) continue;
    const traces = subset.flatMap((row) => (row.tool_calls as ToolTrace[]) ?? []);
    const byName = new Map<string, number>();
    const address = new Map<string, number>();
    const offSchema = new Map<string, number>();
    const errors = new Map<string, number>();
    let follow = 0;
    let depth = 0;
    let fromEnd = 0;
    let failed = 0;
    let emittedLocators = 0;
    let addressedReads = 0;
    let copiedLocators = 0;
    let resolvedLocators = 0;
    for (const trace of traces) {
      byName.set(trace.name, (byName.get(trace.name) ?? 0) + 1);
      if (trace.address) address.set(trace.address, (address.get(trace.address) ?? 0) + 1);
      for (const k of trace.off_schema_keys) offSchema.set(k, (offSchema.get(k) ?? 0) + 1);
      if (trace.follow && trace.follow !== "none") follow += 1;
      if (trace.depth !== null) depth += 1;
      if (trace.from === "end") fromEnd += 1;
      emittedLocators += num(trace.emitted_locator_count);
      if (trace.locator_from_prior_result !== null && trace.locator_from_prior_result !== undefined) {
        addressedReads += 1;
        if (trace.locator_from_prior_result) copiedLocators += 1;
      }
      if (trace.locator_resolved) resolvedLocators += 1;
      if (!trace.ok) {
        failed += 1;
        const message = trace.error ?? "(plain-text or unclassified failure)";
        errors.set(message, (errors.get(message) ?? 0) + 1);
      }
    }
    console.log(`\n${arm}/${surface}: ${subset.length} rows, ${traces.length} tool calls (${failed} failed)`);
    console.log(`  by tool     : ${[...byName].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join("  ") || "(none)"}`);
    console.log(`  address kind: ${[...address].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join("  ") || "(none — every call unaddressed)"}`);
    console.log(`  follow fired: ${follow}   depth passed: ${depth}   from=end: ${fromEnd}`);
    if (RETRIEVAL_EXPERIMENT_ARMS.has(arm)) {
      console.log(
        `  executable Read recipes: emitted=${emittedLocators}  addressed Reads=${addressedReads}  copied from prior result=${copiedLocators}  resolved=${resolvedLocators}`,
      );
    }
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
    if (errors.size) {
      console.log(
        `  failure census: ${[...errors]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([message, count]) => `${count}× ${message}`)
          .join(" | ")}`,
      );
    }
  }
}

/**
 * Schema-identity census. Concurrent sessions share this tree, and both arms'
 * schemas were edited under a run in flight on 2026-07-31 — arm A twice, arm B
 * four times. `schema_chars` was recorded on every row precisely so that is
 * detectable rather than silently averaged. A cell is only comparable against
 * a cell that saw the same two schemas.
 */
function schemaCensus(rows: Row[]) {
  console.log("\n--- schema identity actually sent (arm drift detector) ---");
  const configurations = [
    ...new Set(
      rows.map((row) => `${String(row.arm)}|${String(row.surface || "nav")}`),
    ),
  ].sort();
  for (const configuration of configurations) {
    const [arm, surface] = configuration.split("|");
    const seen = new Map<
      string,
      { chars: number; hash: string; n: number; first: string; last: string }
    >();
    for (const row of rows.filter(
      (r) => r.arm === arm && String(r.surface || "nav") === surface,
    )) {
      const chars = num(row.schema_chars);
      const hash = String(row.schema_hash || "missing");
      const key = `${chars}|${hash}`;
      const held = seen.get(key) ?? {
        chars,
        hash,
        n: 0,
        first: String(row.ts),
        last: String(row.ts),
      };
      held.n += 1;
      held.first = held.first < String(row.ts) ? held.first : String(row.ts);
      held.last = held.last > String(row.ts) ? held.last : String(row.ts);
      seen.set(key, held);
    }
    const variants = [...seen.values()].sort((a, b) => b.n - a.n);
    console.log(
      `  ${`${arm}/${surface}`.padEnd(30)} ${variants.length} distinct schema(s): ` +
        variants.map((v) => `${v.chars}ch/${v.hash} x${v.n}`).join("  "),
    );
    if (variants.length > 1)
      console.log(`           ^ ARM DRIFTED MID-RUN; only same-schema cells are comparable`);
  }
}

/** `--pin-schema legacy=2809,address=5006` restricts scoring to one frozen
 * pairing, which is the only way to read a drifted receipt set. */
function schemaPins(): Record<string, number> {
  const at = process.argv.indexOf("--pin-schema");
  if (at < 0) return {};
  const pins: Record<string, number> = {};
  for (const part of (process.argv[at + 1] ?? "").split(",")) {
    const [arm, chars] = part.split("=");
    if (arm && chars) pins[arm.trim()] = Number(chars);
  }
  return pins;
}

function comparisonArms(): [string, string] {
  const arms = flag("compare", "legacy,address")
    .split(",")
    .map((arm) => arm.trim())
    .filter(Boolean);
  if (arms.length !== 2 || arms[0] === arms[1]) {
    throw new Error("--compare must name two distinct arms, for example address,coding");
  }
  return [arms[0], arms[1]];
}

function report() {
  const { rows: allRows, transportErrors, duplicates } = loadRows();
  const comparison = comparisonArms();
  const selectedRows = allRows.filter((row) =>
    comparison.includes(String(row.arm)),
  );
  const modelStrata = new Set(
    selectedRows.map((row) =>
      JSON.stringify({
        model: row.model,
        effort: row.effort,
        requested_service_tier: row.requested_service_tier ?? null,
      }),
    ),
  );
  if (modelStrata.size > 1) {
    throw new Error(
      "MIXED MODEL STRATA: report each model/effort/service-tier receipts directory separately.",
    );
  }
  const unverifiedFast = selectedRows.filter(
    (row) =>
      row.requested_service_tier === "fast" &&
      !["fast", "priority"].includes(String(row.provider_service_tier || "")),
  );
  if (unverifiedFast.length) {
    throw new Error(
      `FAST TIER UNVERIFIED: ${unverifiedFast.length} completed row(s) did not report fast/priority.`,
    );
  }
  schemaCensus(selectedRows);
  const pins = schemaPins();
  const rows = Object.keys(pins).length
    ? selectedRows.filter((row) => {
        const pin = pins[String(row.arm)];
        return pin === undefined || num(row.schema_chars) === pin;
      })
    : selectedRows;
  if (Object.keys(pins).length)
    console.log(
      `\nPINNED to ${Object.entries(pins).map(([a, c]) => `${a}=${c}ch`).join(", ")}: ${rows.length} of ${selectedRows.length} selected rows retained\n`,
    );
  if (!rows.length) {
    console.log("no receipts yet");
    return;
  }
  console.log(`scored cells: ${rows.length}  (${duplicates} retried cell(s) de-duplicated)`);
  const cells = new Map<string, number>();
  for (const row of rows) {
    const k = `${row.arm}|${row.surface || "nav"}|${row.form}|r${row.rep}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  for (const [k, count] of [...cells].sort()) console.log(`  ${k}: ${count}`);
  console.log(
    `  cells still unrecovered after retry (Codex 429; EXCLUDED from scoring, not scored as 0): ${transportErrors}`,
  );

  pairedTable(rows, comparison);
  replicateFloor(rows);
  affordances(rows);
}

function upstreamSelftest() {
  const text = "Opening.\nALPHA   beta controls.\nClosing.";
  const read = new Set<string>();
  let serial = 0;
  const call = (name: string, input: Record<string, unknown>) =>
    runUpstreamMikeTool({
      call: { id: `self-${serial++}`, name, input },
      text,
      documentId: "uuid-1",
      filename: "doc-deadbeefdeadbeef.docx",
      read,
    });
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`upstream selftest failed: ${message}`);
  };

  const listed = JSON.parse(call("list_documents", {}).content) as unknown[];
  check(listed.length === 1, "list_documents did not return the one document");
  const found = call("find_in_document", {
    doc_id: "doc-0",
    query: "alpha beta",
  });
  const foundBody = JSON.parse(found.content) as {
    ok?: boolean;
    hits?: Array<{ excerpt?: string }>;
  };
  check(foundBody.ok === true, "find_in_document was not ok");
  check(
    foundBody.hits?.[0]?.excerpt === "ALPHA   beta",
    "whitespace/case-tolerant match drifted",
  );
  check(
    found.evidenceSpans?.some(([start, end]) =>
      text.slice(start, end).includes("ALPHA   beta"),
    ),
    "private evidence span missed the visible match",
  );
  const first = call("read_document", { doc_id: "uuid-1" });
  check(first.content === text, "read_document did not return full text");
  check(first.evidenceSpans?.[0]?.[1] === text.length, "full-read span drifted");
  const second = JSON.parse(
    call("read_document", { doc_id: "doc-0" }).content,
  ) as { already_read?: boolean };
  check(second.already_read === true, "duplicate read was not suppressed");
  check(
    call("read_document", { doc_id: "doc-99" }).content ===
      "Document not found.",
    "unknown document did not fail faithfully",
  );
  console.log(
    `upstream comparator OK: commit=${UPSTREAM_MIKE_COMMIT} schema_sha256=${UPSTREAM_MIKE_SCHEMA_SHA256}`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  const command = process.argv[2];
  if (command === "upstream-selftest") return upstreamSelftest();
  if (command === "ingest") return ingest();
  if (command === "prebake-bed") return prebakeBed();
  if (command === "arms") return arms();
  if (command === "schema-tokens") return schemaTokens();
  if (command === "sample") {
    const perSource = Number(flag("n", "40"));
    const skipPerSource = Number(flag("skip", "0"));
    if (
      !Number.isInteger(perSource) ||
      perSource < 1 ||
      !Number.isInteger(skipPerSource) ||
      skipPerSource < 0
    ) {
      throw new Error("--n must be positive and --skip must be non-negative");
    }
    const cells = sampleCells(loadCells(), perSource, skipPerSource);
    const byDoc = new Set(cells.map((cell) => cell.document));
    for (const source of benchmarkSources(cells)) {
      const subset = cells.filter((cell) => cell.source === source);
      console.log(
        `${source.padEnd(12)} n=${subset.length} docs=${new Set(subset.map((c) => c.document)).size}`,
      );
    }
    for (const band of [...new Set(cells.map((cell) => sizeBand(corpusText(cell.document).length)))].sort()) {
      console.log(
        `${band.padEnd(30)} n=${cells.filter((cell) => sizeBand(corpusText(cell.document).length) === band).length}`,
      );
    }
    const ids = cells.map((cell) => cell.id).join(",");
    console.log(
      `total n=${cells.length} documents=${byDoc.size} seed=${SEED} skip_per_source=${skipPerSource} sample_sha256=${createHash("sha256").update(ids).digest("hex")}`,
    );
    console.log(ids);
    return;
  }
  if (command === "run") return run();
  if (command === "report") return report();
  throw new Error(
    "usage: ingest | prebake-bed | arms | schema-tokens | sample | run | report | upstream-selftest",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
