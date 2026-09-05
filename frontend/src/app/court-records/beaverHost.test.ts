import { describe, expect, it } from "vitest";
import type { WorkProduct } from "@/app/lib/workProducts";
import { courtRecordOutputReceipts } from "./beaverHost";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { BuildArtifact, BuildReceiptSource, CourtRecordDraft, CourtRecordReceipt,
  RecordEntry } from "./types";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

const sha = (letter: string) => letter.repeat(64);
const builtAt = "2026-08-30T12:00:00.000Z";

function entry(id: string, binding: RecordEntry["binding"], origin: RecordEntry["origin"],
  sourceSha: string): RecordEntry {
  return { id, kindId: "other-document", title: id, file: {} as File,
    pageCount: 1, searchable: true, encrypted: false, binding, origin,
    lastSeen: { name: `${id}.pdf`, size: 10, modified: 20, sha256: sourceSha } };
}

function source(item: RecordEntry, sourceSha: string, order = 0): BuildReceiptSource {
  return { order, entryId: item.id, filename: `${item.id}.pdf`, title: item.title,
    kindId: item.kindId, sha256: sourceSha, mimeType: "application/pdf", byteCount: 10,
    pageCount: 1, origin: item.origin!, ocrAppliedPages: [] };
}

const receiptProfile = (id = "fc-motion-record-moving"): CourtRecordReceipt["profile"] => ({
  id, sha256: sha("e"), jurisdiction: "ca", court_id: "fc", division: null,
  language: "en", document_family: "motion-record", variant: "moving",
  label: "Motion record", effective: { from: "2025-12-21" }, source_ids: ["fc-rules"],
});

describe("court record Beaver output receipts", () => {
  it("resolves every saved binding and ties the artifact to the exact draft revision", async () => {
    const local = entry("local", { kind: "local-file", handleId: "handle-1",
      lastSeen: { name: "local.pdf", size: 10, modified: 20, sha256: sha("a") } },
    { kind: "device" }, sha("a"));
    const document = entry("document", { kind: "document", documentId: "document-1",
      version: "latest" }, { kind: "library", documentId: "document-1",
      versionId: "version-1", sourceSha256: sha("b") }, sha("b"));
    const nested = entry("nested", { kind: "work-product-output", workProductId: "book-1",
      role: "book" }, { kind: "library", documentId: "document-2",
      versionId: "version-2", sourceSha256: sha("c") }, sha("c"));
    const entries = [local, document, nested];
    const state: CourtRecordDraft = { profileId: "fc-motion-record-moving", cover: {},
      entries: entries.map((item) => ({ id: item.id, kindId: item.kindId, title: item.title,
        lastSeen: item.lastSeen! })), bindings: Object.fromEntries(entries.map((item) =>
        [item.id, item.binding!])) };
    const product: WorkProduct<CourtRecordDraft> = {
      id: "record-1", kind: "court-record", title: "Motion record", projectId: null,
      revision: 4, state, outputs: {}, createdAt: builtAt, updatedAt: builtAt,
    };
    const artifact: BuildArtifact = { role: "record", filename: "Motion record.pdf",
      mimeType: "application/pdf", bytes: new Uint8Array([1]), pageCount: 3,
      sha256: sha("d") };
    const receipt: CourtRecordReceipt = {
      schema_version: "beaver.court-record-receipt.v2", created_at: builtAt,
      profile: receiptProfile(state.profileId), preparation_date: "2026-08-30",
      cover: {}, sources: [source(local, sha("a"), 0), source(document, sha("b"), 1),
        source(nested, sha("c"), 2)], outputs: [{ role: "record", filename: artifact.filename,
        mime_type: artifact.mimeType, byte_count: 1, sha256: artifact.sha256,
        page_count: 3 }], automatic_steps: ["index"], needs_attention: [],
    };
    receipt.profile.sha256 = await digestProfile(state.profileId);

    const output = (await courtRecordOutputReceipts(product, entries, receipt, [artifact]))
      .get("record")!;
    expect(output).toMatchObject({
      schemaVersion: "beaver.work-product-build.v2",
      workProduct: { id: "record-1", kind: "court-record", revision: 4 },
      inputs: [
        { role: "local", resolved: { kind: "local-file", handleId: "handle-1",
          sha256: sha("a") } },
        { role: "document", resolved: { kind: "document", documentId: "document-1",
          versionId: "version-1", sha256: sha("b") } },
        { role: "nested", resolved: { kind: "work-product-output", workProductId: "book-1",
          role: "book", documentId: "document-2", versionId: "version-2",
          sha256: sha("c") } },
      ],
      settings: { profileId: state.profileId, outputMode: "combined-record",
        settingsSha256: receipt.profile.sha256,
        sourceReceiptIds: COURT_PROFILE_BY_ID.get(state.profileId)!.sourceIds,
        audit: { effective: { from: receipt.profile.effective.from,
          to: receipt.profile.effective.to ?? null } } },
      output: { role: "record", sha256: sha("d"), pageCount: 3 },
    });
    expect(output.settings.stateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(output.settings.audit.valuesJson)).toMatchObject({
      preparationDate: receipt.preparation_date, cover: receipt.cover,
      entries: state.entries,
    });
    receipt.profile.sha256 = sha("0");
    await expect(courtRecordOutputReceipts(product, entries, receipt, [artifact]))
      .rejects.toThrow("format changed");
  });

  it("refuses a source whose live origin no longer matches the build", async () => {
    const binding = { kind: "document" as const, documentId: "document-1",
      version: "latest" as const };
    const item = entry("document", binding, { kind: "library", documentId: "document-1",
      versionId: "version-new", sourceSha256: sha("a") }, sha("a"));
    const state: CourtRecordDraft = { profileId: "fc-motion-record-moving", cover: {},
      entries: [{ id: item.id, kindId: item.kindId, title: item.title,
        lastSeen: item.lastSeen! }], bindings: { document: binding } };
    const product: WorkProduct<CourtRecordDraft> = { id: "record-1", kind: "court-record",
      title: "Record", projectId: null, revision: 1, state, outputs: {}, createdAt: builtAt,
      updatedAt: builtAt };
    const artifact: BuildArtifact = { role: "record", filename: "Record.pdf",
      mimeType: "application/pdf", bytes: new Uint8Array(), pageCount: 1, sha256: sha("b") };
    const receipt: CourtRecordReceipt = { schema_version: "beaver.court-record-receipt.v2",
      created_at: builtAt, profile: receiptProfile(state.profileId),
      preparation_date: "2026-08-30", cover: {}, sources: [{ ...source(item, sha("a")),
        origin: { ...item.origin!, versionId: "version-old" } }], outputs: [{
        role: "record", filename: artifact.filename, mime_type: artifact.mimeType, byte_count: 0,
        sha256: artifact.sha256, page_count: 1 }], automatic_steps: [], needs_attention: [] };
    await expect(courtRecordOutputReceipts(product, [item], receipt, [artifact]))
      .rejects.toThrow("no longer matches");
  });
});

async function digestProfile(id: string) {
  const bytes = new TextEncoder().encode(canonicalJson(COURT_PROFILE_BY_ID.get(id)));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
