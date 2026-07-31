/**
 * Dense-lane dumper (Stage 18 arm D, re-derived for Stage 18R): exports
 * the passage index (t1600/o120 chars) and per-test lexical top-48 pools
 * + gold to JSONL for the python dense eval that runs on the 3080 Ti.
 * Deterministic, read-only, zero model calls.
 *
 *   npx tsx scripts/legalbench-dense-dump.ts <outDir> \
 *     [--split mini|holdout] [--context-jsonl <headers.jsonl>]
 *
 * Stage 18R: this lived in a scratchpad file for the original arm D run
 * and pointed at the RAW (CRLF) source db, so the dense lane was built
 * over a chunk set that no longer exists — the raw index carried 5,984
 * passages, the normalized one 5,966. It is committed here, repointed at
 * the normalized (LF) db, because an arm that cannot be re-derived from
 * the repo cannot be re-traced.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  LEGALBENCH_RAG_DATA_DIR,
  SOURCE_BENCHMARKS,
  SPLITS,
  splitFromArgv,
  upstreamBenchmarkSchema,
  validateMiniManifest,
} from "../src/lib/legalbenchRag";
import { passageIndexPath, searchPassages } from "../src/lib/passageRetrieval";

const outDir = process.argv[2];
if (!outDir || outDir.startsWith("--"))
  throw new Error(
    "usage: legalbench-dense-dump.ts <outDir> [--split mini|holdout] [--context-jsonl <file>]",
  );

const split = splitFromArgv();
const config = SPLITS[split];
const contextArg = process.argv.indexOf("--context-jsonl");
const contextJsonl = contextArg >= 0 ? process.argv[contextArg + 1] : undefined;

validateMiniManifest(JSON.parse(readFileSync(config.manifestPath, "utf8")));
const sourceDb = config.sourceDb;
const indexDb = passageIndexPath({ sourceDb, target: 1600, overlap: 120 });

// Passages with verbatim text sliced from the (normalized) source documents.
const source = new DatabaseSync(sourceDb, { readOnly: true });
const docs = new Map<
  number,
  { citation: string; name: string | null; text: string }
>();
for (const row of source
  .prepare("SELECT id, citation_en, name_en, unofficial_text_en FROM document")
  .all() as Array<Record<string, unknown>>) {
  docs.set(row.id as number, {
    citation: String(row.citation_en ?? ""),
    name: row.name_en ? String(row.name_en) : null,
    text: String(row.unofficial_text_en ?? ""),
  });
}
source.close();

const index = new DatabaseSync(indexDb, { readOnly: true });
const passages = index
  .prepare("SELECT id, doc_id, start, end FROM passage WHERE language = 'en'")
  .all() as Array<Record<string, unknown>>;
index.close();

const passageLines = passages.map((row) => {
  const doc = docs.get(row.doc_id as number)!;
  return JSON.stringify({
    pid: row.id,
    doc_id: row.doc_id,
    language: "en",
    citation: doc.citation,
    name: doc.name,
    start: row.start,
    end: row.end,
    text: doc.text.slice(row.start as number, row.end as number),
  });
});
writeFileSync(
  path.join(outDir, "passages.jsonl"),
  `${passageLines.join("\n")}\n`,
  "utf8",
);
console.log(
  `[${split}] passages: ${passageLines.length} -> passages.jsonl (index ${path.basename(indexDb)})`,
);

// Tests with gold and the lexical top-48 pool (rerank-bed settings).
const testLines: string[] = [];
for (const sourceName of SOURCE_BENCHMARKS) {
  const benchmarkPath = path.join(
    LEGALBENCH_RAG_DATA_DIR,
    `${config.dir}/benchmarks/${sourceName}.json`,
  );
  let parsed;
  try {
    parsed = upstreamBenchmarkSchema.parse(
      JSON.parse(readFileSync(benchmarkPath, "utf8")),
    );
  } catch {
    continue; // privacy_qa has no hold-out bed.
  }
  parsed.tests.forEach((test, i) => {
    const base = {
      sourceDb,
      query: test.query,
      k: 48,
      target: 1600,
      overlap: 120,
      nameWeight: 16,
      perDocCap: 24,
    } as const;
    const pool = searchPassages(base);
    // The context-enriched lexical pool the dense lane must beat or fuse
    // with. The sidecar is a CLI argument now: the header file is keyed by
    // exact chunk span, so the CRLF-era sidecar keys nothing on this index.
    const ctxPool = contextJsonl
      ? searchPassages({ ...base, contextJsonl, contextWeight: 4 })
      : pool;
    const spans = (hits: typeof pool) =>
      hits.map((hit) => ({
        citation: hit.citation,
        start: hit.start,
        end: hit.end,
      }));
    testLines.push(
      JSON.stringify({
        test_id: `${sourceName}:${String(i).padStart(3, "0")}`,
        source: sourceName,
        query: test.query,
        gold: test.snippets.map((s) => ({
          filePath: s.file_path,
          start: s.span[0],
          end: s.span[1],
        })),
        lex_pool: spans(pool),
        ctx_pool: spans(ctxPool),
        coords: "lf",
      }),
    );
  });
}
writeFileSync(
  path.join(outDir, "tests.jsonl"),
  `${testLines.join("\n")}\n`,
  "utf8",
);
console.log(`[${split}] tests: ${testLines.length} -> tests.jsonl`);
