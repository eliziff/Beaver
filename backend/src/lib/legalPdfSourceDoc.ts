import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { runLegalPdf, runLegalPdfContract } from "./legalPdfProcess";
import { createSourceDoc, type SourceDoc } from "./sourceDoc";

export { LEGAL_PDF_DOCUMENT_SCHEMA } from "./legalPdfProcess";

type EngineSourceDoc = {
  schema_version: "legalpdf.source-doc.v1";
  source_doc: Parameters<typeof createSourceDoc>[0];
};

export async function readLegalPdfSourceDoc(
  artifactRoot: string,
  options?: { id?: string; url?: string | null },
): Promise<SourceDoc> {
  const result = await runLegalPdfContract<EngineSourceDoc>(
    artifactRoot,
    "source_doc",
    { id: options?.id, url: options?.url },
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (
    result.schema_version !== "legalpdf.source-doc.v1" ||
    !result.source_doc ||
    result.source_doc.provider !== "local-pdf" ||
    typeof result.source_doc.text !== "string" ||
    !Array.isArray(result.source_doc.blocks)
  ) {
    throw new Error("Legal PDF engine returned an invalid SourceDoc");
  }
  return createSourceDoc(result.source_doc);
}

export async function countLegalPdfPages(bytes: Buffer) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-"));
  const source = path.join(temporary, "source.pdf");
  try {
    await writeFile(source, bytes);
    const { stdout } = await runLegalPdf(["page-count", source], {
      timeoutMs: 60_000,
    });
    const pages = (JSON.parse(stdout) as { pages?: unknown }).pages;
    if (!Number.isSafeInteger(pages) || Number(pages) < 0) {
      throw new Error("Legal PDF engine returned an invalid page count");
    }
    return Number(pages);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function parseLegalPdfSourceDoc(
  bytes: Buffer,
  signal?: AbortSignal,
) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-"));
  const source = path.join(temporary, "source.pdf");
  const output = path.join(temporary, "artifacts");
  try {
    await writeFile(source, bytes, { signal });
    await runLegalPdf(
      ["parse", source, "--output", output, "--no-cache", "--compact-pages"],
      { signal },
    );
    return await readLegalPdfSourceDoc(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
