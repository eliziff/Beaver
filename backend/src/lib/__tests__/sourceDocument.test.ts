import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { sha256 } from "../hash";

let localData: string | null = null;

async function service() {
  localData = await mkdtemp(path.join(os.tmpdir(), "source-document-"));
  process.env.MIKE_LOCAL_DATA_DIR = localData;
  vi.resetModules();
  const { structureNative } = await import("../structureNative");
  return { ...await import("../sourceDocument"), native: structureNative() };
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.resetModules();
  if (localData) await rm(localData, { recursive: true, force: true });
  localData = null;
});

describe("stored source documents", () => {
  it("reads a textless PDF's labels without OCR when its retained preparation is unavailable", async () => {
    const { openDocument, PLAIN_PDF, native } = await service();
    const { PDFDocument, rgb } = await import("pdf-lib"), pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawRectangle({ x: 72, y: 500, width: 200, height: 20, color: rgb(0, 0, 0) });
    const bytes = Buffer.from(await pdf.save());
    const document = await openDocument({ documentId: "unavailable-preparation", versionId: "v1", fileType: "pdf",
      sourceSha256: sha256(bytes), readBytes: () => bytes, pdfProfile: { cacheKey: "f".repeat(64), status: "degraded",
        profile: { ocr: { provider: "indra", settings: { model_pack: path.join(localData!, "not-installed") } } } } }, PLAIN_PDF);
    expect(native.pdfPageMap(document, []).map(page => page.label)).toEqual([null]);
  });

  it("reads saved PDF form values through the engine's document", async () => {
    const { openDocument, PLAIN_PDF, native } = await service();
    const { PDFDocument } = await import("pdf-lib"), pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    page.drawText("Applicant details", { x: 50, y: 740, size: 12 });
    const field = pdf.getForm().createTextField("Applicant");
    field.setText("Morgan Example");
    field.addToPage(page, { x: 50, y: 660, width: 250, height: 24 });
    const bytes = Buffer.from(await pdf.save());
    const document = await openDocument({ documentId: "form", versionId: "form-v1", fileType: "pdf",
      sourceSha256: sha256(bytes), readBytes: () => bytes }, PLAIN_PDF);
    expect(native.documentText(document)).toContain("Morgan Example");
  });

  it("locates reviewed filing text on its physical page without requiring a printed folio", async () => {
    const { PDFDocument } = await import("pdf-lib"), pdf = await PDFDocument.create();
    for (let index = 0; index < 2; index++) pdf.addPage().drawText("2024 SCC 1 at para 29", { x: 72, y: 650 });
    const bytes = Buffer.from(await pdf.save()), { openDocument, PLAIN_PDF, native } = await service();
    const document = await openDocument({ documentId: "unnumbered-filing", versionId: "v1",
      sourceSha256: sha256(bytes), readBytes: () => bytes }, PLAIN_PDF);
    const geometry = await native.pdfPassageGeometry(document, [{
      id: "reviewed", locatorKind: "page", locator: "1", physicalPages: [2],
      exactQuotes: ["2024 SCC 1"], quoteSelections: [{ text: "2024 SCC 1 at para 29", start: 19, end: 21 }],
    }]);
    expect(geometry.targets[0]).toMatchObject({ status: "found", pages: [{ pageNumber: 2 }],
      quotes: [{ status: "found", pageNumber: 2 }, { text: "29", status: "found", pageNumber: 2 }] });
  });

  it("shares a reporter anchor between displayed labels and physical highlight destinations", async () => {
    const { PDFDocument } = await import("pdf-lib"), pdf = await PDFDocument.create();
    for (let index = 0; index < 8; index++) {
      const page = pdf.addPage([612, 792]);
      page.drawText(index === 0 ? "Cover" : "Reasons for judgment and the disposition of this appeal.",
        { x: 72, y: 650, size: 11 });
      if (index < 2) page.drawText(String(144 + index), { x: 290, y: 27, size: 10 });
    }
    const bytes = Buffer.from(await pdf.save()), { openDocument, PLAIN_PDF, native } = await service();
    const document = await openDocument({ documentId: "reporter-binding", versionId: "v1",
      sourceSha256: sha256(bytes), readBytes: () => bytes }, PLAIN_PDF);
    const citations = ["[1986] 1 SCR 145"];
    expect(native.pdfPageMap(document, citations).map(page => page.label))
      .toEqual(["144", "145", "146", "147", "148", "149", "150", "151"]);
    expect(native.pdfPrintedPages(document, citations, ["150", "3"])).toEqual([[7], []]);
    const geometry = await native.pdfPassageGeometry(document,
      [{ id: "pinpoint", locatorKind: "page", locator: "150" }], citations);
    expect(geometry.targets[0]).toMatchObject({ status: "found", pages: [{ pageNumber: 7 }] });
    const unknown = await native.pdfPassageGeometry(document,
      [{ id: "unknown", locatorKind: "page", locator: "3" }], citations);
    expect(unknown.targets[0].pages).toEqual([]);
    expect(unknown.targets[0].status).not.toBe("found");
  });

  it("preserves duplicate printed labels and rechecks access and source versions on reopening", async () => {
    const { PDFDocument } = await import("pdf-lib"), pdf = await PDFDocument.create();
    const expected = ["101", "102", "103", "101", "102", "103"];
    for (const label of expected) {
      const page = pdf.addPage([612, 792]);
      page.drawText("The agreement requires written notice.", { x: 72, y: 650, size: 11 });
      page.drawText(label, { x: 290, y: 27, size: 10 });
    }
    const bytes = Buffer.from(await pdf.save()), { openDocument, PLAIN_PDF, native } = await service();
    let available = true;
    const source = { documentId: "printed", versionId: "v1", fileType: "pdf", sourceSha256: sha256(bytes),
      readBytes: () => bytes, assertAvailable: async () => { if (!available) throw new Error("Access revoked"); } };
    const document = await openDocument(source, PLAIN_PDF);
    expect(native.pdfPageMap(document, []).map(page => page.label)).toEqual(expected);
    const reopened = await openDocument(source, PLAIN_PDF);
    expect(native.pdfPageMap(reopened, []).map(page => page.label)).toEqual(expected);
    expect(native.documentRevision(reopened)).toBe(native.documentRevision(document));
    expect(native.pdfDocumentSummary(reopened)).toMatchObject({ pageCount: 6, pagesNeedingOcr: [] });
    available = false;
    await expect(openDocument(source, PLAIN_PDF)).rejects.toThrow("Access revoked");
    const changed = await PDFDocument.create();
    changed.addPage();
    const changedBytes = Buffer.from(await changed.save());
    // A reading is the source's by its hash: bytes read for a version must be the ones it records.
    await expect(openDocument({ ...source, assertAvailable: undefined, versionId: "v2", sourceSha256: sha256(Buffer.from("v2")),
      readBytes: () => changedBytes }, PLAIN_PDF)).rejects.toMatchObject({ kind: "source_changed" });
  });

  it("keeps a verified source readable when another reader cancels", async () => {
    const { openDocument, native } = await service();
    const bytes = Buffer.from("1. Written notice is required.\n\n2. Keep a copy of the notice.");
    const pending = Promise.withResolvers<Buffer>();
    const input = { documentId: "agreement", versionId: "version-1", fileType: "txt",
      sourceSha256: sha256(bytes), readBytes: () => pending.promise };
    const controller = new AbortController();
    const abandoned = openDocument(input, { signal: controller.signal });
    const surviving = openDocument(input);
    controller.abort();
    pending.resolve(bytes);
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    const document = await surviving;
    expect(native.documentText(document)).toContain("Written notice is required.");
    expect(native.documentText(await openDocument(input))).toBe(native.documentText(document));
    await expect(openDocument({ ...input, versionId: "version-2",
      readBytes: () => Buffer.from("corrupt") })).rejects.toThrow("no longer match");
    expect(native.documentText(await openDocument({ ...input,
      versionId: "version-2", readBytes: () => bytes }))).toBe(native.documentText(document));
  });

  it("rejects a compressed presentation with oversized slide XML", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", "x".repeat(8 * 1024 * 1024 + 1));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect((await service()).openDocument({ documentId: "document-a", versionId: "version-1", fileType: "pptx",
      sourceSha256: sha256(bytes), readBytes: () => bytes })).rejects.toThrow("oversized slide XML");
  });

  it("rejects mismatched source bytes and cancelled reads", async () => {
    const { openDocument } = await service();
    const input = { documentId: "document-a", versionId: "version-1", fileType: "txt",
      sourceSha256: sha256(Buffer.from("source")), readBytes: () => Buffer.from("source") };
    await expect(openDocument({ ...input, sourceSha256: "0".repeat(64) })).rejects.toThrow("no longer match");
    const controller = new AbortController();
    controller.abort();
    await expect(openDocument(input, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rechecks each reader's authority on cached drafting and redline views", async () => {
    const { openDocument, native } = await service();
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph("Written notice is required."), new Paragraph("Delivery occurs at noon."),
    ] }] }));
    let available = true;
    const input = { documentId: "notice", versionId: "v1", fileType: "docx",
      sourceSha256: sha256(bytes), readBytes: () => bytes,
      assertAvailable: async () => { if (!available) throw new Error("Access revoked"); } };
    const draft = await openDocument(input, { mode: "drafting" });
    const redline = await openDocument(input, { mode: "redline" });
    expect(native.documentText(draft)).toContain("Written notice is required.");
    expect(native.documentText(redline)).toContain("Delivery occurs at noon.");
    expect(native.documentRevision(await openDocument(input, { mode: "drafting" })))
      .toBe(native.documentRevision(draft));
    available = false;
    await expect(openDocument(input, { mode: "drafting" })).rejects.toThrow("Access revoked");
    await expect(openDocument(input, { mode: "redline" })).rejects.toThrow("Access revoked");
  });
});
