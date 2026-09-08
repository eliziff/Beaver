// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api, fixtureState, directoryList, prepareDeviceFile, unexpected } = vi.hoisted(() => ({
  api: {
    workProducts: {
      getWorkProduct: vi.fn(), getWorkProductResolution: vi.fn(), listWorkProducts: vi.fn(),
      listWorkProductMetadata: vi.fn(),
    },
    authorities: {
      refreshAuthoritiesInput: vi.fn(), prepareAuthoritiesSources: vi.fn(), buildAuthorities: vi.fn(),
    },
    documents: {
      directoryResource: vi.fn(), getDocument: vi.fn(), downloadDocument: vi.fn(),
      getDocumentParseStates: vi.fn(), deleteDocument: vi.fn(),
    },
    account: {
      getUserProfile: vi.fn(), updateUserProfile: vi.fn(),
    },
    courtRecords: {
      getCourtRecordPreparation: vi.fn(), uploadCourtRecordDocument: vi.fn(), saveCourtRecordBuild: vi.fn(),
    },
  },
  fixtureState: { product: undefined as unknown, freshness: "current" as "unbuilt" | "current" | "stale" },
  directoryList: vi.fn(), prepareDeviceFile: vi.fn(),
  unexpected: vi.fn((name: string, ..._args: unknown[]) => { throw new Error(`Unconfigured API call: ${name}`); }),
}));

vi.mock("@/app/lib/api/workProducts", async (original) => ({
  ...await original<typeof import("@/app/lib/api/workProducts")>(), ...api.workProducts,
}));
vi.mock("@/app/lib/api/authorities", async (original) => ({
  ...await original<typeof import("@/app/lib/api/authorities")>(), ...api.authorities,
}));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(), ...api.documents,
}));
vi.mock("@/app/lib/api/account", async (original) => ({
  ...await original<typeof import("@/app/lib/api/account")>(), ...api.account,
}));
vi.mock("@/app/lib/api/courtRecords", async (original) => ({
  ...await original<typeof import("@/app/lib/api/courtRecords")>(), ...api.courtRecords,
}));
vi.mock("./prepareDeviceFile", () => ({ prepareDeviceFile, prepareDocxRendition: prepareDeviceFile }));

import type { WorkProduct, WorkProductOutput } from "@/app/lib/workProducts";
import { BeaverApiError } from "@/app/lib/api/client";
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
const sourceContext = (projectId: string | null = null) => ({
  id: "record-1", kind: "court-record" as const, revision: 1, projectId,
});
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

afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected).not.toHaveBeenCalled();
});

beforeEach(() => {
  vi.resetAllMocks();
  for (const group of Object.values(api)) {
    for (const [name, mock] of Object.entries(group)) {
      mock.mockImplementation((...args) => unexpected(name, ...args));
    }
  }
  const book = output("version-1", hash("a"));
  fixtureState.product = product(book);
  fixtureState.freshness = "current";
  api.workProducts.getWorkProduct.mockImplementation(async () => fixtureState.product);
  api.workProducts.getWorkProductResolution.mockImplementation(async () => ({
    product: fixtureState.product, freshness: fixtureState.freshness, inputs: {}, dependencies: [],
  }));
  api.authorities.refreshAuthoritiesInput.mockImplementation(async () => {
    const current = fixtureState.product as WorkProduct;
    fixtureState.product = { ...current, revision: current.revision + 1 };
    return fixtureState.product;
  });
  api.authorities.prepareAuthoritiesSources.mockImplementation(async () => ({
    ...fixtureState.product as WorkProduct, state: { authorities: {}, bindings: {} },
  }));
  api.authorities.buildAuthorities.mockImplementation(async () => {
    const current = fixtureState.product as WorkProduct;
    fixtureState.product = { ...current, revision: current.revision + 1,
      outputs: { ...current.outputs, book: output("version-2", hash("b")) } };
    fixtureState.freshness = "current";
    return { product: fixtureState.product, receipt: {} };
  });
  api.workProducts.listWorkProducts.mockImplementation(async (kind: string) =>
    kind === "authorities" ? [fixtureState.product] : []);
  api.workProducts.listWorkProductMetadata.mockImplementation(async (kind: string) =>
    kind === "authorities" ? [fixtureState.product] : []);
  api.documents.directoryResource.mockImplementation(() => ({ list: directoryList }));
  directoryList.mockResolvedValue({ items: [], next_cursor: null });
  api.documents.getDocument.mockImplementation(async () => document(
    Object.values((fixtureState.product as WorkProduct).outputs)[0]));
  api.documents.downloadDocument.mockResolvedValue({ blob: new Blob(["%PDF-1.7"]),
    filename: "Authorities.pdf" });
  prepareDeviceFile.mockImplementation(async (file: File) => ({ file,
    pageCount: 2, searchable: true, encrypted: false }));
  api.account.getUserProfile.mockResolvedValue({ filingContact: { name: "Ada Lawyer",
    address: "1 Court Street", phone: "555-0100", fax: "555-0101",
    email: "ada@example.test" } });
  api.documents.getDocumentParseStates.mockResolvedValue([{ parse_state: { status: "ready" } }]);
  api.courtRecords.getCourtRecordPreparation.mockRejectedValue(new Error("not prepared"));
});

describe("nested Court Record inputs", () => {
  it("maps the saved filing contact only into a new Beaver draft cover", async () => {
    await expect(beaverCourtRecordsHost.newDraftCover!()).resolves.toEqual({
      counselName: "Ada Lawyer", counselAddress: "1 Court Street",
      counselPhone: "555-0100", counselFax: "555-0101",
      counselEmail: "ada@example.test",
    });
    api.account.updateUserProfile.mockResolvedValue({ filingContact: {
      name: "New Lawyer", address: "1 Court Street", phone: "555-0100", fax: "555-0101",
      email: "new@example.test",
    } });
    await beaverCourtRecordsHost.saveFilingContact!({
      counselName: " New Lawyer ", counselEmail: "new@example.test",
    });
    expect(api.account.updateUserProfile).toHaveBeenCalledWith({ filingContact: {
      name: "New Lawyer", address: "1 Court Street", phone: "555-0100", fax: "555-0101",
      email: "new@example.test",
    } });
    api.account.getUserProfile.mockRejectedValueOnce(new Error("offline"));
    await expect(beaverCourtRecordsHost.newDraftCover!()).resolves.toEqual({});
  });

  it("polls healthy inspection and extraction silently", async () => {
    api.documents.getDocumentParseStates
      .mockResolvedValueOnce([{ parse_state: { status: "parsing", phase: "inspecting" } }])
      .mockResolvedValueOnce([{ parse_state: { status: "ready" } }]);
    api.courtRecords.getCourtRecordPreparation.mockResolvedValueOnce({
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
    prepareDeviceFile.mockImplementationOnce(async (file: File) => ({ file,
      pageCount: 1, searchable: true, encrypted: false,
      sourceFields: { cover: {}, exhibitLabels: ["A"],
        exhibitMentions: { A: ["The order is attached as Exhibit A."] } } }));
    api.courtRecords.getCourtRecordPreparation.mockResolvedValueOnce({
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
    const choices = await beaverCourtRecordsHost.searchDraftOutputs!("appeal", authoritiesSlot, sourceContext());
    expect(choices).toMatchObject([{ workProductId: "authorities-1", role: "book",
      kind: "authorities", workProductTitle: "Appeal authorities",
      output: { versionId: "version-1" } }]);
    const first = await beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot);
    expect(first).toMatchObject({ status: "ready", input: binding,
      prepared: { binding, origin: { documentId: "book-document",
        versionId: "version-1", sourceSha256: hash("a") } } });

    const rebuilt = output("version-2", hash("b"));
    fixtureState.product = product(rebuilt);
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
    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", affidavitSlot, sourceContext()))
      .resolves.toEqual([]);
    await expect(beaverCourtRecordsHost.resolveInput(binding, undefined, affidavitSlot))
      .resolves.toEqual({ status: "missing", reason: "unavailable" });

    const accepted = affidavitProduct("affidavit-fc", "fc-affidavit-exhibits");
    const wrongCourt = affidavitProduct("affidavit-fca", "fca-affidavit-exhibits");
    api.workProducts.listWorkProductMetadata.mockImplementation(async (productKind: string) =>
      productKind === "court-record" ? [accepted, wrongCourt] : [fixtureState.product]);
    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", federalEvidenceSlot, sourceContext()))
      .resolves.toMatchObject([{ workProductId: accepted.id, kind: "court-record",
        profileId: "fc-affidavit-exhibits", role: "record" }]);

    fixtureState.product = accepted;
    const acceptedBinding = { kind: "work-product-output" as const,
      workProductId: accepted.id, role: "record" };
    await expect(beaverCourtRecordsHost.resolveInput(acceptedBinding, undefined,
      federalEvidenceSlot)).resolves.toMatchObject({ status: "ready" });
    fixtureState.product = wrongCourt;
    await expect(beaverCourtRecordsHost.resolveInput({ ...acceptedBinding,
      workProductId: wrongCourt.id }, undefined, federalEvidenceSlot))
      .resolves.toEqual({ status: "missing", reason: "unavailable" });
  });

  it("rebuilds a stale Authorities child before downloading its latest output", async () => {
    fixtureState.freshness = "stale";
    api.documents.getDocument.mockClear();
    api.documents.downloadDocument.mockClear();
    const progress = vi.fn();

    await expect(beaverCourtRecordsHost.resolveInput(binding, progress, authoritiesSlot))
      .resolves.toMatchObject({
      status: "ready", prepared: { origin: { versionId: "version-2", sourceSha256: hash("b") } },
    });
    expect(api.authorities.prepareAuthoritiesSources).toHaveBeenCalledWith("authorities-1", 2);
    expect(api.authorities.buildAuthorities).toHaveBeenCalledWith("authorities-1", 2);
    expect(api.authorities.refreshAuthoritiesInput).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith("Building Appeal authorities");
  });

  it("refreshes changed Authorities inputs before rebuilding and reports a useful failure", async () => {
    fixtureState.freshness = "stale";
    api.workProducts.getWorkProductResolution.mockImplementation(async () => ({
      product: fixtureState.product, freshness: fixtureState.freshness,
      inputs: { source: { status: "changed" }, "authority:grant": { status: "changed" } },
      dependencies: [],
    }));

    await beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot);
    expect(api.authorities.refreshAuthoritiesInput.mock.calls).toEqual([
      ["authorities-1", "source", 2], ["authorities-1", "authority:grant", 3],
    ]);
    expect(api.authorities.prepareAuthoritiesSources).toHaveBeenCalledWith("authorities-1", 4);
    expect(api.authorities.buildAuthorities).toHaveBeenCalledWith("authorities-1", 4);

    fixtureState.freshness = "stale";
    api.authorities.buildAuthorities.mockRejectedValueOnce(new Error("Source PDF is password protected"));
    await expect(beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot))
      .rejects.toThrow(
      "Appeal authorities could not be rebuilt. Open its Authorities draft: Source PDF is password protected",
    );
  });

  it("lists nested outputs only from the active Court Draft's matter", async () => {
    const sameMatter = { ...product(output("version-1", hash("a"))),
      projectId: "project-1" };
    const otherMatter = { ...sameMatter, id: "authorities-2", projectId: "project-2" };
    api.workProducts.listWorkProductMetadata.mockImplementation(async (kind: string) =>
      kind === "authorities" ? [sameMatter, otherMatter] : []);

    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", authoritiesSlot, sourceContext("project-1")))
      .resolves.toMatchObject([{ workProductId: "authorities-1" }]);
  });

  it("does not offer matter outputs to a Library-level Court Draft", async () => {
    const libraryDraft = product(output("version-1", hash("a")));
    const matterDraft = { ...libraryDraft, id: "authorities-2", projectId: "project-2" };
    api.workProducts.listWorkProductMetadata.mockImplementation(async (kind: string) =>
      kind === "authorities" ? [libraryDraft, matterDraft] : []);

    await expect(beaverCourtRecordsHost.searchDraftOutputs!("", authoritiesSlot, sourceContext()))
      .resolves.toMatchObject([{ workProductId: "authorities-1" }]);
  });

  it("coalesces parallel reads of the same child draft", async () => {
    api.workProducts.getWorkProductResolution.mockClear();
    await Promise.all([
      beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot),
      beaverCourtRecordsHost.resolveInput(binding, undefined, authoritiesSlot),
    ]);
    expect(api.workProducts.getWorkProductResolution).toHaveBeenCalledTimes(1);
  });

  it("searches the open draft's project or Library without reloading the draft", async () => {
    api.workProducts.getWorkProduct.mockRejectedValue(new Error("Draft reload must not be needed"));
    api.documents.directoryResource.mockImplementation((scope) => ({ list: async () => ({
      items: [{ kind: "document", document: { id: scope.projectId ?? "library",
        filename: "Motion.pdf", file_type: "pdf" } }], next_cursor: null,
    }) }));
    await expect(beaverCourtRecordsHost.searchLibrary!("motion", ["pdf"], sourceContext("project-1")))
      .resolves.toMatchObject([{ id: "project-1" }]);
    await expect(beaverCourtRecordsHost.searchLibrary!("", ["pdf"], sourceContext()))
      .resolves.toMatchObject([{ id: "library" }]);
  });

  it("retains and flags the slot when the child output disappears", async () => {
    fixtureState.product = product();
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
    api.documents.getDocument.mockRejectedValueOnce(offline);
    await expect(beaverCourtRecordsHost.resolveInput(source)).rejects.toBe(offline);

    api.documents.getDocument.mockRejectedValueOnce(new BeaverApiError({
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
    api.courtRecords.saveCourtRecordBuild.mockResolvedValue(saved);
    await expect(beaverCourtRecordsHost.saveArtifacts!({ artifacts: [artifact], product: record,
      entries: [], receipt: await buildReceipt(artifact) })).resolves.toEqual({
      documents: [], product: saved, outputs: { record: {
        documentId: "created-document", versionId: "created-version",
      } },
    });
    expect(api.courtRecords.saveCourtRecordBuild).toHaveBeenCalledOnce();
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
    api.courtRecords.saveCourtRecordBuild.mockRejectedValue(new TypeError("network connection lost"));
    await expect(beaverCourtRecordsHost.saveArtifacts!({ artifacts: [artifact], product: record,
      entries: [], receipt: await buildReceipt(artifact) })).rejects.toThrow(
        "network connection lost");
    expect(api.courtRecords.saveCourtRecordBuild).toHaveBeenCalledOnce();
    expect(api.documents.deleteDocument).not.toHaveBeenCalled();
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
