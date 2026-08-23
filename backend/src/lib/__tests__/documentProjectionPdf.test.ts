import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryPdfNative = vi.hoisted(() => vi.fn());
vi.mock("../structureNative", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../structureNative")>()),
  queryPdfNative,
}));

let temporaryDirectory: string | null = null;
const native = {};
const sourceSha256 = "a".repeat(64);
const cacheKey = "cache-key";

function engineLookup(request: Record<string, unknown>) {
  const query = request;
  const found = query.locator === "1";
  return {
    schema_version: "legalpdf.structure-lookup.v1",
    requested: {
      locator_kind: query.locator_kind,
      locator: query.locator,
      end_locator: query.end_locator ?? null,
      context_blocks: query.context_blocks ?? 0,
      page: query.page ?? null,
      occurrence: query.occurrence ?? null,
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

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-lookup-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  process.env.MIKE_PDF_OCR_PROVIDER = "none";
  process.env.MIKE_PDF_LAYOUT_PROVIDER = "none";
  queryPdfNative.mockImplementation(async (_document, request) => engineLookup(request));
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.MIKE_PDF_OCR_PROVIDER;
  delete process.env.MIKE_PDF_LAYOUT_PROVIDER;
  vi.clearAllMocks();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("PDF evidence boundary", () => {
  it("binds cache-backed lookup results to stable, rehydratable evidence", async () => {
    const pdf = await import("../documentProjectionPdf");
    const options = {
      cacheKey,
      documentId: "document-1",
      versionId: "version-1",
      sourceSha256,
      parserVersion: "0.4.0",
    };
    const first = await pdf.lookupPdfStructure(
      native,
      { locatorKind: "page", locator: "1" },
      options,
    );
    const second = await pdf.lookupPdfStructure(
      native,
      { locatorKind: "page", locator: "1" },
      options,
    );

    expect(first).toMatchObject({
      status: "found",
      exact: true,
      units: [{ id: "page-1", text: "[page 1]\nExact page text." }],
      source: {
        document_id: "document-1",
        version_id: "version-1",
        source_sha256: sourceSha256,
        schema_version: "legalpdf.document-result.v1",
        cache_key: cacheKey,
      },
      link: { page_numbers: [1], artifact_ids: ["page-1"] },
    });
    if (first.status !== "found" || second.status !== "found") {
      throw new Error("fixture lookup failed");
    }
    expect(second.evidence.handle).toBe(first.evidence.handle);
    await expect(pdf.rehydratePdfEvidence(native, first.evidence.handle))
      .resolves.toMatchObject({ status: "found" });
    await expect(pdf.rehydratePdfLinkEvidence(native, first.evidence.handle))
      .resolves.toMatchObject({
        pageNumbers: [1],
        pages: [{ pageNumber: 1, blockText: "Exact page text." }],
      });
  });

  it("rejects unbounded requests before invoking the engine", async () => {
    const { lookupPdfStructure } = await import("../documentProjectionPdf");
    await expect(lookupPdfStructure(null, {
      locatorKind: "paragraph",
      locator: "2",
      contextBlocks: 3,
    })).resolves.toMatchObject({
      status: "invalid",
      error: "Invalid or unbounded PDF locator",
    });
    expect(queryPdfNative).not.toHaveBeenCalled();
  });

  it("fails closed when the native lookup is unavailable", async () => {
    const { lookupPdfStructure } = await import("../documentProjectionPdf");
    const options = {
      cacheKey,
      documentId: "document-1",
      versionId: "version-1",
      sourceSha256,
      parserVersion: "0.4.0",
    };
    queryPdfNative.mockRejectedValueOnce(new Error("native document unavailable"));
    await expect(lookupPdfStructure(
      native,
      { locatorKind: "page", locator: "1" },
      options,
    )).resolves.toMatchObject({ status: "unavailable", exact: false });
  });
});
