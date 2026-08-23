import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const ROOT = path.resolve(import.meta.dirname, "../..");

const AGREEMENT_ROOTS = [
  path.join(ROOT, "benchmarks/legalbench_rag/data/mini"),
  path.join(ROOT, "benchmarks/legalbench_rag/data/holdout"),
];
const PDF_ROOT = path.join(ROOT, "experiments/legal_pdf_corpus");
const PDF_BASELINE = path.join(
  ROOT, "legal-pdf-parser/experiments/structure-engine-parity/all-cache-baseline.json",
);
const STRUCTURE_BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const TEXT_CACHE = path.join(import.meta.dirname, "cache/text-v1");

export type PdfCorpusFile = {
  file: string;
  id: string;
  inputSha256: string;
  pages: number;
  lines: number;
};

type PdfAddon = {
  derivePdfDocument(request: unknown): Promise<object>;
};

async function filesBelow(root: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(target, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(target);
  }
  return found.sort((left, right) => left.localeCompare(right, "en"));
}

export async function instrumentCorpusFiles(includePdfs = true) {
  const agreements = (await Promise.all(
    AGREEMENT_ROOTS.map((root) => filesBelow(root, ".txt")),
  )).flat();
  const pdfs: PdfCorpusFile[] = [];
  if (includePdfs) {
    const frozen = JSON.parse(await fs.readFile(PDF_BASELINE, "utf8")) as {
      documents: Array<{ relative_path: string; source_sha256: string;
        pages: number; input_lines: number }>;
    };
    const structure = JSON.parse(await fs.readFile(STRUCTURE_BASELINE, "utf8")) as {
      entries: Array<{ id: string; inputSha256: string }>;
    };
    const inputs = new Map(structure.entries.map((entry) => [entry.id, entry.inputSha256]));
    const documents = new Map(frozen.documents.map((document) =>
      [`pdf:${document.source_sha256}`, document]));
    for (const { id, inputSha256 } of structure.entries.filter((entry) => entry.id.startsWith("pdf:"))) {
      const document = documents.get(id);
      if (!document) throw new Error(`${id}: missing frozen PDF source`);
      if (inputs.get(id) !== inputSha256) throw new Error(`${id}: inconsistent frozen input`);
      pdfs.push({ file: path.join(PDF_ROOT, document.relative_path), id, inputSha256,
        pages: document.pages, lines: document.input_lines });
    }
  }
  if (agreements.length !== 124) {
    throw new Error(`agreement denominator drift: expected 124, found ${agreements.length}`);
  }
  if (includePdfs && pdfs.length !== 748) {
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

type PdfDocument = {
  source_sha256: string;
  pages: Array<{ lines: Array<{ text: string }> }>;
};

export async function readPdf(file: PdfCorpusFile, addon: PdfAddon) {
  const textFile = path.join(TEXT_CACHE, `${file.id.slice(4)}.txt.gz`);
  try {
    const bytes = gunzipSync(await fs.readFile(textFile));
    const split = bytes.indexOf(10);
    if (split < 0) throw new Error(`${file.id}: invalid text cache`);
    const header = JSON.parse(bytes.subarray(0, split).toString("utf8")) as Omit<PdfCorpusFile, "file">;
    const text = bytes.subarray(split + 1).toString("utf8");
    if (header.id !== file.id || header.inputSha256 !== file.inputSha256 ||
        header.pages !== file.pages || header.lines !== file.lines ||
        createHash("sha256").update(text).digest("hex") !== file.inputSha256) {
      throw new Error(`${file.id}: stale text cache`);
    }
    return { id: file.id, text, pages: file.pages, lines: file.lines };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const scratch = await fs.mkdtemp(path.join(tmpdir(), "beaver-instrument-"));
  try {
    await addon.derivePdfDocument({ kind: "pdf", id: file.id, source_pdf: file.file,
      cache_dir: scratch });
    const documentRoot = path.join(scratch, "parse-v1/documents");
    const documents = (await fs.readdir(documentRoot)).filter((name) => name.endsWith(".json.gz"));
    if (documents.length !== 1) throw new Error(`${file.id}: expected one parser document`);
    const cached = JSON.parse(gunzipSync(await fs.readFile(
      path.join(documentRoot, documents[0]),
    )).toString("utf8")) as PdfDocument;
    let lines = 0;
    const pageTexts = cached.pages.map((page) => {
      if (!Array.isArray(page.lines) || page.lines.some((line) => typeof line.text !== "string")) {
        throw new Error(`${file.id}: invalid PDF line surface`);
      }
      lines += page.lines.length;
      return page.lines.map((line) => line.text).join("\n");
    });
    const text = pageTexts.join("\n");
    const inputSha256 = createHash("sha256").update(text).digest("hex");
    if (cached.source_sha256 !== file.id.slice(4) || cached.pages.length !== file.pages ||
        lines !== file.lines || inputSha256 !== file.inputSha256) {
      throw new Error(`${file.id}: production PDF extraction differs from the frozen input`);
    }
    await fs.mkdir(TEXT_CACHE, { recursive: true });
    const temporary = `${textFile}.${process.pid}.tmp`;
    const header = JSON.stringify({ id: file.id, inputSha256, pages: file.pages, lines });
    await fs.writeFile(temporary, gzipSync(`${header}\n${text}`));
    await fs.rename(temporary, textFile);
    return { id: file.id, text, pages: file.pages, lines };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
