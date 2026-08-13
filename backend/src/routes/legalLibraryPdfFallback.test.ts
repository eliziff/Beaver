import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());
const readProviderPdfAttachmentState = vi.hoisted(() => vi.fn());
const providerPdfRequestReference = vi.hoisted(() => vi.fn());

vi.mock("../lib/providerPdfLibraryBridge", () => ({
  providerPdfRequestReference,
  queueProviderPdfAttachment,
  readProviderPdfAttachmentState,
}));

let temporaryDirectory: string | null = null;
const originalAuthMode = process.env.AUTH_MODE;

afterEach(async () => {
  try {
    const store = await import("../lib/localDocumentStore");
    await store.closeLocalDocumentStore();
  } catch {}
  delete process.env.MIKE_LOCAL_DATA_DIR;
  process.env.AUTH_MODE = originalAuthMode;
  queueProviderPdfAttachment.mockReset();
  readProviderPdfAttachmentState.mockReset();
  providerPdfRequestReference.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("legal Library provider PDF fallback", () => {
  it("durably records the pointer and reschedules it when reopened", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-legal-pdf-pointer-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    process.env.AUTH_MODE = "anonymous";
    providerPdfRequestReference.mockReturnValue("provider-reference");
    queueProviderPdfAttachment.mockResolvedValue({
      provider: "a2aj",
      identity: "SCC:2099 SCC 7",
      reference_id: "provider-reference",
      download_status: "queued",
      parse_status: null,
    });
    readProviderPdfAttachmentState.mockResolvedValue({
      provider: "a2aj",
      identity: "SCC:2099 SCC 7",
      reference_id: "provider-reference",
      download_status: "downloaded",
      source_sha256: "a".repeat(64),
      parse_status: "queued",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 7",
              name_en: "Pointer v. Restart",
              source_url_en:
                "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99997/index.do",
              unofficial_text_en:
                "[1] First paragraph with enough legal text.\n[2] Second paragraph with enough legal text.",
            },
          ],
        }),
      }),
    );
    const { legalLibraryRouter } = await import("./legalLibrary");
    const app = express();
    app.use(express.json());
    app.use("/library/legal", legalLibraryRouter);

    const viewed = await request(app).get(
      "/library/legal/document?citation=2099%20SCC%207&doc_type=cases&language=en&dataset=SCC",
    );
    expect(viewed.status).toBe(200);
    expect(viewed.body.pdf_fallback).toBeUndefined();
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();
    queueProviderPdfAttachment.mockClear();

    const saved = await request(app).post("/library/legal").send({
      citation: "2099 SCC 7",
      doc_type: "cases",
      language: "en",
      dataset: "SCC",
    });

    expect(saved.status).toBe(201);
    expect(saved.body.pdf_fallback).toMatchObject({
      provider: "a2aj",
      identity: "SCC:2099 SCC 7",
      reference_id: "provider-reference",
      status_url: `/library/legal/${saved.body.id}/pdf-status`,
    });
    const persisted = await (await import("../lib/localDocumentStore"))
      .getLocalLegalSource("00000000-0000-0000-0000-000000000001", saved.body.id);
    expect(persisted?.pdfFallback).toEqual({
      provider: "a2aj",
      identity: "SCC:2099 SCC 7",
      url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/99997/1/document.do",
      canonicalUrl:
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99997/index.do",
      title: "Pointer v. Restart",
      requestReference: "provider-reference",
    });

    const status = await request(app).get(
      `/library/legal/${saved.body.id}/pdf-status`,
    );
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      reference_id: "provider-reference",
      download_status: "downloaded",
      parse_status: "queued",
    });

    queueProviderPdfAttachment.mockClear();
    const reopened = await request(app).get(
      `/library/legal/${saved.body.id}/document`,
    );
    expect(reopened.status).toBe(200);
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();
    expect(queueProviderPdfAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "a2aj",
        identity: "SCC:2099 SCC 7",
        structureSource: "flat_text",
      }),
    );

    queueProviderPdfAttachment.mockClear();
    let finishResume: (() => void) | null = null;
    queueProviderPdfAttachment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = () => resolve(null);
        }),
    );
    const unchanged = await request(app)
      .get(`/library/legal/${saved.body.id}/document`)
      .set("If-None-Match", reopened.headers.etag)
      .timeout({ response: 500, deadline: 1_000 });
    expect(unchanged.status).toBe(304);
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();
    finishResume!();
  });

  it("saves valid provider text when the optional PDF cannot be validated", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-legal-pdf-optional-"),
    );
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    process.env.AUTH_MODE = "anonymous";
    providerPdfRequestReference.mockImplementation(() => {
      throw new Error("Unsupported optional PDF URL");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 8",
              name_en: "Text v. Optional PDF",
              source_url_en:
                "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99998/index.do",
              unofficial_text_en:
                "[1] Provider text remains authoritative when an attachment fails.",
            },
          ],
        }),
      }),
    );
    const { legalLibraryRouter } = await import("./legalLibrary");
    const app = express();
    app.use(express.json());
    app.use("/library/legal", legalLibraryRouter);

    const saved = await request(app).post("/library/legal").send({
      citation: "2099 SCC 8",
      doc_type: "cases",
      language: "en",
      dataset: "SCC",
    });

    expect(saved.status).toBe(201);
    expect(saved.body.pdf_fallback).toBeUndefined();
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
  });
});
