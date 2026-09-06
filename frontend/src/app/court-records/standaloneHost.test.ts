// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  listOutputs: vi.fn(),
  readOutput: vi.fn(),
  saveArtifacts: vi.fn(),
  getFilingContact: vi.fn(),
  setFilingContact: vi.fn(),
  getOutputFolder: vi.fn(),
  chooseOutputFolder: vi.fn(),
  clearOutputFolder: vi.fn(),
  writeOutputs: vi.fn(),
  prepare: vi.fn(),
  bindFile: vi.fn(),
  resolveFile: vi.fn(),
  relinkFile: vi.fn(),
  apiRequest: vi.fn(),
  apiBlobRequest: vi.fn(),
}));

vi.mock("@/app/lib/standaloneWorkProducts", () => ({
  standaloneWorkProducts: { get: mocks.getDraft },
  bindStandaloneFile: mocks.bindFile,
  canRetainLocalFiles: () => false,
  pickRetainedFiles: vi.fn(),
  relinkStandaloneFile: mocks.relinkFile,
  resolveStandaloneFile: mocks.resolveFile,
  listStandaloneOutputs: mocks.listOutputs,
  readStandaloneOutput: mocks.readOutput,
  saveStandaloneArtifacts: mocks.saveArtifacts,
  getStandaloneFilingContact: mocks.getFilingContact,
  setStandaloneFilingContact: mocks.setFilingContact,
  getStandaloneOutputFolder: mocks.getOutputFolder,
  chooseStandaloneOutputFolder: mocks.chooseOutputFolder,
  clearStandaloneOutputFolder: mocks.clearOutputFolder,
  writeStandaloneArtifactsToOutputFolder: mocks.writeOutputs,
}));
vi.mock("@/app/lib/api/client", () => ({
  apiRequest: mocks.apiRequest,
  apiBlobRequest: mocks.apiBlobRequest,
}));
vi.mock("./prepareDeviceFile", () => ({
  prepareDeviceFile: mocks.prepare,
  prepareDocxRendition: mocks.prepare,
}));

import type { WorkProduct, WorkProductOutput } from "@/app/lib/workProducts";
import { restoreCourtRecordDraft } from "./draftState";
import { standaloneCourtRecordsHost } from "./standaloneHost";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { BuildArtifact, CourtRecordDraft, CourtRecordReceipt, RecordEntry } from "./types";

const hash = (letter: string) => letter.repeat(64);
const builtAt = "2026-08-30T12:00:00.000Z";
const destination = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!.documentKinds
  .find(({ id }) => id === "moving-evidence")!;

function output(versionId = "version-1", sha256 = hash("a")): WorkProductOutput {
  return { documentId: "document-1", versionId, filename: "Appeal authorities.pdf",
    mimeType: "application/pdf", sha256, pageCount: 2 };
}

function product(id: string, item?: WorkProductOutput): WorkProduct<CourtRecordDraft> {
  return { id, kind: "court-record", title: id === "child" ? "Appeal authorities" : "Record",
    projectId: null, revision: 2, state: { profileId: id === "child" ? "fc-affidavit-exhibits" : "fc-motion-record-moving",
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
  mocks.bindFile.mockImplementation(async (file: File) => ({ kind: "local-file",
    handleId: "session:direct", lastSeen: { name: file.name, size: file.size,
      modified: file.lastModified, sha256: hash("d") } }));
  mocks.resolveFile.mockResolvedValue({ status: "missing", reason: "unavailable" });
  mocks.prepare.mockImplementation(async (file: File) => ({ file, pageCount: 2,
    searchable: true, encrypted: false, textlessPageCount: 0, textlessPages: [] }));
  mocks.getDraft.mockResolvedValue(product("record"));
  mocks.listOutputs.mockResolvedValue([]);
  mocks.getFilingContact.mockResolvedValue({ name: "Ada Lawyer", address: "1 Court Street",
    phone: "555-0100", fax: "", email: "ada@example.test" });
  mocks.getOutputFolder.mockResolvedValue("Court outputs");
  mocks.chooseOutputFolder.mockResolvedValue("Filed records");
  mocks.writeOutputs.mockResolvedValue(null);
});

describe("standalone Court outputs", () => {
  it("prepares an editable order even when PDF conversion is unavailable", async () => {
    mocks.apiBlobRequest.mockRejectedValueOnce(new Error("Conversion unavailable"));
    const file = new File(["editable order"], "order.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const destination = COURT_PROFILE_BY_ID.get("ab-kb-chambers-justice-applicant-set")!
      .documentKinds.find(({ id }) => id === "proposed-order")!;
    const prepared = await standaloneCourtRecordsHost.prepareDeviceFile(file, undefined, { destination });
    expect(prepared.file).toBe(file);
    expect(prepared.binding).toMatchObject({ kind: "local-file", lastSeen: { name: "order.docx" } });
    mocks.apiBlobRequest.mockReset();
  });
  it("shares the standalone output-folder preference", async () => {
    await expect(standaloneCourtRecordsHost.outputFolder!.get()).resolves.toBe("Court outputs");
    await expect(standaloneCourtRecordsHost.outputFolder!.choose()).resolves.toBe("Filed records");
    await standaloneCourtRecordsHost.outputFolder!.clear();
    expect(mocks.clearOutputFolder).toHaveBeenCalledOnce();
  });

  it("reuses explicitly saved filing details for new records", async () => {
    await expect(standaloneCourtRecordsHost.newDraftCover!()).resolves.toEqual({
      counselName: "Ada Lawyer", counselAddress: "1 Court Street", counselPhone: "555-0100",
      counselFax: "", counselEmail: "ada@example.test",
    });
    await standaloneCourtRecordsHost.saveFilingContact!({ counselEmail: " new@example.test " });
    expect(mocks.setFilingContact).toHaveBeenCalledWith({ name: "Ada Lawyer",
      address: "1 Court Street", phone: "555-0100", fax: "", email: "new@example.test" });
  });

  it("binds a directly added file for later draft restoration", async () => {
    const file = new File(["%PDF-file"], "Affidavit.pdf", { lastModified: 2 });

    const prepared = await standaloneCourtRecordsHost.prepareDeviceFile(file);

    expect(prepared).toMatchObject({ file, binding: { kind: "local-file",
      handleId: "session:direct", lastSeen: { name: "Affidavit.pdf" } } });
  });

  it("verifies retained file contents before treating a restored source as current", async () => {
    const binding = { kind: "local-file" as const, handleId: "retained:affidavit",
      lastSeen: { name: "Affidavit.pdf", size: 12, modified: 7, sha256: hash("a") } };

    await standaloneCourtRecordsHost.resolveInput(binding);

    expect(mocks.resolveFile).toHaveBeenCalledWith(binding, true);
  });

  it("makes a textless device PDF searchable without replacing its file binding", async () => {
    const file = new File(["%PDF-scan"], "Affidavit.pdf", { type: "application/pdf" });
    const binding = { kind: "local-file" as const, handleId: "session:scan",
      lastSeen: { name: file.name, size: file.size, modified: file.lastModified } };
    const entry: RecordEntry = { id: "scan", kindId: "affidavit", title: "Affidavit",
      file, pageCount: 2, searchable: false, encrypted: false,
      textlessPageCount: 1, textlessPages: [2], origin: { kind: "device" }, binding };
    mocks.apiRequest.mockResolvedValue({ page_count: 2, ocr_pages: [2], pages: [
      { page_number: 1, text: "Native first page" },
      { page_number: 2, text: "Recognized second page" },
    ] });
    const progress = vi.fn();

    const merged = { ...entry, ...await standaloneCourtRecordsHost.runOcr!(entry, progress) };

    expect(merged).toMatchObject({ file, origin: { kind: "device" }, binding,
      pageCount: 2, searchable: true, textlessPageCount: 0, textlessPages: [],
      ocrTextByPage: ["", "Recognized second page"], ocrAttemptedPages: [2] });
    const [path, request] = mocks.apiRequest.mock.calls[0];
    expect(path).toBe("/court-records/pdf-preparation");
    expect((request.body as FormData).get("file")).toMatchObject({
      name: file.name, size: file.size,
    });
    expect((request.body as FormData).get("pages")).toBe("[2]");
    expect(progress).toHaveBeenLastCalledWith("OCR complete", 1, 1);
  });

  it("lists and imports an exact named output", async () => {
    const child = product("child", output());
    mocks.listOutputs.mockResolvedValue([{ product: child, role: "record",
      output: child.outputs.record }]);
    mocks.readOutput.mockResolvedValue({ product: child, role: "record",
      output: child.outputs.record, bytes: new Uint8Array([1, 2]), receipt: {} });

    const choices = await standaloneCourtRecordsHost.searchDraftOutputs!(
      "appeal", destination, { ...product("record"), kind: "court-record" });
    expect(choices).toMatchObject([{ workProductId: "child", role: "record",
      workProductTitle: "Appeal authorities", output: { versionId: "version-1" } }]);

    const prepared = await standaloneCourtRecordsHost.importDraftOutput!(choices[0], destination);
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
      id: "authorities", kindId: "moving-evidence", title: "Authorities",
      lastSeen: { name: "Appeal authorities.pdf", size: 1, modified: 1,
        sha256: hash("a") },
    }] };

    await expect(restoreCourtRecordDraft(parent, standaloneCourtRecordsHost))
      .resolves.toMatchObject([{ inputStatus: "changed",
        origin: { versionId: "version-2", sourceSha256: hash("b") } }]);

    mocks.readOutput.mockRejectedValue(new Error(
      "The record output is missing. Rebuild Appeal authorities and try again."));
    await expect(standaloneCourtRecordsHost.resolveInput(binding, undefined, destination))
      .resolves.toEqual({ status: "missing", reason: "deleted" });
    await expect(standaloneCourtRecordsHost.importDraftOutput!({
      workProductId: "child", workProductTitle: "Appeal authorities", role: "record",
      output: rebuilt, document: {} as never,
    }, destination)).rejects.toThrow("Rebuild Appeal authorities");
  });

  it("retains a stale child output but blocks it until that draft is rebuilt", async () => {
    const child = product("child", output());
    mocks.readOutput.mockResolvedValue({ product: child, role: "record",
      output: child.outputs.record, bytes: new Uint8Array([1]), receipt: {}, stale: true });
    const binding = { kind: "work-product-output" as const,
      workProductId: "child", role: "record" };

    await expect(standaloneCourtRecordsHost.resolveInput(binding, undefined, destination)).resolves.toMatchObject({
      status: "stale", prepared: { stale: true },
    });
    await expect(standaloneCourtRecordsHost.importDraftOutput!({
      workProductId: "child", workProductTitle: "Appeal authorities", role: "record",
      output: child.outputs.record, document: {} as never,
    }, destination)).rejects.toThrow("Rebuild Appeal authorities");
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
    expect(mocks.writeOutputs).toHaveBeenCalledWith([expect.objectContaining({
      role: "record", bytes: item.bytes, receipt: receipt(item),
    })]);

    const bad = receipt(item);
    bad.outputs[0].sha256 = hash("0");
    await expect(standaloneCourtRecordsHost.saveArtifacts!({ artifacts: [item], product: current,
      entries: [], receipt: bad })).rejects.toThrow("does not match");
    expect(mocks.saveArtifacts).toHaveBeenCalledTimes(1);
  });
});
