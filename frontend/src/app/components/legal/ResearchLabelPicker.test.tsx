import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResearchFile, ResearchLabel } from "@/app/lib/researchFiles";
import { ResearchLabelEditor, ResearchLabelPicker } from "./ResearchLabelPicker";

const actOnResearchFile = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/beaverApi", () => ({ actOnResearchFile }));

const label = (id: string, order: number): ResearchLabel => ({ id, order, name: id.toUpperCase(),
  parentId: null, color: "#1d4ed8", scope: "source" });
const labels = { a: label("a", 1), b: label("b", 0), c: label("c", 2), d: label("d", 3) };
const file = { document: { id: "file-1" }, versionId: "v1",
  state: { labels, sources: {}, evidence: {}, queries: {}, note: "", schemaVersion: "beaver.research.v1" } } as ResearchFile;

describe("ResearchLabelEditor", () => {
  it("coalesces preparation and shows failures", async () => {
    const prepareFile = vi.fn().mockRejectedValue(new Error("Storage unavailable"));
    render(<ResearchLabelPicker file={null} kind="source" labelIds={[]} title="Source"
      prepareFile={prepareFile} onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Label Source" });
    fireEvent.click(button); fireEvent.click(button);
    expect(prepareFile).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
  });

  it("drags saved sources without fabricating a badge", () => {
    const setData = vi.fn(); render(<ResearchLabelPicker file={file} kind="source" itemId="source-1"
      labelIds={["a"]} title="Source" badge="" buttonLabel="A" onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Label Source" });
    expect(button).toHaveAttribute("draggable", "true");
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    fireEvent.dragStart(button, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith("application/x-beaver-research-source", "source-1");
  });

  it("persists ordered memberships immediately", async () => {
    actOnResearchFile.mockResolvedValue(file); render(<ResearchLabelEditor target={{ file, kind: "source",
      itemId: "source-1", labelIds: ["a", "b", "c", "d"], title: "Source" }} onClose={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Assign another label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "B" }).compareDocumentPosition(
      screen.getByRole("button", { name: "A" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Additional label 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Show this label" }));
    await waitFor(() => expect(actOnResearchFile).toHaveBeenCalledWith("file-1", "v1",
      expect.objectContaining({ type: "annotate", labelIds: ["d", "a", "b", "c"] })));
  });

  it("does not invent primary-label UI for one top-level label", () => {
    render(<ResearchLabelEditor target={{ file: { ...file, state: { ...file.state, labels: { a: labels.a } } },
      kind: "source", itemId: "source-1", labelIds: ["a"], title: "Source" }} onClose={vi.fn()} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Shown label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign another label" })).not.toBeInTheDocument();
  });
});
