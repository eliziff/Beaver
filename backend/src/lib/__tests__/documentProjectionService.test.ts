import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

let localData: string | null = null;

async function service() {
  localData = await mkdtemp(path.join(os.tmpdir(), "document-projection-"));
  process.env.MIKE_LOCAL_DATA_DIR = localData;
  vi.resetModules();
  return (await import("../documentProjectionService"))
    .documentProjectionService;
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (localData) await rm(localData, { recursive: true, force: true });
  localData = null;
});

describe("DocumentProjectionService", () => {
  it("rejects a compressed presentation with oversized slide XML", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "x".repeat(8 * 1024 * 1024 + 1));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect((await service()).read({
      documentId: "document-a", versionId: "version-1", fileType: "pptx", bytes,
    })).rejects.toThrow("oversized slide XML");
  });

  it("validates identity, source bytes, and cancellation", async () => {
    const projections = await service();
    const input = {
      documentId: "document-a",
      versionId: "version-1",
      fileType: "txt",
      bytes: Buffer.from("source"),
    } as const;

    await expect(projections.read({ ...input, documentId: " bad" }))
      .rejects.toThrow("valid document and version IDs");
    await expect(projections.read({ ...input, sourceSha256: "0".repeat(64) }))
      .rejects.toThrow("no longer match");
    const controller = new AbortController();
    controller.abort();
    await expect(projections.read(input, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
