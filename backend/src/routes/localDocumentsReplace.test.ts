import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/localMode", () => ({ isAnonymousLocalMode: () => true }));
vi.mock("../lib/localPdfIngestion", () => ({
  queueLocalPdfParse: vi.fn(async () => ({
    status: "queued",
    flat_text_fallback_available: true,
  })),
  removeLocalPdfParseArtifacts: vi.fn(async () => undefined),
}));

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.AUTH_MODE;
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local document version replacement", () => {
  it("omits stale assistant provenance from the replace and versions APIs", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "mike-local-api-"),
    );
    process.env.AUTH_MODE = "anonymous";
    process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
    const store = await import("../lib/localDocumentStore");
    const document = await store.createLocalDocument({
      userId: "00000000-0000-0000-0000-000000000001",
      kind: "file",
      filename: "draft.xlsx",
      bytes: Buffer.from("assistant-created"),
      provenance: {
        schemaVersion: 1,
        actor: "assistant",
        action: "created",
      },
    });
    const { localDocumentsRouter } = await import("./localDocuments");
    const app = express();
    app.use(express.json());
    app.use("/single-documents", localDocumentsRouter);

    const replacement = await request(app)
      .put(
        `/single-documents/${document.id}/versions/${document.current_version_id}/file`,
      )
      .attach("file", Buffer.from("user-replacement"), "draft.xlsx");
    const versions = await request(app).get(
      `/single-documents/${document.id}/versions`,
    );

    expect(replacement.status).toBe(200);
    expect(replacement.body.provenance).toBeUndefined();
    expect(versions.status).toBe(200);
    expect(versions.body.versions[0].provenance).toBeUndefined();
  });
});
