import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoritiesProduct } from "./types";

const api = vi.hoisted(() => ({
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  attachAuthoritiesBookPdf: vi.fn(), attachAuthoritiesLibraryPdf: vi.fn(),
  createAuthorities: vi.fn(), createWorkProduct: vi.fn(), deleteWorkProduct: vi.fn(),
  duplicateWorkProduct: vi.fn(), getAuthorities: vi.fn(), getDocumentParseStates: vi.fn(),
  getWorkProductResolution: vi.fn(), downloadDocument: vi.fn(),
  listAuthorities: vi.fn(), listWorkProductMetadata: vi.fn(), refreshAuthorities: vi.fn(), updateWorkProduct: vi.fn(),
  prepareAuthoritiesSources: vi.fn(), refreshAuthoritiesInput: vi.fn(),
  reviewAuthorities: vi.fn(),
  resolveAuthoritiesDiscrepancy: vi.fn(), uploadAuthoritiesDocument: vi.fn(),
}));
vi.mock("@/app/lib/api/authorities", () => ({
  actOnAuthorities: api.actOnAuthorities,
  attachAuthorityPdf: api.attachAuthorityPdf,
  buildAuthorities: api.buildAuthorities,
  attachAuthoritiesBookPdf: api.attachAuthoritiesBookPdf,
  attachAuthoritiesLibraryPdf: api.attachAuthoritiesLibraryPdf,
  createAuthorities: api.createAuthorities,
  refreshAuthorities: api.refreshAuthorities,
  prepareAuthoritiesSources: api.prepareAuthoritiesSources,
  refreshAuthoritiesInput: api.refreshAuthoritiesInput,
  reviewAuthorities: api.reviewAuthorities,
  resolveAuthoritiesDiscrepancy: api.resolveAuthoritiesDiscrepancy,
  uploadAuthoritiesDocument: api.uploadAuthoritiesDocument
}));
vi.mock("@/app/lib/api/workProducts", () => ({
  createWorkProduct: api.createWorkProduct,
  deleteWorkProduct: api.deleteWorkProduct,
  duplicateWorkProduct: api.duplicateWorkProduct,
  getWorkProductResolution: api.getWorkProductResolution,
  listWorkProductMetadata: api.listAuthorities,
  updateWorkProduct: api.updateWorkProduct,
  listWorkProducts: api.listAuthorities,
  getWorkProduct: api.getAuthorities
}));
vi.mock("@/app/lib/api/documents", () => ({
  getDocumentParseStates: api.getDocumentParseStates,
  downloadDocument: api.downloadDocument,
  directoryResource: () => ({ list: vi.fn() })
}));

import { beaverAuthoritiesHost } from "./beaverHost";

const product = (): AuthoritiesProduct => ({
  id: "draft-1", kind: "authorities", title: "Authorities", projectId: null,
  revision: 1, createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z",
  outputs: {}, state: { schemaVersion: "beaver.authorities-draft.v1",
    import: { kind: "manual" }, outputMode: "book", insertIntoDocument: false,
    settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric",
      tableOrder: "alphabetical", tableDelivery: "native-append", tableLocation: "pages",
      passageMarking: "margin", scannedPdfPolicy: "page-margin",
      missingSourcePolicy: "placeholder" },
    bookParts: { cover: null, index: null, supplements: [] }, ledger: null,
    units: [], occurrences: {}, authorityOrder: ["included", "excluded"],
    discrepancyDecisions: {},
    bindings: {
      "authority:included:en": { kind: "document", documentId: "pdf-1", version: "latest" },
      "authority:included:fr": { kind: "document", documentId: "pdf-fr", version: "latest" },
      "authority:excluded": { kind: "document", documentId: "pdf-2", version: "latest" },
    },
    authorities: {
      included: { id: "included", key: "included", kind: "case", citation: "2024 ABCA 1",
        name: null, displayName: null, excluded: false, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "attached", sources: [
          { bindingRole: "authority:included:en", filename: "Decision English.pdf",
            sourceSha256: "a".repeat(64), sourceUrl: null, origin: "original", language: "en" },
          { bindingRole: "authority:included:fr", filename: "Decision French.pdf",
            sourceSha256: "f".repeat(64), sourceUrl: null, origin: "original", language: "fr" },
        ] } },
      excluded: { id: "excluded", key: "excluded", kind: "case", citation: "2024 ABCA 2",
        name: null, displayName: null, excluded: true, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "attached", sources: [{
          bindingRole: "authority:excluded", filename: "Excluded.pdf",
          sourceSha256: "b".repeat(64), sourceUrl: null, origin: "manual", language: "en",
        }] } },
    } },
});

describe("Beaver Authorities PDF handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    api.getAuthorities.mockResolvedValue(product());
    const checks = new Map<string, number>();
    api.getDocumentParseStates.mockImplementation(async ([id]: [string]) => {
      const count = checks.get(id) ?? 0; checks.set(id, count + 1);
      if (count) return [{ id, parse_state: { status: "ready" } }];
      return [{ id, parse_state: id === "pdf-fr"
        ? { status: "parsing", phase: "ocr", pages: [4] } : { status: "queued" } }];
    });
    api.buildAuthorities.mockResolvedValue({ product: product(), receipt: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("waits for every included language PDF before building", async () => {
    const progress = vi.fn();
    const pending = beaverAuthoritiesHost.build(product(), progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.buildAuthorities).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(850);
    await pending;

    expect(api.getDocumentParseStates.mock.calls.map(([ids]) => ids))
      .toEqual([["pdf-1"], ["pdf-fr"], ["pdf-1"], ["pdf-fr"]]);
    expect(progress.mock.calls.map(([message]) => message)).toEqual([
      "Preparing Decision English.pdf",
      "Preparing Decision French.pdf",
      "Decision French.pdf: Running OCR on page 4",
      "Building outputs",
    ]);
  });

  it("always sends a source language to the upload operation", async () => {
    api.attachAuthorityPdf.mockResolvedValue(product());
    const file = new File(["%PDF-1.7"], "Decision French.pdf",
      { type: "application/pdf" });

    await beaverAuthoritiesHost.attach("draft-1", "included", 2, { file });
    await beaverAuthoritiesHost.attach("draft-1", "included", 3, { file }, "fr");

    expect(api.attachAuthorityPdf.mock.calls).toEqual([
      ["draft-1", "included", 2, file, "en"],
      ["draft-1", "included", 3, file, "fr"],
    ]);
  });

  it("binds the selected current Library PDF without uploading it", async () => {
    api.attachAuthoritiesLibraryPdf.mockResolvedValue(product());
    const document = { id: "pdf-1", project_id: null, filename: "Decision.pdf", file_type: "pdf",
      pdf_storage_path: null, size_bytes: null, page_count: null, created_at: null,
      current_version_id: "version-2" };

    await beaverAuthoritiesHost.attachLibraryPdf!("draft-1", 2, document,
      { kind: "authority", authorityId: "included", language: "en" });
    await beaverAuthoritiesHost.attachLibraryPdf!("draft-1", 3, document,
      { kind: "book", slot: "cover" });

    expect(api.attachAuthoritiesLibraryPdf.mock.calls).toEqual([
      ["draft-1", 2, "pdf-1", "version-2",
        { kind: "authority", authorityId: "included", language: "en" }],
      ["draft-1", 3, "pdf-1", "version-2", { kind: "book", slot: "cover" }],
    ]);
  });

  it("routes source repair through the Authorities input operation", async () => {
    api.refreshAuthoritiesInput.mockResolvedValue(product());
    await expect(beaverAuthoritiesHost.relinkSource!(
      "draft-1", "authority:included", 4)).resolves.toMatchObject({ id: "draft-1" });
    expect(api.refreshAuthoritiesInput).toHaveBeenCalledWith(
      "draft-1", "authority:included", 4);
  });

  it("prepares sources through the shared draft operation", async () => {
    api.prepareAuthoritiesSources.mockResolvedValue({ ...product(), revision: 2 });
    await expect(beaverAuthoritiesHost.prepareSources(product())).resolves.toMatchObject({ revision: 2 });
    expect(api.prepareAuthoritiesSources).toHaveBeenCalledWith("draft-1", 1, undefined);
  });

  it("opens the resolved source bytes through the existing document download", async () => {
    const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    api.getWorkProductResolution.mockResolvedValue({ inputs: {
      "authority:included:en": { status: "ready", resolved: { kind: "document",
        documentId: "pdf-1", versionId: "version-2" } },
    } });
    api.downloadDocument.mockResolvedValue({ blob, filename: "Decision.pdf" });

    await expect(beaverAuthoritiesHost.readSource!(product(), "authority:included:en"))
      .resolves.toBe(blob);
    expect(api.downloadDocument).toHaveBeenCalledWith("pdf-1", "version-2");
  });
});
