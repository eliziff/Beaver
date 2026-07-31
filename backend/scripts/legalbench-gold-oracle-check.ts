/**
 * Gold-coordinate oracle for LegalBench-RAG-mini (Stage 18 instrument fix).
 *
 * Upstream ships the `answer` string beside every snippet's `span`, so the
 * coordinate space of the gold is DECIDABLE, not assumed: the corpus text a
 * scorer slices must satisfy `text.slice(start, end) === answer` for every
 * snippet of every test. This script asserts exactly that under the corpus
 * loader's normalization (`normalizeCorpusText`: CRLF -> LF, BOM kept) and
 * exits nonzero on any mismatch.
 *
 * It exists because the program scored 334 maud snippets against raw CRLF
 * bytes for five stages (median drift 1,145 chars). Run it before trusting
 * any LegalBench-RAG number:
 *   npx tsx scripts/legalbench-gold-oracle-check.ts [--raw]
 * `--raw` scores the un-normalized bytes instead — the historical instrument,
 * kept so the defect stays reproducible on demand.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LEGALBENCH_RAG_DATA_DIR,
  SOURCE_BENCHMARKS,
  normalizeCorpusText,
  sanitizeCorpusPath,
  upstreamBenchmarkSchema,
} from "../src/lib/legalbenchRag";

const RAW = process.argv.includes("--raw");
const SHOW = Number(
  process.argv.includes("--show")
    ? process.argv[process.argv.indexOf("--show") + 1]
    : 3,
);

const corpusCache = new Map<string, string>();
function corpusText(filePath: string): string {
  const cached = corpusCache.get(filePath);
  if (cached !== undefined) return cached;
  const bytes = readFileSync(
    path.join(
      LEGALBENCH_RAG_DATA_DIR,
      "mini",
      "corpus",
      sanitizeCorpusPath(filePath),
    ),
  ).toString("utf8");
  const text = RAW ? bytes : normalizeCorpusText(bytes);
  corpusCache.set(filePath, text);
  return text;
}

let failures = 0;
let total = 0;
for (const source of SOURCE_BENCHMARKS) {
  const parsed = upstreamBenchmarkSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(LEGALBENCH_RAG_DATA_DIR, `mini/benchmarks/${source}.json`),
        "utf8",
      ),
    ),
  );
  let pass = 0;
  let count = 0;
  let missingAnswer = 0;
  const examples: string[] = [];
  parsed.tests.forEach((test, index) => {
    for (const snippet of test.snippets) {
      const answer = (snippet as { answer?: unknown }).answer;
      if (typeof answer !== "string") {
        missingAnswer += 1;
        continue;
      }
      count += 1;
      const [start, end] = snippet.span;
      const sliced = corpusText(snippet.file_path).slice(start, end);
      if (sliced === answer) {
        pass += 1;
        continue;
      }
      if (examples.length < SHOW)
        examples.push(
          `    ${source}:${String(index).padStart(3, "0")} ${snippet.file_path} [${start},${end}]\n` +
            `      gold  : ${JSON.stringify(answer.slice(0, 60))}\n` +
            `      sliced: ${JSON.stringify(sliced.slice(0, 60))}`,
        );
    }
  });
  total += count;
  failures += count - pass;
  console.log(
    `${source.padEnd(12)} ${pass}/${count} snippets slice to their gold answer` +
      `${missingAnswer ? ` (${missingAnswer} snippets carry no answer string — skipped)` : ""}` +
      `${pass === count ? "" : "  <-- FAIL"}`,
  );
  for (const example of examples) console.log(example);
}

console.log(
  `\n${total - failures}/${total} overall (${RAW ? "RAW bytes" : "normalized corpus load"})`,
);
if (failures) {
  console.error(
    `oracle FAILED: ${failures} snippet(s) do not slice to their gold answer`,
  );
  process.exit(1);
}
console.log("oracle OK");
