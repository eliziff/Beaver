import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkProductInput } from "@/app/lib/workProducts";
import { AuthoritiesWorkspace } from "./AuthoritiesWorkspace";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesDraft, AuthoritiesProduct } from "./types";

const mocks = vi.hoisted(() => ({
  apiResponse: vi.fn(), get: vi.fn(), update: vi.fn(), resolve: vi.fn(), relink: vi.fn(),
  saveArtifacts: vi.fn(),
}));

vi.mock("@/app/lib/standaloneWorkProducts", () => ({
  canRetainLocalFiles: () => true,
  pickRetainedFiles: vi.fn(),
  readStandaloneOutput: vi.fn(),
  resolveLocalFile: mocks.resolve,
  relinkLocalFile: mocks.relink,
  saveStandaloneArtifacts: mocks.saveArtifacts,
  standaloneWorkProducts: {
    create: vi.fn(), duplicate: vi.fn(), get: mocks.get, list: vi.fn(), remove: vi.fn(),
    update: mocks.update,
  },
}));
vi.mock("@/app/lib/apiTransport", () => ({ apiResponse: mocks.apiResponse }));

import { standaloneAuthoritiesHost } from "./standaloneHost";

const input = (sha256: string, size = 3, handleId = "source-handle"): WorkProductInput => ({
  kind: "local-file", handleId, lastSeen: {
    name: "Factum.docx", size, modified: 1, sha256,
  } });

function product(binding: WorkProductInput, insertIntoDocument = false): AuthoritiesProduct {
  const state: AuthoritiesDraft = {
    schemaVersion: "beaver.authorities-draft.v1",
    import: { kind: "document", bindingRole: "source", filename: "Factum.docx",
      fileType: "docx", snapshot: null },
    bindings: { source: binding }, outputMode: "table", insertIntoDocument,
    units: [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: "2024 ABKB 1", occurrenceIds: [] }],
    occurrences: {}, authorities: {}, authorityOrder: [],
  };
  return { id: "draft-1", kind: "authorities", title: "Factum", projectId: null,
    revision: 1, state, outputs: {}, createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z" };
}

async function sha256(file: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => vi.clearAllMocks());

describe("standalone Authorities sources", () => {
  it("relinks a missing imported source and refreshes its review once", async () => {
    const saved = product(input("0".repeat(64)));
    const replacement = new File(["new"], "Updated.docx", { lastModified: 2 });
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "missing", reason: "deleted" });
    mocks.relink.mockResolvedValue({ status: "ready", file: replacement,
      input: { kind: "local-file", handleId: "source-handle",
        lastSeen: { name: replacement.name, size: replacement.size, modified: 2 } } });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      const state = JSON.parse(String((options.body as FormData).get("draft")));
      return { json: async () => ({ ...state, units: [{ ...state.units[0],
        text: "2025 ABKB 2" }] }) };
    });

    await expect(standaloneAuthoritiesHost.sourceIssues!(saved)).resolves.toEqual({
      source: { status: "missing", reason: "deleted" },
    });
    const relinked = await standaloneAuthoritiesHost.relinkSource!("draft-1", "source", 1);

    expect(relinked.state.import).toMatchObject({ filename: "Updated.docx" });
    expect(relinked.state.bindings.source).toMatchObject({ kind: "local-file",
      handleId: "source-handle", lastSeen: { name: "Updated.docx",
        sha256: await sha256(replacement) } });
    expect(relinked.state.units[0].text).toBe("2025 ABKB 2");
    expect(relinked.state.authorities).toEqual(saved.state.authorities);
    expect(mocks.apiResponse).toHaveBeenCalledWith("/authorities-runtime/refresh",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  });

  it("relinks an attached PDF without reparsing citation review", async () => {
    const saved = product(input("0".repeat(64), 3, "attached-draft-source"));
    saved.state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABKB 1", name: null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "attached",
        bindingRole: "authority:case", filename: "Case.pdf",
        sourceSha256: "0".repeat(64), sourceUrl: null } };
    saved.state.authorityOrder = ["case"];
    saved.state.bindings["authority:case"] = { kind: "local-file", handleId: "pdf-handle",
      lastSeen: { name: "Case.pdf", size: 5, modified: 1, sha256: "0".repeat(64) } };
    const replacement = new File(["%PDF-new"], "Case.pdf", { lastModified: 2 });
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "missing", reason: "deleted" });
    mocks.relink.mockResolvedValue({ status: "ready", file: replacement,
      input: saved.state.bindings["authority:case"] });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const relinked = await standaloneAuthoritiesHost.relinkSource!(
      "draft-1", "authority:case", 1,
    );

    expect(relinked.state.authorities.case.source).toMatchObject({
      filename: "Case.pdf", sourceSha256: await sha256(replacement),
    });
    expect(relinked.state.units).toEqual(saved.state.units);
    expect(mocks.apiResponse).not.toHaveBeenCalled();
  });

  it("refreshes a changed imported file with its current snapshot", async () => {
    const saved = product(input("0".repeat(64), 3, "refresh-handle"));
    const changed = new File(["changed"], "Factum.docx", { lastModified: 3 });
    let submitted!: AuthoritiesDraft;
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "changed", file: changed,
      input: saved.state.bindings.source });
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      submitted = JSON.parse(String((options.body as FormData).get("draft")));
      return { json: async () => submitted };
    });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    await standaloneAuthoritiesHost.refresh("draft-1", 1);

    expect(submitted.bindings.source).toMatchObject({ handleId: "refresh-handle",
      lastSeen: { size: changed.size, modified: 3, sha256: await sha256(changed) } });
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  it("includes the imported Word source role and bytes in an annotated build", async () => {
    const source = new File(["docx"], "Factum.docx", { lastModified: 1 });
    const saved = product(input(await sha256(source), source.size, "build-handle"), true);
    let request!: FormData;
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "ready", file: source,
      input: saved.state.bindings.source });
    mocks.saveArtifacts.mockResolvedValue(saved);
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData;
      const response = new FormData();
      response.append("receipt", JSON.stringify({
        schemaVersion: "beaver.authorities-build.v1", builtAt: "2026-08-31T00:00:00Z",
        outputs: {},
      }));
      return { formData: async () => response };
    });

    await standaloneAuthoritiesHost.build("draft-1", 1);

    expect(JSON.parse(String(request.get("roles")))).toEqual(["source"]);
    const [included] = request.getAll("files") as File[];
    expect(included.name).toBe("Factum.docx");
    expect(await included.text()).toBe("docx");
  });

  it("shows the relink action only for an affected standalone source", async () => {
    const saved = product(input("0".repeat(64))), relinked = { ...saved, revision: 2 };
    const issues = vi.fn().mockResolvedValueOnce({
      source: { status: "missing", reason: "deleted" },
    }).mockResolvedValue({});
    const relinkSource = vi.fn().mockResolvedValue(relinked);
    const host: AuthoritiesHost = {
      mode: "standalone", list: vi.fn().mockResolvedValue([saved]),
      get: vi.fn().mockResolvedValue(saved), create: vi.fn(), act: vi.fn(),
      refresh: vi.fn(), attach: vi.fn(), build: vi.fn(), update: vi.fn(),
      duplicate: vi.fn(), remove: vi.fn(), download: vi.fn(),
      sourceIssues: issues, relinkSource,
    };
    render(<MemoryRouter><AuthoritiesWorkspace host={host} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Relink source" }));
    expect(relinkSource).toHaveBeenCalledWith("draft-1", "source", 1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Relink source" }))
      .not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Create Word copy with table" })).toBeVisible();
  });
});
