import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowList } from "./WorkflowList";

const mocks = vi.hoisted(() => ({ listWorkflows: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
    listWorkflows: mocks.listWorkflows,
    createTabularReview: vi.fn(),
    deleteWorkflow: vi.fn(), createWorkflow: vi.fn(), updateWorkflow: vi.fn(),
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
        result: "Written response", execution: "assistant", skill_md: "Draft",
        columns_config: null }],
});
const agreements = item("agreement-work", "Agreement Work", "Agreements", {
    kind: "instructions", variants: [{ id: "agreements-written", label: "Review",
        result: "Written review", execution: "assistant", skill_md: "Review",
        columns_config: null }],
});
const courtRecords = item("court-records", "Court Records",
    "Court and hearing materials", { kind: "court_records" });
courtRecords.metadata.jurisdictions = ["Alberta", "Federal"];

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
beforeEach(() => {
    vi.clearAllMocks();
});

it("filters one catalogue and opens a singleton workspace in one click", async () => {
    agreements.metadata.audiences = ["solicitor"];
    courtRecords.metadata.audiences = ["litigator"];
    mocks.listWorkflows.mockResolvedValue([drafting, agreements, courtRecords, courtRecords]);
    const view = render(<MemoryRouter><WorkflowList /><Location /></MemoryRouter>);
    expect(await screen.findByText("Draft, revise or proofread")).toBeVisible();
    expect(screen.getByText("Drafting description")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Solicitor" }));
    expect(await screen.findByText("Review an agreement")).toBeVisible();
    expect(screen.queryByText("Written review")).toBeNull();
    expect(mocks.listWorkflows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(view.container.querySelectorAll(
        '[data-workflow-id="court-records"]')).toHaveLength(1));
    fireEvent.click(view.container.querySelector('[data-workflow-id="court-records"]')!);
    expect(screen.getByTestId("location")).toHaveTextContent("/court-records");
});

it("switches audience tabs locally without loading or another request", async () => {
    agreements.metadata.audiences = ["solicitor"];
    mocks.listWorkflows.mockResolvedValue([drafting, agreements]);
    const view = render(<MemoryRouter><WorkflowList /></MemoryRouter>);
    expect(await screen.findByText("Draft, revise or proofread")).toBeVisible();
    expect(screen.queryByText("Review an agreement")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Solicitor" }));
    expect(screen.getByText("Draft, revise or proofread")).toBeVisible();
    expect(screen.getByText("Review an agreement")).toBeVisible();
    expect(view.container.querySelector(".animate-pulse")).toBeNull();
    expect(mocks.listWorkflows).toHaveBeenCalledTimes(1);
});

function Location() {
    const location = useLocation();
    return <output data-testid="location"
        data-state={JSON.stringify(location.state)}>{location.pathname}</output>;
}
