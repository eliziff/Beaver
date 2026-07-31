/**
 * LegalBench-RAG-mini over the grounding harness (Stage 14 bed): the
 * program's first real-world test with fully deterministic scoring —
 * gold is HUMAN-annotated char spans, our claims are verbatim char
 * spans, so no stochastic checker touches the score.
 *
 * Pipeline per test: product lexical retrieval (the SAME FTS5 bm25 +
 * snippet window as the 2026-07-28 retrieval baseline) → top-k snippets
 * registered as evidence receipts → the grounding contract composes a
 * claims-typed answer (quote contract + verbatim gate; the citator
 * stands-for machinery is a structural no-op on contracts) → quotation
 * claims located back to original char coordinates → upstream
 * charPrecisionRecall against gold. Each row also scores the RAW
 * retrieval spans at the same k, so harness-vs-baseline is paired per
 * test. Typed abstention (no grounded submission) is a first-class
 * outcome, never an answer.
 *
 * The harness's LegalSourceClass has no contract member; cells run as
 * "legislation" (non-case), which is exactly the class that keeps every
 * case-law-only module off. Rows record source benchmark names for
 * honesty. Receipts are private (LOCALAPPDATA experiments dir).
 *
 * Requires the pinned mini data AND the FTS db built by
 * scripts/legalbench-rag-run.ts. Usage (from backend/):
 *   npx tsx scripts/legalbench-rag-grounding.ts --model codex:gpt-5.6-luna `
 *     --effort medium --per-source 8 --k 4 [--resume 1] [--cases cuad:003,...]
 *
 * Arms differ only in what they are meant to test: --per-doc-cap is one
 * setting for every retrieval path (default 24), recorded on every row and
 * in the resume key, and --output refuses to overwrite an existing receipt
 * without --force.
 */
import "../src/lib/loadEnv";

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createBenchmarkEvidence,
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  legalEvidenceExperimentTools,
  legalEvidenceReceiptEvent,
  planLegalEvidence,
  registerLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
  LEGAL_EVIDENCE_PLAN_TOOL_NAME,
  LEGAL_EVIDENCE_TOOL_NAME,
} from "../src/lib/chat/legalEvidenceExperiment";
import {
  legalbenchRagCellKey,
  receiptPath,
} from "../src/lib/experimentReceipts";
import {
  LEGALBENCH_MINI_SOURCE_DB,
  LEGALBENCH_RAG_DATA_DIR,
  MANIFEST_PATH,
  SOURCE_BENCHMARKS,
  charPrecisionRecall,
  normalizeCorpusBytes,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  verifyAgainstManifest,
  type SourceBenchmark,
  type Span,
} from "../src/lib/legalbenchRag";
import { capHitsPerDoc, searchPassages } from "../src/lib/passageRetrieval";
import { rerankPassages } from "../src/lib/retrievalRerank";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type NormalizedToolCall,
  type NormalizedToolResult,
} from "../src/lib/llm";

const NO_SUB = "The model did not submit a grounded answer.";

// The EXACT prompt modules the registered stages assemble for the
// required_slot arm on non-case cells (legal-grounding-experiment.ts).
// Held verbatim so this bed tests the same contract the stages measured.
const PROMPT_MODULES: Array<[name: string, text: string]> = [
  [
    "base",
    "Answer only from the supplied exact passages. Finish through the available grounded-answer tool without a prose copy or citation text; Beaver places citations from the evidence receipts.",
  ],
  [
    "roles",
    'Type every claim with its kind. "quotation": a supplied span\'s words copied EXACTLY — no edits, no elisions, no framing around them. "conclusion": the direct answer to the question in your own words. "premise_correction": the question (or a prior assistant answer) asserts something the passages contradict — set premise_source, copy the contested words verbatim into premise_text, and state the correction from the passages. Set premise_source and premise_text to null on every other kind.',
  ],
  [
    "quote_contract",
    "Prefer quotation claims. At most ONE conclusion claim, stating only what the quoted text establishes; never characterize the law beyond the quoted words (never assert a statute 'regulates', 'has a framework', or 'governs' unless those words are quoted). If the passages cannot support a direct answer, say exactly that in the conclusion claim. The submission tool rejects violations with the compliant path restated; follow it and resubmit.",
  ],
];

const COVERAGE_MODULE: [name: string, text: string] = [
  "coverage",
  "Quote comprehensively: every supplied passage that answers any part of the question gets its own quotation claim — multi-part questions need the clause for each part; do not stop after the first supporting passage. Omit a passage only when it adds nothing beyond what is already quoted. If any passage bears on the question, answer with quotes rather than declining; decline only when no passage is responsive.",
];

const SPEC_MODULE: [name: string, text: string] = [
  "spec",
  "Before composing, build an internal spec of the supplied passages as a web of related concepts: map defined terms to their definitions, follow cross-references between passages, and note which passages qualify, extend, or carve out exceptions to the others. Then answer the question against that web, quoting every passage that plays a role — the definition, the operative clause, and any exception or cross-referenced qualifier.",
];

// Stage 18 F3 control arm: the whole registered contract replaced by
// one sentence. The claim-typing schema is still enforced by the tool,
// so this prices the PROMPT contract, not the machinery.
const PLAIN_MODULE: [name: string, text: string] = [
  "plain",
  "Answer using the grounded-answer tool. Quote the supplied passages that answer the question, exactly as written.",
];

type MiniTestCell = {
  id: string;
  source: SourceBenchmark;
  query: string;
  gold: Span[];
};

type RowSpanScore = {
  precision: number;
  recall: number;
  doc_hit: boolean;
  chars: number;
};

type Row = {
  schema_version: "lbrag-grounding-1";
  /** Corpus coordinate space of every span in this row. "lf" = upstream
   * gold's space (the fixed instrument). Rows WITHOUT this field are
   * pre-fix raw-CRLF receipts and need score-time mapping. */
  coords: "lf";
  test_id: string;
  source: SourceBenchmark;
  model: string;
  effort: string;
  arm: string;
  k: number;
  /** "product" (doc-level FTS5 + snippet window) or
   * "passage:t<target>/o<overlap>/w<nameWeight>". */
  retriever: string;
  /** P0.1: passages any one document may contribute, applied identically
   * in every retrieval arm; null on the product path, which has no cap.
   * Rows WITHOUT this field predate the fix and ran at whatever the arm
   * implied (2 lexical / 24 reranked / uncapped injected pool). */
  per_doc_cap: number | null;
  query: string;
  status: "passed" | "failed" | "error";
  /** answered: passed with ≥1 located verbatim quote (score precision
   * here); declined: passed but quoteless — an honest typed
   * insufficiency statement; rejected: gates refused the submission;
   * abstained: typed no-submission. */
  outcome: "answered" | "declined" | "rejected" | "abstained" | "error";
  abstained: boolean;
  failure: string | null;
  answer: string;
  /** Located quoted-claim spans in original doc coordinates. */
  quoted_spans: Span[];
  /** Quotation claims whose text could not be located (soundness alarm
   * if ever nonzero — the verbatim gate proved membership). */
  unlocated_quotes: number;
  grounded: RowSpanScore;
  /** The raw top-k retrieval spans scored the baseline way, same test,
   * same k — the paired comparison column. */
  retrieval_baseline: RowSpanScore;
  /** Stage 18 defect D3: whether the listwise reranker fell back to the
   * lexical order for this cell (null = no reranker configured). Silently
   * dropped before the fix, so arm means mixed two systems. */
  rerank_fallback: boolean | null;
  latency_ms: number;
  usage: NormalizedLlmUsage | null;
  legal_evidence_receipt: ReturnType<typeof legalEvidenceReceiptEvent> | null;
  error: string | null;
};

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < process.argv.length)
    return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function runTool(
  call: NormalizedToolCall,
  state: ReturnType<typeof createLegalEvidenceTurnState>,
): NormalizedToolResult {
  const result =
    call.name === LEGAL_EVIDENCE_PLAN_TOOL_NAME
      ? planLegalEvidence(call.input, state)
      : call.name === LEGAL_EVIDENCE_TOOL_NAME
        ? submitLegalEvidenceAnswer(call.input, state)
        : { ok: false, errors: [`Unexpected tool: ${call.name}`] };
  return {
    tool_use_id: call.id,
    content: JSON.stringify(result),
    terminal: "terminal" in result && result.terminal === true,
  };
}

/**
 * Locate a gate-accepted quote in original text with exact offsets. The
 * verbatim gate normalizes quote glyphs and whitespace, so a claim can
 * carry wrapping curly quotes or reflowed whitespace around a genuinely
 * verbatim span (observed: maud:002 pilot). Strip wrapping quote
 * glyphs, try exact, then a whitespace/quote-glyph-tolerant regex whose
 * match still yields exact original coordinates.
 */
export function locateQuote(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  const bare = needle
    .replace(/^[\s"'“”‘’]+/u, "")
    .replace(/[\s"'“”‘’]+$/u, "");
  if (!bare) return null;
  const exact = haystack.indexOf(bare);
  if (exact >= 0) return { start: exact, end: exact + bare.length };
  const pattern = bare
    .split(/\s+/u)
    .map((word) =>
      word
        .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        .replace(/["“”]/gu, '["“”]')
        .replace(/['‘’]/gu, "['‘’]"),
    )
    .join("\\s+");
  const match = new RegExp(pattern, "u").exec(haystack);
  return match
    ? { start: match.index, end: match.index + match[0].length }
    : null;
}

/**
 * Merge same-document spans separated by at most `gap` chars (overlaps
 * included) into single spans, re-sliced verbatim from the document.
 * Order preserved by each merged group's best original rank.
 */
export function stitchSpans(
  spans: Array<Span & { snippet: string }>,
  gap: number,
  textByPath: Map<string, string>,
): Array<Span & { snippet: string }> {
  type Group = Span & { rank: number };
  const groups: Group[] = spans.map((span, rank) => ({
    filePath: span.filePath,
    start: span.start,
    end: span.end,
    rank,
  }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const [a, b] = [groups[i], groups[j]];
        if (a.filePath !== b.filePath) continue;
        if (b.start > a.end + gap || a.start > b.end + gap) continue;
        groups[i] = {
          filePath: a.filePath,
          start: Math.min(a.start, b.start),
          end: Math.max(a.end, b.end),
          rank: Math.min(a.rank, b.rank),
        };
        groups.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  groups.sort((left, right) => left.rank - right.rank);
  return groups.map((group) => {
    const text = textByPath.get(group.filePath);
    const original = spans.find(
      (span) => span.filePath === group.filePath && span.start === group.start,
    );
    return {
      filePath: group.filePath,
      start: group.start,
      end: group.end,
      snippet:
        text?.slice(group.start, group.end) ?? original?.snippet ?? "",
    };
  });
}

function scoreSpans(spans: Span[], gold: Span[]): RowSpanScore {
  const { precision, recall } = charPrecisionRecall(spans, gold);
  const goldDocs = new Set(gold.map((span) => span.filePath));
  return {
    precision,
    recall,
    doc_hit: spans.some((span) => goldDocs.has(span.filePath)),
    chars: spans.reduce((n, span) => n + (span.end - span.start), 0),
  };
}

async function main() {
  const model = flag("model");
  const effort = flag("effort", "medium");
  const perSource = Number(flag("per-source", "8"));
  const k = Number(flag("k", "4"));
  const retrieverKind = flag("retriever", "product");
  const chunkTarget = Number(flag("chunk-target", "1000"));
  const chunkOverlap = Number(flag("chunk-overlap", "120"));
  const nameWeight = Number(flag("name-weight", "4"));
  // P0.1 — passage diversity cap: the most passages any ONE document may
  // contribute. ARM-INDEPENDENT by construction: one flag, applied to the
  // lexical path and the injected-pool path alike, recorded on every row
  // and carried in the resume key.
  //
  // Before this it was `perDocCap: 24` only when a reranker was set, while
  // the lexical path silently took searchPassages' default of 2 and an
  // injected pool took no cap at all — so a four-arm comparison ran three
  // different caps. On maud, where gold concentrates inside one 300 KB
  // agreement, the cap alone can decide the arm.
  //
  // Default 24: the crowned config's value everywhere else (the ablation
  // sweeps, the rerank bed, and legalbench-dense-dump, which BUILT the
  // injected pool sidecars), and the only value that is inert at the
  // composed k (4/6) in every arm while leaving the k=48 pool exactly as
  // the reranker was measured on.
  const perDocCap = Number(flag("per-doc-cap", "24"));
  if (!Number.isInteger(perDocCap) || perDocCap < 1)
    throw new Error("--per-doc-cap must be a positive integer");
  // Optional Stage 16 W2 reranking: pool k=48 lexical, one listwise
  // call (this model) picks the top k. Empty string = off.
  const rerankModel = flag("rerank", "");
  // Rerank candidate preview chars. The module default moved 500 -> 1600
  // (Stage 16b); a resume into a receipt file recorded at the old value
  // must pin it so one file never mixes rerank configs.
  const rerankPreview = flag("rerank-preview", "")
    ? Number(flag("rerank-preview"))
    : undefined;
  // Reranker reasoning effort. Empty = provider default (medium for
  // luna), matching every receipt file recorded before this flag.
  const rerankEffort = flag("rerank-effort", "");
  // Stage 18 G: merge same-doc retrieved spans whose gap is at most
  // this many chars, so narrow gold clauses straddling chunk joints
  // arrive as one evidence snippet. 0 = off. Baseline stays unstitched.
  const stitchGap = Number(flag("stitch", "0"));
  // Stage 18 R5b adopted lane: LLM situating-header sidecar indexed in
  // the FTS context column. The label carries the sidecar's content
  // hash so a receipt file can never silently mix header versions.
  const contextJsonl = flag("context-jsonl", "");
  const contextWeight = Number(flag("context-weight", "0"));
  const contextTag =
    contextJsonl && contextWeight > 0
      ? `+ctx(w${contextWeight}@${createHash("sha256")
          .update(readFileSync(contextJsonl))
          .digest("hex")
          .slice(0, 12)})`
      : "";
  // Stage 18 arm D OPEN action: replace the lexical pool stage with
  // precomputed hybrid pool spans (per-test JSONL: {test_id, pool:
  // [{citation,start,end}...]}). The label carries the sidecar's
  // content hash, which pins the whole upstream pool construction
  // (embedder, headers, fusion); rerank/stitch/contract unchanged.
  const poolJsonl = flag("pool-jsonl", "");
  const poolTag = poolJsonl
    ? `pool(${createHash("sha256")
        .update(readFileSync(poolJsonl))
        .digest("hex")
        .slice(0, 12)})`
    : "";
  const retriever =
    (retrieverKind === "passage"
      ? poolJsonl
        ? `passage:${poolTag}`
        : `passage:t${chunkTarget}/o${chunkOverlap}/w${nameWeight}`
      : "product") +
    (poolJsonl ? "" : contextTag) +
    (rerankModel
      ? `+rerank(${rerankModel}${rerankEffort ? `@${rerankEffort}` : ""})`
      : "") +
    (rerankPreview === undefined ? "" : `@p${rerankPreview}`) +
    (stitchGap > 0 ? `+stitch${stitchGap}` : "");
  // The product path retrieves whole documents through searchLocalA2AJ and
  // has no per-document cap to set, so the row records null rather than a
  // number that did nothing.
  const recordedPerDocCap = retrieverKind === "passage" ? perDocCap : null;
  const timeoutMs = Number(flag("timeout-ms", "300000"));
  const concurrency = Number(flag("concurrency", "3"));
  const experimentsDir = path.join(
    process.env.LOCALAPPDATA ?? "",
    "OpenLegalData/experiments/legal-grounding/2026-07-30",
  );
  const resume = flag("resume", "0") !== "0";
  const coverageArm = flag("coverage", "0") !== "0";
  const specArm = flag("spec", "0") !== "0";
  // Stage 18 F2 negative control: gold docs (and byte-identical twins)
  // dropped from the hits, so the honest outcome is a decline.
  const excludeGold = flag("exclude-gold", "0") !== "0";
  // Stage 18 F3 plain-prompt control: the ONLY module is PLAIN_MODULE.
  const plainArm = flag("plain", "0") !== "0";
  if (plainArm && (coverageArm || specArm))
    throw new Error(
      "--plain is a standalone control arm; it cannot be combined with --coverage or --spec",
    );
  const activeModules = plainArm
    ? [PLAIN_MODULE]
    : [
        ...PROMPT_MODULES,
        ...(coverageArm ? [COVERAGE_MODULE] : []),
        ...(specArm ? [SPEC_MODULE] : []),
      ];
  const armLabel =
    (plainArm
      ? "plain"
      : "required_slot" +
        (coverageArm ? "+coverage" : "") +
        (specArm ? "+spec" : "")) + (excludeGold ? "+nogold" : "");

  // Pinned data, verified before trusting (same discipline as the
  // retrieval baseline runner).
  const manifest = validateMiniManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  );
  const onDisk = [...manifest.benchmarks, ...manifest.corpus].map((entry) => ({
    path: entry.path,
    bytes: readFileSync(path.join(LEGALBENCH_RAG_DATA_DIR, entry.path)),
  }));
  const problems = verifyAgainstManifest(manifest, onDisk);
  if (problems.length)
    throw new Error(`data does not match manifest:\n${problems.join("\n")}`);
  const disk = new Map(onDisk.map((file) => [file.path, file.bytes]));
  // Corpus load normalization (CRLF -> LF) applied AT FILE READ, before any
  // offsetting: quote location, span scoring and the source db below all
  // then live in upstream gold's coordinate space (17 maud files ship
  // CRLF; scripts/legalbench-gold-oracle-check.ts is the assertion).
  //
  // Every receipt written before this fix (stages 14-18) holds RAW CRLF
  // offsets — `quoted_spans`, `retrieval_baseline`, the pool/context
  // sidecars, everything. Score-time mapping for those files is
  //   raw_offset = lf_offset + (count of "\r\n" in the LF text before it),
  // which is not otherwise visible anywhere in this code. Rows written
  // from here on carry `coords: "lf"`, and the resume key below treats a
  // row without that field as a different cell so the two spaces can
  // never interleave in one file.
  const corpusText = new Map(
    manifest.corpus.map((entry) => [
      entry.upstream_path,
      normalizeCorpusBytes(disk.get(entry.path)!),
    ]),
  );
  const COORDS = "lf" as const;

  // F2: a gold doc's byte-identical duplicates count as gold too — the
  // mini corpus carries repeated contracts under distinct paths, and
  // leaving a twin in would silently defeat the negative control.
  const pathsByTextHash = new Map<string, string[]>();
  if (excludeGold) {
    for (const [docPath, text] of corpusText) {
      const digest = createHash("sha256").update(text).digest("hex");
      const twins = pathsByTextHash.get(digest);
      if (twins) twins.push(docPath);
      else pathsByTextHash.set(digest, [docPath]);
    }
  }
  const goldDocsFor = (test: MiniTestCell): Set<string> => {
    const excluded = new Set(test.gold.map((span) => span.filePath));
    for (const docPath of [...excluded]) {
      const text = corpusText.get(docPath);
      if (text === undefined) continue;
      const digest = createHash("sha256").update(text).digest("hex");
      for (const twin of pathsByTextHash.get(digest) ?? []) excluded.add(twin);
    }
    return excluded;
  };

  const poolByTest = new Map<
    string,
    Array<{ citation: string; start: number; end: number }>
  >();
  if (poolJsonl) {
    for (const line of readFileSync(poolJsonl, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as {
        test_id: string;
        pool: Array<{ citation: string; start: number; end: number }>;
      };
      poolByTest.set(row.test_id, row.pool);
    }
  }

  const database = LEGALBENCH_MINI_SOURCE_DB;
  if (!existsSync(database))
    throw new Error(
      `normalized FTS db missing (${database}); run ` +
        "scripts/legalbench-rag-run.ts --build-only once first",
    );
  process.env.MIKE_A2AJ_BULK_DB = database;
  const { searchLocalA2AJ } = await import("../src/lib/a2ajLocalBulk");

  const tests: MiniTestCell[] = SOURCE_BENCHMARKS.flatMap((source) => {
    const parsed = upstreamBenchmarkSchema.parse(
      JSON.parse(disk.get(`mini/benchmarks/${source}.json`)!.toString("utf8")),
    );
    return parsed.tests.slice(0, perSource).map((test, index) => ({
      id: `${source}:${String(index).padStart(3, "0")}`,
      source,
      query: test.query,
      gold: test.snippets.map((snippet) => ({
        filePath: snippet.file_path,
        start: snippet.span[0],
        end: snippet.span[1],
      })),
    }));
  });
  const onlyCases = flag("cases", "");
  const selected = onlyCases
    ? tests.filter((test) =>
        onlyCases.split(",").map((s) => s.trim()).includes(test.id),
      )
    : tests;
  if (!selected.length) throw new Error("no tests selected");
  console.log(
    `selected ${selected.length} tests (k=${k}, model=${model}, ` +
      `arm=${armLabel}, retriever=${retriever}, ` +
      `per_doc_cap=${recordedPerDocCap ?? "n/a"})`,
  );
  if (process.argv.includes("--dry-run")) return;

  // Receipt destination, resolved AFTER --dry-run so a dry run can never
  // be refused by the guard. The default is a fixed path and the
  // non-resume branch below truncates it, so an existing receipt throws
  // unless --force: that is how `stage18-retrieval-arms.jsonl` (sha
  // pinned in the experiment log) was destroyed on 2026-07-30.
  const output = receiptPath(path.join(experimentsDir, "stage14-lbrag.jsonl"), {
    resume,
  });
  mkdirSync(path.dirname(output), { recursive: true });
  const done = new Set<string>();
  // Cell identity (src/lib/experimentReceipts): coordinate space, model,
  // effort, ARM, k, retriever and per-doc cap. A pre-fix (raw-CRLF) row has
  // no `coords`, so it can never satisfy a cell of this LF run — the two
  // instruments are refused into one file rather than silently mixed.
  if (resume && existsSync(output)) {
    for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as Row;
      if (!row.error) done.add(legalbenchRagCellKey(row));
    }
  } else {
    writeFileSync(output, "", "utf8");
  }

  async function runTest(test: MiniTestCell): Promise<Row> {
    const started = Date.now();
    // Retrieval: top-k passages (exact offsets from the index) or the
    // product doc-level path (snippets located back via indexOf).
    const retrieved: Array<Span & { snippet: string }> = [];
    // D3: recorded per cell, never dropped — a fallback cell is the
    // lexical order, not the reranker's.
    let rerankFallback: boolean | null = rerankModel ? false : null;
    // F2: null unless --exclude-gold. Applied to the hits BEFORE rerank
    // in every retrieval path, so the composer never sees a gold doc.
    const excludedDocs = excludeGold ? goldDocsFor(test) : null;
    if (retrieverKind === "passage") {
      let hits;
      if (poolJsonl) {
        const pool = poolByTest.get(test.id);
        if (!pool) throw new Error(`pool sidecar has no test ${test.id}`);
        const docIds = new Map<string, number>();
        hits = capHitsPerDoc(pool, perDocCap, rerankModel ? 48 : k).map((span, index) => {
          if (!docIds.has(span.citation))
            docIds.set(span.citation, docIds.size + 1);
          const text = corpusText.get(span.citation);
          if (!text) throw new Error(`pool cites unknown doc ${span.citation}`);
          return {
            docId: docIds.get(span.citation)!,
            citation: span.citation,
            name: null,
            language: "en" as const,
            start: span.start,
            end: span.end,
            text: text.slice(span.start, span.end),
            rank: index,
          };
        });
        if (excludedDocs)
          hits = hits.filter((hit) => !excludedDocs.has(hit.citation));
      } else {
        hits = searchPassages({
          sourceDb: database,
          query: test.query,
          k: rerankModel ? 48 : k,
          target: chunkTarget,
          overlap: chunkOverlap,
          nameWeight,
          ...(contextJsonl && contextWeight > 0
            ? { contextJsonl, contextWeight }
            : {}),
          perDocCap,
        });
        if (excludedDocs)
          hits = hits.filter((hit) => !excludedDocs.has(hit.citation));
      }
      if (rerankModel) {
        const reranked = await rerankPassages({
          query: test.query,
          hits,
          model: rerankModel,
          top: k,
          ...(rerankPreview === undefined ? {} : { preview: rerankPreview }),
          ...(rerankEffort ? { effort: rerankEffort } : {}),
        });
        hits = reranked.hits;
        rerankFallback = reranked.fallback;
      }
      for (const hit of hits) {
        retrieved.push({
          filePath: hit.citation,
          start: hit.start,
          end: hit.end,
          snippet: hit.text,
        });
      }
    } else {
      const results = (
        searchLocalA2AJ({ query: test.query, docType: "laws", size: k }) ?? []
      ).slice(0, k);
      for (const result of results) {
        if (!result.snippet) continue;
        if (excludedDocs?.has(result.citation)) continue;
        const text = corpusText.get(result.citation);
        const start = text ? text.indexOf(result.snippet) : -1;
        if (start < 0) continue;
        retrieved.push({
          filePath: result.citation,
          start,
          end: start + result.snippet.length,
          snippet: result.snippet,
        });
      }
    }
    const baseline = scoreSpans(retrieved, test.gold);
    const evidence =
      stitchGap > 0 ? stitchSpans(retrieved, stitchGap, corpusText) : retrieved;

    const state = createLegalEvidenceTurnState("required_slot");
    state.premiseContext = { question: test.query, priorAnswer: null };
    state.lintContext = {
      question: test.query,
      alienessIndexPath: path.join(
        process.env.LOCALAPPDATA ?? "",
        "ALR Quote Verifier",
        "alienness",
        "trigrams-en-us.sqlite",
      ),
    };
    const bySnippetId = new Map<string, Span & { snippet: string }>();
    const receipts = evidence.map((span, index) => {
      const receipt = createBenchmarkEvidence({
        jurisdiction: "US",
        sourceClass: "legislation",
        stableSourceId: `lbrag:${test.id}:${index}`,
        sourceText: span.snippet,
        spanText: span.snippet,
        citation: span.filePath,
        dataset: `LegalBench-RAG-mini/${test.source}`,
        locatorKind: "paragraph",
        locatorLabel: `retrieved passage ${index + 1}`,
      });
      registerLegalEvidence(state, receipt);
      bySnippetId.set(receipt.evidence_id, span);
      return receipt;
    });

    let usage: NormalizedLlmUsage | null = null;
    let answer = "";
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const primary = await streamChatWithTools({
      model,
      reasoningEffort: effort,
      enableThinking: false,
      systemPrompt: activeModules.map(([, text]) => text).join(" "),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            question: test.query,
            evidence: receipts.map((receipt) => ({
              evidence_id: receipt.evidence_id,
              citation: receipt.citation,
              locator: receipt.locator.label,
              span_text: receipt.span_text,
            })),
            attested_characterizations: [],
          }),
        },
      ],
      tools: legalEvidenceExperimentTools("required_slot"),
      maxIterations: 3,
      abortSignal,
      runTools: async (calls) => calls.map((call) => runTool(call, state)),
    });
    usage = primary.usage ?? null;
    const finalized = await finalizeLegalEvidenceExperiment({
      state,
      model,
      draft: primary.fullText,
      requestContext: test.query,
      reasoningEffort: effort,
      abortSignal,
    });
    if (finalized.usage) {
      usage = {
        inputTokens:
          (usage?.inputTokens ?? 0) + (finalized.usage.inputTokens ?? 0),
        outputTokens:
          (usage?.outputTokens ?? 0) + (finalized.usage.outputTokens ?? 0),
        reasoningTokens:
          usage?.reasoningTokens == null &&
          finalized.usage.reasoningTokens == null
            ? null
            : (usage?.reasoningTokens ?? 0) +
              (finalized.usage.reasoningTokens ?? 0),
        cacheReadInputTokens:
          (usage?.cacheReadInputTokens ?? 0) +
          (finalized.usage.cacheReadInputTokens ?? 0),
        cacheWriteInputTokens:
          (usage?.cacheWriteInputTokens ?? 0) +
          (finalized.usage.cacheWriteInputTokens ?? 0),
      };
    }
    answer = renderLegalEvidenceAnswer(state) ?? "";
    const receipt = legalEvidenceReceiptEvent(state);

    // Locate final quotation claims back to original coordinates: first
    // inside the snippet the claim's evidence id names, then (fallback)
    // anywhere in that snippet's document.
    const quoted: Span[] = [];
    let unlocated = 0;
    for (const claim of receipt?.claims ?? []) {
      if (claim.kind !== "quotation" || !claim.deterministic_support) continue;
      let located = false;
      for (const evidenceId of claim.evidence_ids) {
        const span = bySnippetId.get(evidenceId);
        if (!span) continue;
        const inSnippet = locateQuote(span.snippet, claim.text);
        if (inSnippet) {
          quoted.push({
            filePath: span.filePath,
            start: span.start + inSnippet.start,
            end: span.start + inSnippet.end,
          });
          located = true;
          break;
        }
        const inDoc = locateQuote(corpusText.get(span.filePath) ?? "", claim.text);
        if (inDoc) {
          quoted.push({ filePath: span.filePath, ...inDoc });
          located = true;
          break;
        }
      }
      if (!located) unlocated += 1;
    }

    const passed = receipt?.status === "passed";
    const abstained = receipt?.failure === NO_SUB;
    return {
      schema_version: "lbrag-grounding-1",
      coords: COORDS,
      test_id: test.id,
      source: test.source,
      model,
      effort,
      arm: armLabel,
      k,
      retriever,
      per_doc_cap: recordedPerDocCap,
      query: test.query,
      status: passed ? "passed" : "failed",
      outcome: passed
        ? quoted.length
          ? "answered"
          : "declined"
        : abstained
          ? "abstained"
          : "rejected",
      abstained,
      failure: receipt?.failure ?? null,
      answer,
      quoted_spans: quoted,
      unlocated_quotes: unlocated,
      grounded: scoreSpans(quoted, test.gold),
      retrieval_baseline: baseline,
      rerank_fallback: rerankFallback,
      latency_ms: Date.now() - started,
      usage,
      legal_evidence_receipt: receipt,
      error: null,
    };
  }

  const queue = selected.filter(
    (test) =>
      !done.has(
        legalbenchRagCellKey({
          coords: COORDS,
          model,
          effort,
          arm: armLabel,
          k,
          retriever,
          per_doc_cap: recordedPerDocCap,
          test_id: test.id,
        }),
      ),
  );
  console.log(`running ${queue.length} tests (${done.size} resumed)`);
  let index = 0;
  const rows: Row[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (index < queue.length) {
        const test = queue[index++];
        let row: Row;
        try {
          row = await runTest(test);
        } catch (error) {
          row = {
            schema_version: "lbrag-grounding-1",
            coords: COORDS,
            test_id: test.id,
            source: test.source,
            model,
            effort,
            arm: armLabel,
            k,
            retriever,
            per_doc_cap: recordedPerDocCap,
            query: test.query,
            status: "error",
            outcome: "error",
            abstained: false,
            failure: null,
            answer: "",
            quoted_spans: [],
            unlocated_quotes: 0,
            grounded: { precision: 0, recall: 0, doc_hit: false, chars: 0 },
            retrieval_baseline: {
              precision: 0,
              recall: 0,
              doc_hit: false,
              chars: 0,
            },
            rerank_fallback: null,
            latency_ms: 0,
            usage: null,
            legal_evidence_receipt: null,
            error: String(error).slice(0, 500),
          };
        }
        appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
        rows.push(row);
        console.log(
          `${row.test_id}: ${row.status}${row.abstained ? " (abstained)" : ""} ` +
            `groundedP=${row.grounded.precision.toFixed(3)} ` +
            `groundedR=${row.grounded.recall.toFixed(3)} ` +
            `baseP=${row.retrieval_baseline.precision.toFixed(3)}` +
            `${row.unlocated_quotes ? ` UNLOCATED=${row.unlocated_quotes}` : ""}` +
            `${row.error ? ` ERROR=${row.error.slice(0, 80)}` : ""}`,
        );
      }
    }),
  );

  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const summarize = (label: string, subset: Row[]) => {
    const ok = subset.filter((row) => !row.error);
    const answered = ok.filter((row) => row.outcome === "answered");
    const count = (outcome: Row["outcome"]) =>
      ok.filter((row) => row.outcome === outcome).length;
    const rerankRows = ok.filter((row) => row.rerank_fallback !== null);
    console.log(
      `${label}: n=${subset.length} errors=${subset.length - ok.length} ` +
        `answered=${answered.length} declined=${count("declined")} ` +
        `rejected=${count("rejected")} abstained=${count("abstained")} ` +
        `unlocated=${ok.reduce((n, r) => n + r.unlocated_quotes, 0)} ` +
        // D3: fallback cells ran the lexical order, not the reranker.
        `rerank_fallback=${
          rerankRows.length
            ? `${rerankRows.filter((r) => r.rerank_fallback).length}/${rerankRows.length}`
            : "n/a"
        } | ` +
        `answered-only grounded P=${mean(answered.map((r) => r.grounded.precision)).toFixed(4)} ` +
        `R=${mean(answered.map((r) => r.grounded.recall)).toFixed(4)} ` +
        // D8: both doc numbers are now printed on BOTH denominators, so
        // an answered-only doc rate is never read against an all-cells
        // one. n= makes each denominator explicit.
        `doc=${mean(answered.map((r) => (r.grounded.doc_hit ? 1 : 0))).toFixed(2)} ` +
        `(n=${answered.length}) ` +
        `answered∩doc-miss=${
          answered.filter((r) => !r.retrieval_baseline.doc_hit).length
        } | ` +
        `baseline P=${mean(ok.map((r) => r.retrieval_baseline.precision)).toFixed(4)} ` +
        `R=${mean(ok.map((r) => r.retrieval_baseline.recall)).toFixed(4)} ` +
        `doc=${mean(ok.map((r) => (r.retrieval_baseline.doc_hit ? 1 : 0))).toFixed(2)} ` +
        `(n=${ok.length}) baseline-on-answered doc=${mean(
          answered.map((r) => (r.retrieval_baseline.doc_hit ? 1 : 0)),
        ).toFixed(2)}`,
    );
  };
  console.log("");
  summarize("overall", rows);
  for (const source of SOURCE_BENCHMARKS)
    summarize(source, rows.filter((row) => row.source === source));
  // D4: the "overall" line above is a flat mean over whatever rows exist,
  // so a partial run (one source short, or unequal per-source counts)
  // reports a source-mix artifact as a score change. Print the mix and the
  // source-balanced (macro) means beside it; compare arms per source and
  // paired, never on the flat mean of a partial file.
  const bySource = SOURCE_BENCHMARKS.map((source) => {
    const ok = rows.filter((row) => row.source === source && !row.error);
    const answered = ok.filter((row) => row.outcome === "answered");
    return { source, cells: ok.length, answered };
  }).filter((entry) => entry.cells > 0);
  const complete = new Set(bySource.map((entry) => entry.cells)).size <= 1;
  console.log(
    `mix: ${bySource
      .map((entry) => `${entry.source}=${entry.cells}`)
      .join(" ")} sources=${bySource.length}/${SOURCE_BENCHMARKS.length}` +
      `${complete ? "" : "  <-- UNBALANCED: the overall line is a mix artifact; read per-source"}`,
  );
  console.log(
    `macro (source-balanced, answered-only): P=${mean(
      bySource.map((entry) => mean(entry.answered.map((r) => r.grounded.precision))),
    ).toFixed(4)} R=${mean(
      bySource.map((entry) => mean(entry.answered.map((r) => r.grounded.recall))),
    ).toFixed(4)}`,
  );
  console.log(`\nReceipts: ${output}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error("[legalbench-rag-grounding]", error);
    process.exit(1);
  });
