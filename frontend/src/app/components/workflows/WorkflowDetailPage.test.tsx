import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowDetailPage } from "./WorkflowDetailPage";

const mocks = vi.hoisted(() => ({ getWorkflow: vi.fn() }));
vi.mock("@/app/lib/beaverApi", () => ({
    getWorkflow: mocks.getWorkflow, deleteWorkflow: vi.fn(),
    deleteWorkflowShare: vi.fn(), listWorkflowShares: vi.fn(), lookupUserByEmail: vi.fn(),
    shareWorkflow: vi.fn(), updateWorkflow: vi.fn(),
}));
vi.mock("@/app/lib/apiTransport", () => ({ apiBlobRequest: vi.fn() }));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({ useUserProfile: () => ({ profile: null }) }));
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));

const system = (id: string, launcher: Workflow["launcher"]): Workflow => ({
    id, user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
    metadata: { title: id, description: null, category: "Templates",
        audiences: ["general"], contributors: [], language: "English",
        version: "1", jurisdictions: ["General"] }, launcher,
});

it.each([
    system("drafting", { kind: "instructions", variants: [{ id: "draft",
        label: "Draft", result: null, execution: "assistant",
        skill_md: "SYSTEM_PROMPT_MUST_NOT_RENDER", columns_config: null }] }),
    system("court-records", { kind: "court_records" }),
    system("authorities", { kind: "authorities" }),
])("redirects system workflow $id to its terminal catalogue branch", async (workflow) => {
    mocks.getWorkflow.mockResolvedValue(workflow);
    render(<MemoryRouter initialEntries={[`/workflows/${workflow.id}`]}><Routes>
        <Route path="/workflows/:id" element={<WorkflowDetailPage id={workflow.id} />} />
        <Route path="/workflows" element={<Location />} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(
        `/workflows?workflow=${workflow.id}`));
    expect(screen.queryByText("SYSTEM_PROMPT_MUST_NOT_RENDER")).not.toBeInTheDocument();
});

function Location() {
    const location = useLocation();
    return <output data-testid="location">{location.pathname}{location.search}</output>;
}
