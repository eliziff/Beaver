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
  it("rejects a partial batch before the application operation", async () => {
    application.saveBuild = vi.fn() as never;
    await request(app).post("/court-records/builds")
      .field("receipts", JSON.stringify({ schemaVersion: "receipt" }))
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Record.pdf")
      .attach("files", Buffer.from("%PDF-1.7\n%%EOF"), "Index.pdf")
      .expect(400);
    expect(application.saveBuild).not.toHaveBeenCalled();
  });
});
