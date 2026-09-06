import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { AssistantSidePanel } from "./AssistantSidePanel";

const file = { document: { id: "research-1", filename: "Appeal.research.md" },
    state: { labels: {}, sources: {} } } as unknown as ResearchFile;
const api = vi.hoisted(() => ({ getResearchFile: vi.fn() }));

vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: api.getResearchFile
}));

vi.mock("@/app/components/legal/LegalSourceViewer", () => ({
    LegalSourceViewer: ({ onOpenResearch }: { onOpenResearch: (intent?: "source-drop") => void }) =>
        <button draggable onDragStart={() => onOpenResearch("source-drop")}>Source marker</button>,
}));
vi.mock("@/app/components/legal/ResearchWorkspaceHost", () => ({
    ResearchWorkspaceHost: ({ open, sourceDropNonce }: { open: boolean; sourceDropNonce?: number }) =>
        <output aria-label="Research workspace">{open ? sourceDropNonce : "closed"}</output>,
}));
vi.mock("./DocPanel", () => ({ DocPanel: () => <p>Document</p> }));
vi.mock("./WorkflowRun", () => ({ WorkflowRunPanel: () => null }));

const legal = { kind: "legal", id: "legal:a2aj:1", citation: "2024 SCC 1",
    name: "Example", dataset: "SCC", docType: "cases", language: "en" } as const;

it("opens its Workspace with a source-drop intent", () => {
    render(<AssistantSidePanel tabs={[legal]} activeTabId={legal.id} onActivateTab={vi.fn()}
        onCloseTab={vi.fn()} onCloseAll={vi.fn()} />);
    expect(screen.getByLabelText("Research workspace")).toHaveTextContent("closed");
    fireEvent.dragStart(screen.getByRole("button", { name: "Source marker" }));
    expect(screen.getByLabelText("Research workspace")).toHaveTextContent("1");
});

it("refreshes the bound workspace once after an assistant turn completes", async () => {
    api.getResearchFile.mockReset().mockResolvedValue(file);
    const props = { tabs: [legal], activeTabId: legal.id, researchFileId: "research-1",
        onActivateTab: vi.fn(), onCloseTab: vi.fn(), onCloseAll: vi.fn() };
    const { rerender } = render(<AssistantSidePanel {...props} researchRefreshKey="turn-1" />);
    await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledOnce());
    expect(api.getResearchFile).toHaveBeenCalledWith("research-1");

    rerender(<AssistantSidePanel {...props} researchRefreshKey="turn-2" />);
    await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledTimes(2));

    rerender(<AssistantSidePanel {...props} researchRefreshKey="turn-2" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getResearchFile).toHaveBeenCalledTimes(2);
});
