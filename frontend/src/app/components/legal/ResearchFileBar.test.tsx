import { act, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchEvidence, ResearchFile, ResearchQueryReceipt } from "@/app/lib/researchFiles";
import { ResearchFileBar } from "./ResearchFileBar";

const api = vi.hoisted(() => ({
  actOnResearchFile: vi.fn(), createResearchFile: vi.fn(), directoryResource: vi.fn(),
  getResearchFile: vi.fn(), getResearchItems: vi.fn(), listProjects: vi.fn(),
  runResearchFileQuery: vi.fn(),
}));
vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/beaverApi")>()), ...api,
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
      baker: { id: "baker", labelIds: ["fairness"], badge: "Leading", note: "Leading case",
        passages: { count: 51, sha256: "p-hash", labelCounts: { holding: 1 }, unlabelledCount: 50 }, reference: { provider: "a2aj", id: "baker",
          kind: "case", title: "Baker v Canada", date: "1999-07-09", collection: "SCC" } },
      appeal: { id: "appeal", labelIds: [], badge: "", note: "", passages: null,
        reference: { provider: "a2aj", id: "appeal", kind: "case", title: "Appeal case",
          date: "2020-01-01", collection: "ONCA" } },
    } },
};

const render = (ui: ReactElement) => renderView(ui, { wrapper: MemoryRouter });
const openLabels = (passages = false) => {
  if (!screen.queryByRole("complementary", { name: "Label organizer" }))
    fireEvent.click(screen.getByRole("button", { name: /^Labels/ }));
  if (passages) fireEvent.click(screen.getByRole("button", { name: "Passages", exact: true }));
};
const openSearch = () => fireEvent.click(screen.getByRole("button", { name: "Search Saved sources" }));
let resize: (width: number) => void;
const renderWorkspace = async () => {
  const view = render(<ResearchFileBar file={file} onChange={vi.fn()} />);
  await screen.findByText("Baker v Canada");
  return view;
};
const openBaker = () => {
  const details = screen.getByText("Baker v Canada").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: true }));
};

describe("ResearchFileBar", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: (entries: unknown[]) => void) { resize = (width) => callback([{ contentRect: { width } }]); }
      observe() {} disconnect() {}
    });
    localStorage.clear();
    vi.clearAllMocks();
    api.actOnResearchFile.mockResolvedValue(file);
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

  it("refreshes passages in an open source after an autosave", async () => {
    const view = await renderWorkspace();
    openBaker();
    expect(await screen.findByText("Key passage")).toBeVisible();
    api.getResearchItems.mockResolvedValue({ items: [{ kind: "passage", index: 0,
      value: { ...evidence, note: "Updated passage" } }], next_cursor: null });
    view.rerender(<ResearchFileBar file={{ ...file, workingRevision: 1, state: { ...file.state,
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker,
        passages: { ...file.state.sources.baker.passages!, sha256: "updated" } } } } }} onChange={vi.fn()} />);
    expect(await screen.findByText("Updated passage")).toBeVisible();
  });

  it("keeps loaded passages and history mounted without requests after metadata edits", async () => {
    const view = await renderWorkspace();
    openBaker();
    const passage = await screen.findByText("Key passage");
    openSearch();
    fireEvent.click(screen.getByText("Search history", { selector: "summary" }));
    await waitFor(() => expect(api.getResearchItems).toHaveBeenCalledTimes(2));
    const source = screen.getByText("Baker v Canada").closest("details")!;
    const panel = source.closest("section")!;
    panel.scrollTop = 120;
    const next = { ...file, workingRevision: 1, document: { ...file.document, filename: "Renamed.research.md" },
      state: { ...file.state, note: "Workspace note", labels: { ...file.state.labels,
        fairness: { ...file.state.labels.fairness, color: "#ff0000" } },
      sources: { ...file.state.sources, baker: { ...file.state.sources.baker, note: "Updated case note" } } } };
    view.rerender(<ResearchFileBar file={next} onChange={vi.fn()} />);
    expect(await screen.findByText("Updated case note")).toBeInTheDocument();
    expect(screen.getByText("Key passage")).toBe(passage);
    expect(source.open).toBe(true);
    expect(panel.scrollTop).toBe(120);
    expect(api.getResearchItems).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Back to sources" }));
    openLabels();
    fireEvent.click(screen.getByRole("button", { name: "Close labels" }));
    expect(screen.getByText("Baker v Canada").closest("details")).toHaveAttribute("open");
    expect(screen.getByText("Key passage")).toBeVisible();
    expect(api.getResearchItems).toHaveBeenCalledTimes(2);
  });

  it("returns to an available page when the last source on a later page is removed", async () => {
    const sources = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), {
      ...file.state.sources.appeal, id: String(index),
      reference: { ...file.state.sources.appeal.reference, title: `Case ${index + 1}` },
    }]));
    const current = { ...file, state: { ...file.state, sources } };
    const view = render(<ResearchFileBar file={current} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(screen.getByText("Case 51")).toBeVisible();
    const { "50": _removed, ...remaining } = sources;
    view.rerender(<ResearchFileBar file={{ ...current, workingRevision: 1,
      state: { ...current.state, sources: remaining } }} onChange={vi.fn()} />);
    expect(await screen.findByText("Case 1")).toBeVisible();
    expect(screen.queryByText("Case 51")).not.toBeInTheDocument();
  });

  it("starts with the collection and exposes one scoped label organizer on demand", async () => {
    await renderWorkspace();
    expect(screen.getByRole("region", { name: "Saved sources" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Label organizer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Search saved source text" })).not.toBeInTheDocument();
    openLabels();
    expect(screen.getByRole("button", { name: "Fairness, 1 sources" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Finding, 0 directly labelled passages" })).not.toBeInTheDocument();
    openLabels(true);
    expect(screen.getByRole("button", { name: "Finding, 0 directly labelled passages" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close labels" }));
    expect(screen.getByRole("region", { name: "Saved sources" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Labels" })).toHaveFocus();
    openSearch();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search saved source text" }), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Search Saved sources" })).toHaveFocus();
    expect(api.getResearchItems).not.toHaveBeenCalled();
  });

  it("closes a label palette on Escape without closing the organizer behind it", async () => {
    await renderWorkspace(); openLabels();
    fireEvent.click(screen.getByRole("button", { name: "Label Baker v Canada: Fairness", hidden: true }));
    const palette = await screen.findByRole("dialog", { name: "Labels and note" });
    fireEvent.keyDown(within(palette).getByRole("textbox", { name: "Item note" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Labels and note" })).not.toBeInTheDocument());
    expect(screen.getByRole("complementary", { name: "Label organizer" })).toBeVisible();
  });

  it("opens the reader from a title and only loads passages with its disclosure", async () => {
    const read = vi.fn();
    render(<ResearchFileBar file={file} onChange={vi.fn()} onReadSource={read} selectedSourceId="baker" />);
    expect(screen.getByRole("button", { name: "Baker v Canada", exact: true })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Baker v Canada", exact: true }));
    expect(read).toHaveBeenCalledWith(file.state.sources.baker, undefined);
    expect(api.getResearchItems).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Passages in Baker v Canada" }));
    fireEvent.click(await screen.findByRole("button", { name: "para 5" }));
    expect(read).toHaveBeenLastCalledWith(file.state.sources.baker, "para 5");
  });

  it("keeps external sources as safe links instead of sending them to the legal reader", () => {
    const read = vi.fn(), external = { ...file.state.sources.baker, reference: {
      ...file.state.sources.baker.reference, provider: "hansard", url: "https://example.org/debate" } };
    render(<ResearchFileBar file={{ ...file, state: { ...file.state, sources: { baker: external } } }}
      onChange={vi.fn()} onReadSource={read} />);
    expect(screen.getByRole("link", { name: "Baker v Canada" })).toHaveAttribute("href", "https://example.org/debate");
    expect(screen.queryByRole("button", { name: "Baker v Canada", exact: true })).not.toBeInTheDocument();
  });

  it("shows navigation automatically when wide and preserves an explicit hide", async () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 900 } as DOMRect);
    await renderWorkspace();
    measure.mockRestore();
    expect(screen.getByRole("complementary", { name: "Label organizer" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close labels" }));
    act(() => resize(350)); act(() => resize(900));
    expect(screen.queryByRole("complementary", { name: "Label organizer" })).not.toBeInTheDocument();
  });

  it("opens saved passages through the app router with workspace and locator intact", async () => {
    function Location() { return <output aria-label="Location">{useLocation().pathname + useLocation().search}</output>; }
    render(<><ResearchFileBar file={file} onChange={vi.fn()} /><Location /></>);
    openBaker();
    fireEvent.click(await screen.findByRole("link", { name: "para 5" }));
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("/sources/view?");
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("research_file=file-1");
    expect(screen.getByRole("status", { name: "Location" })).toHaveTextContent("locator=para%205");
  });

  it("reorders labels by dragging the tree", async () => {
    await renderWorkspace();
    openLabels();
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

  it("rejects an over-deep label drop without showing a drop cue", async () => {
    const nested: ResearchFile = { ...file, state: { ...file.state, labels: { ...file.state.labels,
      child: { id: "child", name: "Child", parentId: "fairness", color: null, order: 0, scope: "source" },
      leaf: { id: "leaf", name: "Leaf", parentId: "child", color: null, order: 0, scope: "source" },
    } } };
    render(<ResearchFileBar file={nested} onChange={vi.fn()} />);
    openLabels();
    await screen.findByRole("button", { name: "Fairness, 1 sources" });
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
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 150, clientY: 20 });
    expect(target).not.toHaveClass("bg-blue-50");
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
  });

  it("moves a focused label with Alt+Arrow but ignores keys bubbled from its controls", async () => {
    await renderWorkspace();
    openLabels();
    const button = screen.getByRole("button", { name: "Fairness, 1 sources" });
    const row = button.closest<HTMLElement>("[data-tree-drop-folder]")!;
    fireEvent.keyDown(button, { key: "ArrowDown", altKey: true });
    expect(api.actOnResearchFile).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      expect.objectContaining({ type: "label", id: "fairness", parentId: null })));
  });

  it("reports exact source-label impact without guessing unloaded passage counts", async () => {
    await renderWorkspace();
    openLabels();
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected label" }));
    let dialog = screen.getByRole("alertdialog", { name: "Delete label?" });
    expect(dialog).toHaveTextContent("1 saved source will lose this label");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    openLabels(true);
    fireEvent.click(screen.getByRole("button", { name: "Holding, 1 directly labelled passages" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected highlight category" }));
    dialog = screen.getByRole("alertdialog", { name: "Delete label?" });
    expect(dialog).toHaveTextContent("Saved passages using these categories will lose them.");
    expect(dialog).not.toHaveTextContent(/\d+ saved item/u);
  });

  it("loads a source's passages on demand and removes one with its source identity", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages" && !input.sourceId)).toBe(false);
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(false);
    openBaker();
    await waitFor(() => expect(api.getResearchItems.mock.calls.some(([, input]) => input.sourceId === "baker")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Delete para 5" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Delete passage?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "remove", kind: "evidence", id: "e_1", sourceId: "baker" }));
  });

  it("counts and filters a second-page highlight without loading passage bodies", async () => {
    await renderWorkspace();
    openLabels(true);
    fireEvent.click(screen.getByRole("button", { name: "Holding, 1 directly labelled passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Filter sources by these passages" }));
    fireEvent.click(screen.getByRole("button", { name: "Close labels" }));
    const list = screen.getByRole("region", { name: "Saved sources" });
    expect(within(list).getByText("Baker v Canada")).toBeVisible();
    expect(within(list).queryByText("Appeal case")).not.toBeInTheDocument();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages")).toBe(false);
  });

  it("reports direct passage assignments without double-counting a parent and child", () => {
    const current = { ...file, state: { ...file.state, sources: { ...file.state.sources,
      baker: { ...file.state.sources.baker, passages: { ...file.state.sources.baker.passages!,
        count: 1, unlabelledCount: 0, labelCounts: { finding: 1, holding: 1 } } } } } };
    render(<ResearchFileBar file={current} onChange={vi.fn()} />); openLabels(true);
    expect(screen.getByRole("button", { name: "Finding, 1 directly labelled passages" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Holding, 1 directly labelled passages" })).toBeVisible();
    expect(api.getResearchItems).not.toHaveBeenCalled();
  });

  it("searches the visible source filters but does not silently narrow a new search to old matches", async () => {
    await renderWorkspace();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search list" }), { target: { value: "Baker" } });
    openSearch();
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker"] })));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search list" }), { target: { value: "case" } });
    openSearch();
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({ sourceIds: ["baker", "appeal"] }));
  });

  it("runs plain search and an immediately persisted capture rule without a save step", async () => {
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
    openSearch();
    expect(screen.getByText("Search history", { selector: "summary" }).closest("details")).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const dialog = screen.getByRole("dialog", { name: "Capture rule" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Phrase to find" }),
      { target: { value: "natural justice" } });
    expect(within(dialog).queryByRole("button", { name: /save rule/i })).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("beaver.research.recipe.v1:file-1")!).rules[0].phrase)
      .toBe("natural justice"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Run rules" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledTimes(2));
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      rules: [expect.objectContaining({ phrase: "natural justice" })],
    }));
  });

  it("loads receipt history only when opened and returns to sources for its matches", async () => {
    await renderWorkspace();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(false);
    openSearch();
    fireEvent.click(screen.getByText("Search history", { selector: "summary" }));
    const query = await screen.findByText("duty", { selector: "span" });
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "queries")).toBe(true);
    fireEvent.click(query);
    expect(screen.getByLabelText("Sources searched")).toHaveTextContent("Baker v Canada");
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Use these rules" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("beaver.research.recipe.v1:file-1")!)).toMatchObject({
      rules: [expect.objectContaining({ phrase: "duty" })], conflict: "append",
    }));
    fireEvent.click(screen.getByRole("button", { name: "View matches" }));
    const list = screen.getByRole("region", { name: "Saved sources" });
    expect(await within(list).findByText("Baker v Canada")).toBeVisible();
    expect(within(list).queryByText("Appeal case")).not.toBeInTheDocument();
    expect(api.getResearchItems.mock.calls.some(([, input]) => input.kind === "passages" && !input.sourceId)).toBe(false);
  });

  it("continues a partial search without dropping earlier matches or reusing an old revision", async () => {
    await renderWorkspace(); openSearch();
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 1 }, receipt,
      coverage: { complete: false, next_after: "next-batch", attempted_sources: 1, selected_sources: 2 } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    expect(await screen.findByText("Partial search · 1 of 2 sources searched")).toBeVisible();
    expect(screen.queryByText("Appeal case")).not.toBeInTheDocument();
    api.runResearchFileQuery.mockResolvedValueOnce({ file: { ...file, workingRevision: 2 },
      receipt: { ...receipt, query_id: "q2", evidenceIds: ["e_2"], matchedSourceIds: ["appeal"] },
      coverage: { complete: true, next_after: null, attempted_sources: 2, selected_sources: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Continue search" }));
    expect(await screen.findByText("Search complete · 2 of 2 sources searched")).toBeVisible();
    expect(screen.getByText("Baker v Canada")).toBeVisible();
    expect(screen.getByText("Appeal case")).toBeVisible();
    expect(api.runResearchFileQuery).toHaveBeenLastCalledWith("file-1", expect.objectContaining({
      after: "next-batch", text: "fairness", workingRevision: 1,
    }));
    expect(screen.queryByRole("button", { name: "Continue search" })).not.toBeInTheDocument();
  });

  it("autosaves the workspace note", async () => {
    await renderWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Workspace options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace note" }),
      { target: { value: "Overall theory" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1", 0,
      { type: "note", markdown: "Overall theory" }));
  });

  it("replaces the Open picker with New workspace and returns on cancel", async () => {
    render(<ResearchFileBar file={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const picker = await screen.findByRole("dialog", { name: "Workspaces" });
    fireEvent.click(within(picker).getByRole("button", { name: "New workspace" }));
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).not.toBeInTheDocument();
    const create = screen.getByRole("dialog", { name: "New workspace" });
    expect(within(create).getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
    fireEvent.click(within(create).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Workspaces" })).toBeVisible();
  });

  it("chooses a visible Library or Project location when creating", async () => {
    api.listProjects.mockResolvedValue({ items: [{ id: "project-1", name: "Appeal" }], next_cursor: null });
    api.createResearchFile.mockResolvedValue(file);
    render(<ResearchFileBar file={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Project" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Appeal" }));
    expect(within(dialog).getByRole("button", { name: "Back to projects" })).toBeVisible();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Workspace name" }), { target: { value: "Fairness" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({ title: "Fairness", projectId: "project-1" }));
  });
});
