/**
 * LegalBench-RAG-mini pinned setup (docs/beaver-evaluation-context-plan.md
 * Issue 5). Downloads the upstream LegalBench-RAG archive, derives the
 * deterministic mini subset, writes it under the git-ignored
 * `benchmarks/legalbench_rag/data/`, and verifies every derived file
 * byte-for-byte against the committed `mini.manifest.json`:
 *
 *   EVAL_LIVE=1 npx tsx scripts/legalbench-rag-mini-setup.ts   # may download
 *   npx tsx scripts/legalbench-rag-mini-setup.ts               # offline re-verify
 *
 * The 90 MB upstream zip is cached at data/LegalBench-RAG.zip; downloading it
 * (network) requires EVAL_LIVE=1. Re-running with the zip present is fully
 * offline and must reproduce the exact pinned bytes (exit 1 otherwise).
 * `--write-manifest` regenerates the manifest (first authoring / deliberate
 * re-pin only). No corpus file is ever committed — only the manifest is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LEGALBENCH_RAG_DATA_DIR,
  MAX_TESTS_PER_SOURCE,
  SOURCE_BENCHMARKS,
  SPLITS,
  deriveSplitTests,
  miniDocumentPaths,
  sanitizeCorpusPath,
  splitFromArgv,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  verifyAgainstManifest,
  type ManifestFile,
  type MiniManifest,
  type SourceBenchmark,
} from "../src/lib/legalbenchRag";
import { sha256Hex } from "../src/lib/runTrace";

const UPSTREAM = {
  repository: "https://github.com/ZeroEntropy-AI/legalbenchrag",
  paper: "https://arxiv.org/abs/2408.10343",
  download_url:
    "https://www.dropbox.com/scl/fo/r7xfa5i3hdsbxex1w6amw/AID389Olvtm-ZLTKAPrw6k4?rlkey=5n8zrbk4c08lbit3iiexofmwg&st=0hu354cq&dl=1",
  download_zip_bytes_observed: 90591976,
  license:
    "MIT (LegalBench-RAG benchmark and repository, Copyright (c) 2025 ZeroEntropy)",
  license_note:
    "Benchmark aggregates ContractNLI, CUAD, MAUD and PrivacyQA; each source dataset retains its own upstream terms. Downloaded and derived data stay in the git-ignored data/ directory; only this manifest (URLs, derivation rule, sha256 pins) is committed.",
} as const;

const DERIVATION_RULE =
  "Per source benchmark: group tests by first-snippet document path, take documents in code-unit lexicographic order until max_tests_per_source tests are accumulated, truncate to max_tests_per_source (upstream file order within a document). Mini benchmark files serialize the selected upstream test objects verbatim as JSON.stringify({tests}) + newline. Corpus files are byte-identical zip entries stored under Windows-safe names (characters <>:\"|?* replaced with _).";

const HOLDOUT_DERIVATION_RULE =
  "Stage 19 hold-out. Same walk as the mini rule, continued: per source benchmark, group tests by first-snippet document path, order documents in code-unit lexicographic order, SKIP every document the mini derivation touched (including one truncated at the mini cap), then take documents until max_tests_per_source tests accumulate, truncated to max_tests_per_source. Sources whose upstream benchmark is exhausted by mini yield no hold-out and are listed in derivation.sources_without_split. Files serialize the selected upstream test objects verbatim as JSON.stringify({tests}) + newline; corpus files are byte-identical zip entries under Windows-safe names.";

const ZIP_PATH = path.join(LEGALBENCH_RAG_DATA_DIR, "LegalBench-RAG.zip");

async function ensureZip(): Promise<void> {
  if (existsSync(ZIP_PATH)) return;
  if (process.env.EVAL_LIVE !== "1") {
    console.error(
      `Missing ${ZIP_PATH} and EVAL_LIVE!=1 — refusing to touch the network. ` +
        "Run with EVAL_LIVE=1 to download the upstream archive once.",
    );
    process.exit(2);
  }
  console.log(`Downloading upstream archive (~90 MB) from Dropbox...`);
  const response = await fetch(UPSTREAM.download_url);
  if (!response.ok)
    throw new Error(`download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(LEGALBENCH_RAG_DATA_DIR, { recursive: true });
  writeFileSync(ZIP_PATH, bytes);
  console.log(`Saved ${bytes.length} bytes to ${ZIP_PATH}`);
}

const SPLIT = splitFromArgv();
const CONFIG = SPLITS[SPLIT];

/** Derive every split file (benchmarks + corpus) from the cached zip. */
async function deriveFiles(): Promise<{
  files: ManifestFile[];
  benchmarks: MiniManifest["benchmarks"];
  corpus: MiniManifest["corpus"];
  empty: SourceBenchmark[];
}> {
  const JSZip = require("jszip") as typeof import("jszip");
  const zip = await JSZip.loadAsync(readFileSync(ZIP_PATH));
  const entry = (name: string) => {
    const file = zip.file(name);
    if (!file) throw new Error(`zip entry missing: ${name}`);
    return file.async("nodebuffer");
  };

  const files: ManifestFile[] = [];
  const benchmarks: MiniManifest["benchmarks"] = [];
  const corpusEntries: MiniManifest["corpus"] = [];
  const corpusPaths = new Map<string, string>(); // upstream -> local
  const empty: SourceBenchmark[] = [];
  for (const source of SOURCE_BENCHMARKS) {
    const raw = JSON.parse(
      (await entry(`benchmarks/${source}.json`)).toString("utf8"),
    ) as { tests: unknown[] };
    upstreamBenchmarkSchema.parse(raw);
    const tests = deriveSplitTests(
      raw.tests as Parameters<typeof deriveSplitTests>[0],
      SPLIT,
    );
    // privacy_qa mini IS the complete upstream benchmark (194 of 194), so it
    // has no hold-out. Record the absence; never fabricate an empty bed.
    if (!tests.length) {
      empty.push(source);
      continue;
    }
    const documents = miniDocumentPaths(tests);
    const bytes = Buffer.from(`${JSON.stringify({ tests })}\n`, "utf8");
    const filePath = `${CONFIG.dir}/benchmarks/${source}.json`;
    files.push({ path: filePath, bytes });
    benchmarks.push({
      source,
      path: filePath,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      tests: tests.length,
      documents: documents.length,
    });
    for (const upstream of documents) {
      if (corpusPaths.has(upstream)) continue;
      const local = `${CONFIG.dir}/corpus/${sanitizeCorpusPath(upstream)}`;
      for (const [otherUpstream, otherLocal] of corpusPaths) {
        if (otherLocal === local)
          throw new Error(
            `sanitized path collision: ${upstream} vs ${otherUpstream}`,
          );
      }
      corpusPaths.set(upstream, local);
      const bytes = await entry(`corpus/${upstream}`);
      files.push({ path: local, bytes });
      corpusEntries.push({
        upstream_path: upstream,
        path: local,
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
      });
    }
  }
  corpusEntries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, benchmarks, corpus: corpusEntries, empty };
}

async function main() {
  const writeManifest = process.argv.includes("--write-manifest");
  await ensureZip();
  const derived = await deriveFiles();

  for (const file of derived.files) {
    const target = path.join(LEGALBENCH_RAG_DATA_DIR, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  const corpusBytes = derived.corpus.reduce((n, f) => n + f.bytes, 0);
  console.log(
    `[${SPLIT}] Derived ${derived.benchmarks.reduce((n, b) => n + b.tests, 0)} tests / ` +
      `${derived.corpus.length} corpus documents (${corpusBytes} bytes) into ${LEGALBENCH_RAG_DATA_DIR}` +
      (derived.empty.length
        ? `; no ${SPLIT} bed for ${derived.empty.join(", ")} (upstream exhausted by mini)`
        : ""),
  );

  // Document-blocking is the ONLY leakage property the hold-out establishes,
  // so it is asserted here rather than assumed: no hold-out document may
  // appear in the pinned mini corpus.
  if (SPLIT === "holdout" && existsSync(SPLITS.mini.manifestPath)) {
    const mini = validateMiniManifest(
      JSON.parse(readFileSync(SPLITS.mini.manifestPath, "utf8")),
    );
    const devDocuments = new Set(mini.corpus.map((c) => c.upstream_path));
    const shared = derived.corpus
      .map((c) => c.upstream_path)
      .filter((p) => devDocuments.has(p));
    if (shared.length) {
      console.error(
        `hold-out is NOT document-blocked: ${shared.length} document(s) also in mini:\n  ${shared.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(
      `Document-blocking OK: 0 of ${derived.corpus.length} hold-out documents appear in the mini corpus`,
    );
  }

  if (writeManifest) {
    const manifest: MiniManifest = validateMiniManifest({
      schema_version: "1",
      name: CONFIG.manifestName,
      upstream: UPSTREAM,
      derivation: {
        rule: SPLIT === "holdout" ? HOLDOUT_DERIVATION_RULE : DERIVATION_RULE,
        max_tests_per_source: MAX_TESTS_PER_SOURCE,
        ...(derived.empty.length
          ? { sources_without_split: derived.empty }
          : {}),
      },
      benchmarks: derived.benchmarks,
      corpus: derived.corpus,
    });
    writeFileSync(
      CONFIG.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(`Wrote manifest: ${CONFIG.manifestPath}`);
    return;
  }

  if (!existsSync(CONFIG.manifestPath)) {
    console.error(
      `No committed manifest at ${CONFIG.manifestPath}. Run with --write-manifest to pin.`,
    );
    process.exit(1);
  }
  const manifest = validateMiniManifest(
    JSON.parse(readFileSync(CONFIG.manifestPath, "utf8")),
  );
  const problems = verifyAgainstManifest(manifest, derived.files);
  if (problems.length) {
    console.error(`Manifest verification FAILED (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `Manifest verification OK: ${derived.files.length} files byte-identical to ${CONFIG.manifestPath}`,
  );
}

main().catch((error) => {
  console.error("[legalbench-rag-mini-setup]", error);
  process.exit(1);
});
