/**
 * LegalBench-RAG-mini retrieval run (docs/beaver-evaluation-context-plan.md
 * Issue 5). Runs the product's EXISTING corpus retrieval configuration —
 * SQLite FTS5 bm25 document search plus the product snippet window, i.e.
 * `searchLocalA2AJ` from src/lib/a2ajLocalBulk.ts, fed by the existing
 * scripts/import_a2aj_bulk.py importer — over the pinned mini subset, and
 * reports char-level precision/recall@k plus retrieved-token volume inside a
 * validated Issue-1 run trace:
 *
 *   npx tsx scripts/legalbench-rag-run.ts        # offline; no model calls
 *   npx tsx scripts/legalbench-rag-run.ts --build-only [--rebuild-index]
 *
 * `--build-only` stops after step 2 — it is the one place the normalized
 * (LF) source db every other LegalBench script reads is built.
 *
 * Requires scripts/legalbench-rag-mini-setup.ts to have populated the
 * git-ignored data directory (verified against mini.manifest.json before the
 * run). Results land under benchmarks/legalbench_rag/results/ (git-ignored).
 * No LLM, no network: EVAL_LIVE is not required.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LEGALBENCH_MINI_SOURCE_DB,
  LEGALBENCH_RAG_DATA_DIR,
  LEGALBENCH_RAG_RESULTS_DIR,
  MANIFEST_PATH,
  SOURCE_BENCHMARKS,
  evaluateMiniRetrieval,
  normalizeCorpusBytes,
  reportScoreMap,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  verifyAgainstManifest,
  type MiniRetrievalReport,
  type MiniTest,
} from "../src/lib/legalbenchRag";
import { gitRunState, sha256Hex, writeRunTrace } from "../src/lib/runTrace";

const REPO_ROOT = path.join(__dirname, "..", "..");
const repoRelative = (file: string) =>
  path.relative(REPO_ROOT, file).split(path.sep).join("/");

function markdown(report: MiniRetrievalReport): string {
  const lines = [
    "# LegalBench-RAG-mini — product lexical retrieval (FTS5 bm25 + snippet window)",
    "",
    `- scoring_version: ${report.scoring_version}`,
    `- queries: ${report.queries}; unmapped snippets: ${report.unmapped_snippets}`,
    "",
    "| slice | k | precision | recall | doc recall | chars/query | word tokens/query |",
    "|---|---|---|---|---|---|---|",
  ];
  const rows = (name: string, metrics: MiniRetrievalReport["overall"]) => {
    for (const m of metrics) {
      lines.push(
        `| ${name} | ${m.k} | ${m.precision.toFixed(4)} | ${m.recall.toFixed(4)} | ` +
          `${m.doc_recall.toFixed(4)} | ${Math.round(m.retrieved_chars_mean)} | ` +
          `${Math.round(m.retrieved_word_tokens_mean)} |`,
      );
    }
  };
  rows("overall", report.overall);
  for (const [source, metrics] of Object.entries(report.per_source))
    rows(source, metrics);
  return `${lines.join("\n")}\n`;
}

async function main() {
  // 1. Verify the pinned data before trusting it.
  if (!existsSync(MANIFEST_PATH))
    throw new Error(`missing manifest: ${MANIFEST_PATH}`);
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const manifest = validateMiniManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const onDisk = [...manifest.benchmarks, ...manifest.corpus].map((entry) => ({
    path: entry.path,
    bytes: readFileSync(path.join(LEGALBENCH_RAG_DATA_DIR, entry.path)),
  }));
  const problems = verifyAgainstManifest(manifest, onDisk);
  if (problems.length)
    throw new Error(
      `data does not match manifest (run setup first):\n${problems.join("\n")}`,
    );
  const disk = new Map(onDisk.map((file) => [file.path, file.bytes]));

  // 2. Import the mini corpus into a local SQLite DB with the product's
  //    existing importer (one record per document). Text is NORMALIZED at
  //    this read (CRLF -> LF; see normalizeCorpusText) so the db, every
  //    derived passage index and every span scored downstream live in the
  //    same coordinate space as upstream gold. The corpus files on disk
  //    are untouched. Receipts and passage sidecars produced BEFORE this
  //    fix (stages 14-18, source db `a2aj-mini.sqlite`) hold raw-CRLF
  //    offsets and need score-time mapping:
  //      raw_offset = lf_offset + (number of "\r\n" before it).
  const databaseDir = path.join(LEGALBENCH_RAG_DATA_DIR, "db");
  const database = LEGALBENCH_MINI_SOURCE_DB;
  const jsonl = path.join(databaseDir, "records-lf.jsonl");
  if (!existsSync(database) || process.argv.includes("--rebuild-index")) {
    mkdirSync(databaseDir, { recursive: true });
    writeFileSync(
      jsonl,
      manifest.corpus
        .map((entry) =>
          JSON.stringify({
            doc_type: "laws",
            dataset: "legalbench_rag_mini",
            citation_en: entry.upstream_path,
            name_en: entry.upstream_path,
            unofficial_text_en: normalizeCorpusBytes(disk.get(entry.path)!),
            upstream_license: manifest.upstream.license,
          }),
        )
        .join("\n"),
    );
    const imported = spawnSync(
      "python",
      [
        path.join(__dirname, "import_a2aj_bulk.py"),
        jsonl,
        "--output",
        database,
        "--fts",
        "--doc-type",
        "laws",
      ],
      { encoding: "utf8", cwd: path.join(__dirname, "..") },
    );
    if (imported.status !== 0)
      throw new Error(`import_a2aj_bulk.py failed: ${imported.stderr}`);
    console.log(imported.stdout.trim());
  }
  if (process.argv.includes("--build-only")) {
    console.log(`Built normalized source db: ${database}`);
    return;
  }

  // 3. Drive the product retriever.
  process.env.MIKE_A2AJ_BULK_DB = database;
  const { searchLocalA2AJ } = await import("../src/lib/a2ajLocalBulk");
  const corpusText = new Map(
    manifest.corpus.map((entry) => [
      entry.upstream_path,
      normalizeCorpusBytes(disk.get(entry.path)!),
    ]),
  );
  const tests: MiniTest[] = SOURCE_BENCHMARKS.flatMap((source) => {
    const parsed = upstreamBenchmarkSchema.parse(
      JSON.parse(disk.get(`mini/benchmarks/${source}.json`)!.toString("utf8")),
    );
    return parsed.tests.map((test) => ({
      source,
      query: test.query,
      gold: test.snippets.map((snippet) => ({
        filePath: snippet.file_path,
        start: snippet.span[0],
        end: snippet.span[1],
      })),
    }));
  });

  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const report = evaluateMiniRetrieval({
    tests,
    corpusText,
    search: (query, size) =>
      (searchLocalA2AJ({ query, docType: "laws", size }) ?? []).map(
        (result) => ({ filePath: result.citation, snippet: result.snippet }),
      ),
  });
  const latencyMs = performance.now() - startedMs;

  // 4. Persist report + validated run trace.
  const runDir = path.join(
    LEGALBENCH_RAG_RESULTS_DIR,
    `${startedAt.replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, "report.json");
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, reportJson);
  writeFileSync(path.join(runDir, "report.md"), markdown(report));
  const git = gitRunState(__dirname);
  const tracePath = writeRunTrace(
    {
      schema_version: "1",
      run_id: randomUUID(),
      task_id: "LEGALBENCH-RAG-MINI",
      arm: "beaver_baseline",
      started_at: startedAt,
      git_commit: git.git_commit,
      dirty_worktree: git.dirty_worktree,
      provider: null,
      model: null,
      effort: null,
      context_strategy: null,
      cache_strategy: null,
      prompt_hash: null,
      source_manifest_hash: sha256Hex(manifestBytes),
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cache_write_tokens: null,
      latency_ms: latencyMs,
      estimated_cost: null,
      retrieved_source_ids: [...SOURCE_BENCHMARKS],
      artifact_paths: [repoRelative(reportPath)],
      artifact_hashes: [sha256Hex(reportJson)],
      fatal_errors: [],
      all_pass: null,
      score: reportScoreMap(report),
      scoring_version: report.scoring_version,
      manual_review_minutes: null,
    },
    runDir,
  );

  console.log(readFileSync(path.join(runDir, "report.md"), "utf8"));
  console.log(`Report: ${reportPath}`);
  console.log(`Trace:  ${tracePath}`);
}

main().catch((error) => {
  console.error("[legalbench-rag-run]", error);
  process.exit(1);
});
