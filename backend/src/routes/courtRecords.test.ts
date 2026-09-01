import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CourtRecordsApplication } from "../lib/courtRecordsApplication";
import { createCourtRecordsRouter } from "./courtRecords";

const originalMode = process.env.AUTH_MODE;
const application = {
  saveFile: vi.fn(),
  saveBuild: vi.fn(async () => ({ id: "record-1", revision: 4 })),
  prepareUploadedPdf: vi.fn(async () => ({ page_count: 1,
    pages: [{ page_number: 1, text: "Recognized text" }] })),
} as unknown as CourtRecordsApplication;
const app = express();
app.use("/court-records", createCourtRecordsRouter(application));

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });

describe("Court Records output HTTP boundary", () => {
  it("carries the Court draft identity for a contained source upload", async () => {
    application.saveFile = vi.fn(async () => ({ id: "source-1" })) as never;
    await request(app).post("/court-records/documents")
      .field("work_product_id", "record-1")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "motion.pdf")
      .expect(201, { id: "source-1" });
    expect(application.saveFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "00000000-0000-0000-0000-000000000001" }),
      expect.objectContaining({ filename: "motion.pdf", fileType: "pdf" }), "record-1",
    );
  });

  it("carries every output and closed receipt through one server-owned build save", async () => {
    const record = JSON.stringify({ schemaVersion: "beaver.work-product-build.v2",
      output: { role: "record" } });
    const index = JSON.stringify({ schemaVersion: "beaver.work-product-build.v2",
      output: { role: "index" } });
    await request(app).post("/court-records/builds")
      .field("receipts", record)
      .field("receipts", index)
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Record.pdf")
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Index.pdf")
      .expect(200, { id: "record-1", revision: 4 });
    expect(application.saveBuild).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "00000000-0000-0000-0000-000000000001" }),
      [{ file: expect.objectContaining({ filename: "Record.pdf", fileType: "pdf" }),
        receipt: JSON.parse(record) },
      { file: expect.objectContaining({ filename: "Index.pdf", fileType: "pdf" }),
        receipt: JSON.parse(index) }],
    );
  });

  it("rejects a partial batch before the application operation", async () => {
    application.saveBuild = vi.fn() as never;
    await request(app).post("/court-records/builds")
      .field("receipts", JSON.stringify({ schemaVersion: "receipt" }))
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Record.pdf")
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Index.pdf")
      .expect(400);
    expect(application.saveBuild).not.toHaveBeenCalled();
  });

  it("passes a staged PDF and one-based pages to stateless preparation", async () => {
    await request(app).post("/court-records/pdf-preparation")
      .field("pages", "[2]")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "scan.pdf")
      .expect(200, { page_count: 1, pages: [{ page_number: 1, text: "Recognized text" }] });
    expect(application.prepareUploadedPdf).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: "scan.pdf", fileType: "pdf" }), [2],
    );
  });
});
