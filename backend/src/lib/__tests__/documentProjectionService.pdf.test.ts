import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("../legalPdfProcess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../legalPdfProcess")>()),
  runLegalPdfDocument: mocks.run,
  configuredLegalPdfProfile: mocks.profile,
}));

let temporaryDirectory: string | null = null;

const digest = (bytes: Buffer) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(name = "source.pdf") {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "beaver-pdf-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
  const sourcePath = path.join(temporaryDirectory, name);
  const bytes = Buffer.from("%PDF-1.4\ncache-only fixture");
  await writeFile(sourcePath, bytes);
  return { sourcePath, bytes, sourceSha256: digest(bytes) };
}

function profile(options?: { env?: NodeJS.ProcessEnv }) {
  const env = options?.env ?? process.env;
  const ocr = env.MIKE_PDF_OCR_PROVIDER;
  return {
    ...(ocr === "tesseract" || ocr === "kraken-lite"
      ? { ocr: { provider: ocr, settings: { dpi: 180 } } }
      : {}),
    ...(env.MIKE_PDF_LAYOUT_PROVIDER === "ppdoc"
      ? { layout: { provider: "ppdoc", settings: { backend: "cpu" } } }
      : {}),
  };
}

function envelope(
  operation: "inspect" | "prepare",
  sourceSha256: string,
  result: Record<string, unknown>,
) {
  return {
    schema_version: "legalpdf.document-result.v1",
    operation,
    source: {
      sha256: sourceSha256,
      parser_version: "0.4.0",
      cache_key: operation === "inspect" ? null : `cache-${sourceSha256.slice(0, 12)}`,
      cache_hit: false,
      page_count: 7,
    },
    result,
  };
}

beforeEach(() => {
  mocks.profile.mockImplementation(profile);
  mocks.run.mockImplementation(async (request: { operation: "inspect" | "prepare"; source_pdf: string }) => {
    const sourceSha256 = digest(await readFile(request.source_pdf));
    return request.operation === "inspect"
      ? envelope("inspect", sourceSha256, {
          page_count: 7,
          pages_needing_ocr: [5],
        })
      : envelope("prepare", sourceSha256, {
          status: "ready",
          page_count: 7,
          pages_needing_ocr: [5],
          ocr_routed_pages: [],
          counts: { paragraphs: 10, footnotes: 2 },
        });
  });
});

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  delete process.env.MIKE_PDF_LAYOUT_PROVIDER;
  delete process.env.MIKE_PDF_OCR_PROVIDER;
  vi.clearAllMocks();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("PDF preparation", () => {
  it("persists only compact cache-backed preparation state", async () => {
    const built = await fixture();
    const { documentProjectionService } = await import("../documentProjectionService");
    const reference = {
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: built.sourcePath,
      sourceSha256: built.sourceSha256,
    };

    const state = await documentProjectionService.parsePdf(reference);

    expect(state).toMatchObject({
      schema_version: "beaver.pdf-preparation.v1",
      status: "ready",
      source_sha256: built.sourceSha256,
      parser_version: "0.4.0",
      cache_key: `cache-${built.sourceSha256.slice(0, 12)}`,
      page_count: 7,
      counts: { paragraphs: 10, footnotes: 2 },
      parser_config: { ocr_provider: null, layout_provider: null },
    });
    expect(state).not.toHaveProperty("artifact_manifest");
    expect(state).not.toHaveProperty("repair_contract");
    await expect(documentProjectionService.pdfState(reference))
      .resolves.toMatchObject({ cache_key: state.cache_key, status: "ready" });
    expect(mocks.run.mock.calls.map(([request]) => request.operation))
      .toEqual(["inspect", "prepare"]);
  });

  it("routes a bounded retry through native OCR and local layout", async () => {
    const built = await fixture();
    process.env.MIKE_PDF_LAYOUT_PROVIDER = "ppdoc";
    const progress = vi.fn();
    const { documentProjectionService } = await import("../documentProjectionService");

    const state = await documentProjectionService.parsePdfPages({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: built.sourcePath,
      sourceSha256: built.sourceSha256,
      pages: [5, 5],
      ocrProvider: "kraken-lite",
      layout: true,
      progress,
    });

    expect(state.parser_config).toMatchObject({
      ocr_provider: "kraken-lite",
      layout_provider: "ppdoc",
      selected_pages: [5],
    });
    expect(mocks.run.mock.calls[1][0]).toMatchObject({
      operation: "prepare",
      pages: [5],
      ocr: { provider: "kraken-lite" },
      layout: { provider: "ppdoc" },
    });
    expect(progress.mock.calls.map(([value]) => value.phase))
      .toEqual(["inspecting", "ocr"]);
  });

  it("fails closed before parsing when version bytes drift", async () => {
    const built = await fixture();
    const { documentProjectionService } = await import("../documentProjectionService");
    await expect(documentProjectionService.parsePdf({
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: built.sourcePath,
      sourceSha256: "f".repeat(64),
    })).rejects.toThrow("source bytes no longer match their version");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("stores a safe failure state without exposing parser paths", async () => {
    const built = await fixture();
    mocks.run.mockImplementationOnce(async () =>
      envelope("inspect", built.sourceSha256, { page_count: 7, pages_needing_ocr: [] }))
      .mockRejectedValueOnce(new Error("failed at C:\\private\\source.pdf"));
    const { documentProjectionService } = await import("../documentProjectionService");
    const reference = {
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: built.sourcePath,
      sourceSha256: built.sourceSha256,
    };

    await expect(documentProjectionService.parsePdf(reference))
      .rejects.toThrow("PDF structural parser failed");
    const state = await documentProjectionService.pdfState(reference);
    expect(state).toMatchObject({ status: "failed", error: "PDF structural parser failed" });
    expect(JSON.stringify(state)).not.toContain("C:\\private");
  });

  it("removes transient state when preparation is aborted", async () => {
    const built = await fixture();
    const controller = new AbortController();
    mocks.run.mockImplementationOnce(async () =>
      envelope("inspect", built.sourceSha256, { page_count: 7, pages_needing_ocr: [] }))
      .mockImplementationOnce(async () => new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
    const { documentProjectionService } = await import("../documentProjectionService");
    const reference = {
      documentId: "document-1",
      versionId: "version-1",
      sourcePath: built.sourcePath,
      sourceSha256: built.sourceSha256,
    };
    const pending = documentProjectionService.parsePdf({ ...reference, signal: controller.signal });
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(documentProjectionService.pdfState(reference)).resolves.toBeNull();
  });
});
