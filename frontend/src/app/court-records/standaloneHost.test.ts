// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  listOutputs: vi.fn(),
  readOutput: vi.fn(),
  saveArtifacts: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/app/lib/standaloneWorkProducts", () => ({
  standaloneWorkProducts: { get: mocks.getDraft },
  canRetainLocalFiles: () => false,
  pickRetainedFiles: vi.fn(),
  relinkLocalFile: vi.fn(),
  resolveLocalFile: vi.fn(async () => ({ status: "missing", reason: "unavailable" })),
  listStandaloneOutputs: mocks.listOutputs,
  readStandaloneOutput: mocks.readOutput,
  saveStandaloneArtifacts: mocks.saveArtifacts,
}));
vi.mock("@/app/lib/apiTransport", () => ({ apiBlobRequest: vi.fn() }));
vi.mock("./prepareDeviceFile", () => ({
  prepareDeviceFile: mocks.prepare,
  prepareDocxRendition: mocks.prepare,
}));

import type { WorkProduct, WorkProductOutput } from "@/app/lib/workProducts";
import { restoreCourtRecordDraft } from "./draftState";
import { standaloneCourtRecordsHost } from "./standaloneHost";
import type { BuildArtifact, CourtRecordDraft, CourtRecordReceipt } from "./types";

const hash = (letter: string) => letter.repeat(64);
const builtAt = "2026-08-30T12:00:00.000Z";

function output(versionId = "version-1", sha256 = hash("a")): WorkProductOutput {
  return { documentId: "document-1", versionId, filename: "Appeal authorities.pdf",
    mimeType: "application/pdf", sha256, pageCount: 2 };
}

function product(id: string, item?: WorkProductOutput): WorkProduct<CourtRecordDraft> {
  return { id, kind: "court-record", title: id === "child" ? "Appeal authorities" : "Record",
    projectId: null, revision: 2, state: { profileId: "fc-motion-record-moving",
      cover: {}, entries: [], bindings: {} }, outputs: item ? { record: item } : {},
    createdAt: builtAt, updatedAt: builtAt };
}

function artifact(): BuildArtifact {
  return { role: "record", filename: "Motion record.pdf", mimeType: "application/pdf",
    bytes: new Uint8Array([1]), pageCount: 1, sha256: hash("f") };
}

function receipt(item = artifact()): CourtRecordReceipt {
  return { schema_version: "beaver.court-record-receipt.v2", created_at: builtAt,
    profile: { id: "fc-motion-record-moving", sha256: hash("e"), jurisdiction: "ca",
      court_id: "fc", division: null, language: "en", document_family: "motion-record",
      variant: "moving", label: "Motion record", effective: { from: "2025-12-21" },
      source_ids: ["fc-rules"] }, preparation_date: "2026-08-30", cover: {}, sources: [],
    outputs: [{ role: "record", filename: item.filename, mime_type: item.mimeType,
      byte_count: item.bytes.byteLength, sha256: item.sha256,
      page_count: item.pageCount ?? null }], automatic_steps: [], needs_attention: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockImplementation(async (file: File) => ({ file, pageCount: 2,
    searchable: true, encrypted: false, textlessPageCount: 0, textlessPages: [] }));
  mocks.getDraft.mockResolvedValue(product("record"));
  mocks.listOutputs.mockResolvedValue([]);
});

describe("standalone Court outputs", () => {
  it("lists and imports an exact named output", async () => {
    const child = product("child", output());
    mocks.listOutputs.mockResolvedValue([{ product: child, role: "record",
      output: child.outputs.record }]);
    mocks.readOutput.mockResolvedValue({ product: child, role: "record",
      output: child.outputs.record, bytes: new Uint8Array([1, 2]), receipt: {} });

    const choices = await standaloneCourtRecordsHost.searchDraftOutputs!(
      "appeal", ["pdf"], "record");
    expect(choices).toMatchObject([{ workProductId: "child", role: "record",
      workProductTitle: "Appeal authorities", output: { versionId: "version-1" } }]);

    const prepared = await standaloneCourtRecordsHost.importDraftOutput!(choices[0]);
    expect(mocks.readOutput).toHaveBeenCalledWith("child", "record", "version-1");
    expect(prepared).toMatchObject({ binding: { kind: "work-product-output",
      workProductId: "child", role: "record" }, origin: { documentId: "document-1",
      versionId: "version-1", sourceSha256: hash("a") } });
  });

  it("marks a nested slot changed after the child rebuilds and missing after deletion", async () => {
    const rebuilt = output("version-2", hash("b")), child = product("child", rebuilt);
    mocks.readOutput.mockResolvedValue({ product: child, role: "record", output: rebuilt,
      bytes: new Uint8Array([2]), receipt: {} });
    const binding = { kind: "work-product-output" as const, workProductId: "child", role: "record" };
    const parent = product("record");
    parent.state = { ...parent.state, bindings: { authorities: binding }, entries: [{
      id: "authorities", kindId: "authorities", title: "Authorities",
      lastSeen: { name: "Appeal authorities.pdf", size: 1, modified: 1,
        sha256: hash("a") },
    }] };

    await expect(restoreCourtRecordDraft(parent, standaloneCourtRecordsHost))
      .resolves.toMatchObject([{ inputStatus: "changed",
        origin: { versionId: "version-2", sourceSha256: hash("b") } }]);

    mocks.readOutput.mockRejectedValue(new Error(
      "The record output is missing. Rebuild Appeal authorities and try again."));
    await expect(standaloneCourtRecordsHost.resolveInput(binding))
      .resolves.toEqual({ status: "missing", reason: "deleted" });
    await expect(standaloneCourtRecordsHost.importDraftOutput!({
      workProductId: "child", workProductTitle: "Appeal authorities", role: "record",
      output: rebuilt, document: {} as never,
    })).rejects.toThrow("Rebuild Appeal authorities");
  });

  it("persists one receipt-matched artifact batch and returns the CAS-owned product", async () => {
    const current = product("record"), item = artifact();
    const saved = { ...current, revision: 3, outputs: { record: output("version-2", item.sha256) } };
    mocks.saveArtifacts.mockResolvedValue(saved);

    await expect(standaloneCourtRecordsHost.saveArtifacts!({ artifacts: [item], product: current,
      entries: [], receipt: receipt(item) })).resolves.toMatchObject({ product: saved,
      outputs: { record: { documentId: "document-1", versionId: "version-2" } } });
    expect(mocks.saveArtifacts).toHaveBeenCalledWith(current, [expect.objectContaining({
      role: "record", bytes: item.bytes, receipt: receipt(item),
    })]);

    const bad = receipt(item);
    bad.outputs[0].sha256 = hash("0");
    await expect(standaloneCourtRecordsHost.saveArtifacts!({ artifacts: [item], product: current,
      entries: [], receipt: bad })).rejects.toThrow("does not match");
    expect(mocks.saveArtifacts).toHaveBeenCalledTimes(1);
  });
});
