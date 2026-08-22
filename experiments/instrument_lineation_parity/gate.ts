import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { instrumentLineationHypothesesNative } from "../../backend/src/lib/structureNative";

const ROOT = path.resolve(import.meta.dirname, "../..");
const AGREEMENT_ROOTS = [
  path.join(ROOT, "benchmarks/legalbench_rag/data/mini"),
  path.join(ROOT, "benchmarks/legalbench_rag/data/holdout"),
];
const PDF_CACHE = path.join(
  ROOT,
  ".tmp/digital-native-structure-audit/cache/parse-v1/extractions",
);
const REPORT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, ".tmp/instrument-lineation-parity.json");

const CONTAINER_WORDS = "ARTICLE|Article|PART|Part|DIVISION|Division";
const SCHEDULE_WORDS =
  "SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix";
const SECTION_WORDS = "Section|SECTION";
const DECIMAL_LABEL = String.raw`\d{1,3}\.\d{1,3}(?:\.\d{1,3})*`;
const HEAD_WORD = `(?:${CONTAINER_WORDS}|${SECTION_WORDS}|${SCHEDULE_WORDS})`;
const SENTENCE_JOIN_RE = new RegExp(
  String.raw`(?<=[.;:][)\]"'”’»]?)[ \t]` +
    String.raw`(?=${HEAD_WORD}\s+[IVXLCDM\d]|${DECIMAL_LABEL}\s+\S|\(\w{1,3}\)\s)`,
  "gu",
);

function typescriptOracle(text: string): string[] {
  const splitSpaceRuns = (value: string) => value.replace(
    /(?<=\S)[ \t]([ \t]+)(?=\S)/gu,
    (_match, rest: string) => `\n${rest}`,
  );
  const joined = text.replace(SENTENCE_JOIN_RE, "\n");
  const hypotheses = [text, splitSpaceRuns(text), joined, splitSpaceRuns(joined)];
  return hypotheses.filter(
    (candidate, index) => hypotheses.indexOf(candidate) === index,
  );
}

async function filesBelow(root: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(target, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(target);
  }
  return found.sort((left, right) => left.localeCompare(right, "en"));
}

type PdfExtraction = {
  source_sha256: string;
  extraction: {
    pages: Array<{ lines: Array<{ text: string }> }>;
  };
};

function addFramed(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value)));
  hash.update(":");
  hash.update(value);
  hash.update("\n");
}

async function main(): Promise<void> {
  const agreements = (await Promise.all(
    AGREEMENT_ROOTS.map((root) => filesBelow(root, ".txt")),
  )).flat();
  const pdfs = await filesBelow(PDF_CACHE, ".json.gz");
  if (agreements.length !== 124) {
    throw new Error(`agreement denominator drift: expected 124, found ${agreements.length}`);
  }
  if (pdfs.length !== 748) {
    throw new Error(`PDF denominator drift: expected 748, found ${pdfs.length}`);
  }

  const started = performance.now();
  const oracleHash = createHash("sha256");
  const candidateHash = createHash("sha256");
  const inputHash = createHash("sha256");
  const mismatches: Array<{ id: string; oracle: string; candidate: string }> = [];
  let checked = 0;
  let bytes = 0;
  let pages = 0;
  let lines = 0;
  let hypotheses = 0;

  const report = async (complete: boolean) => {
    const value = {
      schemaVersion: "beaver.instrument-lineation-parity.v1",
      complete,
      denominators: { agreements: agreements.length, pdfs: pdfs.length, pages, lines },
      checked,
      inputBytes: bytes,
      hypotheses,
      mismatches: mismatches.length,
      mismatchSamples: mismatches.slice(0, 20),
      inputSha256: inputHash.copy().digest("hex"),
      oracleSha256: oracleHash.copy().digest("hex"),
      candidateSha256: candidateHash.copy().digest("hex"),
      elapsedSeconds: (performance.now() - started) / 1_000,
    };
    await fs.mkdir(path.dirname(REPORT), { recursive: true });
    await fs.writeFile(REPORT, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  };

  const check = async (id: string, text: string) => {
    const oracle = typescriptOracle(text);
    const candidate = instrumentLineationHypothesesNative(text);
    const oracleJson = JSON.stringify(oracle);
    const candidateJson = JSON.stringify(candidate);
    addFramed(inputHash, id);
    addFramed(inputHash, text);
    addFramed(oracleHash, oracleJson);
    addFramed(candidateHash, candidateJson);
    bytes += Buffer.byteLength(text);
    hypotheses += oracle.length;
    checked += 1;
    if (oracleJson !== candidateJson) {
      mismatches.push({
        id,
        oracle: createHash("sha256").update(oracleJson).digest("hex"),
        candidate: createHash("sha256").update(candidateJson).digest("hex"),
      });
    }
    if (checked % 10 === 0) {
      const partial = await report(false);
      process.stderr.write(
        `[${checked}/${agreements.length + pdfs.length}] mismatches=${mismatches.length} ` +
        `bytes=${bytes} elapsed=${partial.elapsedSeconds.toFixed(1)}s\n`,
      );
    }
  };

  for (const file of agreements) {
    await check(path.relative(ROOT, file).replaceAll("\\", "/"), await fs.readFile(file, "utf8"));
  }
  for (const file of pdfs) {
    const cached = JSON.parse(
      gunzipSync(await fs.readFile(file)).toString("utf8"),
    ) as PdfExtraction;
    const pageTexts = cached.extraction.pages.map((page) => {
      if (!Array.isArray(page.lines) || page.lines.some((line) => typeof line.text !== "string")) {
        throw new Error(`invalid PDF line surface: ${file}`);
      }
      lines += page.lines.length;
      return page.lines.map((line) => line.text).join("\n");
    });
    pages += cached.extraction.pages.length;
    await check(`pdf:${cached.source_sha256}`, pageTexts.join("\n"));
  }

  if (pages !== 24_707 || lines !== 1_221_262) {
    throw new Error(`PDF surface drift: pages=${pages}, lines=${lines}`);
  }
  const final = await report(true);
  process.stderr.write(
    `[${checked}/${agreements.length + pdfs.length}] mismatches=${mismatches.length} ` +
    `bytes=${bytes} elapsed=${final.elapsedSeconds.toFixed(1)}s\n`,
  );
  if (mismatches.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
