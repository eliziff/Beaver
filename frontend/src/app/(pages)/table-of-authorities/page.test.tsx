import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct, AuthorityIdentity } from "@/app/authorities/types";
import TableOfAuthoritiesPage from "./page";

const api = vi.hoisted(() => ({
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  attachAuthoritiesBookPdf: vi.fn(),
  createAuthorities: vi.fn(), createWorkProduct: vi.fn(), deleteWorkProduct: vi.fn(),
  downloadDocument: vi.fn(), duplicateWorkProduct: vi.fn(), getDocumentParseStates: vi.fn(),
  getWorkProduct: vi.fn(),
  getWorkProductResolution: vi.fn(), listWorkProductMetadata: vi.fn(),
  listWorkProducts: vi.fn(), prepareAuthoritiesSources: vi.fn(), refreshAuthorities: vi.fn(), replaceAuthoritiesSource: vi.fn(),
  refreshAuthoritiesInput: vi.fn(), reviewAuthorities: vi.fn(),
  updateWorkProduct: vi.fn(),
  uploadAuthoritiesDocument: vi.fn(), directoryList: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ options: [] as Record<string, unknown>[],
  handleChat: vi.fn() }));

vi.mock("@/app/lib/beaverApi", () => ({
  ...api,
  directoryResource: () => ({ list: api.directoryList }),
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs, expanded }: { tabs: Array<{ content: ReactNode }>; expanded: boolean }) =>
    <aside aria-label="Assistant dock" hidden={!expanded}>{tabs[0]?.content}</aside>,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
  ChatView: ({ handleChat, sendDisabled }: {
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
    state: { schemaVersion: "beaver.authorities-draft.v1", import: { kind: "manual" },
      bindings: {}, outputMode: "both", insertIntoDocument: false, ledger: null,
      settings: { profileId: "general", sourceMode: "automatic", tabStyle: "numeric",
        tableOrder: "alphabetical", tableDelivery: "native-append", tableLocation: "pages",
        passageMarking: "margin", scannedPdfPolicy: "page-margin",
        missingSourcePolicy: "placeholder" },
      bookParts: { cover: null, index: null, supplements: [] },
      units: [], occurrences: {}, authorities: {}, authorityOrder: [] } };
}

function documentDraft(id = "draft-1", title = "Requested draft") {
  const saved = draft(id, title);
  saved.state.import = { kind: "document", bindingRole: "source", filename: "Factum.docx",
    fileType: "docx", snapshot: null };
  saved.state.outputMode = "table";
  return saved;
}

function authority(id: string, name: string, source: AuthorityIdentity["source"]): AuthorityIdentity {
  return { id, key: id, kind: "case", citation: `${name} citation`, name, displayName: null,
    tabLabel: null, evidenceIds: [], locators: [], sourceIdentity: null, excluded: false, source };
}

function add(saved: AuthoritiesProduct, ...items: AuthorityIdentity[]) {
  saved.state.authorities = Object.fromEntries(items.map((item) => [item.id, item]));
  saved.state.authorityOrder = items.map(({ id }) => id);
  return saved;
}
const workspaceRoute = (draftId = "") => ({ draftId, replaceDraft: vi.fn() });

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
  });

  it("renders the shared blank workspace without opening saved work or an iframe", async () => {
    api.listWorkProductMetadata.mockResolvedValue([
      (({ state: _state, outputs: _outputs, ...item }) => item)(draft("other", "Other draft")),
    ]);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Automatic", "Manual", "Drafts", "Settings",
    ]);
    expect(screen.getByRole("heading", { name: "Import and review" })).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() => expect(api.listWorkProductMetadata).toHaveBeenCalledOnce());
    expect(api.getWorkProduct).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Other draft" })).not.toBeInTheDocument();
  });

  it("applies the selected source and marking options before importing a document", async () => {
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
    await userEvent.click(within(setup).getByLabelText(/Add missing PDFs myself/));
    await userEvent.click(within(setup).getByLabelText(/Highlight exact quotes/));
    await userEvent.click(within(setup).getByRole("button", { name: "Import and review" }));

    await waitFor(() => expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "document", documentId: "uploaded-document", version: "latest" },
      title: "Factum", projectId: undefined,
      settings: { profileId: "general", sourceMode: "manual-originals", passageMarking: "text" },
    }));
    expect(await screen.findByLabelText("Add PDF")).toBeVisible();
  });

  it("restores the rebuild-from-text preference", async () => {
    localStorage.setItem("beaver.authorities.preferences", JSON.stringify({
      profileId: "general", sourceMode: "render", passageMarking: "margin",
    }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    const sources = screen.getByLabelText("Source PDFs");
    expect(sources).toHaveValue("render");
    expect(within(sources).getAllByRole("option").map(({ textContent }) => textContent))
      .toEqual(["Automatic sources", "Add missing PDFs myself", "Rebuild all sources from text"]);
  });

  it("creates a manual book in manual order regardless of document-import defaults", async () => {
    const created = draft(); created.state.outputMode = "book";
    created.state.settings.sourceMode = "manual-originals";
    created.state.settings.passageMarking = "none";
    const added = add({ ...created, revision: 2, state: structuredClone(created.state) },
      authority("manual-1", "First decision", { kind: "unresolved" }));
    const attached = add({ ...added, revision: 3, state: structuredClone(added.state) },
      authority("manual-1", "First decision", { kind: "attached", bindingRole: "manual-1",
        filename: "First decision.pdf", sourceSha256: "a".repeat(64), sourceUrl: null,
        origin: "manual" }));
    api.createAuthorities.mockResolvedValue(created);
    api.actOnAuthorities.mockResolvedValue(added);
    api.attachAuthorityPdf.mockResolvedValue(attached);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Manual" }));
    const file = new File(["%PDF-1.7"], "First decision.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Add PDFs"), file);

    await waitFor(() => expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "manual" }, title: "Book of Authorities", projectId: undefined,
      settings: { profileId: "general", sourceMode: "manual-originals",
        passageMarking: "none", outputMode: "book" },
    }));
  });

  it("loads only the draft named by the route", async () => {
    api.listWorkProductMetadata.mockResolvedValue([
      (({ state: _state, outputs: _outputs, ...item }) => item)(draft("other", "Other draft")),
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

  it("keeps Drafts and Settings in the global Authorities context", async () => {
    api.getWorkProduct.mockResolvedValue(documentDraft());
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Requested draft" })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Drafts" }));
    expect(screen.getByRole("heading", { name: "Authorities" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Requested draft" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Authorities" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Requested draft" })).not.toBeInTheDocument();
  });

  it("shows the optional output-folder setting without changing the shared workspace", async () => {
    const outputFolder = { get: vi.fn().mockResolvedValue("Court outputs"),
      choose: vi.fn().mockResolvedValue("Appeal outputs"), clear: vi.fn().mockResolvedValue(undefined) };
    render(<MemoryRouter><AuthoritiesWorkspace
      host={{ ...beaverAuthoritiesHost, outputFolder }} route={workspaceRoute()} /></MemoryRouter>);

    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("Court outputs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(await screen.findByText("Appeal outputs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByText("Not set")).toBeVisible());
  });

  it("opens the exact in-text citation without a confirmation gate", async () => {
    const saved = documentDraft();
    const citation = "2024 ABKB 1", styled = `R v Example, ${citation}`;
    saved.state.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
      footnoteRefs: [], pageNumbers: [1], text: styled, occurrenceIds: ["occurrence-1"] }];
    saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:1",
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
      .toEqual(["Use selection as authority", "Use selection as pinpoint", "Split at cursor",
        "Merge with previous"]);
    expect(screen.queryByRole("checkbox", { name: "Reviewed" })).not.toBeInTheDocument();
  });

  it("keeps automatic source acquisition behind Build until manual intervention is requested", async () => {
    const saved = add(documentDraft(), authority("case", "Example v Example",
      { kind: "unresolved" }));
    saved.state.outputMode = "book";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const build = (await screen.findByRole("heading", { name: "Build outputs" })).closest("section")!;
    const sources = screen.getByRole("heading", { name: "Sources" }).closest("details")!;
    expect(build.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sources).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Add PDF")).not.toBeVisible();
    expect(screen.queryByText(/missing source PDF/)).not.toBeInTheDocument();

    await userEvent.click(within(sources).getByText("Sources"));
    expect(screen.getByLabelText("Add PDF")).toBeVisible();
    expect(within(sources).getByRole("button", { name: "Add authority" })).toBeVisible();
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
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const sources = (await screen.findByRole("heading", { name: "Sources" })).closest("details")!;
    expect(sources).toHaveAttribute("open");
    expect(within(sources).getByLabelText("Add PDF")).toBeVisible();
    expect(screen.getByText("Filing PDF")).toBeVisible();
  });

  it("shows a high-confidence source discrepancy inside the fixed citation review", async () => {
    const saved = documentDraft(), citation = "2024 ABKB 1";
    saved.state.units = [{ id: "footnote:1", kind: "footnote", ordinal: 1, footnoteId: 1,
      footnoteRefs: [], pageNumbers: [1], text: citation, occurrenceIds: ["occurrence-1"] }];
    saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "footnote:1",
      start: 0, end: citation.length, text: citation, kind: "case", citation,
      authoritySpan: { start: 0, end: citation.length, text: citation },
      coreSpan: { start: 0, end: citation.length, text: citation }, pinpointSpan: null,
      authorityId: "authority-1", reference: null,
      pinpoints: [{ kind: "paragraph", text: "7" }], evidenceIds: [],
      sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: true };
    add(saved, authority("authority-1", citation, { kind: "resolved" }));
    api.getWorkProduct.mockResolvedValue(saved);
    api.reviewAuthorities.mockResolvedValue([{ kind: "quote_mismatch",
      occurrenceId: "occurrence-1", authorityId: "authority-1", footnoteId: 1, citation,
      proposition: "The court wrote this.", authoredQuote: "the authored words",
      authoredPinpoint: { kind: "paragraph", text: "7" },
      cited: { locator: { kind: "paragraph", label: "7" }, text: "the source words" },
      found: null }]);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByText("Source mismatch")).toBeVisible();
    expect(screen.getByText("the authored words")).toBeVisible();
    expect(screen.getByText("the source words")).toBeVisible();
  });

  it("surfaces source-check failures and does not rerun review after a build-only revision", async () => {
    const saved = documentDraft(), built = { ...saved, revision: 2 };
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

  it("keeps prepared sources visible when the final build fails", async () => {
    const saved = add(documentDraft(), authority("case", "Example v Example",
      { kind: "unresolved" }));
    saved.state.outputMode = "book";
    const prepared = structuredClone(saved); prepared.revision = 2;
    prepared.state.authorities.case.source = { kind: "attached",
      bindingRole: "authority:case", filename: "Decision.pdf", sourceSha256: "a".repeat(64),
      sourceUrl: "https://decisions.example/case.pdf", origin: "original" };
    prepared.state.bindings["authority:case"] = {
      kind: "document", documentId: "pdf-1", version: "latest" };
    api.getWorkProduct.mockResolvedValue(saved);
    api.prepareAuthoritiesSources.mockResolvedValue(prepared);
    api.getDocumentParseStates.mockResolvedValue([{ id: "pdf-1",
      parse_state: { status: "ready" } }]);
    api.buildAuthorities.mockRejectedValue(new Error("The book could not be built"));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Build" }));

    expect(await screen.findByText("The book could not be built")).toBeVisible();
    expect(screen.getByText("Decision.pdf")).toBeVisible();
  });

  it("replaces an imported source without starting a new draft", async () => {
    const saved = documentDraft(), replaced = { ...saved, revision: 2 };
    api.getWorkProduct.mockResolvedValue(saved);
    api.replaceAuthoritiesSource.mockResolvedValue(replaced);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    const file = new File(["PK\x03\x04new"], "Replacement.docx");

    await userEvent.upload(await screen.findByLabelText("Replace file"), file);

    expect(api.replaceAuthoritiesSource).toHaveBeenCalledWith("draft-1", 1, file);
    expect(api.createAuthorities).not.toHaveBeenCalled();
  });

  it("offers file replacement instead of a dead relink for missing Beaver inputs", async () => {
    const saved = documentDraft();
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {
      source: { status: "missing", reason: "deleted" },
    } });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByLabelText("Replace file")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Relink source" })).not.toBeInTheDocument();
  });

  it("offers the normal PDF input when an attached Beaver authority is missing", async () => {
    const saved = add(draft(), authority("alpha", "Alpha", { kind: "attached",
      bindingRole: "authority:alpha", filename: "alpha.pdf", sourceSha256: "a".repeat(64),
      sourceUrl: null, origin: "manual" }));
    api.getWorkProduct.mockResolvedValue(saved);
    api.getWorkProductResolution.mockResolvedValue({ inputs: {
      "authority:alpha": { status: "missing", reason: "deleted" },
    } });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const row = (await screen.findByRole("heading", { name: "Alpha" })).closest("article")!;
    expect(await within(row).findByLabelText("Add PDF")).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Relink PDF" })).not.toBeInTheDocument();
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

  it("renames from the draft header and edits manual tabs and order", async () => {
    let current = add(draft(),
      authority("alpha", "Alpha", { kind: "attached", bindingRole: "authority:alpha",
        filename: "alpha.pdf", sourceSha256: "a".repeat(64), sourceUrl: null, origin: "manual" }),
      authority("beta", "Beta", { kind: "attached", bindingRole: "authority:beta",
        filename: "beta.pdf", sourceSha256: "b".repeat(64), sourceUrl: null, origin: "manual" }));
    api.getWorkProduct.mockImplementation(async () => current);
    api.updateWorkProduct.mockImplementation(async (_id, patch) => {
      current = { ...current, title: patch.title ?? current.title, revision: current.revision + 1 };
      return current;
    });
    api.actOnAuthorities.mockImplementation(async (_id, _revision, action) => {
      const next = structuredClone(current); next.revision += 1;
      if (action.type === "set-authority-tab") next.state.authorities[action.authorityId].tabLabel = action.tabLabel;
      if (action.type === "reorder-authorities") next.state.authorityOrder = action.authorityIds;
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

    const tab = screen.getByLabelText("Tab for Alpha");
    await userEvent.clear(tab); await userEvent.type(tab, "A"); fireEvent.blur(tab);
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 2,
      { type: "set-authority-tab", authorityId: "alpha", tabLabel: "A" }));

    fireEvent.keyDown(screen.getByRole("button", { name: /Reorder Alpha/ }),
      { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenLastCalledWith("draft-1", 3,
      { type: "reorder-authorities", authorityIds: ["beta", "alpha"] }));
  });

  it("appends a PDF dropped on a populated manual book instead of replacing that row", async () => {
    const saved = add(draft(), authority("alpha", "Alpha", { kind: "attached",
      bindingRole: "authority:alpha", filename: "alpha.pdf", sourceSha256: "a".repeat(64),
      sourceUrl: null, origin: "manual" }));
    const added = add({ ...saved, revision: 2, state: structuredClone(saved.state) },
      authority("alpha", "Alpha", saved.state.authorities.alpha.source),
      authority("beta", "Beta", { kind: "unresolved" }));
    const attached = add({ ...added, revision: 3, state: structuredClone(added.state) },
      authority("alpha", "Alpha", saved.state.authorities.alpha.source),
      authority("beta", "Beta", { kind: "attached", bindingRole: "authority:beta",
        filename: "beta.pdf", sourceSha256: "b".repeat(64), sourceUrl: null, origin: "manual" }));
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue(added);
    api.attachAuthorityPdf.mockResolvedValue(attached);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);
    const row = (await screen.findByRole("heading", { name: "Alpha" })).closest("article")!;
    const file = new File(["%PDF-1.7"], "beta.pdf", { type: "application/pdf" });

    fireEvent.drop(row, { dataTransfer: { files: [file], types: ["Files"], getData: () => "" } });

    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1,
      { type: "add-authority", kind: "other", citation: "beta", name: "beta" }));
    await waitFor(() => expect(api.attachAuthorityPdf)
      .toHaveBeenCalledWith("draft-1", "beta", 2, file));
    expect(api.attachAuthorityPdf).not.toHaveBeenCalledWith("draft-1", "alpha", 1, file);
  });

  it("offers CanLII only for a known handoff and accepts it through Add PDF", async () => {
    const pdfUrl = "https://www.canlii.org/en/ca/scc/doc/1986/1986canlii46/1986canlii46.pdf";
    const saved = add(draft(),
      authority("oakes", "R v Oakes", { kind: "pending-canlii", authorityKey: "oakes",
        pageUrl: pdfUrl.replace(/\.pdf$/u, ".html"), pdfUrl }),
      authority("unknown", "Unresolved case", { kind: "unresolved" }));
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthorityPdf.mockResolvedValue({ ...saved, revision: 2 });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} route={workspaceRoute("draft-1")} />
    </MemoryRouter>);

    const known = (await screen.findByRole("heading", { name: "R v Oakes" })).closest("article")!;
    const unknown = screen.getByRole("heading", { name: "Unresolved case" }).closest("article")!;
    expect(within(known).getByRole("link", { name: "Download from CanLII" }))
      .toHaveAttribute("href", pdfUrl);
    expect(within(unknown).queryByRole("link", { name: "Download from CanLII" })).toBeNull();

    const file = new File(["%PDF-"], "oakes.pdf", { type: "application/pdf" });
    await userEvent.upload(within(known).getByLabelText("Add PDF"), file);
    await waitFor(() => expect(api.attachAuthorityPdf).toHaveBeenCalledWith(
      "draft-1", "oakes", 1, file));
  });

  it("keeps book composition visible and accepts a custom cover through the normal file seam", async () => {
    const saved = add(draft(), authority("missing", "Missing decision", { kind: "unresolved" }));
    api.getWorkProduct.mockResolvedValue(saved);
    api.attachAuthoritiesBookPdf.mockResolvedValue({ ...saved, revision: 2 });
    api.prepareAuthoritiesSources.mockResolvedValue({ ...saved, revision: 2 });
    api.buildAuthorities.mockResolvedValue({ product: { ...saved, revision: 2 }, receipt: {},
      notice: "Saved to Court outputs" });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    const contents = await screen.findByRole("heading", { name: "Book contents" });
    const cover = screen.getByText("Cover").parentElement!;
    expect(within(cover).getByText("Generated")).toBeVisible();
    const file = new File(["%PDF-1.7"], "cover.pdf", { type: "application/pdf" });
    await userEvent.upload(within(cover).getByLabelText("Add file"), file);
    await waitFor(() => expect(api.attachAuthoritiesBookPdf)
      .toHaveBeenCalledWith("draft-1", 1, "cover", file));
    expect(contents).toBeVisible();
    expect(screen.queryByText(/labelled pages will be added/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(api.buildAuthorities).toHaveBeenCalledWith(
      "draft-1", 2, expect.any(AbortSignal)));
    expect(screen.getByText("Saved to Court outputs")).toBeVisible();
  });

  it("does not offer placeholder pages for a Federal Court book", async () => {
    const saved = add(draft(), authority("missing", "Missing decision", { kind: "unresolved" }));
    Object.assign(saved.state.settings, { profileId: "federal-court" as const,
      filingMedium: "electronic" as const, bookRole: "applicant" as const });
    api.getWorkProduct.mockResolvedValue(saved);
    api.actOnAuthorities.mockResolvedValue({ ...saved, revision: 2 });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    expect(await screen.findByLabelText("Filing")).toHaveValue("electronic");
    expect(screen.queryByText(/source PDF is required/)).not.toBeInTheDocument();
    const filedBy = screen.getByLabelText("Filed by");
    expect(within(filedBy).getAllByRole("option").map(({ textContent }) => textContent))
      .toEqual(["Applicant", "Respondent", "Joint"]);
    await userEvent.selectOptions(filedBy, "respondent");
    await waitFor(() => expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1,
      { type: "set-settings", settings: { bookRole: "respondent" } }));
    await userEvent.click(screen.getByText("Options"));
    expect(screen.queryByLabelText("Missing sources")).not.toBeInTheDocument();
  });

  it("does not offer placeholder pages when the Alberta court preset fixes source handling", async () => {
    const saved = draft();
    saved.state.settings.profileId = "ab-court-of-kings-bench";
    api.getWorkProduct.mockResolvedValue(saved);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost}
      route={workspaceRoute("draft-1")} /></MemoryRouter>);

    await screen.findByLabelText("Court");
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

  it("keeps the scoped Assistant mounted through build and tool refresh", async () => {
    const saved = documentDraft(); saved.projectId = "matter-1";
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
});
