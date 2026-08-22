import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const ROOT = path.resolve(import.meta.dirname, "../..");

const AGREEMENT_ROOTS = [
  path.join(ROOT, "benchmarks/legalbench_rag/data/mini"),
  path.join(ROOT, "benchmarks/legalbench_rag/data/holdout"),
];
const PDF_CACHE = path.join(
  ROOT,
  ".tmp/digital-native-structure-audit/cache/parse-v1/extractions",
);

async function filesBelow(root: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(target, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(target);
  }
  return found.sort((left, right) => left.localeCompare(right, "en"));
}

export async function instrumentCorpusFiles() {
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
  return { agreements, pdfs };
}

export async function readAgreement(file: string) {
  return {
    id: path.relative(ROOT, file).replaceAll("\\", "/"),
    text: await fs.readFile(file, "utf8"),
  };
}

type PdfExtraction = {
  source_sha256: string;
  extraction: { pages: Array<{ lines: Array<{ text: string }> }> };
};

export async function readPdf(file: string) {
  const cached = JSON.parse(
    gunzipSync(await fs.readFile(file)).toString("utf8"),
  ) as PdfExtraction;
  let lines = 0;
  const pageTexts = cached.extraction.pages.map((page) => {
    if (!Array.isArray(page.lines) || page.lines.some((line) => typeof line.text !== "string")) {
      throw new Error(`invalid PDF line surface: ${file}`);
    }
    lines += page.lines.length;
    return page.lines.map((line) => line.text).join("\n");
  });
  return {
    id: `pdf:${cached.source_sha256}`,
    text: pageTexts.join("\n"),
    pages: cached.extraction.pages.length,
    lines,
  };
}
