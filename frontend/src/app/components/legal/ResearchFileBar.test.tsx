import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { BeaverApiError } from "@/app/lib/apiTransport";
import { ResearchFileBar } from "./ResearchFileBar";

const api = vi.hoisted(() => ({ actOnResearchFile: vi.fn(), createResearchFile: vi.fn(),
  getResearchFile: vi.fn(), runResearchFileQuery: vi.fn() }));
vi.mock("@/app/lib/beaverApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/beaverApi")>()), ...api,
}));

const file: ResearchFile = {
  document: { id: "file-1", filename: "Fairness.research.md", file_type: "md",
    project_id: null, pdf_storage_path: null, size_bytes: 1, page_count: null,
    created_at: null, current_version_id: "version-1" },
  versionId: "version-1",
  state: { schemaVersion: "beaver.research.v1",
    labels: {
      fairness: { id: "fairness", name: "Fairness", parentId: null, color: "#1d4ed8", order: 0, scope: "source" },
      holding: { id: "holding", name: "Holding", parentId: null, color: "#047857", order: 0, scope: "highlight" },
    },
    sources: {
      baker: { id: "baker", labelIds: ["fairness"], badge: "Leading", note: "Leading case",
        reference: { provider: "a2aj", id: "baker", kind: "case", title: "Baker v Canada",
          date: "1999-07-09", collection: "SCC", url: "https://example.test/baker" } },
      appeal: { id: "appeal", labelIds: [], badge: "", note: "",
        reference: { provider: "a2aj", id: "appeal", kind: "case", title: "Appeal case",
          date: "2020-01-01", collection: "ONCA" } },
    },
    evidence: { e_1: { sourceId: "baker", labelIds: ["holding"], note: "Key passage",
      receipt: { evidence_id: "e_1", provider: "a2aj", stable_source_id: "baker", source_sha256: "a",
        span_sha256: "b", block_id: "paragraph:5", span_text: "A duty of fairness applies.", citation: "[1999] 2 SCR 817",
        name: null, external_url: null, locator: { kind: "paragraph", label: "para 5" } } } },
    queries: { q1: { query_id: "q1", call_id: "c1", tool: "Read", executed_at: "2025-01-01",
      model: "human", input: { rules: [{ phrase: "duty", slot: "holding" }] }, sourceIds: ["baker"],
      evidenceIds: ["e_1"], failures: [], slots: { e_1: ["holding"] } } }, note: "" },
};
const openBaker = () => { const details = screen.getByText("Baker v Canada").closest("details")!;
  details.open = true; fireEvent(details, new Event("toggle", { bubbles: true })); };

describe("ResearchFileBar", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); api.actOnResearchFile.mockResolvedValue(file);
    Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) } }); });

  it("starts workspace creation directly when no workspace exists", () => {
    render(<ResearchFileBar file={null} active onChange={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeVisible();
  });

  it("keeps four slots and expands an adjacent panel from an empty slot", async () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    for (const name of ["Labels", "List", "Highlights", "Search Saved sources"])
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close List panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel to slot 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand Labels" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Labels panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel to slot 2" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "List" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("beaver.research.panels.v1")!))
      .toEqual(["labels", "list", "highlights", "search"]));
  });

  it("expands a panel when its header is dragged onto an adjacent panel", () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    const labels = screen.getByRole("heading", { name: "Labels" }).closest("section")!;
    const list = screen.getByRole("heading", { name: "List" }).closest("section")!;
    const transfer = { setData: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(labels.querySelector("header")!, { dataTransfer: transfer });
    fireEvent.dragOver(list.parentElement!, { dataTransfer: transfer });
    fireEvent.drop(list.parentElement!, { dataTransfer: transfer });
    expect(screen.getByRole("button", { name: "Restore Labels panel" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "List" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Highlights panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel to slot 3" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "List" }));
    expect(screen.getAllByRole("heading", { name: "List" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add panel to slot 2" })).toBeInTheDocument();
  });

  it("keeps overall notes out of the four-panel workspace", async () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Labels panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add panel to slot 1" }));
    expect(screen.queryByRole("menuitem", { name: "Notes" })).not.toBeInTheDocument();
  });

  it("scopes real capture rules through source and highlight label trees", async () => {
    api.runResearchFileQuery.mockResolvedValue({ file, queryId: "q2", failures: [],
      counts: { attemptedSources: 1, matchedSources: 1, matches: 1, failures: 0 } });
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Phrase to find" }), { target: { value: "duty of fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Unit" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Characters" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Characters" }), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as highlight" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Holding" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Conflict policy" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Longer passage" }));
    fireEvent.click(screen.getByRole("button", { name: "Run rules" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", {
      versionId: "version-1", syntax: "literal", target: "sources", labelIds: ["fairness"],
      sourceIds: ["baker"], conflict: "longer", rules: [{ phrase: "duty of fairness", direction: "after",
        unit: "chars", chars: 250, slot: "holding" }],
    }));
  });

  it("keeps filtering separate from editing and runs a plain terms query", async () => {
    api.runResearchFileQuery.mockResolvedValue({ file, queryId: "q2", failures: [],
      counts: { attemptedSources: 1, matchedSources: 1, matches: 1, failures: 0 } });
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    const row = screen.getByRole("button", { name: "Fairness, 1 sources" }).closest("div[draggable]")!;
    fireEvent.drop(row, { dataTransfer: { getData: (type: string) => type === "application/x-beaver-research-source" ? "appeal" : "" } });
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1",
      { type: "annotate", kind: "source", id: "appeal", labelIds: ["fairness"] }));
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    expect(screen.queryByRole("textbox", { name: "Label name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Fairness" }));
    expect(screen.getByRole("textbox", { name: "Label name" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search saved source text" }), { target: { value: "duty fairness" } });
    fireEvent.click(screen.getByRole("button", { name: "Search syntax" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All terms" }));
    fireEvent.click(screen.getByRole("button", { name: "Find passages" }));
    await waitFor(() => expect(api.runResearchFileQuery).toHaveBeenCalledWith("file-1", {
      versionId: "version-1", text: "duty fairness", syntax: "terms", target: "sources",
      labelIds: ["fairness"], sourceIds: ["baker"],
    }));
  });

  it("adds a child under the one selected label", async () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add label" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1",
      expect.objectContaining({ type: "label", name: "New label", parentId: "fairness", scope: "source" })));
  });

  it("refreshes and retries a concurrent file update", async () => {
    const latest = { ...file, versionId: "version-2" }, onChange = vi.fn();
    api.actOnResearchFile.mockRejectedValueOnce(new BeaverApiError({ status: 409, message: "changed" }));
    api.getResearchFile.mockResolvedValueOnce(latest);
    render(<ResearchFileBar file={file} onChange={onChange} />);
    openBaker();
    fireEvent.click(screen.getByRole("button", { name: "Delete para 5" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenLastCalledWith("file-1", "version-2",
      { type: "remove", kind: "evidence", id: "e_1" }));
    expect(onChange).toHaveBeenCalledWith(file);
  });

  it("searches receipt details, restores their rules, and reclassifies evidence", async () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Search history", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Use these rules" }));
    fireEvent.click(screen.getByRole("button", { name: /duty/u }));
    expect(screen.getByRole("textbox", { name: "Phrase to find" })).toHaveValue("duty");
    expect(screen.getByRole("button", { name: "Save as highlight" })).toHaveTextContent("Holding");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search history" }), { target: { value: "missing" } });
    expect(screen.queryByRole("button", { name: "Use these rules" })).not.toBeInTheDocument();
    openBaker();
    fireEvent.click(screen.getByRole("button", { name: "Label para 5" }));
    expect(screen.getByRole("dialog", { name: "Labels and note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Holding" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1",
      { type: "annotate", kind: "evidence", id: "e_1", labelIds: ["holding"], note: "Key passage" }));
  });

  it("exposes list badges, filters, exact passage actions, and search summaries", async () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    expect(screen.getByText("Leading")).toBeInTheDocument();
    expect(screen.getByText("Search history", { selector: "summary" })).toBeInTheDocument();
    openBaker();
    fireEvent.click(screen.getByRole("button", { name: "Delete para 5" }));
    await waitFor(() => expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1",
      { type: "remove", kind: "evidence", id: "e_1" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter jurisdiction" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "ONCA" }));
    expect(screen.queryByText("Baker v Canada")).not.toBeInTheDocument();
    expect(screen.getByText("Appeal case")).toBeInTheDocument();
  });

  it("keeps the selected label visible in the List heading", () => {
    render(<ResearchFileBar file={file} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Fairness, 1 sources" }));
    expect(screen.getByRole("heading", { name: "Fairness" })).toBeInTheDocument();
  });

  it("creates an ordinary workspace file when the first label is added", async () => {
    api.createResearchFile.mockResolvedValue(file);
    const onChange = vi.fn(); render(<ResearchFileBar file={null} projectId="matter-1" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add label" }));
    await waitFor(() => expect(api.createResearchFile).toHaveBeenCalledWith({ title: "Untitled workspace", projectId: "matter-1" }));
    expect(api.actOnResearchFile).toHaveBeenCalledWith("file-1", "version-1",
      expect.objectContaining({ type: "label", name: "New label", parentId: null, scope: "source" }));
  });
});
