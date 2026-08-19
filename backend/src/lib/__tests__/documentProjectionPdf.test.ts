import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runLegalPdfContract = vi.hoisted(() => vi.fn());

vi.mock("../legalPdfProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../legalPdfProcess")>()),
  runLegalPdfContract,
}));

let temporaryDirectory: string | null = null;

function engineLookup(request: Record<string, unknown>) {
  const found = request.locator === "1";
  return {
    schema_version: "legalpdf.structure-lookup.v1",
    requested: {
      locator_kind: request.locator_kind,
      locator: request.locator,
      end_locator: request.end_locator ?? null,
      context_blocks: request.context_blocks ?? 0,
      page: request.page ?? null,
      occurrence: request.occurrence ?? null,
    },
    units: found ? [{
      id: "page-1",
      kind: "page",
      locator: "[page 1]",
      text: "[page 1]\nExact page text.",
      page_numbers: [1],
      confidence: 0.99,
      confidence_basis: "page_text_quality",
      provenance: "native",
    }] : [],
    before: [],
    after: [],
    matches: found ? ["page-1"] : [],
    pages: found ? [{ page_number: 1, text: "Exact page text." }] : [],
    status: found ? "found" : "not_found",
    exact: found,
  };
}

async function fixture() {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-lookup-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  const source = path.join(temporaryDirectory, "source.pdf");
  const bytes = Buffer.from("%PDF-1.4 exact lookup fixture");
  await writeFile(source, bytes);
  const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const projection = await import("../documentProjection");
  const identity = projection.pdfProjectionIdentity({
    documentId: "document-1",
    versionId: "version-1",
    sourceSha256,
    compiler: { name: "legalpdf", version: "0.3.0" },
    options: {
      parser_config: {
        mode: "local", ocr_provider: null, layout_provider: null,
        layout_model: null, model: null, prompt_version: null,
      },
    },
  });
  const cacheKey = projection.pdfProjectionKey(identity);
  const output = projection.pdfProjectionDirectory(identity);
  const manifestPath = path.join(output, "document.json");
  await mkdir(output, { recursive: true });
  const names = {
    pages: "pages.jsonl", paragraphs: "paragraphs.jsonl",
    sections: "sections.jsonl", footnotes: "footnotes.jsonl",
    tables: "tables.jsonl", images: "images.jsonl",
    diagnostics: "diagnostics.jsonl", repairs: "repairs.jsonl",
  };
  await Promise.all(Object.values(names).map((name) =>
    writeFile(path.join(output, name), "", "utf8")));
  const manifest = {
    schema_version: "legalpdf.document.v2",
    artifact_profile: "compact-source",
    parser_version: "0.3.0",
    document_id: "parsed-document",
    source_sha256: sourceSha256,
    page_count: 0,
    status: "ready",
    counts: Object.fromEntries(Object.keys(names).map((name) => [name, 0])),
    artifacts: names,
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await projection.publishPdfProjection(identity);
  const state = {
    schema_version: "mike.pdf_parse.v1",
    job_id: "job-1",
    document_id: identity.documentId,
    version_id: identity.versionId,
    status: "ready",
    source_sha256: sourceSha256,
    parser_version: "0.3.0",
    parser_config: identity.options.parser_config,
    cache_key: cacheKey,
    artifact_manifest: projection.relativeLocalDataPath(manifestPath),
    attempts: 1,
    queued_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
  };
  const statePath = source + ".legalpdf-state.json";
  await writeFile(statePath, JSON.stringify(state), "utf8");
  return { source, sourceSha256, statePath, manifestPath };
}

beforeEach(() => {
  runLegalPdfContract.mockImplementation(
    async (_artifact: string, operation: string, request: Record<string, unknown>) => {
      if (operation === "structure_lookup") return engineLookup(request);
      throw new Error("unexpected operation");
    },
  );
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.clearAllMocks();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("PDF projection evidence boundary", () => {
  it("binds engine lookup results to stable, rehydratable evidence", async () => {
    const built = await fixture();
    const pdf = await import("../documentProjectionPdf");
    const first = await pdf.lookupPdfStructure(built.source, {
      locatorKind: "page", locator: "1",
    });
    const second = await pdf.lookupPdfStructure(built.source, {
      locatorKind: "page", locator: "1",
    });
    expect(first).toMatchObject({
      status: "found",
      exact: true,
      units: [{ id: "page-1", text: "[page 1]\nExact page text." }],
      source: {
        document_id: "document-1",
        version_id: "version-1",
        source_sha256: built.sourceSha256,
        schema_version: "legalpdf.document.v2",
      },
      link: { page_numbers: [1], artifact_ids: ["page-1"] },
    });
    if (first.status !== "found" || second.status !== "found") {
      throw new Error("fixture lookup failed");
    }
    expect(second.evidence.handle).toBe(first.evidence.handle);
    await expect(pdf.rehydratePdfEvidence(
      built.source, first.evidence.handle,
    )).resolves.toMatchObject({ status: "found" });
    await expect(pdf.rehydratePdfLinkEvidence(
      built.source, first.evidence.handle,
    )).resolves.toMatchObject({
      pageNumbers: [1],
      pages: [{ pageNumber: 1, blockText: "Exact page text." }],
    });
  });

  it("rejects unbounded requests before invoking the engine", async () => {
    const built = await fixture();
    const { lookupPdfStructure } = await import("../documentProjectionPdf");
    await expect(lookupPdfStructure(built.source, {
      locatorKind: "paragraph", locator: "2", contextBlocks: 3,
    })).resolves.toMatchObject({
      status: "invalid",
      error: "Invalid or unbounded PDF locator",
    });
    expect(runLegalPdfContract).not.toHaveBeenCalled();
  });

  it("fails closed when state or immutable artifacts drift", async () => {
    const built = await fixture();
    const { lookupPdfStructure } = await import("../documentProjectionPdf");
    const state = JSON.parse(await readFile(built.statePath, "utf8"));
    await writeFile(built.statePath, JSON.stringify({
      ...state, artifact_manifest: "projections/other/document.json",
    }));
    await expect(lookupPdfStructure(built.source, {
      locatorKind: "page", locator: "1",
    })).resolves.toMatchObject({
      status: "unavailable",
      error: "PDF lookup projection does not match the selected source",
    });

    await writeFile(built.statePath, JSON.stringify(state));
    await writeFile(built.manifestPath, "{}");
    await expect(lookupPdfStructure(built.source, {
      locatorKind: "page", locator: "1",
    })).resolves.toMatchObject({ status: "unavailable", exact: false });
  });
});
