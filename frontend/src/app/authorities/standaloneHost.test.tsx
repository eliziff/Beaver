import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkProductInput } from "@/app/lib/workProducts";
import { AuthoritiesWorkspace } from "./AuthoritiesWorkspace";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesDraft, AuthoritiesProduct } from "./types";

const mocks = vi.hoisted(() => ({
  apiResponse: vi.fn(), bindFile: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(),
  inspect: vi.fn(), resolve: vi.fn(), relink: vi.fn(), retainFile: vi.fn(), saveArtifacts: vi.fn(),
  getOutputFolder: vi.fn(), chooseOutputFolder: vi.fn(), clearOutputFolder: vi.fn(),
  writeOutputs: vi.fn(),
}));

vi.mock("@/app/lib/standaloneWorkProducts", () => ({
  canRetainLocalFiles: () => true,
  bindStandaloneFile: mocks.bindFile,
  chooseStandaloneOutputFolder: mocks.chooseOutputFolder,
  clearStandaloneOutputFolder: mocks.clearOutputFolder,
  getStandaloneOutputFolder: mocks.getOutputFolder,
  inspectStandaloneFile: mocks.inspect,
  pickRetainedFiles: vi.fn(),
  readStandaloneOutput: vi.fn(),
  resolveStandaloneFile: mocks.resolve,
  relinkStandaloneFile: mocks.relink,
  retainStandaloneFile: mocks.retainFile,
  saveStandaloneArtifacts: mocks.saveArtifacts,
  writeStandaloneArtifactsToOutputFolder: mocks.writeOutputs,
  standaloneWorkProducts: {
    create: mocks.create, duplicate: vi.fn(), get: mocks.get, list: vi.fn(), remove: vi.fn(),
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
    settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric",
      tableOrder: "alphabetical", tableDelivery: "native-append", tableLocation: "pages",
      passageMarking: "margin", scannedPdfPolicy: "page-margin",
      missingSourcePolicy: "placeholder" },
    bookParts: { cover: null, index: null }, ledger: null,
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
  it("sends initial settings with the source before import", async () => {
    const file = new File(["PK"], "Factum.docx", { lastModified: 7 }),
      binding = input("1".repeat(64));
    const saved = product(binding); let request!: FormData;
    mocks.bindFile.mockResolvedValue(binding);
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData;
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => saved.state };
    });
    mocks.create.mockImplementation(async ({ state }) => ({ ...saved, state }));

    await standaloneAuthoritiesHost.create({ source: { kind: "file", selected: { file } },
      title: "Factum", settings: { profileId: "federal-court",
        sourceMode: "render" } });

    expect(JSON.parse(String(request.get("settings")))).toEqual({
      profileId: "federal-court", sourceMode: "render",
    });
    expect(request.get("file")).toBe(file);
  });

  it("materializes automatic source files into durable browser bindings", async () => {
    const saved = product(input("0".repeat(64))), state = structuredClone(saved.state);
    const bytes = new TextEncoder().encode("%PDF-automatic"), digest = await sha256(
      new Blob([bytes]),
    );
    const role = "authority:case";
    state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABKB 1", name: null, displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "attached", bindingRole: role, filename: "Case.pdf",
        sourceSha256: digest, sourceUrl: null, origin: "reconstructed" } };
    state.authorityOrder = ["case"];
    state.bindings[role] = { kind: "local-file", handleId: `stored:${digest}`,
      lastSeen: { name: "Case.pdf", size: bytes.length, modified: 0, sha256: digest } };
    const response = new FormData();
    response.append("draft", JSON.stringify(state));
    response.append("attachments", JSON.stringify([{ part: "file-0", authorityId: "case",
      filename: "Case.pdf", sourceSha256: digest }]));
    response.append("file-0", new File([bytes], "source.pdf", { type: "application/pdf" }));
    mocks.get.mockResolvedValue(saved);
    mocks.retainFile.mockResolvedValue(state.bindings[role]);
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));
    mocks.apiResponse.mockResolvedValue({
      headers: new Headers({ "content-type": "multipart/form-data; boundary=test" }),
      formData: async () => response,
    });

    const changed = await standaloneAuthoritiesHost.prepareSources(saved);

    expect(mocks.retainFile).toHaveBeenCalledWith(expect.objectContaining({ name: "Case.pdf" }));
    expect(changed.state.bindings[role]).toEqual(state.bindings[role]);
    expect(mocks.apiResponse).toHaveBeenCalledWith("/authorities-runtime/sources",
      expect.objectContaining({ method: "POST" }));
  });

  it("does not start source preparation after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(standaloneAuthoritiesHost.prepareSources(
      product(input("0".repeat(64))), controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apiResponse).not.toHaveBeenCalled();
  });

  it("relinks a missing imported source and refreshes its review once", async () => {
    const saved = product(input("0".repeat(64)));
    const replacement = new File(["new"], "Updated.docx", { lastModified: 2 });
    mocks.get.mockResolvedValue(saved);
    mocks.inspect.mockResolvedValue({ status: "missing", reason: "deleted" });
    mocks.relink.mockResolvedValue({ status: "ready", file: replacement,
      input: { kind: "local-file", handleId: "source-handle",
        lastSeen: { name: replacement.name, size: replacement.size, modified: 2,
          sha256: await sha256(replacement) } } });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      const state = JSON.parse(String((options.body as FormData).get("draft")));
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ...state, units: [{ ...state.units[0],
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
    expect(mocks.relink).toHaveBeenCalledWith(saved.state.bindings.source, true, "source");
    expect(mocks.apiResponse).toHaveBeenCalledWith("/authorities-runtime/refresh",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  });

  it("relinks an attached PDF without reparsing citation review", async () => {
    const saved = product(input("0".repeat(64), 3, "attached-draft-source"));
    saved.state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABKB 1", name: null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "attached",
        bindingRole: "authority:case", filename: "Case.pdf",
        sourceSha256: "0".repeat(64), sourceUrl: null, origin: "manual" } };
    saved.state.authorityOrder = ["case"];
    saved.state.bindings["authority:case"] = { kind: "local-file", handleId: "pdf-handle",
      lastSeen: { name: "Case.pdf", size: 5, modified: 1, sha256: "0".repeat(64) } };
    const replacement = new File(["%PDF-new"], "Case.pdf", { lastModified: 2 });
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "missing", reason: "deleted" });
    mocks.relink.mockResolvedValue({ status: "ready", file: replacement,
      input: { kind: "local-file", handleId: "pdf-handle", lastSeen: {
        name: replacement.name, size: replacement.size, modified: 2,
        sha256: await sha256(replacement),
      } } });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const relinked = await standaloneAuthoritiesHost.relinkSource!(
      "draft-1", "authority:case", 1,
    );

    expect(relinked.state.authorities.case.source).toMatchObject({
      filename: "Case.pdf", sourceSha256: await sha256(replacement),
    });
    expect(relinked.state.units).toEqual(saved.state.units);
    expect(mocks.relink).toHaveBeenCalledWith(
      saved.state.bindings["authority:case"], true, "pdf",
    );
    expect(mocks.apiResponse).not.toHaveBeenCalled();
  });

  it("refreshes a changed imported file with its current snapshot", async () => {
    const saved = product(input("0".repeat(64), 3, "refresh-handle"));
    const changed = new File(["changed"], "Factum.docx", { lastModified: 3 });
    let submitted!: AuthoritiesDraft;
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "changed", file: changed,
      input: { kind: "local-file", handleId: "refresh-handle", lastSeen: {
        name: changed.name, size: changed.size, modified: 3, sha256: await sha256(changed),
      } } });
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      submitted = JSON.parse(String((options.body as FormData).get("draft")));
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => submitted };
    });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    await standaloneAuthoritiesHost.refresh("draft-1", 1);

    expect(submitted.bindings.source).toMatchObject({ handleId: "refresh-handle",
      lastSeen: { size: changed.size, modified: 3, sha256: await sha256(changed) } });
    expect(mocks.relink).not.toHaveBeenCalled();
  });

  it("replaces the imported source and retains the new local binding", async () => {
    const saved = product(input("0".repeat(64))), file = new File(
      ["%PDF-replacement"], "Replacement.pdf", { type: "application/pdf", lastModified: 4 });
    const binding = { kind: "local-file" as const, handleId: "replacement-handle",
      lastSeen: { name: file.name, size: file.size, modified: 4, sha256: await sha256(file) } };
    mocks.get.mockResolvedValue(saved); mocks.bindFile.mockResolvedValue(binding);
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      const form = options.body as FormData, state = JSON.parse(String(form.get("draft")));
      return { headers: new Headers({ "content-type": "application/json" }), json: async () => ({
        ...state, import: { ...state.import, filename: file.name, fileType: "pdf" },
      }) };
    });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const replaced = await standaloneAuthoritiesHost.replaceSource!("draft-1", 1, { file });

    expect(replaced.state.import).toMatchObject({ filename: file.name, fileType: "pdf" });
    expect(replaced.state.bindings.source).toEqual(binding);
    const form = mocks.apiResponse.mock.calls[0][1].body as FormData;
    expect(form.get("replace")).toBe("true");
  });

  it("retains a custom book PDF through the standalone runtime seam", async () => {
    const saved = product(input("0".repeat(64))), file = new File(
      ["%PDF-cover"], "cover.pdf", { type: "application/pdf", lastModified: 6 });
    saved.state.outputMode = "book";
    const digest = await sha256(file), binding = { kind: "local-file" as const,
      handleId: "cover-handle", lastSeen: { name: file.name, size: file.size,
        modified: 6, sha256: digest } };
    mocks.get.mockResolvedValue(saved); mocks.bindFile.mockResolvedValue(binding);
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      const state = JSON.parse(String((options.body as FormData).get("draft")));
      const role = "book:cover:cover";
      return { headers: new Headers({ "content-type": "application/json" }), json: async () => ({
        ...state, bindings: { ...state.bindings, [role]: { ...binding, handleId: "standalone" } },
        bookParts: { ...state.bookParts,
          cover: { bindingRole: role, filename: file.name, sourceSha256: digest } },
      }) };
    });
    mocks.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const changed = await standaloneAuthoritiesHost.attachBookPdf!(
      "draft-1", 1, "cover", { file },
    );

    expect(changed.state.bookParts.cover?.filename).toBe("cover.pdf");
    expect(changed.state.bindings["book:cover:cover"]).toEqual(binding);
    const form = mocks.apiResponse.mock.calls[0][1].body as FormData;
    expect(form.get("slot")).toBe("cover");
    expect((form.get("file") as File).name).toBe(file.name);
  });

  it("includes custom book-part bytes in a standalone book build", async () => {
    const file = new File(["%PDF-cover"], "cover.pdf", { lastModified: 1 });
    const saved = product(input("0".repeat(64))); saved.state.outputMode = "book";
    const role = "book:cover:cover", binding = input(await sha256(file), file.size, "cover-handle");
    saved.state.bookParts.cover = { bindingRole: role, filename: file.name,
      sourceSha256: binding.kind === "local-file" ? binding.lastSeen.sha256! : "" };
    saved.state.bindings[role] = binding;
    let request!: FormData;
    mocks.get.mockResolvedValue(saved);
    mocks.resolve.mockResolvedValue({ status: "ready", file, input: binding });
    mocks.saveArtifacts.mockResolvedValue(saved);
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData; const response = new FormData();
      response.append("receipt", JSON.stringify({ schemaVersion: "beaver.authorities-build.v1",
        builtAt: "2026-08-31T00:00:00Z", outputs: {} }));
      return { formData: async () => response };
    });

    await standaloneAuthoritiesHost.build(saved);

    expect(JSON.parse(String(request.get("roles")))).toEqual([role]);
    expect((request.getAll("files")[0] as File).name).toBe("cover.pdf");
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

    await standaloneAuthoritiesHost.build(saved);

    expect(JSON.parse(String(request.get("roles")))).toEqual(["source"]);
    const [included] = request.getAll("files") as File[];
    expect(included.name).toBe("Factum.docx");
    expect(await included.text()).toBe("docx");
  });

  it("includes an unlinked authority PDF with an Alberta appeal filing PDF", async () => {
    const filing = new File(["%PDF-filing"], "Factum.pdf", { lastModified: 1 });
    const authority = new File(["%PDF-case"], "Case.pdf", { lastModified: 2 });
    const filingBinding = input(await sha256(filing), filing.size, "filing-handle");
    const authorityBinding = input(await sha256(authority), authority.size, "case-handle");
    const saved = product(filingBinding, true), role = "authority:case";
    saved.state.import = { kind: "document", bindingRole: "source", filename: filing.name,
      fileType: "pdf", snapshot: null };
    saved.state.settings.profileId = "ab-court-of-appeal";
    saved.state.bindings[role] = authorityBinding;
    saved.state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABCA 1", name: "Example v Example", displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "attached", bindingRole: role, filename: authority.name,
        sourceSha256: authorityBinding.kind === "local-file"
          ? authorityBinding.lastSeen.sha256! : "", sourceUrl: null, origin: "manual" } };
    saved.state.authorityOrder = ["case"];
    let request!: FormData;
    mocks.get.mockResolvedValue(saved); mocks.saveArtifacts.mockResolvedValue(saved);
    mocks.resolve.mockImplementation(async (binding) => ({ status: "ready",
      file: binding === filingBinding ? filing : authority, input: binding }));
    mocks.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData; const response = new FormData();
      response.append("receipt", JSON.stringify({ schemaVersion: "beaver.authorities-build.v1",
        builtAt: "2026-08-31T00:00:00Z", outputs: {} }));
      return { formData: async () => response };
    });

    await standaloneAuthoritiesHost.build(saved);

    expect(JSON.parse(String(request.get("roles")))).toEqual([role, "source"]);
    expect((request.getAll("files") as File[]).map(({ name }) => name))
      .toEqual([authority.name, filing.name]);
  });

  it("keeps a successful build available when its output folder cannot be written", async () => {
    const saved = product(input("0".repeat(64))), built = { ...saved, revision: 2 };
    const response = new FormData(), output = new File(["table"], "Factum.table.docx");
    response.append("receipt", JSON.stringify({
      schemaVersion: "beaver.authorities-build.v1", builtAt: "2026-08-31T00:00:00Z",
      outputs: { table: { filename: output.name, mimeType: output.type,
        sha256: "a".repeat(64), pageCount: null } },
    }));
    response.append("table", output);
    mocks.get.mockResolvedValue(saved); mocks.saveArtifacts.mockResolvedValue(built);
    mocks.writeOutputs.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    mocks.apiResponse.mockResolvedValue({ formData: async () => response });

    const result = await standaloneAuthoritiesHost.build(saved);

    expect(mocks.saveArtifacts).toHaveBeenCalledOnce();
    expect(mocks.writeOutputs).toHaveBeenCalledOnce();
    expect(mocks.saveArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.writeOutputs.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ product: built, notice: expect.stringContaining("ready to download") });
    mocks.getOutputFolder.mockResolvedValue("Court outputs");
    await expect(standaloneAuthoritiesHost.outputFolder!.get()).resolves.toBe("Court outputs");
  });

  it("shows permission reconnection only for the affected standalone source", async () => {
    const saved = product(input("0".repeat(64))), relinked = { ...saved, revision: 2 };
    const issues = vi.fn().mockResolvedValueOnce({
      source: { status: "missing", reason: "permission" },
    }).mockResolvedValue({});
    const relinkSource = vi.fn().mockResolvedValue(relinked);
    const host: AuthoritiesHost = {
      drafts: {
        list: vi.fn().mockResolvedValue([saved]), get: vi.fn().mockResolvedValue(saved),
        create: vi.fn(), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn(),
      },
      create: vi.fn(), act: vi.fn(), refresh: vi.fn(), prepareSources: vi.fn(),
      attach: vi.fn(), build: vi.fn(),
      download: vi.fn(),
      sourceIssues: issues, relinkSource,
    };
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={host}
        route={{ draftId: "draft-1", replaceDraft: vi.fn() }} />
    </MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Allow file access" },
      { timeout: 5_000 }));
    expect(relinkSource).toHaveBeenCalledWith("draft-1", "source", 1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow file access" }))
      .not.toBeInTheDocument());
    expect(screen.getByRole("checkbox")).toBeEnabled();
  });
});
