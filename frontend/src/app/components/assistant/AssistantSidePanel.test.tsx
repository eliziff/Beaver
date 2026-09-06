import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ResearchFile } from "@/app/lib/researchFiles";
import { AssistantSidePanel, type AssistantSidePanelTab } from "./AssistantSidePanel";

const file = { document: { id: "research-1", filename: "Appeal.research.md" } } as ResearchFile;
const api = vi.hoisted(() => ({ getResearchFile: vi.fn() }));

vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  getResearchFile: api.getResearchFile
}));

vi.mock("@/app/components/legal/LegalSourceViewer", () => ({
    LegalSourceViewer: ({ onResearchFileChange, onOpenResearch }: {
        onResearchFileChange: (file: ResearchFile) => void;
        onOpenResearch: (intent?: "source-drop") => void;
    }) => <><button onClick={() => onResearchFileChange(file)}>Select research</button>
        <button draggable onDragStart={() => onOpenResearch("source-drop")}>Source marker</button></>,
}));
vi.mock("@/app/components/legal/ResearchWorkspaceHost", () => ({
    ResearchWorkspaceHost: ({ open, sourceDropNonce }: { open: boolean; sourceDropNonce?: number }) =>
        <output aria-label="Research workspace">{open ? sourceDropNonce : "closed"}</output>,
}));
vi.mock("./DocPanel", () => ({ DocPanel: () => <p>Document</p> }));
vi.mock("./WorkflowRun", () => ({ WorkflowRunPanel: () => null }));

const legal = { kind: "legal", id: "legal:a2aj:1", citation: "2024 SCC 1",
    name: "Example", dataset: "SCC", docType: "cases", language: "en" } as const;
const documentTab = { kind: "document", id: "document-1", documentId: "document-1",
    filename: "Brief.docx", versionId: "version-1", versionNumber: 1 } as const;

it("opens its Workspace with a source-drop intent", () => {
    render(<AssistantSidePanel tabs={[legal]} activeTabId={legal.id} onActivateTab={vi.fn()}
        onCloseTab={vi.fn()} onCloseAll={vi.fn()} />);
    expect(screen.getByLabelText("Research workspace")).toHaveTextContent("closed");
    fireEvent.dragStart(screen.getByRole("button", { name: "Source marker" }));
    expect(screen.getByLabelText("Research workspace")).toHaveTextContent("1");
});

it("publishes research only while its legal tab is active", async () => {
    const publish = vi.fn(), tabs: AssistantSidePanelTab[] = [legal, documentTab];
    const props = { tabs, onResearchFileChange: publish, onActivateTab: vi.fn(),
        onCloseTab: vi.fn(), onCloseAll: vi.fn() };
    const { rerender, unmount } = render(<AssistantSidePanel {...props} activeTabId={legal.id} />);

    fireEvent.click(screen.getByRole("button", { name: "Select research" }));
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(file));

    rerender(<AssistantSidePanel {...props} activeTabId={documentTab.id} />);
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(null));

    rerender(<AssistantSidePanel {...props} activeTabId={legal.id} />);
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(file));
    rerender(<AssistantSidePanel {...props} tabs={[]} activeTabId={null} />);
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(null));

    unmount();
    expect(publish).toHaveBeenLastCalledWith(null);
});

it("refreshes selected research once after an assistant turn completes", async () => {
    const publish = vi.fn(), refreshed = { ...file, workingRevision: 2 };
    api.getResearchFile.mockReset().mockResolvedValue(refreshed);
    const props = { tabs: [legal], activeTabId: legal.id, onResearchFileChange: publish,
        onActivateTab: vi.fn(), onCloseTab: vi.fn(), onCloseAll: vi.fn() };
    const { rerender } = render(<AssistantSidePanel {...props} researchRefreshKey="turn-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Select research" }));
    expect(api.getResearchFile).not.toHaveBeenCalled();

    rerender(<AssistantSidePanel {...props} researchRefreshKey="turn-2" />);
    await waitFor(() => expect(api.getResearchFile).toHaveBeenCalledOnce());
    expect(api.getResearchFile).toHaveBeenCalledWith("research-1");
    await waitFor(() => expect(publish).toHaveBeenLastCalledWith(refreshed));

    rerender(<AssistantSidePanel {...props} researchRefreshKey="turn-2" />);
    expect(api.getResearchFile).toHaveBeenCalledOnce();
});
