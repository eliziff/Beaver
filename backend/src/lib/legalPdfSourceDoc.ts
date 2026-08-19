import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  runLegalPdfDocument,
  type LegalPdfLayoutConfig,
  type LegalPdfOcrConfig,
} from "./legalPdfProcess";
import { createSourceDoc, type SourceDoc } from "./sourceDoc";

type EngineSourceDoc = {
  schema_version: "legalpdf.source-doc.v1";
  source_doc: Parameters<typeof createSourceDoc>[0];
};

type SourceOptions = {
  cacheDir?: string;
  id?: string;
  url?: string | null;
  ocr?: LegalPdfOcrConfig;
  layout?: LegalPdfLayoutConfig;
  expectedCacheKey?: string;
  expectedSourceSha256?: string;
  signal?: AbortSignal;
};

function validSourceDoc(value: unknown): value is EngineSourceDoc {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<EngineSourceDoc>;
  const doc = result.source_doc;
  return result.schema_version === "legalpdf.source-doc.v1" &&
    Boolean(doc) &&
    doc!.provider === "local-pdf" &&
    typeof doc!.id === "string" &&
    (doc!.url === undefined || doc!.url === null || typeof doc!.url === "string") &&
    typeof doc!.text === "string" &&
    Array.isArray(doc!.blocks) &&
    doc!.blocks.every((block) =>
      Boolean(block) &&
      typeof block.label === "string" &&
      ["paragraph", "page", "section", "footnote"].includes(block.kind) &&
      Number.isSafeInteger(block.start) && block.start >= 0 &&
      Number.isSafeInteger(block.end) && block.end >= block.start && block.end <= doc!.text.length &&
      ["native", "heuristic"].includes(block.origin),
    );
}

export async function readLegalPdfSourceDoc(
  sourcePdf: string,
  options: SourceOptions = {},
): Promise<SourceDoc> {
  const response = await runLegalPdfDocument<EngineSourceDoc>(
    {
      operation: "source_doc",
      source_pdf: sourcePdf,
      ...(options.cacheDir ? { cache_dir: options.cacheDir } : {}),
      ...(options.ocr ? { ocr: options.ocr } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
      ...(options.id !== undefined ? { id: options.id } : {}),
      ...(options.url !== undefined ? { url: options.url } : {}),
    },
    { signal: options.signal, maxBuffer: 64 * 1024 * 1024 },
  );
  if (!validSourceDoc(response.result)) {
    throw new Error("Legal PDF engine returned an invalid SourceDoc");
  }
  if (options.expectedCacheKey && response.source.cache_key !== options.expectedCacheKey)
    throw new Error("Legal PDF cache identity changed");
  if (options.expectedSourceSha256 && response.source.sha256 !== options.expectedSourceSha256)
    throw new Error("Legal PDF source identity changed");
  return createSourceDoc(response.result.source_doc);
}

async function withTemporaryPdf<T>(
  bytes: Buffer,
  signal: AbortSignal | undefined,
  read: (source: string) => Promise<T>,
) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-"));
  try {
    const source = path.join(temporary, "source.pdf");
    await writeFile(source, bytes, { signal });
    return await read(source);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function countLegalPdfPages(bytes: Buffer, signal?: AbortSignal) {
  return withTemporaryPdf(bytes, signal, async (source) => {
    const response = await runLegalPdfDocument<{ page_count?: unknown }>(
      { operation: "inspect", source_pdf: source },
      { signal, timeoutMs: 60_000 },
    );
    const pages = response.result.page_count;
    if (!Number.isSafeInteger(pages) || Number(pages) < 0) {
      throw new Error("Legal PDF engine returned an invalid page count");
    }
    return Number(pages);
  });
}

export async function parseLegalPdfSourceDoc(
  bytes: Buffer,
  signal?: AbortSignal,
) {
  return withTemporaryPdf(bytes, signal, (source) =>
    readLegalPdfSourceDoc(source, { signal }),
  );
}
