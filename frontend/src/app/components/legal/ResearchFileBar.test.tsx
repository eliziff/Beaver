import { fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      baker: { id: "baker", labelIds: ["fairness", "other"], badge: "Leading", note: "Leading case",
        passages: { count: 51, sha256: "p-hash", labelCounts: { holding: 1 }, unlabelledCount: 50 }, reference: { provider: "a2aj", id: "baker",
          kind: "case", title: "Baker v Canada", date: "1999-07-09", collection: "SCC" } },
      appeal: { id: "appeal", labelIds: [], badge: "", note: "", passages: null,
        reference: { provider: "a2aj", id: "appeal", kind: "case", title: "Appeal case",
          date: "2020-01-01", collection: "ONCA" } },
    } },
};

const render = (ui: ReactElement) => renderView(ui, { wrapper: MemoryRouter });
const openSearch = () => fireEvent.click(screen.getByRole("tab", { name: "Search" }));
const renderWorkspace = async () => {
  const view = render(<ResearchFileBar file={file} onChange={vi.fn()} />);
  await screen.findAllByRole("listitem", { name: "Baker v Canada" });
  return view;
};
const openBaker = () => fireEvent.click(screen.getAllByRole("button", { name: "Passages in Baker v Canada" })[0]);
const chooseType = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Choose highlight type" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: new RegExp(`${name}$`) }));
};
const menu = (name: string) => fireEvent.click(screen.getAllByRole("button", { name })[0]);

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

  it("preserves label browsing and keeps unlabelled sources visible without a synthetic folder", async () => {
    await renderWorkspace();
    const tree = screen.getByRole("list", { name: "Research sources" });
    const names = within(tree).getAllByRole("listitem").map((row) => row.getAttribute("aria-label"));
    expect(names).toEqual(["Baker v Canada", "Appeal case"]);
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    expect(within(tree).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All sources" }));
    expect(within(tree).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("complementary", { name: "Label organizer" })).not.toBeInTheDocument();
  });

  it("shows a source's saved passages under it when it is expanded", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(false);
    openBaker();
    expect(await screen.findByRole("link", { name: "A duty of fairness applies." })).toBeVisible();
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

  it("shows current table findings and opens their original pinned document", async () => {
    const reference = { provider: "library" as const, kind: "document" as const, id: "agreement", versionId: "original-version", title: "Agreement.pdf" };
    const saved = { ...file, state: { ...file.state, tables: ["table-1"], sources: {
      agreement: { ...file.state.sources.appeal, id: "agreement", reference } } } };
    api.getWorkspaceFindings.mockResolvedValue({ total: 1, next_offset: null, items: [{
      reference: { kind: "cell", reviewId: "table-1", rowId: "agreement", columnIndex: 0 },
      question: { title: "Termination", format: "yes_no", prompt: "Find termination" },
      answer: { value: true, summary: "Yes", flag: "green", coverage: "partial", outcome: "answered",
          claims: [{ text: "Termination is permitted on notice.", evidence_ids: ["original"] }] }, evidence: [{ ...evidence.receipt,
            evidence_id: "original", provider: "library", stable_source_id: "agreement", name: "Agreement.pdf", version: "original-version",
            locator: { kind: "page", label: "2" } }] }] });
    render(<ResearchFileBar file={saved} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Passages in Agreement.pdf" }));
    fireEvent.click(await screen.findByText("Termination"));
    expect(screen.getByText("Yes")).toBeVisible();
    expect(screen.getByText(/Termination is permitted on notice/)).toBeVisible();
    expect(screen.getByText("Partial coverage")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Agreement.pdf, p. 2" }));
    expect(await screen.findByLabelText("Original document")).toHaveTextContent("agreement:original-version");
  });

  it("refreshes passages in an open source after an autosave", async () => {
    const view = await renderWorkspace();
    openBaker();
    expect(await screen.findAllByText("Key passage")).not.toHaveLength(0);
    api.getResearchItems.mockResolvedValue({ items: [{ kind: "passage", index: 0,
      value: { ...evidence, note: "Updated passage" } }], next_cursor: null });
    view.rerender(<ResearchFileBar file={{ ...file, workingRevision: 1, state: { ...file.state,
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker,
        passages: { ...file.state.sources.baker.passages!, sha256: "updated" } } } } }} onChange={vi.fn()} />);
    expect(await screen.findAllByText("Updated passage")).not.toHaveLength(0);
  });

  it("keeps loaded passages and history mounted without requests after metadata edits", async () => {
    const view = await renderWorkspace();
    openBaker();
    await screen.findAllByText("Key passage");
    openSearch();
    fireEvent.click(screen.getByText("Searches", { selector: "summary" }));
    await waitFor(() => expect(api.getResearchItems).toHaveBeenCalledTimes(2));
    const next = { ...file, workingRevision: 1, document: { ...file.document, filename: "Renamed.research.md" },
      state: { ...file.state, note: "Workspace note", labels: { ...file.state.labels,
        fairness: { ...file.state.labels.fairness, color: "#ff0000" } },
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker, note: "Updated case note" } } } };
    view.rerender(<ResearchFileBar file={next} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Research" }));
    expect(screen.getAllByText("Key passage")[0]).toBeVisible();
    expect(api.getResearchItems).toHaveBeenCalledTimes(2);
  });

  it("keeps one tree and three workspace tabs", async () => {
    await renderWorkspace();
    expect(screen.getByRole("list", { name: "Research sources" })).toBeVisible();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Research", "Search", "Memo"]);
    expect(screen.queryByRole("textbox", { name: "Search saved source text" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose highlight type" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "Filter sources" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "List options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Organize" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search target" })).not.toBeInTheDocument();
    openSearch();
    expect(screen.getByRole("tab", { name: "Search" })).toHaveAttribute("aria-selected", "true");
    expect(api.getResearchItems).not.toHaveBeenCalled();
  });

  it("narrows the tree with the one filter field", async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter sources" }), { target: { value: "Appeal" } });
    const tree = screen.getByRole("list", { name: "Research sources" });
    expect(within(tree).getByRole("listitem", { name: "Appeal case" })).toBeVisible();
    expect(within(tree).queryByRole("listitem", { name: "Baker v Canada" })).not.toBeInTheDocument();
  });

  it("selects a highlight type without hiding other research sources", async () => {
    await renderWorkspace();
    chooseType("Holding");
    const tree = screen.getByRole("list", { name: "Research sources" });
    expect(within(tree).getAllByRole("listitem", { name: "Baker v Canada" })[0]).toBeVisible();
    expect(within(tree).getByRole("listitem", { name: "Appeal case" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose highlight type" })).toHaveTextContent("Holding");
    chooseType("Holding");
    expect(screen.getByRole("button", { name: "Choose highlight type" })).toHaveTextContent("Holding");
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages")).toBe(false);
  });

  it("edits a source's labels from its row menu and closes the palette on Escape", async () => {
    await renderWorkspace();
    menu("Baker v Canada options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Labels / note" }));
    const palette = await screen.findByRole("dialog", { name: "Labels and note" });
    fireEvent.keyDown(within(palette).getByRole("textbox", { name: "Item note" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Labels and note" })).not.toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Research sources" })).toBeVisible();
  });

  it("inserts a citation from the memo toolbar instead of a row action", async () => {
    api.getResearchCitation.mockResolvedValue({ href: "/sources/view?provider=a2aj&source_id=baker&citation=1999%202%20SCR%20817&authority=Baker%20v%20Canada" });
    await renderWorkspace();
    expect(screen.queryByRole("button", { name: "Cite Baker v Canada" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Insert citation" }, { timeout: 5000 }));
    const picker = await screen.findByRole("group", { name: "Insert citation" });
    fireEvent.click(within(picker).getByRole("button", { name: /Baker v Canada/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Whole source" }));
    await waitFor(() => expect(api.getResearchCitation).toHaveBeenCalledWith("file-1", "baker", undefined));
  });

  it("opens the reader from a title and only loads passages with its disclosure", async () => {
    const read = vi.fn();
    render(<ResearchFileBar file={file} onChange={vi.fn()} onReadSource={read} selectedSourceId="baker" />);
    const title = screen.getAllByRole("button", { name: "Baker v Canada", exact: true })[0];
    expect(title).toHaveAttribute("aria-current", "true");
    fireEvent.click(title);
    expect(read).toHaveBeenCalledWith(file.state.sources.baker, undefined);
    expect(api.getResearchItems).not.toHaveBeenCalled();
    openBaker();
    fireEvent.click((await screen.findAllByRole("button", { name: "A duty of fairness applies." }))[0]);
    expect(read).toHaveBeenLastCalledWith(file.state.sources.baker, "para 5");
  });

  it("keeps external sources as safe links instead of sending them to the legal reader", () => {
    const read = vi.fn(), external = { ...file.state.sources.baker, labelIds: [], reference: {
      ...file.state.sources.baker.reference, provider: "hansard", url: "https://example.org/debate" } };
    render(<ResearchFileBar file={{ ...file, state: { ...file.state, sources: { baker: external } } }}
      onChange={vi.fn()} onReadSource={read} />);
    expect(screen.getByRole("link", { name: "Baker v Canada" })).toHaveAttribute("href", "https://example.org/debate");
    expect(screen.queryByRole("button", { name: "Baker v Canada", exact: true })).not.toBeInTheDocument();
  });

  it("opens saved passages through the app router with workspace and locator intact", async () => {
    function Location() { return <output aria-label="Location">{useLocation().pathname + useLocation().search}</output>; }
    render(<><ResearchFileBar file={file} onChange={vi.fn()} /><Location /></>);
    openBaker();
    fireEvent.click((await screen.findAllByRole("link", { name: "A duty of fairness applies." }))[0]);
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
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 10, clientY: 35 });
    fireEvent.drop(target, { dataTransfer: transfer });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "fairness", parentId: null, order: 1.5 })));
  });

  it("moves a focused label with Alt+Arrow but ignores keys bubbled from its controls", async () => {
    await renderWorkspace();
    const row = document.querySelector<HTMLElement>('[data-tree-drop-folder="fairness"]')!;
    fireEvent.keyDown(within(row).getByRole("button", { name: "Fairness, 1 sources" }), { key: "ArrowDown", altKey: true });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
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
    menu("Choose highlight type");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit highlight types…" }));
    menu("Holding options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    dialog = screen.getByRole("alertdialog", { name: "Delete label?" });
    expect(dialog).toHaveTextContent("Its passages will keep their highlights using the default Highlight type.");
    expect(dialog).not.toHaveTextContent(/\d+ saved source/u);
  });

  it("loads a source's passages on demand and removes one with its source identity", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages" && !input.sourceId)).toBe(false);
    openBaker();
    await waitFor(() => expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(true));
    menu("para 5 options");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete highlight" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete passage?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "remove", kind: "evidence", id: "e_1", sourceId: "baker" }));
  });

  it("searches the visible source filters but does not silently narrow a new search to old matches", async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter sources" }), { target: { value: "Baker" } });
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker"] })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter sources" }), { target: { value: "case" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker", "appeal"] }));
  });

  it("runs plain search and a passage-extent capture without a rule editor", async () => {
    await renderWorkspace();
    openSearch();
    const failures = [{ sourceId: "baker", code: "result_limit" }, { sourceId: "appeal", code: "unavailable" }];
    api.runResearchFileQuery.mockResolvedValueOnce({ file,
      receipt: { ...receipt, query_id: "limited", failures } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }),
      { target: { value: "procedural fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1",
      expect.objectContaining({ text: "procedural fairness", syntax: "literal", target: "sources",
        versionId: "version-1", workingRevision: 0 })));
    expect(screen.getByText("1 matches · limit reached · 1 source failure", { selector: "span" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Passage extent" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Sentence after" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "natural justice" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      syntax: "literal", target: "sources", conflict: "append",
      rules: [{ phrase: "natural justice", direction: "after", unit: "sentence", slot: "" }],
    }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("highlights matched passages with the active pen", async () => {
    await renderWorkspace(); openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "duty" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all matches" }));
    chooseType("Holding");
    fireEvent.click(screen.getByRole("button", { name: "Highlight 1 as Holding" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "label-selection", target: "passages", sourceIds: ["baker"], evidenceIds: ["e_1"], assign: ["holding"], mode: "replace" }));
  });

  it("loads receipt history only when opened and returns to sources for its matches", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(false);
    openSearch();
    fireEvent.click(screen.getByText("Searches", { selector: "summary" }));
    const query = await screen.findByText("duty", { selector: "span" });
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(true);
    fireEvent.click(query);
    expect(screen.getByLabelText("Sources searched")).toHaveTextContent("Baker v Canada");
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({
      rules: [expect.objectContaining({ phrase: "duty" })], conflict: "append" })));
    fireEvent.click(screen.getByRole("button", { name: "View matches" }));
    const tree = screen.getByRole("list", { name: "Research sources" });
    expect((await within(tree).findAllByRole("listitem", { name: "Baker v Canada" }))[0]).toBeVisible();
    expect(within(tree).queryByRole("listitem", { name: "Appeal case" })).not.toBeInTheDocument();
  });

  it("shows saved query matches beyond the first passage page and restores unfiltered passages", async () => {
    const unrelated = { ...evidence, receipt: { ...evidence.receipt,
      evidence_id: "other-passage", span_text: "An unrelated passage." } };
    api.getResearchItems.mockImplementation(async (_id, input) => input.kind === "queries"
      ? { items: [{ kind: "query", index: 0, value: receipt }], next_cursor: null }
      : { items: [{ kind: "passage", index: input.cursor ? 50 : 0,
          value: input.cursor ? evidence : unrelated }], next_cursor: input.cursor ? null : "page-2" });
    await renderWorkspace(); openSearch();
    fireEvent.click(screen.getByText("Searches", { selector: "summary" }));
    fireEvent.click(await screen.findByText("duty", { selector: "span" }));
    fireEvent.click(screen.getByRole("button", { name: "View matches" }));
    expect((await screen.findAllByText("A duty of fairness applies."))[0]).toBeVisible();
    expect(screen.queryByText("An unrelated passage.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear matches" }));
    expect((await screen.findAllByText("An unrelated passage."))[0]).toBeVisible();
  });

  it("continues a partial search without dropping earlier matches or reusing an old revision", async () => {
    await renderWorkspace(); openSearch();
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 1 }, receipt,
      coverage: { complete: false, next_after: "next-batch", attempted_sources: 1, selected_sources: 2 } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    expect(await screen.findByText("Partial search · 1 of 2 sources searched")).toBeVisible();
    expect(screen.queryByRole("listitem", { name: "Appeal case" })).not.toBeInTheDocument();
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 2 },
      receipt: { ...receipt, query_id: "q2", evidenceIds: ["e_2"], matchedSourceIds: ["appeal"] },
      coverage: { complete: true, next_after: null, attempted_sources: 2, selected_sources: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    expect(await screen.findByText("Search complete · 2 of 2 sources searched")).toBeVisible();
    expect(screen.getAllByRole("listitem", { name: "Baker v Canada" })[0]).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Appeal case" })).toBeVisible();
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      after: "next-batch", text: "fairness", workingRevision: 1,
    }));
    expect(screen.queryByRole("button", { name: "Continue search" })).not.toBeInTheDocument();
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
  it("browses nested labels without duplicate sources and filters highlights independently of the drawing type", async () => {
    const nested = { ...file, state: { ...file.state, labels: { ...file.state.labels,
      child: { ...file.state.labels.fairness, id: "child", name: "Duty", parentId: "fairness", order: 0 } },
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker, labelIds: ["child", "other"] } } } };
    render(<ResearchFileBar file={nested} onChange={vi.fn()} />);
    const sources = screen.getByRole("list", { name: "Research sources" });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    expect(within(sources).getAllByRole("listitem")).toHaveLength(1);
    expect(within(sources).getByRole("listitem", { name: "Baker v Canada" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Source filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by highlight type" }), { target: { value: "finding" } });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(1);
    chooseType("Holding");
    expect(screen.getByRole("combobox", { name: "Filter by highlight type" })).toHaveValue("finding");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "No source labels" }));
    expect(within(sources).getByRole("listitem", { name: "Appeal case" })).toBeVisible();
    expect(within(sources).queryByRole("listitem", { name: "Baker v Canada" })).not.toBeInTheDocument();
  });

  it("creates a nested highlight type with one name and colour, without an independent pen assignment", async () => {
    await renderWorkspace();
    menu("Choose highlight type");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit highlight types…" }));
    const dialog = screen.getByRole("dialog", { name: "Highlight types" });
    menu("Finding options");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add child" }));
    const name = within(dialog).getByRole("textbox", { name: "Highlight type name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Application" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add", exact: true }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", name: "Application", parentId: "finding", scope: "highlight", color: expect.stringMatching(/^#[a-f0-9]{6}$/) })));
    expect(api.actOnResearchFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("searchbox", { name: "Filter sources", hidden: true })).toHaveValue("");
  });

  it("moves a child out through its keyboard-accessible menu and rejects a cycle drop", async () => {
    const nested = { ...file, state: { ...file.state, labels: { ...file.state.labels,
      other: { ...file.state.labels.other, parentId: "fairness" } } } };
    render(<ResearchFileBar file={nested} onChange={vi.fn()} />);
    const parent = document.querySelector<HTMLElement>('[data-tree-drop-folder="fairness"]')!;
    const child = document.querySelector<HTMLElement>('[data-tree-drop-folder="other"]')!;
    const transfer = { types: ["application/x-beaver-research-label"], setData: vi.fn(),
      getData: () => "fairness", effectAllowed: "none" };
    fireEvent.dragStart(parent, { dataTransfer: transfer });
    fireEvent.drop(child, { dataTransfer: transfer });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
    menu("Other options");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move out" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "other", parentId: null })));
  });

});

it("intersects a supplied passage scope with a broader highlight-type filter", async () => {
  const scopedFile = { ...file, state: { ...file.state, sources: { baker: { ...file.state.sources.baker,
    passages: { count: 2, sha256: "two", labelCounts: { holding: 1, finding: 1 }, unlabelledCount: 0 } } } } };
  api.getResearchItems.mockResolvedValue({ items: [
    { kind: "passage", index: 0, value: evidence },
    { kind: "passage", index: 1, value: { ...evidence, labelIds: ["finding"], receipt: { ...evidence.receipt, evidence_id: "e_outside" } } },
  ], total: 2, next_cursor: null });
  function Selection() { return <output data-testid="scope">{JSON.stringify(useSourcesWorkspace().selection)}</output>; }
  render(<SourcesWorkspaceProvider file={scopedFile} selection={{ target: "passages", labelIds: ["holding"] }}>
    <WorkspaceBar /><Selection />
  </SourcesWorkspaceProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Source filters" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by highlight type" }), { target: { value: "finding" } });
  await waitFor(() => expect(JSON.parse(screen.getByTestId("scope").textContent!)).toMatchObject({ target: "passages", members: [{ sourceId: "baker", evidenceIds: ["e_1"] }] }));
  expect(screen.getAllByText(evidence.receipt.span_text!)).toHaveLength(1);
});
