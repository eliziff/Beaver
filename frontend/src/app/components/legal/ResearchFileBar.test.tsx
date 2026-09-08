import { fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BeaverApiError } from "@/app/lib/api/client";
import type { ResearchEvidence, ResearchFile, ResearchQueryReceipt } from "@/app/lib/researchFiles";
import { ResearchFileBar as WorkspaceBar } from "./ResearchFileBar";
import { SourcesWorkspaceProvider, useSourcesWorkspace } from "./SourcesWorkspace";
function ResearchFileBar({ file, onChange, ...props }: React.ComponentProps<typeof WorkspaceBar> & {
  file: ResearchFile | null; onChange: (file: ResearchFile | null) => void }) {
  return <SourcesWorkspaceProvider file={file} onChange={onChange}><WorkspaceBar {...props} /></SourcesWorkspaceProvider>;
}

const api = vi.hoisted(() => ({
  actOnResearchFile: vi.fn(), createResearchFile: vi.fn(), directoryResource: vi.fn(),
  getResearchFile: vi.fn(), getResearchItems: vi.fn(), listProjects: vi.fn(),
  runResearchFileQuery: vi.fn(), getResearchCitation: vi.fn(),
  getWorkspaceFindings: vi.fn(), getWorkspaceViews: vi.fn(),
}));
vi.mock("../shared/views/DocumentViewer", () => ({ DocumentViewer: (props: { documentId: string; versionId: string }) =>
  <div aria-label="Original document">{props.documentId}:{props.versionId}</div> }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  actOnResearchFile: api.actOnResearchFile,
  createResearchFile: api.createResearchFile,
  getResearchFile: api.getResearchFile,
  getResearchItems: api.getResearchItems,
  runResearchFileQuery: api.runResearchFileQuery,
  getResearchCitation: api.getResearchCitation,
  getWorkspaceFindings: api.getWorkspaceFindings,
  getWorkspaceViews: api.getWorkspaceViews,
}));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  directoryResource: api.directoryResource
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
  ...await original<typeof import("@/app/lib/api/projects")>(),
  listProjects: api.listProjects
}));

const evidence: ResearchEvidence = {
  sourceId: "baker", labelIds: ["holding"], note: "Key passage",
  receipt: { evidence_id: "e_1", provider: "a2aj", stable_source_id: "baker",
    source_sha256: "source-hash", span_sha256: "span-hash", block_id: "paragraph:5",
    span_text: "A duty of fairness applies.", citation: "[1999] 2 SCR 817", name: null,
    external_url: null, locator: { kind: "paragraph", label: "para 5" } },
};
const receipt: ResearchQueryReceipt = {
  query_id: "q1", call_id: "c1", tool: "Read", executed_at: "2026-01-01T00:00:00Z",
  model: "luna", executor_version: "legal-source-pattern-v1",
  input: { syntax: "literal", target: "sources", rules: [
    { phrase: "duty", direction: "after", unit: "sentence", slot: "holding" },
  ], conflict: "append" }, results: [{ rank: 1, evidence_id: "e_1" }], sourceIds: ["baker"], matchedSourceIds: ["baker"],
  evidenceIds: ["e_1"], failures: [], slots: { e_1: ["holding"] },
};
const file: ResearchFile = {
  document: { id: "file-1", filename: "Fairness.research.md", file_type: "md",
    project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
    created_at: null, current_version_id: "version-1" },
  versionId: "version-1", workingRevision: 0,
  state: { schemaVersion: "beaver.research.v2", note: "", queries: { count: 1, sha256: "q-hash" },
    labels: {
      fairness: { id: "fairness", name: "Fairness", parentId: null, color: "#1d4ed8", order: 0, scope: "source" },
      other: { id: "other", name: "Other", parentId: null, color: "#7c3aed", order: 1, scope: "source" },
      finding: { id: "finding", name: "Finding", parentId: null, color: "#059669", order: 0, scope: "highlight" },
      holding: { id: "holding", name: "Holding", parentId: "finding", color: "#047857", order: 0, scope: "highlight" },
    },
    sources: {
      baker: { id: "baker", collected: true, labelIds: ["fairness", "other"],
      note: "Leading case",
        passages: { count: 51, sha256: "p-hash", labelCounts: { holding: 1 }, unlabelledCount: 50 }, reference: { provider: "a2aj", id: "baker",
          kind: "case", title: "Baker v Canada", date: "1999-07-09", collection: "SCC" } },
      appeal: { id: "appeal", collected: true, labelIds: [],
      note: "", passages: null,
        reference: { provider: "a2aj", id: "appeal", kind: "case", title: "Appeal case",
          date: "2020-01-01", collection: "ONCA" } },
    } },
};

const render = (ui: ReactElement) => renderView(ui, { wrapper: MemoryRouter });
const openSearch = () => fireEvent.click(screen.getByRole("tab", { name: "Search" }));
const renderWorkspace = async () => {
  const view = render(<ResearchFileBar file={file} onChange={vi.fn()} />);
  await screen.findAllByRole("treeitem", { name: "Baker v Canada" });
  return view;
};
const openBaker = () => fireEvent.click(screen.getAllByRole("button", { name: "Passages in Baker v Canada" })[0]);
const menu = (name: string) => fireEvent.click(screen.getAllByRole("button", { name })[0]);
const highlightTree = () => within(screen.getByRole("tree", { name: "Highlight types" }));

describe("ResearchFileBar", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {} disconnect() {}
    });
    localStorage.clear(); sessionStorage.clear();
    vi.clearAllMocks();
    api.actOnResearchFile.mockResolvedValue(file);
    api.getWorkspaceFindings.mockResolvedValue({ items: [], next_offset: null, total: 0 });
    api.getWorkspaceViews.mockResolvedValue({ tables: [], chats: [] });
    api.directoryResource.mockReturnValue({
      list: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      createFolder: vi.fn(), renameDocument: vi.fn(),
    });
    api.listProjects.mockResolvedValue({ items: [], next_cursor: null });
    api.getResearchItems.mockImplementation(async (_id: string, input: { kind: string; sourceId?: string }) => {
      const items = input.kind === "queries"
        ? [{ kind: "query" as const, index: 0, value: receipt }]
        : input.sourceId === "appeal" ? [] : [{ kind: "passage" as const, index: 0, value: evidence }];
      return { items, next_cursor: null, total: items.length };
    });
    api.runResearchFileQuery.mockResolvedValue({
      file, receipt: { ...receipt, query_id: "run-1" },
    });
  });

  it("browses virtual folders over one source list, including unlabelled sources at All sources", async () => {
    await renderWorkspace();
    const tree = screen.getByRole("tree", { name: "Sources" });
    expect(within(tree).getAllByRole("treeitem").map((row) => row.getAttribute("aria-label")))
      .toEqual([null, "Fairness", "Baker v Canada", "Other", "Baker v Canada", "Appeal case"]);
    fireEvent.click(screen.getByRole("button", { name: "Fairness" }));
    expect(within(tree).getAllByRole("treeitem", { name: "Baker v Canada" })).toHaveLength(2);
    expect(within(tree).queryByRole("treeitem", { name: "Appeal case" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
    expect(within(tree).getByRole("treeitem", { name: "Appeal case" })).toBeVisible();
    expect(screen.queryByText(/Unsorted|Unclassified/)).not.toBeInTheDocument();
  });

  it("includes descendants regardless of insertion order and carries the selected folder to new searches", async () => {
    const nested = { ...file, state: { ...file.state, labels: {
      leaf: { ...file.state.labels.other, id: "leaf", name: "Leaf", parentId: "middle" },
      middle: { ...file.state.labels.other, id: "middle", name: "Middle", parentId: "fairness" },
      ...file.state.labels,
    }, sources: { ...file.state.sources, baker: { ...file.state.sources.baker, labelIds: ["leaf"] } } } };
    render(<ResearchFileBar file={nested} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fairness" }));
    expect(screen.getAllByRole("treeitem", { name: "Baker v Canada" })).toHaveLength(1);
    expect(screen.queryByRole("treeitem", { name: "Appeal case" })).not.toBeInTheDocument();
    openSearch(); fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker"] })));
  });

  it("narrows sources by selecting a label in the tree and by the text filter", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Fairness" }));
    expect(screen.getAllByRole("treeitem", { name: "Baker v Canada" })[0]).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: "Appeal case" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All sources/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "Appeal" } });
    expect(screen.queryByRole("treeitem", { name: "Baker v Canada" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Appeal case" })).toBeVisible();
  });

  it("respects a carried label scope before presenting source rows or handing off to chat", async () => {
    function Selection() { return <output aria-label="Current selection">{JSON.stringify(useSourcesWorkspace().selection)}</output>; }
    render(<SourcesWorkspaceProvider file={file} selection={{ target: "sources", labelIds: ["fairness"] }}>
      <WorkspaceBar /><Selection />
    </SourcesWorkspaceProvider>);
    expect(screen.getAllByRole("treeitem", { name: "Baker v Canada" })[0]).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: "Appeal case" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Current selection")).toHaveTextContent('"sourceIds":["baker"]'));
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("treeitem", { name: "Appeal case" })).toBeVisible();
  });

  it("creates a named highlight type in one action and cancels an unfinished type without writing", async () => {
    await renderWorkspace();
    const tree = highlightTree();
    fireEvent.click(tree.getByRole("button", { name: "New highlight type", exact: true }));
    fireEvent.keyDown(tree.getByRole("textbox", { name: "Highlight type name" }), { key: "Escape" });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
    fireEvent.click(tree.getByRole("button", { name: "New highlight type", exact: true }));
    const name = tree.getByRole("textbox", { name: "Highlight type name" });
    fireEvent.change(name, { target: { value: "Drafting language" } });
    api.actOnResearchFile.mockImplementation(async (_id, _version, _revision, action) => ({ ...file, workingRevision: 1,
      state: { ...file.state, labels: { ...file.state.labels, [action.id]: action } } }));
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(tree.getByRole("treeitem", { name: "Drafting language" })).toBeVisible());
    expect(api.actOnResearchFile).toHaveBeenCalledTimes(1);
    expect(api.actOnResearchFile.mock.calls[0][3]).toMatchObject({ type: "label", name: "Drafting language", scope: "highlight", parentId: null, color: expect.stringMatching(/^#[0-9a-f]{6}$/) });
  });

  it("nests a highlight type by keyboard and changes its single colour without a second assignment", async () => {
    await renderWorkspace();
    const tree = highlightTree();
    fireEvent.keyDown(tree.getByRole("button", { name: "Holding" }), { key: "ArrowLeft", altKey: true });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "holding", scope: "highlight", parentId: null })));
    fireEvent.change(tree.getByLabelText("Holding colour"), { target: { value: "#91a58c" } });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenLastCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "holding", color: "#91a58c", parentId: "finding" })));
  });

  it("shows a source's saved passages under it when it is expanded", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(false);
    openBaker();
    expect(await screen.findAllByRole("treeitem", { name: /para 5$/ })).not.toHaveLength(0);
    expect(screen.getAllByText("A duty of fairness applies.")[0]).toBeVisible();
  });

  it("adds a label by dropping a source onto it", async () => {
    await renderWorkspace();
    const target = document.querySelector<HTMLElement>('[data-tree-drop-folder="other"]')!;
    const transfer = { types: ["application/x-beaver-research-source"],
      getData: (type: string) => type === "application/x-beaver-research-source" ? "appeal" : "",
      setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 10, clientY: 20 });
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "annotate", kind: "source", id: "appeal", labelIds: ["other"] }));
  });

  it("refreshes passages in an open source after an autosave", async () => {
    const view = await renderWorkspace();
    openBaker();
    expect(await screen.findAllByTitle(/Key passage/)).not.toHaveLength(0);
    api.getResearchItems.mockResolvedValue({ items: [{ kind: "passage", index: 0,
      value: { ...evidence, note: "Updated passage" } }], next_cursor: null });
    view.rerender(<ResearchFileBar file={{ ...file, workingRevision: 1, state: { ...file.state,
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker,
        passages: { ...file.state.sources.baker.passages!, sha256: "updated" } } } } }} onChange={vi.fn()} />);
    expect(await screen.findAllByTitle(/Updated passage/)).not.toHaveLength(0);
  });

  it("keeps loaded passages and history mounted without requests after metadata edits", async () => {
    const view = await renderWorkspace();
    openBaker();
    await screen.findAllByTitle(/Key passage/);
    openSearch();
    fireEvent.click(screen.getByText("Previous searches", { selector: "summary" }));
    await waitFor(() => expect(api.getResearchItems).toHaveBeenCalledTimes(2));
    const next = { ...file, workingRevision: 1, document: { ...file.document, filename: "Renamed.research.md" },
      state: { ...file.state, note: "Workspace note", labels: { ...file.state.labels,
        fairness: { ...file.state.labels.fairness, color: "#ff0000" } },
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker, note: "Updated case note" } } } };
    view.rerender(<ResearchFileBar file={next} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Labels" }));
    expect(screen.getAllByTitle(/Key passage/)[0]).toBeVisible();
    expect(api.getResearchItems).toHaveBeenCalledTimes(2);
  });

  it("keeps folder navigation, one source list and three workspace tabs", async () => {
    await renderWorkspace();
    expect(screen.getByRole("tree", { name: "Sources" })).toBeVisible();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Labels", "Search", "Memo"]);
    expect(screen.queryByRole("textbox", { name: "Search saved source text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Highlight types" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Highlight types" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Filter" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "List options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Organize" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search target" })).not.toBeInTheDocument();
    openSearch();
    expect(screen.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true");
    expect(api.getResearchItems).not.toHaveBeenCalled();
  });

  it("narrows the tree with the one filter field", async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "Appeal" } });
    const tree = screen.getByRole("tree", { name: "Sources" });
    expect(within(tree).getByRole("treeitem", { name: "Appeal case" })).toBeVisible();
    expect(within(tree).queryAllByRole("treeitem", { name: "Baker v Canada" })).toHaveLength(0);
  });

  it("selects the highlight type without changing the research scope", async () => {
    await renderWorkspace();
    fireEvent.click(highlightTree().getByRole("button", { name: "Holding" }));
    const tree = screen.getByRole("tree", { name: "Sources" });
    expect(within(tree).getAllByRole("treeitem", { name: "Baker v Canada" })[0]).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Appeal case" })).toBeVisible();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages")).toBe(false);
  });

  it("edits a source's labels from its row menu and closes the palette on Escape", async () => {
    await renderWorkspace();
    menu("Baker v Canada options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Labels" }));
    const palette = await screen.findByRole("dialog", { name: "Labels and note" });
    fireEvent.keyDown(within(palette).getByRole("textbox", { name: "Item note" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Labels and note" })).not.toBeInTheDocument());
    expect(screen.getByRole("tree", { name: "Sources" })).toBeVisible();
  });

  it("opens the reader only from the Open control, never from touching the row", async () => {
    const read = vi.fn();
    render(<ResearchFileBar file={file} onChange={vi.fn()} onReadSource={read} selectedSourceId="baker" />);
    const title = screen.getAllByRole("button", { name: "Baker v Canada", exact: true })[0];
    expect(title).toHaveAttribute("aria-current", "true");
    fireEvent.click(title);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Open Baker v Canada" })[0]);
    expect(read).toHaveBeenCalledWith(file.state.sources.baker, undefined);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open ¶ 5" }))[0]);
    expect(read).toHaveBeenLastCalledWith(file.state.sources.baker, "para 5");
  });

  it("keeps external sources as safe links instead of sending them to the legal reader", () => {
    const read = vi.fn(), external = { ...file.state.sources.baker, labelIds: [], reference: {
      ...file.state.sources.baker.reference, provider: "hansard", url: "https://example.org/debate" } };
    render(<ResearchFileBar file={{ ...file, state: { ...file.state, sources: { baker: external } } }}
      onChange={vi.fn()} onReadSource={read} />);
    expect(screen.getByRole("link", { name: "Open Baker v Canada" })).toHaveAttribute("href", "https://example.org/debate");
    expect(read).not.toHaveBeenCalled();
  });

  it("opens saved passages through the app router with workspace and locator intact", async () => {
    function Location() { return <output aria-label="Location">{useLocation().pathname + useLocation().search}</output>; }
    render(<><ResearchFileBar file={file} onChange={vi.fn()} /><Location /></>);
    openBaker();
    fireEvent.click((await screen.findAllByRole("link", { name: "Open ¶ 5" }))[0]);
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/sources/view?");
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("research_file=file-1");
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("locator=para%205");
  });

  it("reorders labels by dragging the tree", async () => {
    await renderWorkspace();
    const dragged = document.querySelector<HTMLElement>('[data-tree-drop-folder="fairness"]')!;
    const target = document.querySelector<HTMLElement>('[data-tree-drop-folder="other"]')!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 0, left: 0, width: 200, height: 40, right: 200, bottom: 40, x: 0, y: 0,
      toJSON: vi.fn(),
    });
    const transfer = { types: ["application/x-beaver-research-label"], setData: vi.fn(),
      getData: (type: string) => type === "application/x-beaver-research-label" ? "fairness" : "",
      effectAllowed: "none" };
    fireEvent.dragStart(dragged, { dataTransfer: transfer });
    const over = new MouseEvent("dragover", { bubbles: true, clientX: 10, clientY: 35 });
    Object.defineProperty(over, "dataTransfer", { value: transfer }); fireEvent(target, over);
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "fairness", parentId: null, order: 1.5 })));
  });

  it("moves a focused label with Alt+Arrow but ignores keys bubbled from its controls", async () => {
    await renderWorkspace();
    const row = document.querySelector<HTMLElement>('[data-tree-drop-folder="fairness"]')!;
    fireEvent.keyDown(within(row).getByLabelText("Fairness colour"), { key: "ArrowDown", altKey: true });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
    fireEvent.keyDown(within(row).getByRole("button", { name: "Fairness" }), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "fairness", parentId: null })));
  });

  it("reports exact source-label impact without guessing unloaded passage counts", async () => {
    await renderWorkspace();
    menu("Fairness options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    let dialog = screen.getByRole("alertdialog", { name: "Delete label?" });
    expect(dialog).toHaveTextContent("1 saved source will lose this label");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(highlightTree().getByRole("button", { name: "Holding options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    dialog = screen.getByRole("alertdialog", { name: "Delete label?" });
    expect(dialog).toHaveTextContent("Its highlights will be kept under Highlight.");
    expect(dialog).not.toHaveTextContent(/\d+ saved source/u);
  });

  it("loads a source's passages on demand and removes one with its source identity", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages" && !input.sourceId)).toBe(false);
    openBaker();
    await waitFor(() => expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(true));
    menu("¶ 5 options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete passage?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "remove", kind: "evidence", id: "e_1", sourceId: "baker" }));
  });

  it("searches the visible source filters but does not silently narrow a new search to old matches", async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "Baker" } });
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker"] })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter" }), { target: { value: "case" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker", "appeal"] }));
  });

  it("runs a plain phrase search and a capture rule without a rule editor", async () => {
    await renderWorkspace();
    openSearch();
    const failures = [{ sourceId: "baker", code: "result_limit" }, { sourceId: "appeal", code: "unavailable" }];
    api.runResearchFileQuery.mockResolvedValueOnce({ file,
      receipt: { ...receipt, query_id: "limited", failures } });
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }),
      { target: { value: "procedural fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1",
      expect.objectContaining({ text: "procedural fairness", syntax: "literal", target: "sources",
        versionId: "version-1", workingRevision: 0 })));
    expect((await screen.findAllByText(/A duty of fairness applies/))[0]).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "its sentence" }));
    fireEvent.click(screen.getByRole("button", { name: "after the phrase" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }), { target: { value: "natural justice" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      syntax: "literal", target: "sources", conflict: "append",
      rules: [{ phrase: "natural justice", direction: "after", unit: "sentence" }],
    }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends a Boolean expression as terms and keeps a malformed one beside the input", async () => {
    await renderWorkspace(); openSearch();
    const input = screen.getByRole("textbox", { name: "Phrase to find in saved sources" });
    fireEvent.change(input, { target: { value: 'fairness AND (duty OR "natural justice")' } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1",
      expect.objectContaining({ text: 'fairness AND (duty OR "natural justice")', syntax: "terms" })));
    api.runResearchFileQuery.mockRejectedValueOnce(new BeaverApiError({ status: 400,
      code: "invalid_query", message: "Check the search: AND, OR, NOT, matching brackets and closed quotes." }));
    fireEvent.change(input, { target: { value: "fairness AND (duty" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/Check the search/)).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "fairness AND (duty)" } });
    expect(screen.queryByText(/Check the search/)).not.toBeInTheDocument();
  });

  it("saves matched passages under the active pen", async () => {
    await renderWorkspace(); openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }), { target: { value: "duty" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(highlightTree().getByRole("button", { name: "Holding" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Highlight all as/ }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "label-selection", target: "passages", sourceIds: ["baker"], evidenceIds: ["e_1"], assign: ["holding"], mode: "replace" }));
  });

  it("loads previous searches only when opened and reruns one from its own row", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(false);
    openSearch();
    fireEvent.click(screen.getByText("Previous searches", { selector: "summary" }));
    const query = await screen.findByRole("button", { name: /duty/ });
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(true);
    expect(screen.getByLabelText("Sources searched")).toHaveAttribute("title", expect.stringContaining("Baker v Canada"));
    fireEvent.click(query);
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({
      rules: [expect.objectContaining({ phrase: "duty" })], conflict: "append" })));
    expect((await screen.findAllByText(/of fairness applies/))[0]).toBeVisible();
  });

  it("continues a partial search without dropping earlier matches or reusing an old revision", async () => {
    await renderWorkspace(); openSearch();
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 1 }, receipt,
      coverage: { complete: false, next_after: "next-batch", attempted_sources: 1, selected_sources: 2 } });
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find in saved sources" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const more = await screen.findByRole("button", { name: "Continue searching" });
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 2 },
      receipt: { ...receipt, query_id: "q2", evidenceIds: ["e_2"], matchedSourceIds: ["appeal"] },
      coverage: { complete: true, next_after: null, attempted_sources: 2, selected_sources: 2 } });
    fireEvent.click(more);
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      after: "next-batch", text: "fairness", workingRevision: 1,
    })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue searching" })).not.toBeInTheDocument());
  });

  it("keeps the selected workspace available to retry after opening fails", async () => {
    api.directoryResource.mockReturnValue({ list: vi.fn().mockResolvedValue({
      items: [{ kind: "document", document: file.document }], next_cursor: null,
    }) });
    api.getResearchFile.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(file);
    const onChange = vi.fn();
    render(<ResearchFileBar file={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const picker = screen.getByRole("dialog", { name: "Workspaces" });
    fireEvent.click(await within(picker).findByLabelText("Select Fairness"));
    fireEvent.click(within(picker).getByRole("button", { name: "Open" }));
    expect(await within(picker).findByRole("alert")).toHaveTextContent("Failed to fetch");
    expect(within(picker).getByLabelText("Select Fairness")).toBeChecked();
    expect(onChange).not.toHaveBeenCalledWith(file);
    fireEvent.click(within(picker).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(file));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names a workspace inside the Open picker and cancels without creating a file", async () => {
    render(<ResearchFileBar file={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const picker = await screen.findByRole("dialog", { name: "Workspaces" });
    fireEvent.click(within(picker).getByRole("button", { name: "New workspace" }));
    expect(screen.getByRole("dialog")).toBe(picker);
    const name = within(picker).getByRole("textbox", { name: "Workspace name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Unfinished name" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(picker).toBeVisible();
    expect(within(picker).queryByRole("textbox", { name: "Workspace name" })).not.toBeInTheDocument();
    expect(api.createResearchFile).not.toHaveBeenCalled();
  });

  it("creates in the project being browsed and selects the new workspace", async () => {
    api.listProjects.mockResolvedValue({ items: [{ id: "project-1", name: "Appeal" }], next_cursor: null });
    api.createResearchFile.mockResolvedValue({ ...file, document: { ...file.document, project_id: "project-1" } });
    render(<ResearchFileBar file={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const picker = screen.getByRole("dialog", { name: "Workspaces" });
    fireEvent.click(within(picker).getByRole("tab", { name: "Projects" }));
    fireEvent.click(await within(picker).findByRole("button", { name: "Appeal" }));
    fireEvent.click(within(picker).getByRole("button", { name: "New workspace" }));
    const name = within(picker).getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "Fairness" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(await within(picker).findByLabelText("Select Fairness")).toBeChecked();
    expect(api.createResearchFile).toHaveBeenCalledWith({ title: "Fairness", projectId: "project-1" });
    expect(picker).toBeVisible();
  });
});
