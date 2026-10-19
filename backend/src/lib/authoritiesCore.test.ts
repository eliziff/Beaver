import { afterEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildAuthoritiesDraft } from "./authoritiesCore";
import { createAuthoritiesDraft } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";
import { sha256 } from "./hash";

vi.mock("./documentProjectionService", () => ({ documentProjectionService: {
  preparePdf: vi.fn(), pdfPagination: vi.fn(),
} }));

afterEach(() => vi.restoreAllMocks());

it("includes an attached PDF whole when neither its text nor printed labels can be read", async () => {
  const original = await PDFDocument.create();
  original.addPage([400, 500]).drawText("Nimbus evidence", { x: 40, y: 440 });
  const bytes = Buffer.from(await original.save()), sourceSha256 = sha256(bytes);
  const state = createAuthoritiesDraft({ kind: "manual" }, {}, "book");
  Object.assign(state.settings, { tabPages: false, rightHandStarts: false, scannedPdfPolicy: "full" });
  state.bindings.decision = { kind: "local-file", handleId: "decision", lastSeen: {
    name: "Decision.pdf", size: bytes.length, modified: 0, sha256: sourceSha256 } };
  state.authorityOrder = ["decision"];
  state.authorities.decision = { id: "decision", key: "decision", kind: "case", citation: "2024 SCC 11",
    name: "Nimbus v Aurora", displayName: null, evidenceIds: [], excluded: false, locators: [], sourceIdentity: null,
    source: { kind: "attached", sources: [{ bindingRole: "decision", filename: "Decision.pdf", sourceSha256,
      sourceUrl: null, origin: "manual", language: "en" }] } };
  vi.mocked(documentProjectionService.preparePdf).mockRejectedValue(new Error("Text unavailable"));
  vi.mocked(documentProjectionService.pdfPagination).mockRejectedValue(new Error("Labels unavailable"));
  const { built } = await buildAuthoritiesDraft(state, { title: "Authorities", workProduct: { id: "book", revision: 1 },
    files: [{ role: "decision", filename: "Decision.pdf", bytes, sourceSha256 }],
    statuteText: async () => null, signal: new AbortController().signal });
  const book = await PDFDocument.load(built.artifacts.book!.bytes);
  expect(book.getPageCount()).toBe(3);
  expect(book.getPage(2).getSize()).toEqual({ width: 400, height: 500 });
});
