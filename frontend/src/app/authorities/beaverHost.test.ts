import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthoritiesProduct } from "./types";

const api = vi.hoisted(() => ({
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  createAuthorities: vi.fn(), createWorkProduct: vi.fn(), deleteWorkProduct: vi.fn(),
  duplicateWorkProduct: vi.fn(), getAuthorities: vi.fn(), getDocumentParseStates: vi.fn(),
  listAuthorities: vi.fn(), refreshAuthorities: vi.fn(), updateWorkProduct: vi.fn(),
  uploadAuthoritiesDocument: vi.fn(),
}));
vi.mock("@/app/lib/beaverApi", () => ({ ...api,
  listWorkProducts: api.listAuthorities, getWorkProduct: api.getAuthorities,
  directoryResource: () => ({ list: vi.fn() }) }));

import { beaverAuthoritiesHost } from "./beaverHost";

const product = (): AuthoritiesProduct => ({
  id: "draft-1", kind: "authorities", title: "Authorities", projectId: null,
  revision: 1, createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z",
  outputs: {}, state: { schemaVersion: "beaver.authorities-draft.v1",
    import: { kind: "manual" }, outputMode: "book", insertIntoDocument: false,
    units: [], occurrences: {}, authorityOrder: ["included", "excluded"],
    bindings: {
      "authority:included": { kind: "document", documentId: "pdf-1", version: "latest" },
      "authority:excluded": { kind: "document", documentId: "pdf-2", version: "latest" },
    },
    authorities: {
      included: { id: "included", key: "included", kind: "case", citation: "2024 ABCA 1",
        name: null, displayName: null, excluded: false, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "attached", bindingRole: "authority:included",
          filename: "Decision.pdf", sourceSha256: "a".repeat(64), sourceUrl: null } },
      excluded: { id: "excluded", key: "excluded", kind: "case", citation: "2024 ABCA 2",
        name: null, displayName: null, excluded: true, evidenceIds: [], locators: [],
        sourceIdentity: null, source: { kind: "attached", bindingRole: "authority:excluded",
          filename: "Excluded.pdf", sourceSha256: "b".repeat(64), sourceUrl: null } },
    } },
});

describe("Beaver Authorities PDF handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    api.getAuthorities.mockResolvedValue(product());
    api.getDocumentParseStates
      .mockResolvedValueOnce([{ id: "pdf-1", parse_state: { status: "queued" } }])
      .mockResolvedValueOnce([{ id: "pdf-1", parse_state: {
        status: "parsing", phase: "ocr", pages: [4] } }])
      .mockResolvedValueOnce([{ id: "pdf-1", parse_state: { status: "ready" } }]);
    api.buildAuthorities.mockResolvedValue({ product: product(), receipt: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("waits for included attached PDFs and reports queue state before building", async () => {
    const progress = vi.fn();
    const pending = beaverAuthoritiesHost.build(product(), progress);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.buildAuthorities).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(850);
    expect(api.buildAuthorities).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(850);
    await pending;

    expect(api.getDocumentParseStates).toHaveBeenCalledTimes(3);
    expect(api.getDocumentParseStates).toHaveBeenCalledWith(["pdf-1"]);
    expect(progress.mock.calls.map(([message]) => message)).toEqual([
      "Preparing Decision.pdf",
      "Decision.pdf: Running OCR on page 4",
      "Building outputs",
    ]);
    expect(api.buildAuthorities).toHaveBeenCalledWith("draft-1", 1);
  });
});
