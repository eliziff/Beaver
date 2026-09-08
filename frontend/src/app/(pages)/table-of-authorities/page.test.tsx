import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import type { AuthoritiesProduct, AuthorityIdentity } from "@/app/authorities/types";
import type { WorkProductMetadata } from "@/app/lib/workProducts";
import TableOfAuthoritiesPage from "./page";

const api = vi.hoisted(() => ({
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  attachAuthoritiesBookPdf: vi.fn(), attachAuthoritiesLibraryPdf: vi.fn(),
  createAuthorities: vi.fn(), createWorkProduct: vi.fn(), deleteWorkProduct: vi.fn(),
  downloadDocument: vi.fn(), duplicateWorkProduct: vi.fn(), getDocumentParseStates: vi.fn(),
  getWorkProduct: vi.fn(),
  getWorkProductResolution: vi.fn(), listWorkProductMetadata: vi.fn(),
  listWorkProducts: vi.fn(), prepareAuthoritiesSources: vi.fn(), refreshAuthorities: vi.fn(),
  refreshAuthoritiesInput: vi.fn(), reviewAuthorities: vi.fn(),
  resolveAuthoritiesDiscrepancy: vi.fn(),
  updateWorkProduct: vi.fn(),
  uploadAuthoritiesDocument: vi.fn(), directoryList: vi.fn(), directoryResource: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ options: [] as Record<string, unknown>[],
  handleChat: vi.fn() }));

vi.mock("@/app/lib/api/authorities", () => ({
  actOnAuthorities: api.actOnAuthorities,
  attachAuthorityPdf: api.attachAuthorityPdf,
  buildAuthorities: api.buildAuthorities,
  attachAuthoritiesBookPdf: api.attachAuthoritiesBookPdf,
  attachAuthoritiesLibraryPdf: api.attachAuthoritiesLibraryPdf,
  createAuthorities: api.createAuthorities,
  prepareAuthoritiesSources: api.prepareAuthoritiesSources,
  refreshAuthorities: api.refreshAuthorities,
  refreshAuthoritiesInput: api.refreshAuthoritiesInput,
  reviewAuthorities: api.reviewAuthorities,
  resolveAuthoritiesDiscrepancy: api.resolveAuthoritiesDiscrepancy,
  uploadAuthoritiesDocument: api.uploadAuthoritiesDocument
}));
vi.mock("@/app/lib/api/workProducts", () => ({
  createWorkProduct: api.createWorkProduct,
  deleteWorkProduct: api.deleteWorkProduct,
  duplicateWorkProduct: api.duplicateWorkProduct,
  getWorkProduct: api.getWorkProduct,
  getWorkProductResolution: api.getWorkProductResolution,
  listWorkProductMetadata: api.listWorkProductMetadata,
  listWorkProducts: api.listWorkProducts,
  updateWorkProduct: api.updateWorkProduct
}));
vi.mock("@/app/lib/api/documents", () => ({
  downloadDocument: api.downloadDocument,
  getDocumentParseStates: api.getDocumentParseStates,
  directoryResource: api.directoryResource
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs, expanded }: { tabs: Array<{ content: ReactNode }>; expanded: boolean }) =>
    <aside aria-label="Assistant dock" hidden={!expanded}>{tabs[0]?.content}</aside>,
}));
vi.mock("@/app/components/assistant/ConversationView", () => ({
  ConversationView: ({ handleChat, sendDisabled }: {
    handleChat: (...args: never[]) => Promise<unknown>; sendDisabled?: boolean;
  }) => <button type="button" disabled={sendDisabled}
    onClick={() => void handleChat({ content: "Update this draft" } as never)}>Complete turn</button>,
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: (options: Record<string, unknown>) => {
    assistant.options.push(options);
    const [messages, setMessages] = useState<Array<{ role: "assistant"; workflowRuns: Array<{
      status: "complete"; work_product: { id: string; kind: string; revision: number } }> }>>([]);
    const product = options.workProduct as { id: string; kind: string; revision: number } | undefined;
    return { state: { chatId: options.chatId, messages, run: null }, actions: {
      handleChat: async (request: unknown) => {
        const result = await assistant.handleChat(request);
        if (product) setMessages([{ role: "assistant", workflowRuns: [{ status: "complete",
          work_product: { ...product, revision: product.revision + 1 } }] }]);
        return result;
      }, cancel: vi.fn(), clearRejectedTurn: vi.fn(), retryRejectedTurn: vi.fn(),
    } };
  },
}));

function draft(id = "draft-1", title = "Book of Authorities"): AuthoritiesProduct {
  return { id, kind: "authorities", title, projectId: null, revision: 1,
    createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z", outputs: {},
    state: { schemaVersion: "beaver.authorities-draft.v1", import: { kind: "manual" }, stage: "build",
      bindings: {}, outputMode: "both", insertIntoDocument: false, ledger: null,
      settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric",
        tableOrder: "alphabetical", tableDelivery: "native-append", tableLocation: "pages",
        passageMarking: "margin", scannedPdfPolicy: "page-margin",
        missingSourcePolicy: "placeholder" },
      cover: { courtFileNumber: "", partyGroups: [], applicationUnder: "", title: "" },
      bookParts: { cover: null, index: null, supplements: [] },
      units: [], occurrences: {}, authorities: {}, authorityOrder: [],
      discrepancyDecisions: {} } };
}

function documentDraft(id = "draft-1", title = "Requested draft") {
  const saved = draft(id, title);
  saved.state.import = { kind: "document", bindingRole: "source", filename: "Factum.docx",
    fileType: "docx", snapshot: null };
  saved.state.outputMode = "table";
  saved.state.stage = "citations";
  return saved;
}

function authority(id: string, name: string, source: AuthorityIdentity["source"]): AuthorityIdentity {
  return { id, key: id, kind: "case", citation: `${name} citation`, name, displayName: null,
    evidenceIds: [], locators: [], sourceIdentity: null, excluded: false, source };
}
function attachedSource(bindingRole: string, filename: string, hash = "a",
  sourceUrl: string | null = null, origin: "manual" | "original" | "reconstructed" = "manual"):
  AuthorityIdentity["source"] {
  return { kind: "attached", sources: [{ bindingRole, filename, sourceSha256: hash.repeat(64),
    sourceUrl, origin, language: "en" }] };
}

function add(saved: AuthoritiesProduct, ...items: AuthorityIdentity[]) {
  saved.state.authorities = Object.fromEntries(items.map((item) => [item.id, item]));
  saved.state.authorityOrder = items.map(({ id }) => id);
  return saved;
}
function addReviewCandidate(saved: AuthoritiesProduct) {
  const citation = "2024 ABKB 1", id = "authority-1";
  saved.state.units = [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
    footnoteRefs: [], pageNumbers: [1], text: citation, occurrenceIds: ["occurrence-1"] }];
  saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "footnote:1",
    start: 0, end: citation.length, text: citation, kind: "case", citation,
    authoritySpan: { start: 0, end: citation.length, text: citation },
    coreSpan: { start: 0, end: citation.length, text: citation }, pinpointSpan: null,
    authorityId: id, reference: null, pinpoints: [{ kind: "paragraph", text: "7" }],
    evidenceIds: [], sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: true };
  const item = authority(id, citation, { kind: "resolved" });
  item.sourceIdentity = { provider: "a2aj", stableSourceId: "cases:1", sourceSha256: "b".repeat(64),
    version: "2024-01-01", externalUrl: "https://example.test/decision" };
  add(saved, item);
  return citation;
}
const workspaceRoute = (draftId = "") => ({ draftId, replaceDraft: vi.fn() });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function selectRange(root: HTMLElement, start: number, end = start) {
  const range = document.createRange(), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode(), offset = 0, started = false;
  while (node) {
    const next = offset + (node.textContent?.length ?? 0);
    if (!started && start <= next) {
      range.setStart(node, start - offset); started = true;
    }
    if (started && end <= next) { range.setEnd(node, end - offset); break; }
    offset = next; node = walker.nextNode();
  }
  const selection = window.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range); fireEvent.mouseUp(root);
}

describe("Authorities UI contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); assistant.options.length = 0;
    assistant.handleChat.mockResolvedValue(null);
    api.listWorkProductMetadata.mockResolvedValue([]);
    api.listWorkProducts.mockResolvedValue([]);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {} });
    api.getDocumentParseStates.mockResolvedValue([]);
    api.prepareAuthoritiesSources.mockResolvedValue(draft());
    api.reviewAuthorities.mockResolvedValue([]);
    api.directoryList.mockResolvedValue({ items: [], next_cursor: null });
    api.directoryResource.mockReturnValue({ list: api.directoryList });
  });

  it("renders the shared blank workspace without opening saved work or an iframe", async () => {
    api.listWorkProductMetadata.mockResolvedValue([
      (({ state: _state, ...item }) => item)(draft("other", "Other draft")),
    ]);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Automatic", "Manual", "Drafts",
    ]);
    expect(await screen.findByRole("heading", { name: "Import and review" })).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() => expect(api.listWorkProductMetadata).toHaveBeenCalledOnce());
    expect(api.getWorkProduct).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Other draft" })).not.toBeInTheDocument();
  });

  it("searches the active project's files from the primary picker", async () => {
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      LibraryPicker={LibraryDocumentPicker}
      route={{ ...workspaceRoute(), projectId: "matter-1" }} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Project" }));
    await waitFor(() => expect(api.directoryResource).toHaveBeenCalledWith({ projectId: "matter-1" }));
    expect(api.directoryList).toHaveBeenCalledWith({ q: "", limit: 30 }, expect.any(AbortSignal));
  });

  it("binds a project PDF to an authority and book slot through the shared picker", async () => {
    const saved = add(draft(), authority("grant", "R v Grant", { kind: "unresolved" }));
    saved.projectId = "matter-1";
    const document = { id: "pdf-1", project_id: "matter-1", filename: "Grant.pdf",
      file_type: "pdf", pdf_storage_path: null, size_bytes: 100, page_count: 4,
      created_at: "2026-09-01T00:00:00Z", current_version_id: "version-2" };
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthoritiesLibraryPdf.mockResolvedValue(saved);
    api.directoryList.mockResolvedValue({ items: [{ kind: "document", document }], next_cursor: null });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      LibraryPicker={LibraryDocumentPicker}
      route={{ ...workspaceRoute(saved.id), projectId: "matter-1" }} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("tab", { name: "Sources", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Upload for R v Grant" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Choose from Project" }));
    await userEvent.click(await screen.findByRole("button", { name: /Grant\.pdf/u }));
    await waitFor(() => expect(api.attachAuthoritiesLibraryPdf).toHaveBeenLastCalledWith(
      saved.id, saved.revision, document.id, document.current_version_id,
      { kind: "authority", authorityId: "grant", language: "en" }));

    await userEvent.click(screen.getByRole("tab", { name: "Build book", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Choose Cover from Project" }));
    await userEvent.click(await screen.findByRole("button", { name: /Grant\.pdf/u }));
    await waitFor(() => expect(api.attachAuthoritiesLibraryPdf).toHaveBeenLastCalledWith(
      saved.id, saved.revision, document.id, document.current_version_id,
      { kind: "book", slot: "cover", supplementId: undefined }));
  });

  it("resumes the last Authorities draft until the user starts a new one", async () => {
    const saved = documentDraft("last-draft", "Last draft"), load = deferred<AuthoritiesProduct>();
    localStorage.setItem("beaver.authorities.last.library", saved.id);
    api.getWorkProduct.mockReturnValue(load.promise);
    const route = workspaceRoute();
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={route} /></MemoryRouter>);

    expect(screen.getByText("Loading authorities")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Import and review" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.getWorkProduct).toHaveBeenCalledWith("last-draft"));
    expect(screen.queryByRole("heading", { name: "Import and review" })).not.toBeInTheDocument();
    load.resolve(saved);
    expect(await screen.findByRole("heading", { name: "Last draft" })).toBeVisible();
    expect(api.getWorkProduct).toHaveBeenCalledWith("last-draft");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    expect(screen.getByRole("heading", { name: "Import and review" })).toBeVisible();
    expect(localStorage.getItem("beaver.authorities.last.library")).toBeNull();
    expect(route.replaceDraft).toHaveBeenLastCalledWith();
  });

  it("restores the saved draft after briefly opening the other start mode", async () => {
    const saved = documentDraft("active", "Active authorities");
    api.getWorkProduct.mockResolvedValue(saved);
    const route = workspaceRoute(saved.id);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={route} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Active authorities" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));

    expect(screen.getByRole("heading", { name: "Build a book from PDFs" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Manual" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem("beaver.authorities.last.library")).toBe("active");
    expect(route.replaceDraft).toHaveBeenLastCalledWith();

    await userEvent.click(screen.getByRole("tab", { name: "Automatic" }));
    expect(screen.getByRole("heading", { name: "Active authorities" })).toBeVisible();
    expect(route.replaceDraft).toHaveBeenLastCalledWith("active");
  });

  it("keeps an automatic draft title out of a new manual book", async () => {
    const saved = documentDraft("active", "Imported factum");
    const renamed = { ...saved, title: "Appeal factum", revision: 2 };
    api.getWorkProduct.mockResolvedValue(saved);
    api.updateWorkProduct.mockResolvedValue(renamed);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute(saved.id)} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Imported factum" });
    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    expect(screen.getByLabelText("Book title")).toHaveValue("Book of Authorities");
    await userEvent.click(screen.getByRole("tab", { name: "Automatic" }));
    await userEvent.click(screen.getByRole("button", { name: "authorities draft actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = screen.getByLabelText("Rename authorities draft");
    await userEvent.clear(title); await userEvent.type(title, renamed.title); fireEvent.blur(title);
    await waitFor(() => expect(api.updateWorkProduct).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    expect(screen.getByLabelText("Book title")).toHaveValue("Book of Authorities");
  });

  it("gives a routed draft precedence over a remembered draft", async () => {
    const remembered = documentDraft("remembered", "Remembered");
    const requested = documentDraft("requested", "Requested");
    const { state: _state, ...rememberedMetadata } = remembered;
    localStorage.setItem("beaver.authorities.last.library", remembered.id);
    api.listWorkProductMetadata.mockResolvedValue([rememberedMetadata]);
    api.getWorkProduct.mockResolvedValue(requested);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute(requested.id)} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Requested" })).toBeVisible();
    expect(api.getWorkProduct).toHaveBeenCalledTimes(1);
    expect(api.getWorkProduct).toHaveBeenCalledWith("requested");
  });

  it("applies import options without asking a Table-only draft for PDFs", async () => {
    api.uploadAuthoritiesDocument.mockResolvedValue({ id: "uploaded-document" });
    const created = add(documentDraft(), authority("case", "Example v Example",
      { kind: "unresolved" }));
    created.state.settings.sourceMode = "manual-originals";
    api.createAuthorities.mockResolvedValue(created);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);
    const file = new File(["PK\x03\x04"], "Factum.docx", { type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });

    await userEvent.upload(screen.getByLabelText("Add file"), file);
    const setup = screen.getByRole("dialog", { name: "Import options" });
    await userEvent.click(within(setup).getByLabelText(/Use available original PDFs and manually add the PDFs myself for the rest/));
    await userEvent.click(within(setup).getByLabelText(/Highlight exact quotes/));
    await userEvent.click(within(setup).getByRole("button", { name: "Import and review" }));

    await waitFor(() => expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "document", documentId: "uploaded-document", version: "latest" },
      title: "Factum", projectId: undefined,
      settings: { profileId: "general", sourceMode: "manual-originals", passageMarking: "text" },
    }));
    expect(await screen.findByRole("button", { name: "Done" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add file for Example v Example")).not.toBeInTheDocument();
  });

  it("restores the rebuild-from-text preference", async () => {
    localStorage.setItem("beaver.authorities.preferences", JSON.stringify({
      profileId: "general", sourceMode: "render", passageMarking: "margin",
    }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: /Rebuild all sources from text/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /Automatic sources/ }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.upload(screen.getByLabelText("Add file"), new File(["PK"], "Factum.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }));
    expect(within(screen.getByRole("dialog", { name: "Import options" }))
      .getByRole("radio", { name: /Automatic sources/ })).toBeChecked();
  });

  it("normalizes Federal passage marking and omits the invalid no-marks choice", async () => {
    localStorage.setItem("beaver.authorities.preferences", JSON.stringify({
      profileId: "federal-court", sourceMode: "automatic", passageMarking: "none",
    }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("radio", { name: /Paragraph line and exact quote/ })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /No passage marks/ })).not.toBeInTheDocument();
  });

  it("creates a manual book in manual order and rejects a table-only court default", async () => {
    const created = draft(); created.state.outputMode = "book";
    created.state.settings.sourceMode = "manual-originals";
    created.state.settings.passageMarking = "none";
    const added = add({ ...created, revision: 2, state: structuredClone(created.state) },
      authority("manual-1", "First decision", { kind: "unresolved" }));
    const attached = add({ ...added, revision: 3, state: structuredClone(added.state) },
      authority("manual-1", "First decision", attachedSource("manual-1", "First decision.pdf")));
    api.createAuthorities.mockResolvedValue(created);
    api.actOnAuthorities.mockResolvedValue(added);
    api.attachAuthorityPdf.mockResolvedValue(attached);
    localStorage.setItem("beaver.authorities.preferences", JSON.stringify({
      profileId: "ab-court-of-appeal", sourceMode: "automatic", passageMarking: "none",
    }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    const file = new File(["%PDF-1.7"], "First decision.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Add files"), file);

    await waitFor(() => expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "manual" }, title: "Book of Authorities", projectId: undefined,
      settings: { profileId: "general", sourceMode: "manual-originals",
        passageMarking: "margin", outputMode: "book" },
    }));
  });

  it("starts a manual book from an existing Library PDF without uploading it", async () => {
    const created = draft(); created.state.outputMode = "book";
    const added = add({ ...created, revision: 2, state: structuredClone(created.state) },
      authority("manual-1", "First decision", { kind: "unresolved" }));
    const attached = add({ ...added, revision: 3, state: structuredClone(added.state) },
      authority("manual-1", "First decision", attachedSource("manual-1", "First decision.pdf")));
    const document = { id: "pdf-1", project_id: null, filename: "First decision.pdf",
      file_type: "pdf", pdf_storage_path: null, size_bytes: 100, page_count: 4,
      created_at: "2026-09-01T00:00:00Z", current_version_id: "version-2" };
    api.createAuthorities.mockResolvedValue(created);
    api.actOnAuthorities.mockResolvedValue(added);
    api.attachAuthoritiesLibraryPdf.mockResolvedValue(attached);
    api.directoryList.mockResolvedValue({ items: [{ kind: "document", document }], next_cursor: null });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      LibraryPicker={LibraryDocumentPicker} route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await userEvent.click(screen.getByRole("button", { name: "Library" }));
    await userEvent.click(await screen.findByRole("button", { name: /First decision\.pdf/u }));

    await waitFor(() => expect(api.attachAuthoritiesLibraryPdf).toHaveBeenCalledWith(
      created.id, added.revision, document.id, document.current_version_id,
      { kind: "authority", authorityId: "manual-1", language: "en" }));
    expect(api.uploadAuthoritiesDocument).not.toHaveBeenCalled();
  });

  it("keeps English and French enactment PDFs under one Federal tab", async () => {
    const english = attachedSource("authority:code:en", "Criminal Code English.pdf");
    const law = authority("code", "Criminal Code", english);
    Object.assign(law, { kind: "legislation", citation: "RSC 1985, c C-46" });
    const saved = add(draft(), law); saved.state.outputMode = "book";
    saved.state.settings.profileId = "federal-court";
    saved.state.stage = "sources";
    const updated = structuredClone(saved); updated.revision = 2;
    if (updated.state.authorities.code.source.kind === "attached") {
      updated.state.authorities.code.source.sources.push({
        bindingRole: "authority:code:fr", filename: "Code criminel français.pdf",
        sourceSha256: "b".repeat(64), sourceUrl: null, origin: "manual", language: "fr",
      });
    }
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthorityPdf.mockResolvedValue(updated);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "View PDF for Criminal Code" })).toBeVisible();
    const row = screen.getByRole("heading", { name: "Criminal Code" }).closest("article")!;
    const file = new File(["%PDF-fr"], "Code criminel français.pdf", { type: "application/pdf" });
    await userEvent.upload(within(row).getByLabelText("Upload PDF for Criminal Code"), file);
    await userEvent.click(screen.getByRole("button", { name: /^French\./u }));

    await waitFor(() => expect(api.attachAuthorityPdf)
      .toHaveBeenCalledWith("draft-1", "code", 1, file, "fr"));
    expect(await screen.findByRole("button", { name: "View PDFs for Criminal Code" })).toBeVisible();
    expect(screen.getByText("Tab 1")).toBeVisible();
  });

  it("loads only the draft named by the route", async () => {
    api.listWorkProductMetadata.mockResolvedValue([
      (({ state: _state, ...item }) => item)(draft("other", "Other draft")),
    ]);
    api.getWorkProduct.mockResolvedValue(documentDraft("wanted", "Wanted draft"));
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=wanted"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} route={workspaceRoute("wanted")} />
    </MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Wanted draft" })).toBeVisible();
    expect(api.getWorkProduct).toHaveBeenCalledTimes(1);
    expect(api.getWorkProduct).toHaveBeenCalledWith("wanted");
    expect(screen.queryByRole("heading", { name: "Other draft" })).not.toBeInTheDocument();
  });

  it("reserves the workspace height while a route draft is loading", async () => {
    const load = deferred<AuthoritiesProduct>();
    api.getWorkProduct.mockReturnValue(load.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(screen.getByText("Loading authorities")).toBeVisible();
    load.resolve(draft());
    expect(await screen.findByRole("heading", { name: "Book of Authorities" })).toBeVisible();
  });

  it("lets only the latest route load replace the workspace", async () => {
    const loads = new Map(["a", "b", "c"].map((id) => [id, deferred<AuthoritiesProduct>()]));
    api.getWorkProduct.mockImplementation((id: string) => loads.get(id)!.promise);
    const view = render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("a")} /></MemoryRouter>);
    await waitFor(() => expect(api.getWorkProduct).toHaveBeenCalledWith("a"));

    view.rerender(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("b")} /></MemoryRouter>);
    view.rerender(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("c")} /></MemoryRouter>);
    loads.get("b")!.resolve(draft("b", "Draft B"));
    loads.get("a")!.resolve(draft("a", "Draft A"));
    loads.get("c")!.resolve(draft("c", "Draft C"));

    expect(await screen.findByRole("heading", { name: "Draft C" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Draft A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Draft B" })).not.toBeInTheDocument();
  });

  it("keeps an explicitly selected global tab while a route draft is loading", async () => {
    const load = deferred<AuthoritiesProduct>();
    api.getWorkProduct.mockReturnValue(load.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    await waitFor(() => expect(api.getWorkProduct).toHaveBeenCalledWith("draft-1"));
    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));

    load.resolve(documentDraft());
    await waitFor(() => expect(screen.getByRole("tab", { name: "Drafts" }))
      .toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByRole("heading", { name: "Requested draft" })).toBeVisible();
  });

  it("keeps the current draft visible while a new route is loading", async () => {
    const next = deferred<AuthoritiesProduct>();
    api.getWorkProduct.mockResolvedValueOnce(documentDraft("a", "Draft A"))
      .mockReturnValueOnce(next.promise);
    const view = render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("a")} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Draft A" })).toBeVisible();

    view.rerender(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("missing")} /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Draft A" })).toBeVisible();
    next.reject(new Error("Draft missing"));
    expect(await screen.findByText("Draft missing")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Draft A" })).toBeVisible();
  });

  it("opens settings over the selected workspace section", async () => {
    api.getWorkProduct.mockResolvedValue(documentDraft());
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Requested draft" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));
    expect(screen.getByRole("heading", { name: "Requested draft" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Requested draft" })).toBeVisible();
  });

  it("keeps the drafts surface in a loading state until metadata arrives", async () => {
    const load = deferred<WorkProductMetadata[]>(), saved = draft("saved", "Saved book");
    saved.updatedAt = new Date(2026, 8, 9, 1, 34, 56).toISOString();
    const { state: _state, ...metadata } = saved;
    api.listWorkProductMetadata.mockReturnValue(load.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));
    expect(screen.getByText("Loading saved drafts")).toBeVisible();
    expect(screen.queryByText("No saved drafts yet.")).not.toBeInTheDocument();
    load.resolve([metadata]);
    expect(await screen.findByText("Saved book")).toBeVisible();
    expect(screen.getByText("September 9, 2026 1:34 AM")).toBeVisible();
  });

  it("labels a draft-opening operation without deriving it from the selected tab", async () => {
    const load = deferred<AuthoritiesProduct>(), saved = draft("saved", "Saved book");
    const { state: _state, ...metadata } = saved;
    api.listWorkProductMetadata.mockResolvedValue([metadata]);
    api.getWorkProduct.mockReturnValue(load.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));
    await userEvent.click(await screen.findByText("Saved book"));
    expect(screen.getByRole("status")).toHaveTextContent("Opening draft");
    load.resolve(saved);
    expect(await screen.findByRole("heading", { name: "Saved book" })).toBeVisible();
  });

  it("shows the optional output-folder setting without changing the shared workspace", async () => {
    const outputFolder = { get: vi.fn().mockResolvedValue("Court outputs"),
      choose: vi.fn().mockResolvedValue("Appeal outputs"), clear: vi.fn().mockResolvedValue(undefined) };
    render(<MemoryRouter><AuthoritiesWorkspace
      host={{ ...beaverAuthoritiesHost, outputFolder }} route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Court outputs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(await screen.findByText("Appeal outputs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByText("Not set")).toBeVisible());
  });

  it("opens the exact in-text citation without a confirmation gate", async () => {
    const saved = documentDraft();
    const citation = "2024 ABKB 1", styled = `R v Example, ${citation}`;
    saved.state.units = [{ id: "footnote:misleading", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: styled, occurrenceIds: ["occurrence-1"] }];
    saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "footnote:misleading",
      start: 0, end: styled.length, text: styled, kind: "case", citation,
      authoritySpan: { start: 0, end: styled.length, text: styled },
      coreSpan: { start: styled.indexOf(citation), end: styled.length, text: citation }, pinpointSpan: null,
      authorityId: "authority-1", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };
    const identity = authority("authority-1", "R v Example", { kind: "unresolved" });
    identity.citation = citation; add(saved, identity);
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue({ ...saved, revision: 2 });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} route={workspaceRoute("draft-1")} />
    </MemoryRouter>);

    const item = await screen.findByRole("option", { name: /In-text citation 1/ });
    expect(item).toHaveTextContent(citation);
    const context = screen.getByRole("textbox", { name: "In-text citation context" });
    expect(context).toHaveTextContent(styled);
    expect(context.querySelector("mark")).toHaveTextContent(styled);
    expect(within(context.parentElement!).getAllByRole("button").map(({ textContent }) => textContent))
      .toEqual(["Use selection as citation", "Use selection as pinpoint", "Split at cursor",
        "Merge with previous", "Not a citation"]);
    expect(screen.queryByRole("checkbox", { name: "Reviewed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
  });

  it("submits a DOM selection across existing marks and clears the stale selection", async () => {
    const saved = documentDraft(), text = "😀 See R v Example, 2024 ABKB 1 at para 12.";
    const start = text.indexOf("R v"), pinpoint = text.indexOf("at para"), end = text.length - 1;
    saved.state.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["occurrence-1"] }];
    saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:1",
      start, end, text: text.slice(start, end), kind: "case", citation: "2024 ABKB 1",
      authoritySpan: { start, end, text: text.slice(start, end) },
      coreSpan: { start: text.indexOf("2024"), end: pinpoint - 1, text: "2024 ABKB 1" },
      pinpointSpan: { start: pinpoint, end, text: text.slice(pinpoint, end) },
      authorityId: "authority-1", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };
    add(saved, { ...authority("authority-1", "R v Example", { kind: "unresolved" }),
      citation: "2024 ABKB 1" });
    const changed = structuredClone(saved); changed.revision = 2;
    changed.state.occurrences["occurrence-1"].authoritySpan =
      { start: 0, end, text: text.slice(0, end) };
    changed.state.occurrences["occurrence-1"].reviewed = true;
    const update = deferred<AuthoritiesProduct>(), onDraftChange = vi.fn();
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockReturnValue(update.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} onDraftChange={onDraftChange} /></MemoryRouter>);

    const context = await screen.findByRole("textbox", { name: "In-text citation context" });
    expect(api.reviewAuthorities).not.toHaveBeenCalled();
    expect([...context.querySelectorAll<HTMLElement>("[data-authority-span]")]
      .map((node) => node.textContent).join("")).toBe(text.slice(start, end));
    expect([...context.querySelectorAll<HTMLElement>("[data-pinpoint-span]")]
      .map((node) => node.textContent).join("")).toBe(text.slice(pinpoint, end));
    expect(context.querySelector("[data-authority-span][data-pinpoint-span]")).not.toBeNull();

    selectRange(context, 0, end);
    const useSelection = screen.getByRole("button", { name: "Use selection as citation" });
    expect(useSelection).toBeEnabled();
    await userEvent.click(useSelection);
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1, {
      type: "set-authority-span", occurrenceId: "occurrence-1", start: 0, end,
    }));
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Updating authorities");
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(saved, false));
    expect(useSelection).toBeDisabled();
    update.resolve(changed);
    await waitFor(() => expect(useSelection).toBeDisabled());
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(changed, true));
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it("keeps the right citation selected after splitting a later footnote span", async () => {
    const saved = documentDraft(), text = "Alpha; Beta", split = text.indexOf("Beta");
    const occurrence = (id: string, start: number, end: number, ordinal: number) => ({
      id, unitId: "footnote:1", start, end, text: text.slice(start, end), kind: "other" as const,
      citation: text.slice(start, end), authoritySpan: { start, end, text: text.slice(start, end) },
      coreSpan: { start, end, text: text.slice(start, end) }, pinpointSpan: null,
      authorityId: null, reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: ordinal, reviewed: false,
    });
    saved.state.units = [{ id: "footnote:1", kind: "footnote", ordinal: 0, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["whole"] }];
    saved.state.occurrences = { whole: occurrence("whole", 0, text.length, 0) };
    const changed = structuredClone(saved); changed.revision = 2;
    changed.state.units[0].occurrenceIds = ["left", "right"];
    changed.state.occurrences = {
      left: occurrence("left", 0, split, 0),
      right: occurrence("right", split, text.length, 1),
    };
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue(changed);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const context = await screen.findByRole("textbox", { name: "Footnote context" });
    selectRange(context, split);
    await userEvent.click(screen.getByRole("button", { name: "Split at cursor" }));
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1, {
      type: "split-occurrence", occurrenceId: "whole", cursor: split,
    }));
    expect(await screen.findByRole("option", { name: /Beta/ })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps parallel citation forms visible under one authority", async () => {
    const saved = documentDraft(), neutral = "2009 SCC 32", reporter = "[2009] 2 SCR 353";
    const text = `${neutral}; ${reporter}`;
    const occurrence = (id: string, citation: string, start: number, ordinal: number) => ({
      id, unitId: "footnote:1", start, end: start + citation.length, text: citation,
      kind: "case" as const, citation,
      authoritySpan: { start, end: start + citation.length, text: citation },
      coreSpan: { start, end: start + citation.length, text: citation }, pinpointSpan: null,
      authorityId: "grant", reference: null, pinpoints: [], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: ordinal, reviewed: true,
    });
    saved.state.units = [{ id: "footnote:1", kind: "footnote", ordinal: 0, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["neutral", "reporter"] }];
    saved.state.occurrences = {
      neutral: occurrence("neutral", neutral, 0, 0),
      reporter: occurrence("reporter", reporter, text.indexOf(reporter), 1),
    };
    add(saved, { ...authority("grant", "R v Grant", { kind: "resolved" }),
      citation: neutral });
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByRole("option", { name: new RegExp(neutral) })).toBeVisible();
    expect(screen.getByRole("option", { name: /\[2009\] 2 SCR 353/u })).toBeVisible();
    api.prepareAuthoritiesSources.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue({ ...saved, revision: 2, state: { ...saved.state, stage: "sources" } });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    const sources = (await screen.findByRole("list", { name: "Authority tab slots" })).closest("section")!;
    expect(within(sources).getAllByRole("listitem")).toHaveLength(1);
    expect(within(sources).getByText(`${neutral}; ${reporter}`)).toBeInTheDocument();
  });

  it("links a cross-reference through the authority chooser", async () => {
    const saved = documentDraft(), text = "2024 ABKB 1; Ibid", ibidStart = text.indexOf("Ibid");
    const span = (start: number, end: number) => ({ start, end, text: text.slice(start, end) });
    saved.state.units = [{ id: "footnote:1", kind: "footnote", ordinal: 0, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["full", "ibid"] }];
    saved.state.occurrences = {
      full: { id: "full", unitId: "footnote:1", ...span(0, 11), kind: "case",
        citation: "2024 ABKB 1", authoritySpan: span(0, 11), coreSpan: span(0, 11),
        pinpointSpan: null, authorityId: "authority-1", reference: null, pinpoints: [],
        evidenceIds: [], sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false },
      ibid: { id: "ibid", unitId: "footnote:1", ...span(ibidStart, text.length),
        kind: "reference", citation: "Ibid", authoritySpan: span(ibidStart, text.length),
        coreSpan: span(ibidStart, text.length), pinpointSpan: null, authorityId: null,
        reference: null, pinpoints: [], evidenceIds: [], sourceTextSha256: "a".repeat(64),
        localOrdinal: 1, reviewed: false },
    };
    add(saved, { ...authority("authority-1", "Example v Example", { kind: "unresolved" }),
      citation: "2024 ABKB 1" });
    const changed = structuredClone(saved); changed.revision = 2;
    Object.assign(changed.state.occurrences.ibid, { authorityId: "authority-1",
      reference: { kind: "ibid" as const, targetAuthorityId: "authority-1" }, reviewed: true });
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue(changed);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const source = await screen.findByRole("option", { name: /Ibid/ });
    await userEvent.click(source);
    await userEvent.click(screen.getByRole("button", { name: "Link to authority" }));
    const chooser = screen.getByRole("dialog", { name: "Link to authority" });
    await userEvent.click(within(chooser).getByRole("button", { name: /Example v Example/ }));
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1, {
      type: "set-reference", occurrenceId: "ibid",
      reference: { kind: "ibid", targetAuthorityId: "authority-1" },
    }));
    expect(screen.queryByRole("dialog", { name: "Link to authority" })).not.toBeInTheDocument();
    expect(await screen.findByText("Linked to Example v Example, 2024 ABKB 1")).toBeVisible();
    expect(source).toHaveAttribute("aria-selected", "true");
  });

  it("fetches after citation review and reveals Sources only when acquisition finishes", async () => {
    const saved = add(documentDraft(), authority("resolved", "Fetchable decision",
      { kind: "resolved" }), authority("missing", "Missing decision", { kind: "unresolved" }));
    saved.state.outputMode = "book";
    const pending = deferred<AuthoritiesProduct>();
    api.getWorkProduct.mockResolvedValue(saved);
    api.prepareAuthoritiesSources.mockReturnValue(pending.promise);
    api.actOnAuthorities.mockImplementation(async (_id, _revision, action) => ({
      ...saved, revision: 2, state: { ...saved.state, stage: action.stage },
    }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    await screen.findByRole("button", { name: "Done" });
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(api.prepareAuthoritiesSources).toHaveBeenCalledWith(saved.id, saved.revision, expect.any(AbortSignal));
    expect(screen.queryByRole("list", { name: "Authority tab slots" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(saved));
    const sources = (await screen.findByRole("list", { name: "Authority tab slots" })).closest("section")!;
    expect(sources).toBeVisible();
    expect(within(sources).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Done$/u })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
  });

  it("offers an ordinary PDF attachment for an unlinked Alberta appeal authority", async () => {
    const saved = add(documentDraft(), authority("case", "Example v Example",
      { kind: "unresolved" }));
    saved.state.import = { kind: "document", bindingRole: "source", filename: "Factum.pdf",
      fileType: "pdf", snapshot: null };
    saved.state.settings.profileId = "ab-court-of-appeal";
    saved.state.insertIntoDocument = true;
    saved.outputs["annotated-document"] = { documentId: "filing", versionId: "v1",
      filename: "Factum.with-table-of-authorities.pdf", mimeType: "application/pdf",
      sha256: "f".repeat(64), pageCount: 4 };
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const sources = (await screen.findByRole("list", { name: "Authority tab slots" })).closest("section")!;
    expect(sources).toBeVisible();
    expect(within(sources).getByRole("button", { name: "Upload for Example v Example" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Build outputs" })).not.toBeInTheDocument();
  });

  it("never offers the Word-copy control for a Book-only draft", async () => {
    const saved = documentDraft();
    saved.state.outputMode = "book";
    saved.state.insertIntoDocument = true;
    saved.state.stage = "build";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await screen.findByRole("heading", { name: "Build outputs" });
    await userEvent.click(screen.getByText("Options"));
    expect(screen.queryByRole("checkbox", { name: "Add the table to a Word copy" }))
      .not.toBeInTheDocument();
  });

  it("shows a high-confidence source discrepancy inside the fixed citation review", async () => {
    const saved = documentDraft(), citation = addReviewCandidate(saved);
    api.getWorkProduct.mockResolvedValue(saved);
    const findingId = "d".repeat(64);
    api.reviewAuthorities.mockResolvedValue([{ id: findingId,
      actions: ["ignore", "quote_editorial"], kind: "quote_mismatch",
      occurrenceId: "occurrence-1", authorityId: "authority-1", footnoteId: 1, citation,
      proposition: "The court wrote this.", authoredQuote: "the authored words",
      authoredPinpoint: { kind: "paragraph", text: "7" },
      cited: { locator: { kind: "paragraph", label: "7" }, text: "the source words" },
      found: { locator: { kind: "paragraph", label: "7" }, text: "the source words" } }]);
    const corrected = structuredClone(saved); corrected.revision = 2;
    corrected.state.discrepancyDecisions[findingId] = "quote_editorial";
    api.resolveAuthoritiesDiscrepancy.mockResolvedValue(corrected);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByText("Check quotation")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Review quotation" }));
    expect(screen.getByText((_text, node) => node?.tagName === "P" && node.textContent === "the authored words")).toBeVisible();
    expect(screen.getByText((_text, node) => node?.tagName === "P" && node.textContent === "the source words")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use source wording" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Mark edits with brackets and ellipses (edits your .docx)" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply correction" }));
    await waitFor(() => expect(api.resolveAuthoritiesDiscrepancy).toHaveBeenCalledWith(
      "draft-1", { id: findingId, action: "quote_editorial", revision: 1 }));
    expect(await screen.findByText("Source corrected and draft refreshed")).toBeVisible();
  });

  it("rejects a pending settings result and review after opening another draft", async () => {
    const first = documentDraft("first", "First draft"), second = draft("second", "Second draft");
    addReviewCandidate(first); first.state.stage = "build";
    const update = deferred<AuthoritiesProduct>(), review = deferred<never[]>();
    api.getWorkProduct.mockImplementation(async (id: string) => id === "first" ? first : second);
    api.actOnAuthorities.mockReturnValue(update.promise);
    api.reviewAuthorities.mockReturnValue(review.promise);
    const view = render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("first")} /></MemoryRouter>);
    await userEvent.selectOptions(await screen.findByLabelText("Create"), "book");
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("first", 1,
      { type: "set-output-mode", outputMode: "book" }));
    view.rerender(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("second")} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Second draft" })).toBeVisible();
    await act(async () => {
      update.resolve({ ...first, revision: 2, state: { ...first.state, outputMode: "book" } });
      review.reject(new Error("Late review failure"));
    });
    expect(screen.getByRole("heading", { name: "Second draft" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "First draft" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Late review failure/u)).not.toBeInTheDocument();
    expect(localStorage.getItem("beaver.authorities.last.library")).toBe("second");
  });

  it("surfaces source-check failures and does not rerun review after a build-only revision", async () => {
    const saved = documentDraft(), built = { ...saved, revision: 2 };
    addReviewCandidate(saved);
    saved.state.stage = "build";
    api.getWorkProduct.mockResolvedValue(saved);
    api.reviewAuthorities.mockRejectedValueOnce(new Error("Source service unavailable"))
      .mockResolvedValue([]);
    api.prepareAuthoritiesSources.mockResolvedValue(saved);
    api.buildAuthorities.mockResolvedValue({ product: built, receipt: {} });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByText("Source check unavailable. Source service unavailable"))
      .toBeVisible();
    expect(api.reviewAuthorities).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(api.buildAuthorities).toHaveBeenCalledOnce());
    expect(api.reviewAuthorities).toHaveBeenCalledTimes(1);
  });

  it("keeps source status and outputs stable while a citation-only edit is saved", async () => {
    const saved = draft(), changed = structuredClone(saved), update = deferred<AuthoritiesProduct>();
    saved.outputs.book = { documentId: "book", versionId: "book-v1",
      filename: "Book of Authorities.pdf", mimeType: "application/pdf",
      sha256: "a".repeat(64), pageCount: 4 };
    changed.outputs = structuredClone(saved.outputs);
    changed.revision = 2;
    changed.state.settings.tabStyle = "alpha";
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {}, freshness: "current" });
    api.actOnAuthorities.mockReturnValue(update.promise);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const download = await screen.findByRole("button", { name: "Download Book of Authorities.pdf" });
    await waitFor(() => expect(api.getWorkProductResolution).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByText("Options"));
    await userEvent.selectOptions(screen.getByLabelText("Tabs"), "alpha");

    expect(download).toBeEnabled();
    expect(screen.queryByText("Previous build — rebuild to update")).not.toBeInTheDocument();
    expect(api.getWorkProductResolution).toHaveBeenCalledTimes(1);
    update.resolve(changed);
    expect(await screen.findByText("Previous build — rebuild to update")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download previous Book of Authorities.pdf" }))
      .toBeEnabled();
    expect(api.getWorkProductResolution).toHaveBeenCalledTimes(1);
  });

  it("keeps prepared sources revisitable when the final build fails", async () => {
    const saved = add(documentDraft(), authority("case", "Example v Example",
      { kind: "unresolved" }));
    saved.state.outputMode = "book";
    const prepared = structuredClone(saved); prepared.revision = 2;
    prepared.state.authorities.case.source = attachedSource("authority:case", "Decision.pdf", "a",
      "https://decisions.example/case.pdf", "original");
    prepared.state.bindings["authority:case"] = {
      kind: "document", documentId: "pdf-1", version: "latest" };
    prepared.state.stage = "build";
    api.getWorkProduct.mockResolvedValue(prepared);
    api.prepareAuthoritiesSources.mockResolvedValue(prepared);
    api.getDocumentParseStates.mockResolvedValue([{ id: "pdf-1",
      parse_state: { status: "ready" } }]);
    api.buildAuthorities.mockRejectedValue(new Error("The book could not be built"));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Build" }));

    expect(await screen.findByText("The book could not be built")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Sources", exact: true }));
    expect(screen.getByRole("img", { name: "Decision.pdf" })).toBeVisible();
  });

  it.each(["federal-court", "ab-court-of-kings-bench"] as const)(
    "stops a required-source %s book before final build", async (profile) => {
      const saved = add(documentDraft(),
        authority("missing", "Missing decision", { kind: "unresolved" }));
      saved.state.outputMode = "book"; saved.state.stage = "build";
      saved.state.settings.profileId = profile;
      saved.state.settings.sourceMode = "manual-originals";
      if (profile === "federal-court") {
        saved.state.settings.bookRole = "applicant";
        saved.state.cover = { courtFileNumber: "T-123-26", applicationUnder: "", title: "",
          partyGroups: [{ role: "Applicant", parties: ["Ada North"] },
            { role: "Respondent", parties: ["River South"] }] };
      }
      const prepared = structuredClone(saved); prepared.revision = 2;
      prepared.title = `${profile} prepared`;
      api.getWorkProduct.mockResolvedValue(saved);
      api.prepareAuthoritiesSources.mockResolvedValue(prepared);
      api.buildAuthorities.mockResolvedValue({ product: prepared, receipt: {} });
      render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
        route={workspaceRoute("draft-1")} /></MemoryRouter>);

      await userEvent.click(await screen.findByRole("button", { name: "Build" }));

      const warning = await screen.findByRole("dialog", { name: /Missing PDFs/u });
      expect(within(warning).getByText(/1 authority has no PDF/u)).toBeVisible();
      expect(api.buildAuthorities).not.toHaveBeenCalled();
      await userEvent.click(within(warning).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog", { name: /Missing PDFs/u })).not.toBeInTheDocument();
      expect(api.buildAuthorities).not.toHaveBeenCalled();
    });

  it("remembers a missing attached PDF and offers its replacement", async () => {
    const saved = add(draft(), authority("alpha", "Alpha",
      attachedSource("authority:alpha", "alpha.pdf")));
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {
      "authority:alpha": { status: "missing", reason: "deleted" },
    } });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const row = (await screen.findByRole("heading", { name: "Alpha" })).closest("article")!;
    expect(await within(row).findByText("PDF unavailable")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Replace for Alpha" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Relink PDF" })).not.toBeInTheDocument();
  });

  it("replaces or removes a PDF without deleting its procedural slot", async () => {
    const saved = add(draft(), authority("alpha", "Alpha",
      attachedSource("authority:alpha", "alpha.pdf")));
    saved.state.stage = "sources";
    const replaced = structuredClone(saved); replaced.revision = 2;
    replaced.state.authorities.alpha.source = attachedSource("authority:alpha", "replacement.pdf", "b");
    const cleared = structuredClone(replaced); cleared.revision = 3;
    cleared.state.authorities.alpha.source = { kind: "unresolved" };
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthorityPdf.mockResolvedValue(replaced);
    api.actOnAuthorities.mockResolvedValue(cleared);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const row = (await screen.findByRole("heading", { name: "Alpha" })).closest("article")!;
    const replacement = new File(["%PDF-1.7"], "replacement.pdf", { type: "application/pdf" });
    await userEvent.upload(within(row).getByLabelText("Upload PDF for Alpha"), replacement);
    await waitFor(() => expect(api.attachAuthorityPdf)
      .toHaveBeenCalledWith("draft-1", "alpha", 1, replacement, "en"));
    await userEvent.click(within(row).getByRole("button", { name: "Options for Alpha" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove PDF" }));
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 2,
      { type: "clear-authority-source", authorityId: "alpha" }));
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeVisible();
    expect(screen.getByText("Tab 1")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Upload for Alpha" })).toBeVisible();
  });

  it("refreshes a changed Beaver input in place", async () => {
    const saved = documentDraft(), refreshed = { ...saved, revision: 2 };
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: { source: { status: "changed" } } });
    api.refreshAuthoritiesInput.mockResolvedValue(refreshed);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Use updated source" }));
    expect(api.refreshAuthoritiesInput).toHaveBeenCalledWith("draft-1", "source", 1);
  });

  it("does not show source issues from the previous draft while the next draft resolves", async () => {
    const first = documentDraft("first", "First draft"), second = documentDraft("second", "Second draft");
    const pending = deferred<{ inputs: Record<string, never> }>();
    api.getWorkProduct.mockImplementation(async (id) => id === "first" ? first : second);
    api.getWorkProductResolution.mockImplementation((id) => id === "first"
      ? Promise.resolve({ inputs: { source: { status: "changed" } } }) : pending.promise);
    const { rerender } = render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("first")} /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Use updated source" })).toBeVisible();

    rerender(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("second")} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Second draft" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Use updated source" })).not.toBeInTheDocument();
    await act(async () => pending.resolve({ inputs: {} }));
  });

  it("keeps authority order and reserves missing PDF slots while leaving out excluded entries", async () => {
    const legislation = authority("act", "Zulu Act", { kind: "unresolved" });
    legislation.kind = "legislation";
    const alpha = authority("alpha", "Alpha v Test", { kind: "unresolved" });
    alpha.excluded = true;
    const saved = add(documentDraft(), legislation,
      authority("beta", "Beta v Test", { kind: "unresolved" }), alpha);
    saved.state.outputMode = "book";
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const sources = (await screen.findByRole("list", { name: "Authority tab slots" })).closest("section")!;
    const rows = within(sources).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("heading").textContent))
      .toEqual(["Zulu Act", "Beta v Test", "Alpha v Test"]);
    expect(within(rows[0]).getByText("Tab 1")).toBeVisible();
    expect(within(rows[1]).getByText("Tab 2")).toBeVisible();
    expect(within(rows[2]).getByText("Excluded")).toBeVisible();
  });

  it.each(["manual", "document"] as const)("labels fixed slots with the configured tab format in %s mode", async (mode) => {
    const saved = add(mode === "manual" ? draft() : documentDraft(),
      authority("alpha", "Alpha", { kind: "unresolved" }),
      authority("beta", "Beta", { kind: "unresolved" }),
      authority("gamma", "Gamma", { kind: "unresolved" }));
    saved.state.outputMode = "book"; saved.state.stage = "sources";
    Object.assign(saved.state.settings, { tabStyle: "roman", tabStart: 4,
      tabPrefix: "Record ", tabLabels: ["Front", "", "End"] });
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    const sources = (await screen.findByRole("list", { name: "Authority tab slots" })).closest("section")!;
    const rows = within(sources).getAllByRole("listitem");
    rows.forEach((row, i) => {
      expect(within(row).getByRole("heading")).toHaveTextContent(["Alpha", "Beta", "Gamma"][i]);
      expect(within(row).getByText(["Front", "Record V", "End"][i])).toBeVisible();
    });
    expect(within(sources).queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("renames a manual draft and derives its procedural tabs", async () => {
    let current = add(draft(),
      authority("alpha", "Alpha", attachedSource("authority:alpha", "alpha.pdf")),
      authority("beta", "Beta", attachedSource("authority:beta", "beta.pdf", "b")));
    api.getWorkProduct.mockImplementation(async () => current);
    api.updateWorkProduct.mockImplementation(async (_id, patch) => {
      current = { ...current, title: patch.title ?? current.title, revision: current.revision + 1 };
      return current;
    });
    api.actOnAuthorities.mockImplementation(async (_id, _revision, action) => {
      const next = structuredClone(current); next.revision += 1;
      if (action.type === "set-settings") Object.assign(next.state.settings, action.settings);
      current = next; return next;
    });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} route={workspaceRoute("draft-1")} />
    </MemoryRouter>);

    await screen.findByRole("heading", { name: "Book of Authorities" });
    expect(screen.queryByLabelText("Book title")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "authorities draft actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const title = screen.getByLabelText("Rename authorities draft");
    await userEvent.clear(title); await userEvent.type(title, "Appeal authorities");
    fireEvent.blur(title);
    await waitFor(() => expect(api.updateWorkProduct).toHaveBeenCalledWith("draft-1",
      { revision: 1, title: "Appeal authorities" }));

    await userEvent.click(screen.getByRole("tab", { name: "Sources", exact: true }));
    expect(screen.getByText("Tab 1")).toBeVisible();
    expect(screen.getByText("Tab 2")).toBeVisible();
    expect(screen.queryByLabelText(/Tab for/u)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Build book", exact: true }));
    await userEvent.click(screen.getByText("Options"));
    await userEvent.selectOptions(screen.getByLabelText("Tabs"), "alpha");
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 2,
      { type: "set-settings", settings: { tabStyle: "alpha" } }));
    await userEvent.click(screen.getByRole("tab", { name: "Sources", exact: true }));
    expect(await screen.findByText("Tab A")).toBeVisible();
    expect(screen.getByText("Tab B")).toBeVisible();
  });

  it("uses one Add files seam to append PDFs to a populated manual book", async () => {
    const saved = add(draft(), authority("alpha", "Alpha",
      attachedSource("authority:alpha", "alpha.pdf")));
    saved.state.stage = "sources";
    const added = add({ ...saved, revision: 2, state: structuredClone(saved.state) },
      authority("alpha", "Alpha", saved.state.authorities.alpha.source),
      authority("beta", "Beta", { kind: "unresolved" }));
    const attached = add({ ...added, revision: 3, state: structuredClone(added.state) },
      authority("alpha", "Alpha", saved.state.authorities.alpha.source),
      authority("beta", "Beta", attachedSource("authority:beta", "beta.pdf", "b")));
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue(added);
    api.attachAuthorityPdf.mockResolvedValue(attached);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Alpha" });
    const file = new File(["%PDF-1.7"], "beta.pdf", { type: "application/pdf" });

    const authorities = screen.getByRole("list", { name: "Authority tab slots" }).closest("section")!;
    await userEvent.upload(within(authorities).getByLabelText("Upload"), file);

    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1,
      { type: "add-authority", kind: "other", citation: "beta", name: "beta" }));
    await waitFor(() => expect(api.attachAuthorityPdf)
      .toHaveBeenCalledWith("draft-1", "beta", 2, file, "en"));
    expect(api.attachAuthorityPdf).not.toHaveBeenCalledWith("draft-1", "alpha", 1, file, "en");
  });

  it("corrects filename-derived manual PDF identity in one editor", async () => {
    const mistaken = authority("grant", "2009scc32",
      attachedSource("authority:grant", "2009scc32.pdf"));
    Object.assign(mistaken, { kind: "other", citation: "2009scc32" });
    const saved = add(draft(), mistaken), corrected = structuredClone(saved);
    saved.state.stage = corrected.state.stage = "sources";
    corrected.revision = 2;
    Object.assign(corrected.state.authorities.grant,
      { kind: "case", citation: "2009 SCC 32", name: "R v Grant", displayName: null });
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {
      "authority:grant": { status: "missing", reason: "deleted" },
    } });
    api.actOnAuthorities.mockResolvedValue(corrected);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const row = (await screen.findByRole("heading", { name: "2009scc32" })).closest("article")!;
    expect(await within(row).findByText("PDF unavailable")).toBeVisible();
    expect(within(row).getByRole("button", { name: "Replace for 2009scc32" })).toBeVisible();
    await userEvent.click(within(row).getByRole("button", { name: "Options for 2009scc32" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));
    const dialog = screen.getByRole("dialog", { name: "Edit authority" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Type"), "case");
    await userEvent.clear(within(dialog).getByLabelText("Citation"));
    await userEvent.type(within(dialog).getByLabelText("Citation"), "2009 SCC 32");
    await userEvent.clear(within(dialog).getByLabelText(/Displayed title/u));
    await userEvent.type(within(dialog).getByLabelText(/Displayed title/u), "R v Grant");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1, {
      type: "edit-authority", authorityId: "grant", kind: "case",
      citation: "2009 SCC 32", name: "R v Grant",
    }));
    const correctedRow = (await screen.findByRole("heading", { name: "R v Grant" })).closest("article")!;
    expect(screen.getByText("2009 SCC 32")).toBeVisible();
    expect(within(correctedRow).getByText("PDF unavailable")).toBeVisible();
    expect(within(correctedRow).getByRole("button", { name: "Replace for R v Grant" })).toBeVisible();
  });

  it("opens the CanLII document page and offers a direct PDF attachment", async () => {
    const pdfUrl = "https://www.canlii.org/en/ca/scc/doc/1986/1986canlii46/1986canlii46.pdf";
    const saved = add(draft(),
      authority("oakes", "R v Oakes", { kind: "pending-canlii", authorityKey: "oakes",
        pageUrl: pdfUrl.replace(/\.pdf$/u, ".html"), pdfUrl }),
      authority("unknown", "Unresolved case", { kind: "unresolved" }));
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthorityPdf.mockResolvedValue({ ...saved, revision: 2 });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} route={workspaceRoute("draft-1")} />
    </MemoryRouter>);

    const known = (await screen.findByRole("heading", { name: "R v Oakes" })).closest("article")!;
    const unknown = screen.getByRole("heading", { name: "Unresolved case" }).closest("article")!;
    expect(within(unknown).queryByRole("link", { name: "CanLII" })).toBeNull();
    const handoff = within(known).getByRole("link", { name: "CanLII" });
    expect(handoff).toHaveAttribute("href", pdfUrl.replace(/\.pdf$/u, ".html"));
    expect(within(known).getByRole("button", { name: "Attach PDF for R v Oakes" })).toBeVisible();
    expect(handoff).toHaveAttribute("target", "_blank");
    expect(handoff).toHaveAttribute("rel", "noopener noreferrer");

    const file = new File(["%PDF-"], "oakes.pdf", { type: "application/pdf" });
    await userEvent.upload(within(known).getByLabelText("Upload PDF for R v Oakes"), file);
    await waitFor(() => expect(api.attachAuthorityPdf).toHaveBeenCalledWith(
      "draft-1", "oakes", 1, file, "en"));
  });

  it("prepares a manually added neutral citation before asking for its PDF", async () => {
    const saved = draft(), added = structuredClone(saved), prepared = structuredClone(saved);
    saved.state.stage = added.state.stage = prepared.state.stage = "sources";
    added.revision = 2;
    add(added, { ...authority("jordan", "R v Jordan", { kind: "unresolved" }),
      citation: "2016 SCC 27", userAdded: true });
    Object.assign(prepared, added, { state: structuredClone(added.state), revision: 3 });
    prepared.state.authorities.jordan.source = { kind: "pending-canlii", authorityKey: "jordan",
      pageUrl: "https://www.canlii.org/en/ca/scc/doc/2016/2016scc27/2016scc27.html",
      pdfUrl: "https://www.canlii.org/en/ca/scc/doc/2016/2016scc27/2016scc27.pdf" };
    saved.state.stage = "sources";
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue(added);
    api.prepareAuthoritiesSources.mockResolvedValue(prepared);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Add authority" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Citation"), "2016 SCC 27");
    await userEvent.type(within(dialog).getByLabelText(/Displayed title/u), "R v Jordan");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(api.prepareAuthoritiesSources)
      .toHaveBeenCalledWith("draft-1", 2, undefined));
    expect(await screen.findByRole("link", { name: "CanLII" })).toBeVisible();
    const row = screen.getByRole("heading", { name: "R v Jordan" }).closest("article")!;
    await userEvent.click(within(row).getByRole("button", { name: "Options for R v Jordan" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));
    expect(within(screen.getByRole("dialog", { name: "Edit authority" }))
      .getByLabelText("Citation")).toHaveValue("2016 SCC 27");
  });

  it("keeps book composition visible and accepts a custom cover through the normal file seam", async () => {
    const saved = add(draft(), authority("missing", "Missing decision", { kind: "unresolved" }));
    saved.state.settings.allowIncomplete = true;
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthoritiesBookPdf.mockResolvedValue({ ...saved, revision: 2 });
    api.prepareAuthoritiesSources.mockResolvedValue({ ...saved, revision: 2 });
    api.buildAuthorities.mockResolvedValue({ product: { ...saved, revision: 2 }, receipt: {},
      notice: "Saved to Court outputs" });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const contents = await screen.findByRole("heading", { name: "Cover and index" });
    const cover = screen.getByText("Cover").parentElement!;
    expect(within(cover).getByText("Generated")).toBeVisible();
    const file = new File(["%PDF-1.7"], "cover.pdf", { type: "application/pdf" });
    await userEvent.upload(within(cover).getByLabelText("Add file"), file);
    await waitFor(() => expect(api.attachAuthoritiesBookPdf)
      .toHaveBeenCalledWith("draft-1", 1, "cover", file, undefined));
    expect(contents).toBeVisible();
    expect(screen.queryByText(/labelled pages will be added/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Build draft" }));
    await waitFor(() => expect(api.buildAuthorities).toHaveBeenCalledWith(
      "draft-1", 2, expect.any(AbortSignal)));
    expect(screen.getByText("Saved to Court outputs")).toBeVisible();
  });

  it("adds other book PDFs in fixed order with procedural tabs and removes them", async () => {
    const saved = add(draft(), authority("included", "Included case", { kind: "unresolved" }),
      { ...authority("excluded", "Excluded case", { kind: "unresolved" }), excluded: true });
    saved.state.settings.missingSourcePolicy = "omit";
    const added = structuredClone(saved); added.revision = 2;
    added.state.bookParts.supplements = [{ id: "other-1", bindingRole: "book:other-1",
      filename: "Other material.pdf", sourceSha256: "a".repeat(64) }];
    const replaced = structuredClone(added); replaced.revision = 3;
    replaced.state.bookParts.supplements[0].filename = "Replacement.pdf";
    const removed = structuredClone(replaced); removed.revision = 4;
    removed.state.bookParts.supplements = [];
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthoritiesBookPdf.mockResolvedValueOnce(added).mockResolvedValueOnce(replaced);
    api.actOnAuthorities.mockResolvedValue(removed);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Other book PDFs" })).toBeVisible();
    const file = new File(["%PDF-other"], "Other material.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Add other book files"), file);

    await waitFor(() => expect(api.attachAuthoritiesBookPdf)
      .toHaveBeenCalledWith("draft-1", 1, "supplemental", file, undefined));
    expect(await screen.findByText("Other material.pdf")).toBeVisible();
    expect(screen.getByText("Tab 2")).toBeVisible();
    expect(screen.queryByText(/appendix/iu)).not.toBeInTheDocument();
    const row = screen.getByText("Other material.pdf").closest("div.grid")!;
    const replacement = new File(["%PDF-replacement"], "Replacement.pdf",
      { type: "application/pdf" });
    await userEvent.upload(within(row).getByLabelText("Replace"), replacement);
    await waitFor(() => expect(api.attachAuthoritiesBookPdf)
      .toHaveBeenCalledWith("draft-1", 2, "supplemental", replacement, "other-1"));
    await userEvent.click(screen.getByRole("button", { name: "Replacement.pdf options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from book" }));
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 3,
      { type: "remove-book-supplement", id: "other-1" }));
  });

  it("retains Federal filing requirements until an incomplete draft is explicitly selected", async () => {
    const saved = add(draft(), authority("missing", "Missing decision", { kind: "unresolved" }));
    Object.assign(saved.state.settings, { profileId: "federal-court" as const,
      filingMedium: "electronic" as const, bookRole: "applicant" as const });
    const covered = structuredClone(saved); covered.revision = 2;
    covered.state.cover = { courtFileNumber: "T-123-26", partyGroups: [
      { role: "Applicant", parties: ["North Prairie Ltd."] },
      { role: "Respondent", parties: ["Attorney General of Canada"] },
    ], applicationUnder: "", title: "" };
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValueOnce(covered).mockResolvedValue({ ...covered, revision: 3 });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByLabelText("Filing")).toHaveValue("electronic");
    expect(screen.getByText("Details required")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    const coverDialog = screen.getByRole("dialog", { name: "Cover details" });
    await userEvent.type(within(coverDialog).getByLabelText("Court file number"), "T-123-26");
    const names = within(coverDialog).getAllByLabelText(/Party names/u);
    await userEvent.type(names[0], "North Prairie Ltd.");
    await userEvent.type(names[1], "Attorney General of Canada");
    await userEvent.click(within(coverDialog).getByRole("button", { name: "Save cover" }));
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1,
      { type: "set-cover", cover: covered.state.cover }));
    await waitFor(() => expect(within(screen.getByText("Cover").parentElement!)
      .getByText("Generated")).toBeVisible());
    expect(screen.getByText("1 missing PDF.")).toBeVisible();
    const filedBy = screen.getByLabelText("Filed by");
    expect(within(filedBy).getAllByRole("option").map(({ textContent }) => textContent))
      .toEqual(["Plaintiff", "Defendant", "Applicant", "Respondent", "Moving party",
        "Responding party", "Joint"]);
    await userEvent.selectOptions(filedBy, "respondent");
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 2,
      { type: "set-settings", settings: { bookRole: "respondent" } }));
    await userEvent.click(screen.getByText("Options"));
    expect(screen.queryByLabelText("Missing sources")).not.toBeInTheDocument();
  });

  it("selects courts across jurisdictions directly in one chooser and keeps book-only choices valid", async () => {
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} jurisdictionOrder={["ca-ab"]} /></MemoryRouter>);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Court: No court preset" }));
    let chooser = screen.getByRole("dialog", { name: "Choose court" });
    const jurisdictions = within(within(chooser).getByRole("group", { name: "Jurisdiction" }))
      .getAllByRole("button");
    expect(jurisdictions[0]).toHaveTextContent("Alberta");
    expect(jurisdictions.map((button) => button.textContent)).toContain("Federal courts");
    await userEvent.click(jurisdictions[0]);
    expect(within(chooser).getByRole("button", { name: "Court of Appeal of Alberta" })).toBeVisible();
    await userEvent.click(within(chooser).getByRole("button", { name: "Federal courts" }));
    await userEvent.click(within(chooser).getByRole("button", { name: "Federal Court", exact: true }));
    expect(screen.queryByRole("dialog", { name: "Choose court" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Court: Federal Court", exact: true }));
    chooser = screen.getByRole("dialog", { name: "Choose court" });
    await userEvent.click(within(chooser).getByRole("button", { name: "Alberta" }));
    await userEvent.click(within(chooser).getByRole("button", { name: "Court of Appeal of Alberta" }));
    expect(screen.queryByRole("dialog", { name: "Choose court" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Court: Court of Appeal of Alberta" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    await userEvent.click(screen.getByRole("button", { name: /Court:/ }));
    chooser = screen.getByRole("dialog", { name: "Choose court" });
    await userEvent.click(within(chooser).getByRole("button", { name: "Alberta" }));
    expect(within(chooser).queryByRole("button", { name: "Court of Appeal of Alberta" })).not.toBeInTheDocument();
    await userEvent.click(within(chooser).getByRole("button", { name: "Federal courts" }));
    expect(within(chooser).getByRole("button", { name: "Federal Court", exact: true })).toBeVisible();
  });

  it("retains Alberta filing requirements until an incomplete draft is explicitly selected", async () => {
    const saved = add(draft(), authority("missing", "Missing decision", { kind: "unresolved" }));
    saved.state.settings.profileId = "ab-court-of-kings-bench";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await screen.findByRole("button", { name: /Court:/u });
    expect(screen.getByText("1 missing PDF.")).toBeVisible();
    await userEvent.click(screen.getByText("Options"));
    expect(screen.queryByLabelText("Missing sources")).not.toBeInTheDocument();
  });

  it("offers joint and filing-party roles only for a Federal Court of Appeal book", async () => {
    const saved = draft();
    Object.assign(saved.state.settings, { profileId: "federal-court-of-appeal" as const,
      filingMedium: "electronic" as const, bookRole: "joint" as const });
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const filedBy = await screen.findByLabelText("Filed by");
    expect(within(filedBy).getAllByRole("option").map(({ textContent }) => textContent))
      .toEqual(["Joint", "Appellant", "Respondent", "Intervener"]);
  });

  it("gives the scoped Assistant the focused citation and exact DOM selection", async () => {
    const saved = documentDraft(), text = "See R v Example, 2024 ABKB 1 at para 12.";
    const start = text.indexOf("R v"), end = text.indexOf(" at para");
    saved.state.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["occurrence-1"] }];
    saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:1",
      start, end, text: text.slice(start, end), kind: "case", citation: "2024 ABKB 1",
      authoritySpan: { start, end, text: text.slice(start, end) },
      coreSpan: { start: text.indexOf("2024"), end, text: "2024 ABKB 1" },
      pinpointSpan: null, authorityId: "authority-1", reference: null, pinpoints: [],
      evidenceIds: [], sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };
    add(saved, { ...authority("authority-1", "R v Example", { kind: "unresolved" }),
      citation: "2024 ABKB 1" });
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <TableOfAuthoritiesPage />
    </MemoryRouter>);

    const context = await screen.findByRole("textbox", { name: "In-text citation context" });
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
      focus: { itemId: "occurrence-1" },
    }));
    selectRange(context, 3, end + 3);
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
      focus: { itemId: "occurrence-1", selection: { start: 3, end: end + 3 } },
    }));
  });

  it("keeps the scoped Assistant mounted through build and tool refresh", async () => {
    const saved = documentDraft(); saved.projectId = "matter-1"; saved.state.stage = "build";
    const built = { ...saved, revision: 2 }, refreshed = { ...saved, revision: 3 };
    api.getWorkProduct.mockResolvedValueOnce(saved).mockResolvedValue(refreshed);
    api.prepareAuthoritiesSources.mockResolvedValue(saved);
    api.buildAuthorities.mockResolvedValue({ product: built });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <TableOfAuthoritiesPage />
    </MemoryRouter>);

    const assistantButton = await screen.findByRole("button", { name: "Assistant" });
    await waitFor(() => expect(assistantButton).toBeEnabled());
    await userEvent.click(assistantButton);
    await screen.findByRole("button", { name: "Complete turn" });
    const dock = screen.getByRole("complementary", { name: "Assistant dock" });
    expect(dock).toBeVisible();
    expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
    });

    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 2,
    }));
    expect(dock).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Complete turn" }));
    await waitFor(() => expect(api.getWorkProduct).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 3,
    }));
    expect(dock).toBeVisible();
  });

  it("keeps the Assistant bound when switching Authorities surfaces", async () => {
    api.getWorkProduct.mockResolvedValue(documentDraft());
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <TableOfAuthoritiesPage />
    </MemoryRouter>);

    const assistantButton = await screen.findByRole("button", { name: "Assistant" });
    await userEvent.click(assistantButton);
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));

    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Assistant" })).toBeEnabled();
  });
});

it("advances immediately to Highlights and revisits completed steps without saving unreviewed marks", async () => {
  let current = draft(); current.state.stage = "sources"; current.state.outputMode = "book";
  add(current, authority("case", "Example", attachedSource("case-en", "case.pdf", "a", null, "reconstructed")));
  api.getWorkProduct.mockResolvedValue(current);
  const host = { ...beaverAuthoritiesHost,
    readSource: vi.fn(async () => new Blob(["synthetic source"])),
    prepareAnnotations: vi.fn(async () => ({ annotations: { schemaVersion: "beaver.pdf-annotations.v1" as const,
      sourceSha256: "a".repeat(64), marks: [] }, unresolved: [{ label: "para 42 · Quote", excerpt: "Unlocated quoted words" }] })),
    act: vi.fn(async (_id: string, _revision: number, action: import("@/app/authorities/types").AuthoritiesAction) => {
      current = structuredClone(current); current.revision++;
      if (action.type === "set-settings") Object.assign(current.state.settings, action.settings);
      if (action.type === "set-stage") current.state.stage = action.stage;
      return current;
    }),
  };
  render(<MemoryRouter><AuthoritiesWorkspace host={host} route={workspaceRoute("draft-1")} /></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "Done" }));
  expect(await screen.findByRole("button", { name: "Edit in PDF" })).toBeVisible();
  expect(current.state.stage).toBe("highlights");
  expect(host.act.mock.calls.some(([, , action]) => action.type === "set-annotations")).toBe(false);
  await userEvent.click(screen.getByRole("tab", { name: "Sources", exact: true }));
  expect(screen.getByRole("list", { name: "Authority tab slots" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Edit in PDF" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("tab", { name: "Highlights", exact: true }));
  expect(screen.getByRole("button", { name: "Edit in PDF" })).toBeVisible();
  expect(current.state.stage).toBe("highlights");
});
