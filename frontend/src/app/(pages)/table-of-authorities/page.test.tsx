import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import TableOfAuthoritiesPage from "./page";

const api = vi.hoisted(() => ({
  listAuthorities: vi.fn(), createAuthorities: vi.fn(), getAuthorities: vi.fn(),
  createWorkProduct: vi.fn(),
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  deleteWorkProduct: vi.fn(), duplicateWorkProduct: vi.fn(), refreshAuthorities: vi.fn(),
  updateWorkProduct: vi.fn(), uploadAuthoritiesDocument: vi.fn(), downloadDocument: vi.fn(),
  directoryList: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ options: [] as Record<string, unknown>[],
  handleChat: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
  ...api,
  listWorkProducts: api.listAuthorities,
  getWorkProduct: api.getAuthorities,
  directoryResource: () => ({ list: api.directoryList }),
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs, expanded }: { tabs: Array<{ content: ReactNode }>; expanded: boolean }) =>
    <aside aria-label="Assistant dock" hidden={!expanded}>{tabs[0]?.content}</aside>,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
  ChatView: ({ handleChat, sendDisabled }: {
    handleChat: (...args: never[]) => Promise<unknown>; sendDisabled?: boolean;
  }) =>
    <button type="button" disabled={sendDisabled}
      onClick={() => void handleChat({ content: "Add the case" } as never)}>
      Complete Assistant turn
    </button>,
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: (options: Record<string, unknown>) => {
    assistant.options.push(options);
    const [messages, setMessages] = useState<Array<{ role: "assistant"; workflowRuns: Array<{
      status: "complete"; work_product: { id: string; kind: string; revision: number } }> }>>([]);
    const product = options.workProduct as { id: string; kind: string; revision: number } | undefined;
    return { state: { chatId: options.chatId, messages }, actions: {
      handleChat: async (request: unknown) => {
        const result = await assistant.handleChat(request);
        if (product) setMessages([{ role: "assistant", workflowRuns: [{ status: "complete",
          work_product: { ...product, revision: product.revision + 1 } }] }]);
        return result;
      }, cancel: vi.fn(), clearRejectedTurn: vi.fn(),
      retryRejectedTurn: vi.fn(),
    } };
  },
}));

const product = (): AuthoritiesProduct => ({
  id: "draft-1", kind: "authorities", title: "Book of Authorities", projectId: null,
  revision: 1, createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-30T00:00:00Z",
  outputs: {}, state: { schemaVersion: "beaver.authorities-draft.v1",
    import: { kind: "manual" }, bindings: {}, outputMode: "both",
    insertIntoDocument: false, units: [],
    occurrences: {}, authorities: {}, authorityOrder: [] },
});

const reviewProduct = (): AuthoritiesProduct => {
  const saved = product(), text = "2024 ABKB 1";
  saved.state.units = [{ id: "body:1", kind: "body", ordinal: 0, footnoteId: null,
    footnoteRefs: [], pageNumbers: [1], text, occurrenceIds: ["occurrence-1"] }];
  saved.state.occurrences["occurrence-1"] = { id: "occurrence-1", unitId: "body:1",
    start: 0, end: text.length, text, kind: "case", citation: text,
    authorityId: "authority-1", reference: null, pinpoints: [], evidenceIds: [],
    sourceTextSha256: "a".repeat(64), localOrdinal: 0, reviewed: false };
  saved.state.authorities["authority-1"] = { id: "authority-1", key: "2024 abkb 1",
    kind: "case", citation: text, name: null, displayName: null, evidenceIds: [],
    locators: [], sourceIdentity: null, excluded: false, source: { kind: "unresolved" } };
  saved.state.authorityOrder = ["authority-1"];
  return saved;
};

describe("Authorities workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks(); assistant.options.length = 0;
    assistant.handleChat.mockResolvedValue(null);
    api.listAuthorities.mockResolvedValue([]);
    api.directoryList.mockResolvedValue({ items: [], next_cursor: null });
  });

  it("keeps the scoped Assistant beside the draft and refreshes only that draft", async () => {
    const saved = product(), built = { ...product(), revision: 2 },
      refreshed = { ...product(), revision: 3 };
    for (const item of [saved, built, refreshed]) {
      item.state = { ...item.state, outputMode: "table", import: { kind: "document",
        bindingRole: "source", filename: "Factum.docx", fileType: "docx", snapshot: null } };
    }
    saved.projectId = built.projectId = refreshed.projectId = "matter-1";
    api.listAuthorities.mockResolvedValue([saved]);
    api.getAuthorities.mockResolvedValue(refreshed);
    let finishBuild!: (value: { product: AuthoritiesProduct }) => void;
    api.buildAuthorities.mockImplementation(() => new Promise((resolve) => {
      finishBuild = resolve;
    }));
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <TableOfAuthoritiesPage />
    </MemoryRouter>);

    const openAssistant = await screen.findByRole("button", { name: "Assistant" });
    await waitFor(() => expect(openAssistant).toBeEnabled());
    await userEvent.click(openAssistant);
    expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
    });
    expect(assistant.options.at(-1)?.projectId).toBe("matter-1");
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
    }));
    expect(openAssistant).toBeEnabled();
    expect(screen.getByRole("button", { name: "Complete Assistant turn" })).toBeDisabled();
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    finishBuild({ product: built });
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 2,
    }));
    expect(screen.getByRole("button", { name: "Complete Assistant turn" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Complete Assistant turn" }));
    await waitFor(() => expect(api.getAuthorities).toHaveBeenCalledWith("draft-1"));
    expect(api.getAuthorities).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 3,
    }));
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
  });

  it("starts a durable blank book without an iframe or legacy runtime", async () => {
    const created = product(); created.state.outputMode = "book";
    api.createAuthorities.mockResolvedValue(created);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Blank book" }));
    expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "manual" }, title: "Book of Authorities", projectId: undefined,
    });
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("keeps the Authorities surface in place while saved drafts load", async () => {
    let finish!: (items: AuthoritiesProduct[]) => void;
    api.listAuthorities.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Authorities" })).toBeVisible();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Loading authorities");
    finish([]);
    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
  });

  it("accepts a correct citation without changing its link or form", async () => {
    const saved = reviewProduct();
    api.listAuthorities.mockResolvedValue([saved]);
    api.actOnAuthorities.mockResolvedValue({ ...saved, revision: 2,
      state: { ...saved.state, occurrences: { "occurrence-1": {
        ...saved.state.occurrences["occurrence-1"], reviewed: true,
      } } } });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);

    const reviewed = await screen.findByRole("checkbox", { name: "Reviewed" });
    expect(reviewed).not.toBeChecked();
    await userEvent.click(reviewed);
    expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1, {
      type: "set-reviewed", occurrenceId: "occurrence-1", reviewed: true,
    });
  });

  it("keeps a direct source upload inside its Project", async () => {
    const file = new File(["brief"], "Brief.docx");
    api.uploadAuthoritiesDocument.mockResolvedValue({ id: "source-1" });
    api.createAuthorities.mockResolvedValue(product());

    await beaverAuthoritiesHost.create({ source: { kind: "file", selected: { file } },
      title: "Brief", projectId: "matter-1" });

    expect(api.uploadAuthoritiesDocument).toHaveBeenCalledWith(file, "matter-1");
    expect(api.createAuthorities).toHaveBeenCalledWith({ source: { kind: "document",
      documentId: "source-1", version: "latest" }, title: "Brief", projectId: "matter-1" });
  });

  it("opens a requested saved draft in one load", async () => {
    const saved = product();
    api.listAuthorities.mockResolvedValue([saved]);
    api.getAuthorities.mockResolvedValue(saved);
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);
    expect(await screen.findByText("Manual book")).toBeVisible();
    expect(api.listAuthorities).toHaveBeenCalledTimes(1);
    expect(api.getAuthorities).not.toHaveBeenCalled();
  });

  it("loads a requested draft omitted from the bounded list", async () => {
    const saved = product();
    api.listAuthorities.mockResolvedValue([]);
    api.getAuthorities.mockResolvedValue(saved);
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);

    expect(await screen.findByText("Manual book")).toBeVisible();
    expect(api.getAuthorities).toHaveBeenCalledOnce();
    expect(api.getAuthorities).toHaveBeenCalledWith("draft-1");
  });

  it("opens saved work only when it is selected from the blank route", async () => {
    const saved = product();
    api.listAuthorities.mockResolvedValue([saved]);
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
    expect(screen.queryByText("Manual book")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open saved draft" }));
    await userEvent.click(screen.getByRole("button", { name: saved.title }));
    expect(await screen.findByText("Manual book")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back from authorities draft" }));
    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
  });

  it("returns home after deleting the active draft", async () => {
    const saved = product();
    api.listAuthorities.mockResolvedValue([saved]);
    api.deleteWorkProduct.mockResolvedValue(undefined);
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "authorities draft actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.deleteWorkProduct).toHaveBeenCalledWith("draft-1"));
    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
  });

  it("aborts a superseded Library search and shows only the latest result", async () => {
    const signals: AbortSignal[] = [];
    api.directoryList.mockImplementation(({ q }: { q: string }, signal: AbortSignal) => {
      signals.push(signal);
      if (q === "first") return new Promise((_resolve, reject) => signal.addEventListener(
        "abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return Promise.resolve({ items: q === "second" ? [{ kind: "document", document: {
        id: "second", filename: "Second.docx", file_type: "docx",
      } }] : [], next_cursor: null });
    });
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "Library" }));
    const input = screen.getByRole("searchbox", { name: "Search Library PDF or Word files" });
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.change(input, { target: { value: "second" } });

    await waitFor(() => expect(signals.at(-2)?.aborted).toBe(true));
    expect(await screen.findByText("Second.docx")).toBeVisible();
  });

  it("offers one native Word-copy option for imported DOCX drafts", async () => {
    const saved = product();
    saved.state.import = { kind: "document", bindingRole: "source",
      filename: "Factum.docx", fileType: "docx", snapshot: {
        documentId: "factum", versionId: "v1", sha256: "a".repeat(64),
      } };
    saved.state.bindings.source = { kind: "document", documentId: "factum",
      version: { versionId: "v1", sha256: "a".repeat(64) } };
    api.listAuthorities.mockResolvedValue([saved]);
    api.actOnAuthorities.mockResolvedValue({ ...saved, revision: 2,
      state: { ...saved.state, insertIntoDocument: true } });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);
    await userEvent.click(await screen.findByRole("checkbox", {
      name: "Create Word copy with table",
    }));
    expect(api.actOnAuthorities).toHaveBeenCalledWith("draft-1", 1,
      { type: "set-document-output", enabled: true });
  });

  it("keeps a manual authority label editable", async () => {
    const saved = product();
    saved.state.authorities.oakes = { id: "oakes", key: "oakes", kind: "case",
      citation: "[1986] 1 SCR 103", name: "R v Oakes", displayName: null,
      excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "unresolved" } };
    saved.state.authorityOrder = ["oakes"];
    api.listAuthorities.mockResolvedValue([saved]);
    api.actOnAuthorities.mockImplementation(async (_id, _revision, action) => {
      const next = structuredClone(saved); next.revision = 2;
      next.state.authorities.oakes.displayName = action.displayName;
      return next;
    });
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);
    await userEvent.click(await screen.findByLabelText("Options for R v Oakes"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit label" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Authority label" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Authority label" }), "Oakes");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "Oakes" })).toBeVisible();
  });

  it("hands off to a canonical CanLII PDF and binds the selected download", async () => {
    const saved = product();
    saved.state.outputMode = "book";
    saved.state.authorities.oakes = { id: "oakes", key: "oakes", kind: "case",
      citation: "1986 CanLII 46 (SCC)", name: "R v Oakes", displayName: null,
      excluded: false, evidenceIds: [], locators: [], sourceIdentity: null,
      source: { kind: "pending-canlii", authorityKey: "oakes",
        pageUrl: "https://www.canlii.org/en/ca/scc/doc/1986/1986canlii46/1986canlii46.html",
        pdfUrl: "https://www.canlii.org/en/ca/scc/doc/1986/1986canlii46/1986canlii46.pdf" } };
    saved.state.authorityOrder = ["oakes"];
    api.listAuthorities.mockResolvedValue([saved]);
    api.getAuthorities.mockResolvedValue(saved);
    const attached = structuredClone(saved); attached.revision = 2;
    attached.state.authorities.oakes.source = { kind: "attached", bindingRole: "authority:oakes",
      filename: "1986canlii46.pdf", sourceSha256: "a".repeat(64), sourceUrl: null };
    api.attachAuthorityPdf.mockResolvedValue(attached);
    render(<MemoryRouter initialEntries={["/table-of-authorities?draft=draft-1"]}>
      <AuthoritiesWorkspace host={beaverAuthoritiesHost} />
    </MemoryRouter>);
    const link = await screen.findByRole("link", { name: "Download from CanLII" });
    expect(link).toHaveAttribute("href", saved.state.authorities.oakes.source.pdfUrl);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.upload(screen.getByLabelText("Add downloaded PDF"),
      new File(["%PDF-"], "1986canlii46.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("1986canlii46.pdf attached")).toBeVisible();
    expect(api.attachAuthorityPdf).toHaveBeenCalledWith("draft-1", "oakes", 1,
      expect.objectContaining({ name: "1986canlii46.pdf" }));
  });
});
