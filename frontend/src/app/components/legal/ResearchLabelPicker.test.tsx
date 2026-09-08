import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResearchFile, ResearchLabel } from "@/app/lib/researchFiles";
import { RESEARCH_SOURCE_DRAG, ResearchLabelEditor, ResearchLabelPicker } from "./ResearchLabelPicker";
import type { ResearchFileMutations } from "./useResearchFileMutations";

const label = (id: string, order: number, scope: ResearchLabel["scope"] = "source",
  color: string | null = "#1d4ed8"): ResearchLabel => ({ id, order, scope, color, name: id.toUpperCase(), parentId: null });
const labels = { a: label("a", 0), b: label("b", 1), c: label("c", 2), d: label("d", 3),
  h: label("h", 0, "highlight", null) };
const file = { document: { id: "file-1" }, versionId: "v1", workingRevision: 0,
  state: { schemaVersion: "beaver.research.v2", labels, sources: {}, queries: null, note: "" } } as ResearchFile;
const lane = (act = vi.fn().mockResolvedValue(file)) => ({ act, query: vi.fn() }) as ResearchFileMutations;

describe("ResearchLabelPicker", () => {
  it("delegates an unsaved marker and drags a saved source identity", () => {
    const need = vi.fn(), drag = vi.fn(), mutations = lane();
    const view = render(<ResearchLabelPicker file={null} kind="source" labelIds={[]} title="Source"
      onNeedFile={need} mutations={mutations} />);
    fireEvent.click(screen.getByRole("button", { name: "Label Source" }));
    expect(need).toHaveBeenCalledOnce();
    view.rerender(<ResearchLabelPicker file={file} kind="source" itemId="source-1" labelIds={["a"]}
      title="Source" mutations={mutations} onSourceDrag={drag} />);
    const marker = screen.getByRole("button", { name: "Label Source: A" }), setData = vi.fn();
    fireEvent.dragStart(marker, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(RESEARCH_SOURCE_DRAG, "source-1");
    expect(drag).toHaveBeenCalledOnce();
  });

  it("fills an added slot and clears one, saving each choice on the spot", async () => {
    const act = vi.fn().mockResolvedValue(file);
    render(<ResearchLabelEditor target={{ file, kind: "source", itemId: "source-1",
      labelIds: ["a", "b"], title: "Source", note: "Note" }} mutations={lane(act)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    fireEvent.click(screen.getByRole("button", { name: "C" }));
    await waitFor(() => expect(act).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "annotate", kind: "source", id: "source-1", labelIds: ["a", "b", "c"], note: "Note",
    })));
    fireEvent.click(screen.getByRole("button", { name: "Filed under A" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    await waitFor(() => expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ labelIds: ["b", "c"] })));
    expect(screen.getByRole("button", { name: "A" })).toHaveAttribute("aria-pressed", "false");
  });

  it("optimistically keeps the coloured control stable while autosaving evidence identity", async () => {
    const act = vi.fn().mockResolvedValue(file);
    render(<ResearchLabelEditor target={{ file, kind: "evidence", itemId: "e-1", sourceId: "source-1",
      labelIds: [], title: "Passage" }} mutations={lane(act)} onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Badge")).not.toBeInTheDocument();
    const choice = screen.getByRole("button", { name: "H" }), icon = choice.querySelector("span[style]");
    expect(icon).toHaveStyle({ backgroundColor: "#eab308" });
    fireEvent.click(choice);
    expect(screen.getByRole("button", { name: "H" })).toBe(choice);
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(choice.querySelector("span[style]")).toBe(icon);
    await waitFor(() => expect(act).toHaveBeenCalledWith({ type: "annotate", kind: "evidence",
      id: "e-1", sourceId: "source-1", labelIds: ["h"], note: "" }));
  });

  it("replaces a highlight type without offering additional assignment slots", async () => {
    const typed = { ...file, state: { ...file.state, labels: { ...labels,
      other: label("other", 1, "highlight", "#93ab87") } } }, act = vi.fn().mockResolvedValue(file);
    render(<ResearchLabelEditor target={{ file: typed, kind: "evidence", itemId: "e-1",
      sourceId: "source-1", labelIds: ["h"], title: "Passage" }} mutations={lane(act)} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Add label assignment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show this label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "None" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OTHER" }));
    await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({
      type: "annotate", kind: "evidence", id: "e-1", sourceId: "source-1", labelIds: ["other"],
    })));
  });

  it("does not turn arbitrary drags on label choices into membership changes", () => {
    const act = vi.fn().mockResolvedValue(file);
    render(<ResearchLabelEditor target={{ file, kind: "source", itemId: "source-1",
      labelIds: ["a", "b"], title: "Source" }} mutations={lane(act)} onClose={vi.fn()} />);
    fireEvent.drop(screen.getByRole("button", { name: "B" }), { dataTransfer: { types: ["text/plain"], getData: () => "0" } });
    expect(act).not.toHaveBeenCalled();
  });

  it("escapes clipping and returns focus after Escape or an outside click", async () => {
    const parentKeyDown = vi.fn();
    render(<div style={{ overflow: "hidden" }} onKeyDown={parentKeyDown}><ResearchLabelPicker file={file} kind="source"
      itemId="source-1" labelIds={["a"]} title="Source" mutations={lane()} /></div>);
    const trigger = screen.getByRole("button", { name: "Label Source: A" });
    trigger.focus(); fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Labels and note" }).parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: "Close label palette" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(parentKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger); fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("cascades into a branch and files an independent one without creating labels", async () => {
    const nested = { ...file, state: { ...file.state, labels: { ...labels,
      child: { ...label("child", 0), parentId: "a" }, leaf: { ...label("leaf", 0), parentId: "child" },
    } } }, act = vi.fn().mockResolvedValue(nested);
    render(<ResearchLabelEditor target={{ file: nested, kind: "source", itemId: "source-1",
      labelIds: [], title: "Source" }} mutations={lane(act)} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "CHILD" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "CHILD" }));
    fireEvent.click(screen.getByRole("button", { name: "LEAF" }));
    await waitFor(() => expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ labelIds: ["leaf"] })));
    fireEvent.click(screen.getByRole("button", { name: "Add a label" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(act).toHaveBeenLastCalledWith(expect.objectContaining({ labelIds: ["leaf", "b"] })));
    expect(act.mock.calls.every(([action]) => action.type === "annotate")).toBe(true);
  });

  it("keeps every generation's row reserved so revealing children moves nothing above", () => {
    const nested = { ...file, state: { ...file.state, labels: { ...labels,
      child: { ...label("child", 0), parentId: "a" }, leaf: { ...label("leaf", 0), parentId: "child" },
    } } };
    const view = render(<ResearchLabelEditor target={{ file: nested, kind: "source", itemId: "source-1",
      labelIds: [], title: "Source" }} mutations={lane()} onClose={vi.fn()} />);
    const rows = () => view.container.querySelectorAll<HTMLElement>('[role="dialog"] .overflow-x-auto');
    expect(rows()).toHaveLength(3);
    const first = rows()[0];
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(rows()).toHaveLength(3); expect(rows()[0]).toBe(first);
    fireEvent.click(screen.getByRole("button", { name: "CHILD" }));
    expect(rows()).toHaveLength(3); expect(rows()[0]).toBe(first);
  });
});
