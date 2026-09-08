import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkProductInput } from "@/app/lib/workProducts";
import { AuthoritiesWorkspace } from "./AuthoritiesWorkspace";
import type { AuthoritiesHost } from "./host";
import type { AuthoritiesDraft, AuthoritiesProduct } from "./types";

const { api, fileStore, drafts, unexpected } = vi.hoisted(() => ({
  api: { apiResponse: vi.fn() },
  fileStore: {
    bindStandaloneFile: vi.fn(), chooseStandaloneOutputFolder: vi.fn(), clearStandaloneOutputFolder: vi.fn(),
    getStandaloneOutputFolder: vi.fn(), inspectStandaloneFile: vi.fn(), pickRetainedFiles: vi.fn(),
    readStandaloneOutput: vi.fn(), resolveStandaloneFile: vi.fn(), relinkStandaloneFile: vi.fn(),
    retainStandaloneFile: vi.fn(), saveStandaloneArtifacts: vi.fn(), writeStandaloneArtifactsToOutputFolder: vi.fn(),
  },
  drafts: { create: vi.fn(), duplicate: vi.fn(), get: vi.fn(), list: vi.fn(), remove: vi.fn(), update: vi.fn() },
  unexpected: vi.fn((name: string, ..._args: unknown[]) => { throw new Error(`Unconfigured host call: ${name}`); }),
}));

vi.mock("@/app/lib/standaloneWorkProducts", () => ({
  canRetainLocalFiles: () => true, ...fileStore, standaloneWorkProducts: drafts,
}));
vi.mock("@/app/lib/api/client", () => api);

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
    cover: { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" },
    bookParts: { cover: null, index: null, supplements: [] }, ledger: null,
    units: [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: "2024 ABKB 1", occurrenceIds: [] }],
    occurrences: {}, authorities: {}, authorityOrder: [], discrepancyDecisions: {},
  };
  return { id: "draft-1", kind: "authorities", title: "Factum", projectId: null,
    revision: 1, state, outputs: {}, createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z" };
}

async function sha256(file: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const group of [api, fileStore, drafts]) {
    for (const [name, mock] of Object.entries(group)) {
      mock.mockImplementation((...args) => unexpected(name, ...args));
    }
  }
  fileStore.writeStandaloneArtifactsToOutputFolder.mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(unexpected).not.toHaveBeenCalled();
});

describe("standalone Authorities sources", () => {
  it("sends initial settings with the source before import", async () => {
    const file = new File(["PK"], "Factum.docx", { lastModified: 7 }),
      binding = input("1".repeat(64));
    const saved = product(binding); let request!: FormData;
    fileStore.bindStandaloneFile.mockResolvedValue(binding);
    api.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData;
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => saved.state };
    });
    drafts.create.mockImplementation(async ({ state }) => ({ ...saved, state }));

    await standaloneAuthoritiesHost.create({ source: { kind: "file", selected: { file } },
      title: "Factum", settings: { profileId: "federal-court",
        sourceMode: "render" } });

    expect(JSON.parse(String(request.get("settings")))).toEqual({
      profileId: "federal-court", sourceMode: "render",
    });
    expect(request.get("file")).toBe(file);
  });

  it("materializes every automatic language PDF into a durable browser binding", async () => {
    const saved = product(input("0".repeat(64))), state = structuredClone(saved.state);
    const bytes = [new TextEncoder().encode("%PDF-english"),
      new TextEncoder().encode("%PDF-french")];
    const digests = await Promise.all(bytes.map((value) => sha256(new Blob([value]))));
    const roles = ["authority:case:en", "authority:case:fr"];
    state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABKB 1", name: null, displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "attached", sources: roles.map((bindingRole, index) => ({ bindingRole,
        filename: index ? "Case French.pdf" : "Case English.pdf",
        sourceSha256: digests[index], sourceUrl: null, origin: "reconstructed",
        language: index ? "fr" as const : "en" as const })) } };
    state.authorityOrder = ["case"];
    roles.forEach((role, index) => { state.bindings[role] = { kind: "local-file",
      handleId: `stored:${digests[index]}`, lastSeen: {
        name: index ? "Case French.pdf" : "Case English.pdf", size: bytes[index].length,
        modified: 0, sha256: digests[index] } }; });
    const response = new FormData();
    response.append("draft", JSON.stringify(state));
    response.append("attachments", JSON.stringify(roles.map((_, index) => ({
      part: `file-${index}`, authorityId: "case",
      filename: index ? "Case French.pdf" : "Case English.pdf",
      sourceSha256: digests[index], language: index ? "fr" : "en" }))));
    bytes.forEach((value, index) => response.append(`file-${index}`,
      new File([value], "source.pdf", { type: "application/pdf" })));
    drafts.get.mockResolvedValue(saved);
    fileStore.retainStandaloneFile.mockImplementation(async (file: File) => state.bindings[
      file.name.includes("French") ? roles[1] : roles[0]]);
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));
    api.apiResponse.mockResolvedValue({
      headers: new Headers({ "content-type": "multipart/form-data; boundary=test" }),
      formData: async () => response,
    });

    const changed = await standaloneAuthoritiesHost.prepareSources(saved);

    expect(fileStore.retainStandaloneFile).toHaveBeenCalledTimes(2);
    expect(roles.map((role) => changed.state.bindings[role]))
      .toEqual(roles.map((role) => state.bindings[role]));
    expect(api.apiResponse).toHaveBeenCalledWith("/authorities-runtime/sources",
      expect.objectContaining({ method: "POST" }));
  });

  it("does not start source preparation after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(standaloneAuthoritiesHost.prepareSources(
      product(input("0".repeat(64))), controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(api.apiResponse).not.toHaveBeenCalled();
  });

  it("keeps English and French PDFs on one authority and lets a bilingual PDF replace them", async () => {
    let saved = product(input("0".repeat(64)));
    saved.state.stage = "build";
    saved.state.authorityOrder = ["case"];
    saved.state.authorities.case = { id: "case", key: "case", kind: "legislation",
      citation: "RSC 1985, c C-46", name: "Criminal Code", displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "unresolved" } };
    const files = [new File(["%PDF-en"], "Code English.pdf", { type: "application/pdf" }),
      new File(["%PDF-fr"], "Code French.pdf", { type: "application/pdf" }),
      new File(["%PDF-bi"], "Code bilingual.pdf", { type: "application/pdf" })];
    const bindings = await Promise.all(files.map(async (file, index) =>
      input(await sha256(file), file.size, `code-${index}`)));
    drafts.get.mockImplementation(async () => saved);
    fileStore.bindStandaloneFile.mockImplementation(async (file: File) => bindings[files.indexOf(file)]);
    drafts.update.mockImplementation(async (_id, patch) => (saved = {
      ...saved, revision: saved.revision + 1, state: patch.state,
    }));

    saved = await standaloneAuthoritiesHost.attach(saved.id, "case", saved.revision,
      { file: files[0] }, "en");
    saved = await standaloneAuthoritiesHost.attach(saved.id, "case", saved.revision,
      { file: files[1] }, "fr");
    expect(saved.state.authorityOrder).toEqual(["case"]);
    expect(saved.state.authorities.case.source).toMatchObject({ kind: "attached", sources: [
      { language: "en", filename: files[0].name },
      { language: "fr", filename: files[1].name },
    ] });

    saved = await standaloneAuthoritiesHost.attach(saved.id, "case", saved.revision,
      { file: files[2] }, "bilingual");
    expect(saved.state.authorityOrder).toEqual(["case"]);
    expect(saved.state.authorities.case.source).toMatchObject({ kind: "attached", sources: [
      { language: "bilingual", filename: files[2].name },
    ] });
    expect(Object.keys(saved.state.bindings).filter((role) => role.startsWith("authority:")))
      .toHaveLength(1);
    expect(saved.state.stage).toBe("sources");
    expect(api.apiResponse).not.toHaveBeenCalled();
  });

  it("relinks a missing imported source and refreshes its review once", async () => {
    const saved = product(input("0".repeat(64)));
    const replacement = new File(["new"], "Updated.docx", { lastModified: 2 });
    drafts.get.mockResolvedValue(saved);
    fileStore.inspectStandaloneFile.mockResolvedValue({ status: "missing", reason: "deleted" });
    fileStore.relinkStandaloneFile.mockResolvedValue({ status: "ready", file: replacement,
      input: { kind: "local-file", handleId: "source-handle",
        lastSeen: { name: replacement.name, size: replacement.size, modified: 2,
          sha256: await sha256(replacement) } } });
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));
    api.apiResponse.mockImplementation(async (_path, options) => {
      const state = JSON.parse(String((options.body as FormData).get("draft")));
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ...state, units: [{ ...state.units[0],
        text: "2025 ABKB 2" }] }) };
    });

    await expect(standaloneAuthoritiesHost.inspectDraft(saved)).resolves.toMatchObject({
      outputFreshness: "unbuilt",
      sourceIssues: { source: { status: "missing", reason: "deleted" } },
    });
    const relinked = await standaloneAuthoritiesHost.relinkSource!("draft-1", "source", 1);

    expect(relinked.state.import).toMatchObject({ filename: "Updated.docx" });
    expect(relinked.state.bindings.source).toMatchObject({ kind: "local-file",
      handleId: "source-handle", lastSeen: { name: "Updated.docx",
        sha256: await sha256(replacement) } });
    expect(relinked.state.units[0].text).toBe("2025 ABKB 2");
    expect(relinked.state.authorities).toEqual(saved.state.authorities);
    expect(fileStore.relinkStandaloneFile).toHaveBeenCalledWith(saved.state.bindings.source, true, "source");
    expect(api.apiResponse).toHaveBeenCalledWith("/authorities-runtime/refresh",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
  });

  it("relinks one language PDF without dropping its companion or reparsing review", async () => {
    const saved = product(input("0".repeat(64), 3, "attached-draft-source"));
    const englishRole = "authority:case:en", frenchRole = "authority:case:fr";
    saved.state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABKB 1", name: null, displayName: null, excluded: false,
      evidenceIds: [], locators: [], sourceIdentity: null, source: { kind: "attached", sources: [
        { bindingRole: englishRole, filename: "Case English.pdf",
          sourceSha256: "e".repeat(64), sourceUrl: null, origin: "manual", language: "en" },
        { bindingRole: frenchRole, filename: "Case French.pdf",
          sourceSha256: "f".repeat(64), sourceUrl: null, origin: "manual", language: "fr" },
      ] } };
    saved.state.authorityOrder = ["case"];
    saved.state.bindings[englishRole] = { kind: "local-file", handleId: "en-handle",
      lastSeen: { name: "Case English.pdf", size: 5, modified: 1,
        sha256: "e".repeat(64) } };
    saved.state.bindings[frenchRole] = { kind: "local-file", handleId: "fr-handle",
      lastSeen: { name: "Case French.pdf", size: 5, modified: 1,
        sha256: "f".repeat(64) } };
    const replacement = new File(["%PDF-new"], "Case French.pdf", { lastModified: 2 });
    drafts.get.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "missing", reason: "deleted" });
    fileStore.relinkStandaloneFile.mockResolvedValue({ status: "ready", file: replacement,
      input: { kind: "local-file", handleId: "fr-handle", lastSeen: {
        name: replacement.name, size: replacement.size, modified: 2,
        sha256: await sha256(replacement),
      } } });
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const relinked = await standaloneAuthoritiesHost.relinkSource!(
      "draft-1", frenchRole, 1,
    );

    expect(relinked.state.authorities.case.source).toMatchObject({ kind: "attached", sources: [
      { language: "en", filename: "Case English.pdf", sourceSha256: "e".repeat(64) },
      { language: "fr", filename: "Case French.pdf",
        sourceSha256: await sha256(replacement) },
    ] });
    expect(relinked.state.units).toEqual(saved.state.units);
    expect(fileStore.relinkStandaloneFile).toHaveBeenCalledWith(
      saved.state.bindings[frenchRole], true, "pdf",
    );
    expect(api.apiResponse).not.toHaveBeenCalled();
  });

  it("refreshes a changed imported file with its current snapshot", async () => {
    const saved = product(input("0".repeat(64), 3, "refresh-handle"));
    const changed = new File(["changed"], "Factum.docx", { lastModified: 3 });
    let submitted!: AuthoritiesDraft;
    drafts.get.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "changed", file: changed,
      input: { kind: "local-file", handleId: "refresh-handle", lastSeen: {
        name: changed.name, size: changed.size, modified: 3, sha256: await sha256(changed),
      } } });
    api.apiResponse.mockImplementation(async (_path, options) => {
      submitted = JSON.parse(String((options.body as FormData).get("draft")));
      return { headers: new Headers({ "content-type": "application/json" }),
        json: async () => submitted };
    });
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    await standaloneAuthoritiesHost.refresh("draft-1", 1);

    expect(submitted.bindings.source).toMatchObject({ handleId: "refresh-handle",
      lastSeen: { size: changed.size, modified: 3, sha256: await sha256(changed) } });
    expect(fileStore.relinkStandaloneFile).not.toHaveBeenCalled();
  });

  it.each(["cover", "supplemental"] as const)(
    "retains a %s book PDF through the standalone runtime seam", async (slot) => {
    const saved = product(input("0".repeat(64))), file = new File(
      [`%PDF-${slot}`], `${slot}.pdf`, { type: "application/pdf", lastModified: 6 });
    saved.state.outputMode = "book";
    const digest = await sha256(file), binding = { kind: "local-file" as const,
      handleId: `${slot}-handle`, lastSeen: { name: file.name, size: file.size,
        modified: 6, sha256: digest } };
    drafts.get.mockResolvedValue(saved); fileStore.bindStandaloneFile.mockResolvedValue(binding);
    api.apiResponse.mockImplementation(async (_path, options) => {
      const state = JSON.parse(String((options.body as FormData).get("draft")));
      const role = `book:${slot}:${slot}`;
      const part = { bindingRole: role, filename: file.name, sourceSha256: digest };
      return { headers: new Headers({ "content-type": "application/json" }), json: async () => ({
        ...state, bindings: { ...state.bindings, [role]: { ...binding, handleId: "standalone" } },
        bookParts: slot === "supplemental"
          ? { ...state.bookParts, supplements: [{ ...part, id: "other-1" }] }
          : { ...state.bookParts, cover: part },
      }) };
    });
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const changed = await standaloneAuthoritiesHost.attachBookPdf!(
      "draft-1", 1, slot, { file },
    );

    const part = slot === "supplemental"
      ? changed.state.bookParts.supplements[0] : changed.state.bookParts.cover;
    expect(part?.filename).toBe(`${slot}.pdf`);
    expect(changed.state.bindings[`book:${slot}:${slot}`]).toEqual(binding);
    const form = api.apiResponse.mock.calls[0][1].body as FormData;
    expect(form.get("slot")).toBe(slot);
    expect((form.get("file") as File).name).toBe(file.name);
  });

  it("opens retained source bytes through the existing resolver", async () => {
    const saved = product(input("0".repeat(64)));
    const file = new File(["%PDF-1.7"], "Decision.pdf", { type: "application/pdf" });
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "ready", file,
      input: saved.state.bindings.source });

    await expect(standaloneAuthoritiesHost.readSource!(saved, "source")).resolves.toBe(file);
    expect(fileStore.resolveStandaloneFile).toHaveBeenCalledWith(saved.state.bindings.source, true);
  });

  it("stores and rebinds the corrected Word copy returned by the runtime", async () => {
    const source = new File(["original"], "Factum.docx", { lastModified: 1 });
    const sourceBinding = input(await sha256(source), source.size);
    const saved = product(sourceBinding), bytes = new TextEncoder().encode("corrected");
    const digest = await sha256(new Blob([bytes])), responseState = structuredClone(saved.state);
    responseState.import = { ...responseState.import as Extract<AuthoritiesDraft["import"],
      { kind: "document" }>, filename: "Factum corrected.docx" };
    responseState.bindings.source = { kind: "local-file", handleId: "standalone", lastSeen: {
      name: "Factum corrected.docx", size: bytes.length, modified: 0, sha256: digest,
    } };
    responseState.discrepancyDecisions["d".repeat(64)] = "quote_exact";
    const response = new FormData(); response.append("draft", JSON.stringify(responseState));
    response.append("source", new File([bytes], "source.docx", { type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const retained = { kind: "local-file" as const, handleId: `stored:${digest}`,
      lastSeen: { name: "Factum corrected.docx", size: bytes.length, modified: 0, sha256: digest } };
    drafts.get.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "ready", file: source, input: sourceBinding });
    fileStore.retainStandaloneFile.mockResolvedValue(retained);
    api.apiResponse.mockResolvedValue({ headers: new Headers({
      "content-type": "multipart/form-data; boundary=test" }), formData: async () => response });
    drafts.update.mockImplementation(async (_id, patch) => ({ ...saved, revision: 2,
      state: patch.state }));

    const changed = await standaloneAuthoritiesHost.resolveDiscrepancy!(saved.id, {
      id: "d".repeat(64), action: "quote_exact", revision: 1,
    });

    const request = api.apiResponse.mock.calls[0][1].body as FormData;
    expect(JSON.parse(String(request.get("request")))).toEqual({
      id: "d".repeat(64), action: "quote_exact", revision: 1,
    });
    expect(request.get("file")).toMatchObject({ name: source.name, size: source.size });
    expect(fileStore.retainStandaloneFile).toHaveBeenCalledWith(expect.objectContaining({
      name: "Factum corrected.docx", lastModified: 0,
    }));
    expect(changed.state.bindings.source).toEqual(retained);
    expect(changed.state.discrepancyDecisions).toEqual({ ["d".repeat(64)]: "quote_exact" });
  });

  it("includes other-book PDF bytes in a standalone book build", async () => {
    const file = new File(["%PDF-other"], "Other material.pdf", { lastModified: 1 });
    const saved = product(input("0".repeat(64))); saved.state.outputMode = "book";
    const role = "book:other", binding = input(await sha256(file), file.size, "other-handle");
    saved.state.bookParts.supplements = [{ id: "other", bindingRole: role, filename: file.name,
      sourceSha256: binding.kind === "local-file" ? binding.lastSeen.sha256! : "" }];
    saved.state.bindings[role] = binding;
    let request!: FormData;
    drafts.get.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "ready", file, input: binding });
    fileStore.saveStandaloneArtifacts.mockResolvedValue(saved);
    api.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData; const response = new FormData();
      response.append("receipt", JSON.stringify({ schemaVersion: "beaver.authorities-build.v1",
        builtAt: "2026-08-31T00:00:00Z", outputs: {} }));
      return { formData: async () => response };
    });

    await standaloneAuthoritiesHost.build(saved);

    expect(JSON.parse(String(request.get("roles")))).toEqual([role]);
    expect((request.getAll("files")[0] as File).name).toBe("Other material.pdf");
  });

  it("includes the imported Word source role and bytes in an annotated build", async () => {
    const source = new File(["docx"], "Factum.docx", { lastModified: 1 });
    const saved = product(input(await sha256(source), source.size, "build-handle"), true);
    let request!: FormData;
    drafts.get.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockResolvedValue({ status: "ready", file: source,
      input: saved.state.bindings.source });
    fileStore.saveStandaloneArtifacts.mockResolvedValue(saved);
    api.apiResponse.mockImplementation(async (_path, options) => {
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

  it("includes both authority language PDFs with an Alberta appeal filing PDF", async () => {
    const filing = new File(["%PDF-filing"], "Factum.pdf", { lastModified: 1 });
    const authorities = [
      new File(["%PDF-case-en"], "Case English.pdf", { lastModified: 2 }),
      new File(["%PDF-case-fr"], "Case French.pdf", { lastModified: 3 }),
    ];
    const filingBinding = input(await sha256(filing), filing.size, "filing-handle");
    const authorityBindings = await Promise.all(authorities.map(async (file, index) =>
      input(await sha256(file), file.size, `case-${index}-handle`)));
    const saved = product(filingBinding, true), roles = ["authority:case:en", "authority:case:fr"];
    saved.state.import = { kind: "document", bindingRole: "source", filename: filing.name,
      fileType: "pdf", snapshot: null };
    saved.state.settings.profileId = "ab-court-of-appeal";
    roles.forEach((role, index) => { saved.state.bindings[role] = authorityBindings[index]; });
    saved.state.authorities.case = { id: "case", key: "case", kind: "case",
      citation: "2024 ABCA 1", name: "Example v Example", displayName: null,
      evidenceIds: [], locators: [], sourceIdentity: null, excluded: false,
      source: { kind: "attached", sources: roles.map((bindingRole, index) => ({ bindingRole,
        filename: authorities[index].name,
        sourceSha256: authorityBindings[index].kind === "local-file"
          ? authorityBindings[index].lastSeen.sha256! : "", sourceUrl: null, origin: "manual",
        language: index ? "fr" as const : "en" as const })) } };
    saved.state.authorityOrder = ["case"];
    let request!: FormData;
    drafts.get.mockResolvedValue(saved); fileStore.saveStandaloneArtifacts.mockResolvedValue(saved);
    fileStore.resolveStandaloneFile.mockImplementation(async (binding) => ({ status: "ready",
      file: binding === filingBinding ? filing : authorities[authorityBindings.indexOf(binding)],
      input: binding }));
    api.apiResponse.mockImplementation(async (_path, options) => {
      request = options.body as FormData; const response = new FormData();
      response.append("receipt", JSON.stringify({ schemaVersion: "beaver.authorities-build.v1",
        builtAt: "2026-08-31T00:00:00Z", outputs: {} }));
      return { formData: async () => response };
    });

    await standaloneAuthoritiesHost.build(saved);

    expect(JSON.parse(String(request.get("roles")))).toEqual([...roles, "source"]);
    expect((request.getAll("files") as File[]).map(({ name }) => name))
      .toEqual([...authorities.map(({ name }) => name), filing.name]);
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
    drafts.get.mockResolvedValue(saved); fileStore.saveStandaloneArtifacts.mockResolvedValue(built);
    fileStore.writeStandaloneArtifactsToOutputFolder.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    api.apiResponse.mockResolvedValue({ formData: async () => response });

    const result = await standaloneAuthoritiesHost.build(saved);

    expect(fileStore.saveStandaloneArtifacts).toHaveBeenCalledOnce();
    expect(fileStore.writeStandaloneArtifactsToOutputFolder).toHaveBeenCalledOnce();
    expect(fileStore.saveStandaloneArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(fileStore.writeStandaloneArtifactsToOutputFolder.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ product: built, notice: expect.stringContaining("ready to download") });
    fileStore.getStandaloneOutputFolder.mockResolvedValue("Court outputs");
    await expect(standaloneAuthoritiesHost.outputFolder!.get()).resolves.toBe("Court outputs");
  });

  it("shows permission reconnection only for the affected standalone source", async () => {
    const saved = product(input("0".repeat(64))), relinked = { ...saved, revision: 2 };
    const inspectDraft = vi.fn().mockResolvedValueOnce({
      sourceIssues: { source: { status: "missing", reason: "permission" } },
      outputFreshness: "unbuilt",
    }).mockResolvedValue({ sourceIssues: {}, outputFreshness: "unbuilt" });
    const relinkSource = vi.fn().mockResolvedValue(relinked);
    const host: AuthoritiesHost = {
      drafts: {
        list: vi.fn().mockResolvedValue([saved]), get: vi.fn().mockResolvedValue(saved),
        create: vi.fn(), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn(),
      },
      create: vi.fn(), act: vi.fn(), refresh: vi.fn(), prepareSources: vi.fn(),
      attach: vi.fn(), build: vi.fn(),
      download: vi.fn(),
      inspectDraft, relinkSource,
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
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("labels retained outputs as previous after the draft changes", async () => {
    const saved = product(input("0".repeat(64)));
    saved.outputs.table = { documentId: "output-document", versionId: "output-version",
      filename: "Factum.table.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sha256: "a".repeat(64), pageCount: null };
    const host: AuthoritiesHost = {
      drafts: { list: vi.fn().mockResolvedValue([saved]), get: vi.fn().mockResolvedValue(saved),
        create: vi.fn(), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() },
      create: vi.fn(), act: vi.fn(), refresh: vi.fn(), prepareSources: vi.fn(),
      attach: vi.fn(), build: vi.fn(), download: vi.fn(),
      inspectDraft: vi.fn().mockResolvedValue({ sourceIssues: {}, outputFreshness: "stale" }),
    };
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={host}
        route={{ draftId: "draft-1", replaceDraft: vi.fn() }} />
    </MemoryRouter>);

    expect(await screen.findByText("Previous build — rebuild to update")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download previous Factum.table.docx" }))
      .toBeVisible();
  });
  it("discloses source slots only after citation review and fetching complete, and builds last", async () => {
    let saved = product(input("0".repeat(64)));
    saved.state.stage = "citations";
    saved.state.outputMode = "book";
    let resolveSources!: (value: AuthoritiesProduct) => void;
    const pending = new Promise<AuthoritiesProduct>((resolve) => { resolveSources = resolve; });
    const host: AuthoritiesHost = {
      drafts: { list: vi.fn().mockResolvedValue([saved]), get: vi.fn().mockResolvedValue(saved),
        create: vi.fn(), update: vi.fn(), duplicate: vi.fn(), remove: vi.fn() },
      create: vi.fn(), refresh: vi.fn(), prepareSources: vi.fn(() => pending),
      act: vi.fn(async (_id, _revision, action) => {
        saved = { ...saved, revision: saved.revision + 1, state: { ...saved.state } };
        if (action.type === "set-stage") saved.state.stage = action.stage;
        if (action.type === "set-settings") Object.assign(saved.state.settings, action.settings);
        return saved;
      }),
      attach: vi.fn(), build: vi.fn(), download: vi.fn(),
      inspectDraft: vi.fn().mockResolvedValue({ sourceIssues: {}, outputFreshness: "unbuilt" }),
    };
    render(<MemoryRouter><AuthoritiesWorkspace host={host}
      route={{ draftId: "draft-1", replaceDraft: vi.fn() }} /></MemoryRouter>);
    await screen.findByRole("button", { name: "Done" });
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(host.prepareSources).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
    resolveSources(saved);
    await screen.findByRole("list", { name: "Authority tab slots" });
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("button", { name: "Done — build book" });
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done — build book" }));
    await screen.findByRole("heading", { name: "Build outputs" });
  });

});
