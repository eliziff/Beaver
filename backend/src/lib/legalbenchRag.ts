/**
 * LegalBench-RAG-mini adapter (docs/beaver-evaluation-context-plan.md §3
 * Tier 1, Issue 5).
 *
 * Upstream: https://github.com/ZeroEntropy-AI/legalbenchrag (MIT, ZeroEntropy)
 * / arXiv:2408.10343. The benchmark ships four JSON files (contractnli, cuad,
 * maud, privacy_qa); each test is a natural-language query plus gold snippets
 * referencing a corpus text file by path and character span. Retrieval quality
 * is char-overlap precision/recall, exactly the upstream formulas
 * (legalbenchrag/run_benchmark.py).
 *
 * The paper's mini subset caps each source benchmark at 194 tests grouped by
 * document. Its exact selection depends on Python's string-seeded RNG, so this
 * adapter derives its own deterministic equivalent (documented in the pinned
 * manifest): group tests by document, take documents in code-unit
 * lexicographic order until the cap, truncate to the cap. Same shape as the
 * paper (776 tests / 69 docs / ~7.4 MB here vs 776 / 72 / ~8.7 MB there), and
 * byte-identical on every derivation.
 *
 * Nothing downloaded is ever committed: the corpus and derived mini live under
 * git-ignored `benchmarks/legalbench_rag/data/`; only `mini.manifest.json`
 * (upstream pin + sha256 of every derived file) is committed. Retrieval runs
 * reuse the product's existing corpus-search plane — SQLite FTS5 bm25 via
 * `searchLocalA2AJ` — through an injected search function; no new retrieval
 * machinery, no embeddings, no model calls.
 */
import path from "node:path";
import { z } from "zod/v4";
import { sha256Hex } from "./runTrace";
import { tokenizeSourceText } from "./sourceDoc";

export const LEGALBENCH_RAG_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "benchmarks",
  "legalbench_rag",
);
export const LEGALBENCH_RAG_DATA_DIR = path.join(LEGALBENCH_RAG_DIR, "data");
export const LEGALBENCH_RAG_RESULTS_DIR = path.join(
  LEGALBENCH_RAG_DIR,
  "results",
);
export const MANIFEST_PATH = path.join(
  LEGALBENCH_RAG_DIR,
  "mini.manifest.json",
);
export const HOLDOUT_MANIFEST_PATH = path.join(
  LEGALBENCH_RAG_DIR,
  "holdout.manifest.json",
);

/**
 * Source db built from the corpus (one document row per corpus file).
 * `...-lf` is the NORMALIZED build (see `normalizeCorpusText`) and is the
 * only coordinate space that matches upstream gold; the un-suffixed db is
 * the historical raw build kept for re-reading stage 14–18 receipts.
 * Separate paths, so the derived FTS sidecars (keyed by source-db path +
 * chunk params, NOT by source content) can never be reused across the two
 * coordinate spaces.
 */
export const LEGALBENCH_MINI_SOURCE_DB = path.join(
  LEGALBENCH_RAG_DATA_DIR,
  "db",
  "a2aj-mini-lf.sqlite",
);
export const LEGALBENCH_MINI_SOURCE_DB_RAW = path.join(
  LEGALBENCH_RAG_DATA_DIR,
  "db",
  "a2aj-mini.sqlite",
);
/**
 * Stage 19 hold-out source db (normalized at load, like the `-lf` mini db).
 * Separate path for the same reason: the FTS sidecar identity is source-db
 * path + chunk params, so a shared path would silently reuse the dev index.
 */
export const LEGALBENCH_HOLDOUT_SOURCE_DB = path.join(
  LEGALBENCH_RAG_DATA_DIR,
  "db",
  "a2aj-holdout-lf.sqlite",
);

/**
 * Corpus load normalization — apply at EVERY read of a corpus file, before
 * any offsetting, chunking or indexing. Converts CRLF to LF and NOTHING
 * else: a leading BOM is deliberately KEPT, because upstream gold counts
 * it as one character (measured: 334/334 maud snippets slice to their
 * answer with the BOM retained, 0/334 with it stripped).
 *
 * Why: the 17 maud corpus files ship CRLF (+BOM); every other file is LF.
 * Upstream gold `span` offsets are LF coordinates throughout (decidable
 * from the shipped `answer` string: 334/334 maud snippets slice to their
 * answer under LF, 0/334 raw). Normalizing here makes every downstream
 * coordinate — chunk spans, FTS index rows, retrieved/quoted spans —
 * directly comparable to gold. The corpus files themselves are never
 * rewritten; `mini.manifest.json` still pins their raw bytes.
 *
 * COORDINATE-SPACE WARNING for anyone re-scoring old receipts: every
 * receipt produced before this fix (stages 14–18, i.e. every
 * `stage14-`…`stage18-` JSONL and every passage sidecar built from
 * `a2aj-mini.sqlite`) holds RAW-CRLF offsets. Mapping at score time is
 * `raw_offset = lf_offset + (count of "\r\n" in the LF text before
 * lf_offset)` — equivalently, subtract that count to go raw → LF. Only
 * maud is affected; the other three sources are byte-identical either way.
 * Receipts written after this fix carry `coords: "lf"`.
 */
export function normalizeCorpusText(text: string): string {
  return text.replace(/\r\n/gu, "\n");
}

/** `normalizeCorpusText` over freshly read bytes (the file-read path). */
export function normalizeCorpusBytes(bytes: Buffer): string {
  return normalizeCorpusText(bytes.toString("utf8"));
}

export const SOURCE_BENCHMARKS = [
  "contractnli",
  "cuad",
  "maud",
  "privacy_qa",
] as const;
export type SourceBenchmark = (typeof SOURCE_BENCHMARKS)[number];

/** Paper's cap: 194 tests per source benchmark. */
export const MAX_TESTS_PER_SOURCE = 194;

export const SCORING_VERSION = "legalbench-rag-mini-charspan-1";

// ---------------------------------------------------------------------------
// Upstream benchmark schema (loose: verbatim test objects are preserved).
// ---------------------------------------------------------------------------

const snippetSchema = z.looseObject({
  file_path: z.string().min(1),
  span: z.tuple([z.int().nonnegative(), z.int().nonnegative()]),
});
const testSchema = z.looseObject({
  query: z.string().min(1),
  snippets: z.array(snippetSchema).min(1),
});
export const upstreamBenchmarkSchema = z.looseObject({
  tests: z.array(testSchema).min(1),
});

export type UpstreamTest = z.infer<typeof testSchema>;

// ---------------------------------------------------------------------------
// Deterministic mini derivation.
// ---------------------------------------------------------------------------

/**
 * Group tests by their first snippet's document, take documents in code-unit
 * lexicographic order until `cap` tests are accumulated, truncate to `cap`.
 * Test order within a document is upstream file order. Pure and deterministic.
 */
export function deriveMiniTests(
  tests: UpstreamTest[],
  cap: number = MAX_TESTS_PER_SOURCE,
): UpstreamTest[] {
  return deriveSplitTests(tests, "mini", cap);
}

export const SPLIT_NAMES = ["mini", "holdout"] as const;
export type SplitName = (typeof SPLIT_NAMES)[number];

/**
 * Split derivation. `mini` is the pinned dev bed: documents in code-unit
 * lexicographic order until `cap` tests accumulate, truncated to `cap`.
 * `holdout` (Stage 19) continues the SAME walk from the first document the
 * mini derivation never touched, and takes the next `cap` tests.
 *
 * A document the mini walk consumed only partially (the truncation at `cap`
 * lands mid-document) belongs to mini alone and is skipped entirely — that
 * is what makes the split document-blocked, which is the only leakage
 * property the hold-out actually establishes. Sources whose upstream
 * benchmark is exhausted by mini (privacy_qa: 194 of 194 tests) yield an
 * EMPTY hold-out; that is a fact about the benchmark, not an error.
 */
export function deriveSplitTests(
  tests: UpstreamTest[],
  split: SplitName,
  cap: number = MAX_TESTS_PER_SOURCE,
): UpstreamTest[] {
  const byDocument = new Map<string, UpstreamTest[]>();
  for (const test of tests) {
    const document = test.snippets[0].file_path;
    const bucket = byDocument.get(document) ?? [];
    if (!bucket.length) byDocument.set(document, bucket);
    bucket.push(test);
  }
  const documents = [...byDocument.keys()].sort();
  let at = 0;
  if (split === "holdout") {
    // Advance past every document the mini walk touched, truncated or not.
    for (let taken = 0; at < documents.length && taken < cap; at += 1)
      taken += byDocument.get(documents[at])!.length;
  }
  const chosen: UpstreamTest[] = [];
  for (; at < documents.length; at += 1) {
    if (chosen.length >= cap) break;
    chosen.push(...byDocument.get(documents[at])!);
  }
  return chosen.slice(0, cap);
}

/** Everything that differs between the dev bed and the Stage 19 hold-out. */
export const SPLITS = {
  mini: {
    manifestName: "legalbench-rag-mini",
    dir: "mini",
    manifestPath: MANIFEST_PATH,
    sourceDb: LEGALBENCH_MINI_SOURCE_DB,
    recordsJsonl: "records-lf.jsonl",
  },
  holdout: {
    manifestName: "legalbench-rag-holdout",
    dir: "holdout",
    manifestPath: HOLDOUT_MANIFEST_PATH,
    sourceDb: LEGALBENCH_HOLDOUT_SOURCE_DB,
    recordsJsonl: "records-holdout-lf.jsonl",
  },
} as const satisfies Record<SplitName, unknown>;

/** `--split mini|holdout` from argv, defaulting to the dev bed. */
export function splitFromArgv(argv: string[] = process.argv): SplitName {
  const at = argv.indexOf("--split");
  const value = at >= 0 ? argv[at + 1] : "mini";
  if (!SPLIT_NAMES.includes(value as SplitName))
    throw new Error(`--split must be one of ${SPLIT_NAMES.join("|")}`);
  return value as SplitName;
}

export function miniDocumentPaths(tests: UpstreamTest[]): string[] {
  return [
    ...new Set(tests.flatMap((test) => test.snippets.map((s) => s.file_path))),
  ].sort();
}

/** Windows-safe local file name for an upstream corpus path (':' etc.). */
export function sanitizeCorpusPath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => segment.replace(/[<>:"|?*]/gu, "_"))
    .join("/");
}

// ---------------------------------------------------------------------------
// Pinned manifest.
// ---------------------------------------------------------------------------

const fileEntry = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.int().nonnegative(),
});

export const miniManifestSchema = z.strictObject({
  schema_version: z.literal("1"),
  name: z.enum(["legalbench-rag-mini", "legalbench-rag-holdout"]),
  upstream: z.strictObject({
    repository: z.string(),
    paper: z.string(),
    download_url: z.string(),
    download_zip_bytes_observed: z.int().positive(),
    license: z.string(),
    license_note: z.string(),
  }),
  derivation: z.strictObject({
    rule: z.string(),
    max_tests_per_source: z.int().positive(),
    /** Sources the split cannot cover; hold-out only (privacy_qa). */
    sources_without_split: z.array(z.enum(SOURCE_BENCHMARKS)).optional(),
  }),
  benchmarks: z.array(
    fileEntry.extend({
      source: z.enum(SOURCE_BENCHMARKS),
      tests: z.int().positive(),
      documents: z.int().positive(),
    }),
  ),
  corpus: z.array(fileEntry.extend({ upstream_path: z.string().min(1) })),
});

export type MiniManifest = z.infer<typeof miniManifestSchema>;

export function validateMiniManifest(record: unknown): MiniManifest {
  return miniManifestSchema.parse(record);
}

export type ManifestFile = { path: string; bytes: Buffer };

/**
 * Compare freshly derived files against a pinned manifest. Returns mismatch
 * strings (empty array = byte-identical verification).
 */
export function verifyAgainstManifest(
  manifest: MiniManifest,
  derived: ManifestFile[],
): string[] {
  const pinned = new Map(
    [...manifest.benchmarks, ...manifest.corpus].map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of derived) {
    seen.add(file.path);
    const entry = pinned.get(file.path);
    if (!entry) {
      problems.push(`unpinned derived file: ${file.path}`);
      continue;
    }
    const digest = sha256Hex(file.bytes);
    if (digest !== entry.sha256 || file.bytes.length !== entry.bytes) {
      problems.push(
        `hash mismatch: ${file.path} derived ${digest} (${file.bytes.length} B) != pinned ${entry.sha256} (${entry.bytes} B)`,
      );
    }
  }
  for (const entryPath of pinned.keys()) {
    if (!seen.has(entryPath))
      problems.push(`pinned file missing: ${entryPath}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Char-span retrieval metrics (upstream formulas, run_benchmark.py).
// ---------------------------------------------------------------------------

export type Span = { filePath: string; start: number; end: number };

const overlap = (a: Span, b: Span) =>
  a.filePath === b.filePath
    ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
    : 0;

/**
 * Character-level precision/recall of retrieved spans against gold spans —
 * the upstream QAResult formulas, with the credited region UNION-MERGED
 * (Stage 18 defect D2).
 *
 * Upstream sums every (retrieved × gold) pairwise overlap. That is only
 * correct when the retrieved spans are mutually disjoint; ours are not
 * (overlapping chunks, k=48 pools with perDocCap 24, stitched spans), so
 * a character covered by two retrieved spans was credited twice and
 * recall could exceed 1.0. Here the pairwise intersections are merged per
 * document before summing, so every gold character is credited at most
 * once. Both ratios are clipped at 1.0 as a belt-and-braces invariant.
 */
export function charPrecisionRecall(
  retrieved: Span[],
  gold: Span[],
): { precision: number; recall: number } {
  const retrievedLen = retrieved.reduce((n, s) => n + (s.end - s.start), 0);
  const goldLen = gold.reduce((n, s) => n + (s.end - s.start), 0);
  const credited: Span[] = [];
  for (const span of retrieved)
    for (const gt of gold) {
      if (overlap(span, gt) <= 0) continue;
      credited.push({
        filePath: span.filePath,
        start: Math.max(span.start, gt.start),
        end: Math.min(span.end, gt.end),
      });
    }
  const common = unionLength(credited);
  return {
    precision: retrievedLen === 0 ? 0 : Math.min(1, common / retrievedLen),
    recall: goldLen === 0 ? 0 : Math.min(1, common / goldLen),
  };
}

/** Total length covered by `spans`, counting each character once. */
export function unionLength(spans: Span[]): number {
  const byPath = new Map<string, Span[]>();
  for (const span of spans) {
    const bucket = byPath.get(span.filePath);
    if (bucket) bucket.push(span);
    else byPath.set(span.filePath, [span]);
  }
  let total = 0;
  for (const bucket of byPath.values()) {
    bucket.sort((left, right) => left.start - right.start);
    let start = bucket[0].start;
    let end = bucket[0].end;
    for (const span of bucket.slice(1)) {
      if (span.start > end) {
        total += end - start;
        start = span.start;
        end = span.end;
      } else if (span.end > end) end = span.end;
    }
    total += end - start;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Mini retrieval evaluation over an injected product search function.
// ---------------------------------------------------------------------------

export type MiniTest = {
  source: SourceBenchmark;
  query: string;
  gold: Span[];
};

/** One ranked result from the product retriever: document id + verbatim
 * snippet text (the product's 1200-char window), or null snippet. */
export type SearchResult = { filePath: string; snippet: string | null };
export type SearchFn = (query: string, size: number) => SearchResult[];

export type MetricsAtK = {
  k: number;
  precision: number;
  recall: number;
  /** Fraction of queries whose gold document appears in the top k. */
  doc_recall: number;
  /** Mean retrieved volume per query at this k. */
  retrieved_chars_mean: number;
  retrieved_word_tokens_mean: number;
};

export type MiniRetrievalReport = {
  scoring_version: string;
  ks: number[];
  queries: number;
  /** Retrieved snippets that could not be located in their source text. */
  unmapped_snippets: number;
  overall: MetricsAtK[];
  per_source: Record<string, MetricsAtK[]>;
};

type QueryScore = {
  source: SourceBenchmark;
  precision: number[];
  recall: number[];
  docHit: number[];
  chars: number[];
  tokens: number[];
};

/**
 * Run every mini test through the injected search function and score the
 * top-k prefixes. `corpusText` maps upstream file paths to the ORIGINAL file
 * text; retrieved snippets are located back to original char coordinates via
 * indexOf (the product window is a verbatim slice of the trimmed text, which
 * is a substring of the original).
 */
export function evaluateMiniRetrieval(args: {
  tests: MiniTest[];
  corpusText: Map<string, string>;
  search: SearchFn;
  ks?: number[];
}): MiniRetrievalReport {
  const ks = args.ks ?? [1, 2, 4, 8];
  const maxK = Math.max(...ks);
  let unmapped = 0;
  const scores: QueryScore[] = args.tests.map((test) => {
    const results = args.search(test.query, maxK).slice(0, maxK);
    const spans: (Span & { rank: number; tokens: number })[] = [];
    results.forEach((result, rank) => {
      if (!result.snippet) return;
      const text = args.corpusText.get(result.filePath);
      const start = text ? text.indexOf(result.snippet) : -1;
      if (start < 0) {
        unmapped += 1;
        return;
      }
      spans.push({
        filePath: result.filePath,
        start,
        end: start + result.snippet.length,
        rank,
        tokens: tokenizeSourceText(result.snippet).length,
      });
    });
    const goldDocs = new Set(test.gold.map((span) => span.filePath));
    const score: QueryScore = {
      source: test.source,
      precision: [],
      recall: [],
      docHit: [],
      chars: [],
      tokens: [],
    };
    for (const k of ks) {
      const atK = spans.filter((span) => span.rank < k);
      const { precision, recall } = charPrecisionRecall(atK, test.gold);
      score.precision.push(precision);
      score.recall.push(recall);
      score.docHit.push(
        results.slice(0, k).some((r) => goldDocs.has(r.filePath)) ? 1 : 0,
      );
      score.chars.push(atK.reduce((n, s) => n + (s.end - s.start), 0));
      score.tokens.push(atK.reduce((n, s) => n + s.tokens, 0));
    }
    return score;
  });

  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const aggregate = (subset: QueryScore[]): MetricsAtK[] =>
    ks.map((k, index) => ({
      k,
      precision: mean(subset.map((s) => s.precision[index])),
      recall: mean(subset.map((s) => s.recall[index])),
      doc_recall: mean(subset.map((s) => s.docHit[index])),
      retrieved_chars_mean: mean(subset.map((s) => s.chars[index])),
      retrieved_word_tokens_mean: mean(subset.map((s) => s.tokens[index])),
    }));

  const perSource: Record<string, MetricsAtK[]> = {};
  for (const source of new Set(scores.map((score) => score.source))) {
    perSource[source] = aggregate(scores.filter((s) => s.source === source));
  }
  return {
    scoring_version: SCORING_VERSION,
    ks,
    queries: args.tests.length,
    unmapped_snippets: unmapped,
    overall: aggregate(scores),
    per_source: perSource,
  };
}

/** Flatten a report into the run-trace numeric `score` map. */
export function reportScoreMap(
  report: MiniRetrievalReport,
): Record<string, number> {
  const map: Record<string, number> = {
    queries: report.queries,
    unmapped_snippets: report.unmapped_snippets,
  };
  for (const metrics of report.overall) {
    map[`precision_at_${metrics.k}`] = metrics.precision;
    map[`recall_at_${metrics.k}`] = metrics.recall;
    map[`doc_recall_at_${metrics.k}`] = metrics.doc_recall;
    map[`retrieved_chars_mean_at_${metrics.k}`] = metrics.retrieved_chars_mean;
    map[`retrieved_word_tokens_mean_at_${metrics.k}`] =
      metrics.retrieved_word_tokens_mean;
  }
  return map;
}
