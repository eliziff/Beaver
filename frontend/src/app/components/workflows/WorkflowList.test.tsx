import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { Workflow } from "@/app/lib/api/workflows";
import { WorkflowList } from "./WorkflowList";

const mocks = vi.hoisted(() => ({ listWorkflows: vi.fn() }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: vi.fn(), stagePendingChatMessage: vi.fn() }),
}));
vi.mock("@/app/lib/api/workflows", async (original) => ({
    ...await original<typeof import("@/app/lib/api/workflows")>(), listWorkflows: mocks.listWorkflows,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { features: { authorities: true } } }),
}));

const item = (id: string, title: string, category: string,
    launcher: Workflow["launcher"]): Workflow => ({
    id, user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
    metadata: { title, description: `${title} description`, category, audiences: ["general"],
        contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
    launcher,
});
const drafting = item("drafting", "Drafting", "Drafting and document preparation", {
    kind: "instructions", variants: [{ id: "drafting-written", label: "Draft",
        result: "A finished legal draft", execution: "assistant", skill_md: "Draft",
        columns_config: null }],
});
const agreements = item("agreement-work", "Agreement Work", "Agreements", {
    kind: "instructions", variants: [{ id: "agreements-written", label: "Review",
        result: "Agreement findings", execution: "assistant", skill_md: "Review",
        columns_config: null }],
});
const courtRecords = item("court-records", "Court Records",
    "Court and hearing materials", { kind: "court_records" });
courtRecords.metadata.jurisdictions = ["Alberta", "Federal"];



it("filters one catalogue and opens a singleton workspace in one click", async () => {
    agreements.metadata.audiences = ["solicitor"];
    courtRecords.metadata.audiences = ["litigator"];
    mocks.listWorkflows.mockResolvedValue([drafting, agreements, courtRecords, courtRecords]);
    const view = render(<MemoryRouter><WorkflowList /><Location /></MemoryRouter>);
    const draftingButton = await screen.findByRole("button", { name: /^Open chat:/i });
    expect(draftingButton).toHaveAttribute("data-workflow-id", "drafting");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Solicitor" }));
    expect(view.container.querySelector('button[data-workflow-id="agreement-work"]')).toBeVisible();
    expect(mocks.listWorkflows).toHaveBeenCalledTimes(1);

    fireEvent.click(within(screen.getByRole("tablist", { name: "Workflow audience" }))
        .getByRole("tab", { name: "All" }));
    await waitFor(() => expect(view.container.querySelectorAll(
        '[data-workflow-id="court-records"]')).toHaveLength(1));
    fireEvent.click(view.container.querySelector('button[data-workflow-id="court-records"]')!);
    expect(screen.getByTestId("location")).toHaveTextContent("/court-records");
});

function Location() {
    const location = useLocation();
    return <output data-testid="location"
        data-state={JSON.stringify(location.state)}>{location.pathname}</output>;
}
