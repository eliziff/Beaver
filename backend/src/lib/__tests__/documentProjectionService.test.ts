import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { sha256 } from "../hash";

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
  it("shares verified source work without sharing a reader's cancellation", async () => {
    const projections = await service();
    const { structureNative } = await import("../structureNative");
    const bytes = Buffer.from("1. Written notice is required.\n\n2. Keep a copy of the notice.");
    let deliver!: (bytes: Buffer) => void, reads = 0;
    const input = { documentId: "agreement", versionId: "version-1", fileType: "txt",
      sourceSha256: sha256(bytes), readBytes: () => {
        reads++;
        return new Promise<Buffer>((resolve) => { deliver = resolve; });
      } };
    const controller = new AbortController();
    const abandoned = projections.read(input, { signal: controller.signal });
    const surviving = projections.read(input);
    controller.abort();
    deliver(bytes);
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    const document = await surviving;
    expect(structureNative().documentText(document)).toContain("Written notice is required.");
    expect(reads).toBe(1);
    await projections.read(input);
    expect(reads).toBe(1);
    await expect(projections.read({ ...input, versionId: "version-2",
      readBytes: () => Buffer.from("corrupt") })).rejects.toThrow("no longer match");
    expect(structureNative().documentText(await projections.read({ ...input,
      versionId: "version-2", readBytes: () => bytes }))).toEqual(
      structureNative().documentText(document));
  });

  it("rejects a compressed presentation with oversized slide XML", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "x".repeat(8 * 1024 * 1024 + 1));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect((await service()).read({
      documentId: "document-a", versionId: "version-1", fileType: "pptx",
      sourceSha256: sha256(bytes),
      readBytes: () => bytes,
    })).rejects.toThrow("oversized slide XML");
  });

  it("validates identity, source bytes, and cancellation", async () => {
    const projections = await service();
    const input = {
      documentId: "document-a",
      versionId: "version-1",
      fileType: "txt",
      sourceSha256: sha256(Buffer.from("source")),
      readBytes: () => Buffer.from("source"),
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
  it("rechecks each reader's authority on cached drafting and redline views", async () => {
    const projections = await service();
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph("Written notice is required."), new Paragraph("Delivery occurs at noon."),
    ] }] }));
    let available = true;
    const input = { documentId: "notice", versionId: "v1", fileType: "docx",
      sourceSha256: sha256(bytes), readBytes: () => bytes,
      assertAvailable: async () => { if (!available) throw new Error("Access revoked"); } };
    const { structureNative } = await import("../structureNative"), native = structureNative();
    const draft = await projections.read(input, { mode: "drafting" });
    const redline = await projections.read(input, { mode: "redline" });
    expect(native.documentText(draft)).toContain("Written notice is required.");
    expect(native.documentText(redline)).toContain("Delivery occurs at noon.");
    expect(native.documentRevision(await projections.read(input, { mode: "drafting" })))
      .toBe(native.documentRevision(draft));
    available = false;
    await expect(projections.read(input, { mode: "drafting" })).rejects.toThrow("Access revoked");
    await expect(projections.read(input, { mode: "redline" })).rejects.toThrow("Access revoked");
  });

});
