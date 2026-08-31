import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowList } from "./WorkflowList";

const mocks = vi.hoisted(() => ({ listWorkflows: vi.fn(), listWorkProducts: vi.fn(),
    createReview: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
    listWorkflows: mocks.listWorkflows,
    listWorkProducts: mocks.listWorkProducts,
    listTabularReviews: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    createTabularReview: mocks.createReview,
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
const templates = item("templates", "Templates", "Templates", {
    kind: "instructions", variants: [
        { id: "create-template", label: "Create a reusable template", result: null,
            execution: "assistant", skill_md: "Create", columns_config: null },
        { id: "builtin-draft-from-template", label: "Draft from a template", result: null,
            execution: "assistant", skill_md: "Draft", columns_config: null },
    ],
});
const courtRecords = item("court-records", "Court Records",
    "Court and hearing materials", { kind: "court_records" });
courtRecords.metadata.jurisdictions = ["Alberta", "Federal"];

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
beforeEach(() => { vi.clearAllMocks(); mocks.listWorkProducts.mockResolvedValue([]); });

it("filters one catalogue and opens a singleton workspace in one click", async () => {
    agreements.metadata.audiences = ["solicitor"];
    courtRecords.metadata.audiences = ["litigator"];
    mocks.listWorkflows.mockResolvedValue([drafting, agreements, courtRecords, courtRecords]);
    const view = render(<MemoryRouter><WorkflowList /><Location /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Start Draft in Chat" }))
        .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Details for Draft" }));
    expect(screen.getByText("Drafting description")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Solicitor" }));
    expect(await screen.findByRole("button", { name: "Start Review in Chat" }))
        .toBeInTheDocument();
    expect(screen.queryByText("Written review")).toBeNull();
    expect(mocks.listWorkflows).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(view.container.querySelectorAll(
        '[data-workflow-id="court-records"]')).toHaveLength(1));
    expect(view.container.querySelector(
        '[data-workflow-category="Court materials"] summary')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details for Court records" }));
    expect(screen.getByText("Jurisdictions: Alberta, Federal")).toBeVisible();
    fireEvent.click(screen.getByRole("button", {
        name: "Start Court records in Court Records",
    }));
    expect(screen.getByTestId("location")).toHaveTextContent("/court-records");
});

it("hands template drafting to Assistant without another workflow modal", async () => {
    mocks.listWorkflows.mockResolvedValue([templates]);
    const view = render(<MemoryRouter><WorkflowList /><Location /></MemoryRouter>);
    await waitFor(() => expect(view.container.querySelector(
        '[data-workflow-category="Templates"] summary')).not.toBeNull());
    fireEvent.click(view.container.querySelector(
        '[data-workflow-category="Templates"] summary')!);
    fireEvent.click(screen.getByRole("button", {
        name: "Start Draft from a template in Chat",
    }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent("/assistant");
    expect(screen.getByTestId("location").dataset.state).toContain(
        '"variant_id":"builtin-draft-from-template"');
    expect(screen.getByTestId("location").dataset.state).toContain(
        '"documentTab":"templates"');
});

it("switches audience tabs locally without loading or another request", async () => {
    agreements.metadata.audiences = ["solicitor"];
    mocks.listWorkflows.mockResolvedValue([drafting, agreements]);
    const view = render(<MemoryRouter><WorkflowList /></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Start Draft in Chat" }))
        .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Review in Chat" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Solicitor" }));
    expect(screen.getByRole("button", { name: "Start Draft in Chat" }))
        .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Review in Chat" }))
        .toBeInTheDocument();
    expect(view.container.querySelector(".animate-pulse")).toBeNull();
    expect(mocks.listWorkflows).toHaveBeenCalledTimes(1);
});

it("resumes Court Records and Authorities drafts beside workflow reviews", async () => {
    mocks.listWorkflows.mockResolvedValue([drafting]);
    mocks.listWorkProducts
        .mockResolvedValueOnce([{ id: "record-1", kind: "court-record",
            title: "Motion record", updatedAt: "2026-08-30T02:00:00Z" }])
        .mockResolvedValueOnce([{ id: "book-1", kind: "authorities",
            title: "Book of authorities", updatedAt: "2026-08-30T01:00:00Z" }]);
    render(<MemoryRouter><WorkflowList /></MemoryRouter>);

    fireEvent.click(await screen.findByText("Continue working"));
    expect(screen.getByRole("link", { name: "Resume Motion record in Court Records" }))
        .toHaveAttribute("href", "/court-records?draft=record-1");
    expect(screen.getByRole("link", { name: "Resume Book of authorities in Authorities" }))
        .toHaveAttribute("href", "/table-of-authorities?draft=book-1");
});

function Location() {
    const location = useLocation();
    return <output data-testid="location"
        data-state={JSON.stringify(location.state)}>{location.pathname}</output>;
}
