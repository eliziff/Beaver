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
  it("shares a reporter anchor between displayed labels and physical highlight destinations", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 8; index++) {
      const page = pdf.addPage([612, 792]);
      page.drawText(index === 0 ? "Cover" : "Reasons for judgment and the disposition of this appeal.",
        { x: 72, y: 650, size: 11 });
      if (index === 1) page.drawText("145", { x: 290, y: 27, size: 10 });
    }
    const bytes = Buffer.from(await pdf.save()), projections = await service();
    const reference = { documentId: "reporter-binding", versionId: "v1", sourceSha256: sha256(bytes) };
    const source = { ...reference, fileType: "pdf", readBytes: () => bytes,
      reporterOriginal: true };
    const citations = ["[1986] 1 SCR 145"];
    expect(await projections.pdfPageLabels({ ...source, reporterOriginal: false }, citations))
      .toEqual([null, "145", null, null, null, null, null, null]);
    expect(await projections.pdfPageLabels(source, citations)).toEqual([null,"145","146","147","148","149","150","151"]);
    const prepared = await projections.preparePdf({ ...reference, bytes, ocrProvider: null });
    const geometry = await projections.pdfPassageGeometry(() => bytes,
      [{ id: "pinpoint", locatorKind: "page", locator: "150" }],
      { ...reference, cacheKey: prepared.cacheKey }, { citations, reporterOriginal: true,
        pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status } });
    expect(geometry.targets[0]).toMatchObject({ status: "found", pages: [{ pageNumber: 7 }] });
    const unknown = await projections.pdfPassageGeometry(() => bytes,
      [{ id: "unknown", locatorKind: "page", locator: "3" }],
      { ...reference, cacheKey: prepared.cacheKey }, { citations, reporterOriginal: true,
        pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status } });
    expect(unknown.targets[0].pages).toEqual([]);
    expect(unknown.targets[0].status).not.toBe("found");
  });
  it("detects printed labels without metadata, preserves duplicates, and reuses version-bound results", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const expected = ["101", "102", "103", "101", "102", "103"];
    for (const label of expected) {
      const page = pdf.addPage([612, 792]);
      page.drawText("The agreement requires written notice.", { x: 72, y: 650, size: 11 });
      page.drawText(label, { x: 290, y: 27, size: 10 });
    }
    const bytes = Buffer.from(await pdf.save()), projections = await service();
    let available = true, reads = 0;
    const source = { documentId: "printed", versionId: "v1", fileType: "pdf", sourceSha256: sha256(bytes),
      readBytes: () => { reads++; return bytes; },
      assertAvailable: async () => { if (!available) throw new Error("Access revoked"); } };
    expect(await projections.pdfPageLabels(source)).toEqual(expected);
    expect(await projections.pdfPageLabels(source)).toEqual(expected);
    expect(reads).toBe(1);
    available = false;
    await expect(projections.pdfPageLabels(source)).rejects.toThrow("Access revoked");
    await expect(projections.pdfPageLabels({ ...source, assertAvailable: undefined, versionId: "v2",
      readBytes: () => Buffer.from("wrong bytes") })).rejects.toThrow("no longer match");
  });

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
