import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthoritiesWorkspace } from "@/app/authorities/AuthoritiesWorkspace";
import { beaverAuthoritiesHost } from "@/app/authorities/beaverHost";
import type { AuthoritiesProduct } from "@/app/authorities/types";
import TableOfAuthoritiesPage from "./page";

const api = vi.hoisted(() => ({
  listAuthorities: vi.fn(), createAuthorities: vi.fn(), getAuthorities: vi.fn(),
  actOnAuthorities: vi.fn(), attachAuthorityPdf: vi.fn(), buildAuthorities: vi.fn(),
  deleteWorkProduct: vi.fn(), duplicateWorkProduct: vi.fn(), refreshAuthorities: vi.fn(),
  updateWorkProduct: vi.fn(), uploadAuthoritiesDocument: vi.fn(), downloadDocument: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ options: [] as Record<string, unknown>[],
  handleChat: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
  ...api,
  directoryResource: () => ({ list: vi.fn().mockResolvedValue({ items: [] }) }),
}));
vi.mock("@/app/components/assistant/AssistantDock", () => ({
  AssistantDock: ({ tabs }: { tabs: Array<{ content: ReactNode }> }) =>
    <aside aria-label="Assistant dock">{tabs[0]?.content}</aside>,
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
  ChatView: ({ handleChat }: { handleChat: (...args: never[]) => Promise<unknown> }) =>
    <button type="button" onClick={() => void handleChat({ content: "Add the case" } as never)}>
      Complete Assistant turn
    </button>,
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
  useAssistantChat: (options: Record<string, unknown>) => {
    assistant.options.push(options);
    return { state: { chatId: options.chatId }, actions: {
      handleChat: assistant.handleChat, cancel: vi.fn(), clearRejectedTurn: vi.fn(),
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

describe("Authorities workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks(); assistant.options.length = 0;
    assistant.handleChat.mockResolvedValue(null);
    api.listAuthorities.mockResolvedValue([]);
  });

  it("keeps the scoped Assistant beside the draft and refreshes only that draft", async () => {
    const saved = product(), built = { ...product(), revision: 2 },
      refreshed = { ...product(), revision: 3 };
    saved.projectId = built.projectId = refreshed.projectId = "matter-1";
    api.listAuthorities.mockResolvedValue([saved]);
    api.getAuthorities.mockResolvedValue(refreshed);
    let finishBuild!: (value: { product: AuthoritiesProduct }) => void;
    api.buildAuthorities.mockImplementation(() => new Promise((resolve) => {
      finishBuild = resolve;
    }));
    render(<MemoryRouter><TableOfAuthoritiesPage /></MemoryRouter>);

    const openAssistant = await screen.findByRole("button", { name: "Assistant" });
    await waitFor(() => expect(openAssistant).toBeEnabled());
    await userEvent.click(openAssistant);
    expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 1,
    });
    expect(assistant.options.at(-1)?.projectId).toBe("matter-1");
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Build" }));
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toBeUndefined());
    expect(openAssistant).toBeDisabled();
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    finishBuild({ product: built });
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 2,
    }));

    await userEvent.click(screen.getByRole("button", { name: "Complete Assistant turn" }));
    await waitFor(() => expect(api.getAuthorities).toHaveBeenCalledWith("draft-1"));
    expect(api.getAuthorities).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(assistant.options.at(-1)?.workProduct).toEqual({
      kind: "authorities", id: "draft-1", revision: 3,
    }));
    expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
  });

  it("starts a durable blank book without an iframe or legacy runtime", async () => {
    api.createAuthorities.mockResolvedValue(product());
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Start with a document" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Blank book" }));
    expect(api.createAuthorities).toHaveBeenCalledWith({
      source: { kind: "manual" }, title: "Book of Authorities", projectId: undefined,
    });
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
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
    expect(api.getAuthorities).toHaveBeenCalledWith("draft-1");
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
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);
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
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);
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
    render(<MemoryRouter><AuthoritiesWorkspace host={beaverAuthoritiesHost} /></MemoryRouter>);
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
