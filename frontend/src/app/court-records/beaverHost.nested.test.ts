// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  product: undefined as unknown,
  freshness: "current" as "unbuilt" | "current" | "stale",
  getWorkProduct: vi.fn(),
  getWorkProductResolution: vi.fn(),
  refreshAuthoritiesInput: vi.fn(),
  prepareAuthoritiesSources: vi.fn(),
  buildAuthorities: vi.fn(),
  listWorkProducts: vi.fn(),
  listWorkProductMetadata: vi.fn(),
  directoryResource: vi.fn(),
  directoryList: vi.fn(),
  getDocument: vi.fn(),
  downloadDocument: vi.fn(),
  prepareDeviceFile: vi.fn(),
  getUserProfile: vi.fn(),
  updateUserProfile: vi.fn(),
  getDocumentParseStates: vi.fn(),
  getCourtRecordPreparation: vi.fn(),
  uploadCourtRecordDocument: vi.fn(),
  saveCourtRecordBuild: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...await original<typeof import("@/app/lib/beaverApi")>(),
  getWorkProduct: mocks.getWorkProduct,
  getWorkProductResolution: mocks.getWorkProductResolution,
  refreshAuthoritiesInput: mocks.refreshAuthoritiesInput,
  prepareAuthoritiesSources: mocks.prepareAuthoritiesSources,
  buildAuthorities: mocks.buildAuthorities,
  listWorkProducts: mocks.listWorkProducts,
  listWorkProductMetadata: mocks.listWorkProductMetadata,
  directoryResource: mocks.directoryResource,
  getDocument: mocks.getDocument,
  downloadDocument: mocks.downloadDocument,
  getUserProfile: mocks.getUserProfile,
  updateUserProfile: mocks.updateUserProfile,
  getDocumentParseStates: mocks.getDocumentParseStates,
  getCourtRecordPreparation: mocks.getCourtRecordPreparation,
  uploadCourtRecordDocument: mocks.uploadCourtRecordDocument,
  saveCourtRecordBuild: mocks.saveCourtRecordBuild,
  deleteDocument: mocks.deleteDocument,
}));
vi.mock("./prepareDeviceFile", () => ({
  prepareDeviceFile: mocks.prepareDeviceFile,
  prepareDocxRendition: mocks.prepareDeviceFile,
}));

import type { WorkProduct, WorkProductOutput } from "@/app/lib/workProducts";
import { BeaverApiError } from "@/app/lib/apiTransport";
import { beaverCourtRecordsHost, courtRecordOutputReceipts } from "./beaverHost";
import { restoreCourtRecordDraft } from "./draftState";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { CourtRecordDraft } from "./types";
import type { BuildArtifact, CourtRecordReceipt } from "./types";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

const hash = (letter: string) => letter.repeat(64);
const binding = { kind: "work-product-output" as const,
  workProductId: "authorities-1", role: "book" };
const kind = (profileId: string, kindId: string) =>
  COURT_PROFILE_BY_ID.get(profileId)!.documentKinds.find(({ id }) => id === kindId)!;
const authoritiesSlot = kind("ab-kb-chambers-justice-applicant-set", "authorities");
const affidavitSlot = kind("ab-kb-chambers-justice-applicant-set", "affidavit");
const federalEvidenceSlot = kind("fc-motion-record-moving", "moving-evidence");

function output(versionId: string, sha256: string): WorkProductOutput {
  return { documentId: "book-document", versionId, filename: "Authorities.pdf",
    mimeType: "application/pdf", sha256, pageCount: 2 };
}

function product(book?: WorkProductOutput): WorkProduct {
  return { id: "authorities-1", kind: "authorities", title: "Appeal authorities",
    projectId: null, revision: 2, state: {}, outputs: book ? { book } : {},
    createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z" };
}

function affidavitProduct(id: string, profileId: string): WorkProduct<CourtRecordDraft> {
  const record = { ...output("version-1", hash("c")), filename: "Affidavit and exhibits.pdf" };
  return { id, kind: "court-record", title: "Affidavit and exhibits", projectId: null,
    revision: 1, state: { profileId, cover: {}, entries: [], bindings: {} },
    outputs: { record }, createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z" };
}

function document(book: WorkProductOutput) {
  return { id: book.documentId, project_id: null, filename: book.filename,
    file_type: "pdf", pdf_storage_path: null, size_bytes: 10, page_count: 2,
    created_at: "2026-08-30T00:00:00Z", current_version_id: book.versionId,
    source_sha256: book.sha256 };
}

beforeEach(() => {
  vi.clearAllMocks();
  const book = output("version-1", hash("a"));
  mocks.product = product(book);
  mocks.freshness = "current";
  mocks.getWorkProduct.mockImplementation(async () => mocks.product);
  mocks.getWorkProductResolution.mockImplementation(async () => ({
    product: mocks.product, freshness: mocks.freshness, inputs: {}, dependencies: [],
  }));
  mocks.refreshAuthoritiesInput.mockImplementation(async () => {
    const current = mocks.product as WorkProduct;
    mocks.product = { ...current, revision: current.revision + 1 };
    return mocks.product;
  });
  mocks.prepareAuthoritiesSources.mockImplementation(async () => ({
    ...mocks.product as WorkProduct, state: { authorities: {}, bindings: {} },
  }));
  mocks.buildAuthorities.mockImplementation(async () => {
    const current = mocks.product as WorkProduct;
    mocks.product = { ...current, revision: current.revision + 1,
      outputs: { ...current.outputs, book: output("version-2", hash("b")) } };
    mocks.freshness = "current";
    return { product: mocks.product, receipt: {} };
  });
  mocks.listWorkProducts.mockImplementation(async (kind: string) =>
    kind === "authorities" ? [mocks.product] : []);
  mocks.listWorkProductMetadata.mockImplementation(async (kind: string) =>
    kind === "authorities" ? [mocks.product] : []);
  mocks.directoryResource.mockImplementation(() => ({ list: mocks.directoryList }));
  mocks.directoryList.mockResolvedValue({ items: [], next_cursor: null });
  mocks.getDocument.mockImplementation(async () => document(
    Object.values((mocks.product as WorkProduct).outputs)[0]));
  mocks.downloadDocument.mockResolvedValue({ blob: new Blob(["%PDF-1.7"]),
    filename: "Authorities.pdf" });
  mocks.prepareDeviceFile.mockImplementation(async (file: File) => ({ file,
    pageCount: 2, searchable: true, encrypted: false }));
  mocks.getUserProfile.mockResolvedValue({ filingContact: { name: "Ada Lawyer",
    address: "1 Court Street", phone: "555-0100", fax: "555-0101",
    email: "ada@example.test" } });
  mocks.getDocumentParseStates.mockResolvedValue([{ parse_state: { status: "ready" } }]);
  mocks.getCourtRecordPreparation.mockRejectedValue(new Error("not prepared"));
});

describe("nested Court Record inputs", () => {
  it("maps the saved filing contact only into a new Beaver draft cover", async () => {
    await expect(beaverCourtRecordsHost.newDraftCover!()).resolves.toEqual({
      counselName: "Ada Lawyer", counselAddress: "1 Court Street",
      counselPhone: "555-0100", counselFax: "555-0101",
      counselEmail: "ada@example.test",
    });
    await beaverCourtRecordsHost.saveFilingContact!({
      counselName: " New Lawyer ", counselEmail: "new@example.test",
    });
    expect(mocks.updateUserProfile).toHaveBeenCalledWith({ filingContact: {
      name: "New Lawyer", address: "1 Court Street", phone: "555-0100", fax: "555-0101",
      email: "new@example.test",
    } });
    mocks.getUserProfile.mockRejectedValueOnce(new Error("offline"));
    await expect(beaverCourtRecordsHost.newDraftCover!()).resolves.toEqual({});
  });

  it("polls healthy inspection and extraction silently", async () => {
    mocks.getDocumentParseStates
      .mockResolvedValueOnce([{ parse_state: { status: "parsing", phase: "inspecting" } }])
      .mockResolvedValueOnce([{ parse_state: { status: "ready" } }]);
    mocks.getCourtRecordPreparation.mockResolvedValueOnce({
      document_id: "source-1", version_id: "version-1", source_sha256: hash("a"),
      page_count: 1, parser_status: "ready", pages: [{ page_number: 1, text: "Text" }],
    });
    const progress = vi.fn();
    await beaverCourtRecordsHost.runOcr!({ id: "entry-1", kindId: "motion",
      title: "Motion", file: new File(["%PDF-1.7"], "Motion.pdf"), pageCount: 1,
      searchable: true, encrypted: false, textlessPageCount: 0, textlessPages: [],
      origin: { kind: "library", documentId: "source-1", versionId: "version-1",
        sourceSha256: hash("a") } }, progress);
    expect(progress).not.toHaveBeenCalled();
  });

  it("merges affidavit exhibit wording from local inspection and the parser projection", async () => {
    mocks.prepareDeviceFile.mockImplementationOnce(async (file: File) => ({ file,
      pageCount: 1, searchable: true, encrypted: false,
      sourceFields: { cover: {}, exhibitLabels: ["A"],
        exhibitMentions: { A: ["The order is attached as Exhibit A."] } } }));
    mocks.getCourtRecordPreparation.mockResolvedValueOnce({
      document_id: "book-document", version_id: "version-1", source_sha256: hash("a"),
      page_count: 1, parser_status: "ready",
      pages: [{ page_number: 1, text: "The reply is attached as Exhibit B." }],
    });

    const prepared = await beaverCourtRecordsHost.importLibraryDocument!(
      document(output("version-1", hash("a"))),
    );
    expect(prepared.sourceFields).toMatchObject({ exhibitLabels: ["A", "B"],
      exhibitMentions: {
        A: ["The order is attached as Exhibit A."],
        B: ["The reply is attached as Exhibit B."],
      } });
  });

  it("lists named outputs and resolves the child draft's latest built version", async () => {
    const choices = await beaverCourtRecordsHost.searchDraftOutputs!("appeal", authoritiesSlot);
    expect(choices).toMatchObject([{ workProductId: "authorities-1", role: "book",
      kind: "authorities", workProductTitle: "Appeal authorities",
      output: { versionId: "version-1" } }]);
    const first = await beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot);
    expect(first).toMatchObject({ status: "ready", input: binding,
      prepared: { binding, origin: { documentId: "book-document",
        versionId: "version-1", sourceSha256: hash("a") } } });

    const rebuilt = output("version-2", hash("b"));
    mocks.product = product(rebuilt);
    const draft: WorkProduct<CourtRecordDraft> = {
      id: "record-1", kind: "court-record", title: "Motion record", projectId: null,
      revision: 1, state: { profileId: "ab-kb-chambers-justice-applicant-set", cover: {},
        bindings: { authorities: binding }, entries: [{ id: "authorities",
          kindId: "authorities", title: "Authorities",
          lastSeen: { name: "Authorities.pdf", size: 10, modified: 1,
            sha256: hash("a") } }] }, outputs: {},
      createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
    };
    const [restored] = await restoreCourtRecordDraft(draft, beaverCourtRecordsHost);
    expect(restored).toMatchObject({ inputStatus: "changed", binding,
      origin: { versionId: "version-2", sourceSha256: hash("b") } });
  });

  it("offers and resolves only outputs accepted by the destination filing slot", async () => {
    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", affidavitSlot))
      .resolves.toEqual([]);
    await expect(beaverCourtRecordsHost.resolveInput(binding, undefined, affidavitSlot))
      .resolves.toEqual({ status: "missing", reason: "unavailable" });

    const accepted = affidavitProduct("affidavit-fc", "fc-affidavit-exhibits");
    const wrongCourt = affidavitProduct("affidavit-fca", "fca-affidavit-exhibits");
    mocks.listWorkProductMetadata.mockImplementation(async (productKind: string) =>
      productKind === "court-record" ? [accepted, wrongCourt] : [mocks.product]);
    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", federalEvidenceSlot))
      .resolves.toMatchObject([{ workProductId: accepted.id, kind: "court-record",
        profileId: "fc-affidavit-exhibits", role: "record" }]);

    mocks.product = accepted;
    const acceptedBinding = { kind: "work-product-output" as const,
      workProductId: accepted.id, role: "record" };
    await expect(beaverCourtRecordsHost.resolveInput(acceptedBinding, undefined,
      federalEvidenceSlot)).resolves.toMatchObject({ status: "ready" });
    mocks.product = wrongCourt;
    await expect(beaverCourtRecordsHost.resolveInput({ ...acceptedBinding,
      workProductId: wrongCourt.id }, undefined, federalEvidenceSlot))
      .resolves.toEqual({ status: "missing", reason: "unavailable" });
  });

  it("rebuilds a stale Authorities child before downloading its latest output", async () => {
    mocks.freshness = "stale";
    mocks.getDocument.mockClear();
    mocks.downloadDocument.mockClear();
    const progress = vi.fn();

    await expect(beaverCourtRecordsHost.resolveInput(binding, progress, authoritiesSlot))
      .resolves.toMatchObject({
      status: "ready", prepared: { origin: { versionId: "version-2", sourceSha256: hash("b") } },
    });
    expect(mocks.prepareAuthoritiesSources).toHaveBeenCalledWith("authorities-1", 2);
    expect(mocks.buildAuthorities).toHaveBeenCalledWith("authorities-1", 2);
    expect(mocks.refreshAuthoritiesInput).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith("Building Appeal authorities");
  });

  it("refreshes changed Authorities inputs before rebuilding and reports a useful failure", async () => {
    mocks.freshness = "stale";
    mocks.getWorkProductResolution.mockImplementation(async () => ({
      product: mocks.product, freshness: mocks.freshness,
      inputs: { source: { status: "changed" }, "authority:grant": { status: "changed" } },
      dependencies: [],
    }));

    await beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot);
    expect(mocks.refreshAuthoritiesInput.mock.calls).toEqual([
      ["authorities-1", "source", 2], ["authorities-1", "authority:grant", 3],
    ]);
    expect(mocks.prepareAuthoritiesSources).toHaveBeenCalledWith("authorities-1", 4);
    expect(mocks.buildAuthorities).toHaveBeenCalledWith("authorities-1", 4);

    mocks.freshness = "stale";
    mocks.buildAuthorities.mockRejectedValueOnce(new Error("Source PDF is password protected"));
    await expect(beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot))
      .rejects.toThrow(
      "Appeal authorities could not be rebuilt. Open its Authorities draft: Source PDF is password protected",
    );
  });

  it("lists nested outputs only from the active Court Draft's matter", async () => {
    const sameMatter = { ...product(output("version-1", hash("a"))),
      projectId: "project-1" };
    const otherMatter = { ...sameMatter, id: "authorities-2", projectId: "project-2" };
    mocks.getWorkProduct.mockResolvedValueOnce({ ...sameMatter, id: "record-1",
      kind: "court-record", outputs: {} });
    mocks.listWorkProductMetadata.mockImplementation(async (kind: string) =>
      kind === "authorities" ? [sameMatter, otherMatter] : []);

    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", authoritiesSlot, "record-1"))
      .resolves.toMatchObject([{ workProductId: "authorities-1" }]);
    expect(mocks.listWorkProductMetadata).toHaveBeenCalledWith("authorities", "project-1");
    expect(mocks.listWorkProductMetadata).toHaveBeenCalledWith("court-record", "project-1");
  });

  it("does not offer matter outputs to a Library-level Court Draft", async () => {
    const libraryDraft = product(output("version-1", hash("a")));
    const matterDraft = { ...libraryDraft, id: "authorities-2", projectId: "project-2" };
    mocks.getWorkProduct.mockResolvedValueOnce({ ...libraryDraft, id: "record-1",
      kind: "court-record", outputs: {} });
    mocks.listWorkProductMetadata.mockImplementation(async (kind: string) =>
      kind === "authorities" ? [libraryDraft, matterDraft] : []);

    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", authoritiesSlot, "record-1"))
      .resolves.toMatchObject([{ workProductId: "authorities-1" }]);
    expect(mocks.listWorkProductMetadata).toHaveBeenCalledWith("authorities", undefined);
  });

  it("coalesces parallel reads of the same child draft", async () => {
    mocks.getWorkProductResolution.mockClear();
    await Promise.all([
      beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot),
      beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot),
    ]);
    expect(mocks.getWorkProductResolution).toHaveBeenCalledTimes(1);
  });

  it("searches the active Draft project instead of the top-level Library", async () => {
    mocks.product = { ...product(), id: "record-1", kind: "court-record",
      projectId: "project-1" };
    mocks.directoryList.mockResolvedValue({ items: [{ kind: "document", document: {
      id: "source-1", filename: "Motion.pdf", file_type: "pdf",
    } }], next_cursor: null });
    await expect(beaverCourtRecordsHost.searchLibrary!("motion", ["pdf"], {
      workProductId: "record-1",
    })).resolves.toMatchObject([{ id: "source-1" }]);
    expect(mocks.directoryResource).toHaveBeenCalledWith({ projectId: "project-1" });

    mocks.product = { ...mocks.product as WorkProduct, projectId: null };
    await beaverCourtRecordsHost.searchLibrary!("", ["pdf"], {
      workProductId: "record-1",
    });
    expect(mocks.directoryResource).toHaveBeenLastCalledWith({ library: "files" });
  });

  it("retains and flags the slot when the child output disappears", async () => {
    mocks.product = product();
    const state: CourtRecordDraft = {
      profileId: "ab-kb-chambers-justice-applicant-set", cover: {},
      bindings: { authorities: binding }, entries: [{ id: "authorities",
        kindId: "authorities", title: "Authorities", lastSeen: {
          name: "Authorities.pdf", size: 10, modified: 1, sha256: hash("a") } }] };
    const [restored] = await restoreCourtRecordDraft({ id: "record-1",
      kind: "court-record", title: "Record", projectId: null, revision: 1, state,
      outputs: {}, createdAt: "2026-08-30T00:00:00Z",
      updatedAt: "2026-08-30T00:00:00Z" }, beaverCourtRecordsHost);
    expect(restored).toMatchObject({ title: "Authorities", inputStatus: "missing",
      missingReason: "unavailable", binding });
  });

  it("reports only a 404 Library source as deleted", async () => {
    const source = { kind: "document" as const, documentId: "source-1",
      version: "latest" as const };
    const offline = new Error("network unavailable");
    mocks.getDocument.mockRejectedValueOnce(offline);
    await expect(beaverCourtRecordsHost.resolveInput(source)).rejects.toBe(offline);

    mocks.getDocument.mockRejectedValueOnce(new BeaverApiError({
      status: 404, message: "Document not found",
    }));
    await expect(beaverCourtRecordsHost.resolveInput(source)).resolves.toEqual({
      status: "missing", reason: "deleted",
    });
  });

  it("returns the persisted product from one server-owned build save", async () => {
    const state: CourtRecordDraft = { profileId: "fc-motion-record-moving", cover: {},
      entries: [], bindings: {} };
    const record: WorkProduct<CourtRecordDraft> = { id: "record-1", kind: "court-record",
      title: "Record", projectId: "project-1", revision: 3, state, outputs: {},
      createdAt: builtAt, updatedAt: builtAt };
    const artifact = buildArtifact();
    const saved = { ...record, revision: 4, outputs: { record: {
      documentId: "created-document", versionId: "created-version",
      filename: artifact.filename, mimeType: artifact.mimeType,
      sha256: artifact.sha256, pageCount: 1,
    } } };
    mocks.saveCourtRecordBuild.mockResolvedValue(saved);
    await expect(beaverCourtRecordsHost.saveArtifacts!({ artifacts: [artifact], product: record,
      entries: [], receipt: await buildReceipt(artifact) })).resolves.toEqual({
      documents: [], product: saved, outputs: { record: {
        documentId: "created-document", versionId: "created-version",
      } },
    });
    expect(mocks.saveCourtRecordBuild).toHaveBeenCalledOnce();
  });

  it("hashes equivalent Draft state identically regardless of object-key order", async () => {
    const artifact = buildArtifact(), built = await buildReceipt(artifact);
    const state: CourtRecordDraft = { profileId: "fc-motion-record-moving", cover: {},
      entries: [], bindings: {} };
    const reordered = { bindings: {}, entries: [], cover: {},
      profileId: "fc-motion-record-moving" } as CourtRecordDraft;
    const record = (value: CourtRecordDraft): WorkProduct<CourtRecordDraft> => ({
      id: "record-1", kind: "court-record", title: "Record", projectId: null,
      revision: 3, state: value, outputs: {}, createdAt: builtAt, updatedAt: builtAt,
    });
    const [first, second] = await Promise.all([state, reordered].map(async (value) =>
      (await courtRecordOutputReceipts(record(value), [], built, [artifact]))
        .get("record")!.settings.stateSha256));
    expect(first).toBe(second);
  });

  it("never deletes committed outputs when the batch response is lost", async () => {
    const artifact = buildArtifact();
    const state: CourtRecordDraft = { profileId: "fc-motion-record-moving", cover: {},
      entries: [], bindings: {} };
    const record: WorkProduct<CourtRecordDraft> = { id: "record-1", kind: "court-record",
      title: "Record", projectId: null, revision: 3, state, outputs: { record: {
        documentId: "stable-document", versionId: "version-1", filename: artifact.filename,
        mimeType: artifact.mimeType, sha256: hash("a"), pageCount: 1,
      } }, createdAt: builtAt, updatedAt: builtAt };
    mocks.saveCourtRecordBuild.mockRejectedValue(new TypeError("network connection lost"));
    await expect(beaverCourtRecordsHost.saveArtifacts!({ artifacts: [artifact], product: record,
      entries: [], receipt: await buildReceipt(artifact) })).rejects.toThrow(
        "network connection lost");
    expect(mocks.saveCourtRecordBuild).toHaveBeenCalledOnce();
    expect(mocks.deleteDocument).not.toHaveBeenCalled();
  });
});

const builtAt = "2026-08-30T12:00:00.000Z";
function buildArtifact(): BuildArtifact {
  return { role: "record", filename: "Motion record.pdf", mimeType: "application/pdf",
    bytes: new Uint8Array([1]), pageCount: 1, sha256: hash("f") };
}

async function buildReceipt(artifact: BuildArtifact): Promise<CourtRecordReceipt> {
  const profile = COURT_PROFILE_BY_ID.get("fc-motion-record-moving")!;
  const bytes = new TextEncoder().encode(canonicalJson(profile));
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { schema_version: "beaver.court-record-receipt.v2", created_at: builtAt,
    profile: { id: "fc-motion-record-moving", sha256, jurisdiction: "ca",
      court_id: "fc", division: null, language: "en", document_family: "motion-record",
      variant: "moving", label: "Motion record", effective: { from: "2025-12-21" },
      source_ids: ["fc-rules"] }, preparation_date: "2026-08-30", cover: {}, sources: [],
    outputs: [{ role: "record", filename: artifact.filename, mime_type: artifact.mimeType,
      byte_count: artifact.bytes.byteLength, sha256: artifact.sha256,
      page_count: artifact.pageCount ?? null }], automatic_steps: [], needs_attention: [] };
}
