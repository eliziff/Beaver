import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthoritiesRuntimeRouter } from "./authoritiesRuntime";

const mocks = vi.hoisted(() => ({ importFile: vi.fn() }));
vi.mock("../lib/authoritiesImport", () => ({
  importStandaloneAuthoritiesFile: mocks.importFile,
}));

const originalMode = process.env.AUTH_MODE;
const app = express(); app.use(express.json());
app.use("/authorities-runtime", createAuthoritiesRuntimeRouter());

beforeAll(() => { process.env.AUTH_MODE = "local"; });
afterAll(() => { process.env.AUTH_MODE = originalMode; });
afterEach(() => vi.restoreAllMocks());

const manualState = () => ({ schemaVersion: "beaver.authorities-draft.v1" as const,
  import: { kind: "manual" as const }, bindings: {}, outputMode: "table" as const,
  insertIntoDocument: false, ledger: null, units: [], occurrences: {},
  authorityOrder: ["case"], authorities: { case: {
    id: "case", key: "case", kind: "case" as const, citation: "2024 ABKB 123",
    name: "Example v Example", displayName: null, evidenceIds: [], locators: [],
    sourceIdentity: null, excluded: false, source: { kind: "unresolved" as const },
  } } });

describe("standalone Authorities runtime", () => {
  it("refreshes a changed imported source through the domain reducer", async () => {
    const current = structuredClone(manualState()) as ReturnType<typeof manualState> &
      Record<string, unknown>;
    Object.assign(current, { import: { kind: "document", bindingRole: "source",
      filename: "Factum.pdf", fileType: "pdf", snapshot: null }, outputMode: "both",
    bindings: { source: { kind: "local-file", handleId: "retained-handle", lastSeen: {
      name: "Factum.pdf", size: 10, modified: 1, sha256: "a".repeat(64),
    } } } });
    current.authorities.case.displayName = "Kept label";
    const fresh = structuredClone(current) as typeof current;
    fresh.bindings = { source: { kind: "local-file", handleId: "standalone", lastSeen: {
      name: "Updated.pdf", size: 14, modified: 2, sha256: "b".repeat(64),
    } } };
    fresh.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: "2025 ABKB 2", occurrenceIds: [] }];
    fresh.authorities.case.displayName = null;
    mocks.importFile.mockResolvedValue(fresh);

    const response = await request(app).post("/authorities-runtime/refresh")
      .field("draft", JSON.stringify(current)).field("modified", "2")
      .attach("file", Buffer.from("%PDF-1.7\n%%EOF"), "Updated.pdf").expect(200);

    expect(response.body.bindings.source).toMatchObject({ handleId: "retained-handle",
      lastSeen: { name: "Updated.pdf", size: 14, modified: 2, sha256: "b".repeat(64) } });
    expect(response.body.units[0].text).toBe("2025 ABKB 2");
    expect(response.body.authorities.case.displayName).toBe("Kept label");
    expect(response.body.outputMode).toBe("both");
  });

  it("derives the manual CanLII handoff without making a CanLII request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const response = await request(app).post("/authorities-runtime/action").send({
      draft: manualState(), action: { type: "begin-canlii-handoff", authorityId: "case" },
    }).expect(200);
    expect(response.body.authorities.case.source).toEqual({ kind: "pending-canlii",
      authorityKey: "case",
      pageUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.html",
      pdfUrl: "https://www.canlii.org/en/ab/abkb/doc/2024/2024abkb123/2024abkb123.pdf" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("splits and merges a standalone footnote through the shared reducer", async () => {
    const text = "2024 ABKB 123; 2024 FCA 2", state = manualState();
    Object.assign(state, { units: [{ id: "footnote:1", kind: "footnote", ordinal: 0,
      footnoteId: 1, footnoteRefs: [], pageNumbers: [], text,
      occurrenceIds: ["original"] }], occurrences: { original: {
      id: "original", unitId: "footnote:1", start: 0, end: text.length, text,
      kind: "case", citation: "2024 ABKB 123", authorityId: "case", reference: null,
      pinpoints: [], evidenceIds: [], sourceTextSha256: "unit", localOrdinal: 0,
      reviewed: false } } });
    const split = await request(app).post("/authorities-runtime/action").send({ draft: state,
      action: { type: "split-occurrence", occurrenceId: "original",
        cursor: text.indexOf(";") + 1 } }).expect(200);
    expect(split.body.units[0].occurrenceIds).toHaveLength(2);
    const merged = await request(app).post("/authorities-runtime/action").send({
      draft: split.body, action: { type: "merge-occurrence",
        occurrenceId: split.body.units[0].occurrenceIds[1] },
    }).expect(200);
    expect(merged.body.units[0].occurrenceIds).toHaveLength(1);
  });

  it("builds browser-owned draft state with the production Authorities builder", async () => {
    const state = manualState();
    const response = await request(app).post("/authorities-runtime/build")
      .field("draft", JSON.stringify(state)).field("roles", "[]")
      .field("id", "draft-1").field("revision", "1").field("title", "Authorities")
      .buffer(true).parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    expect(response.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/u);
    expect((response.body as Buffer).includes(Buffer.from("beaver.authorities-build.v1"))).toBe(true);
    expect((response.body as Buffer).includes(Buffer.from("PK"))).toBe(true);
  });
});
