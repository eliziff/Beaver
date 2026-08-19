import {
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowList } from "./WorkflowList";

const mocks = vi.hoisted(() => ({
    deleteWorkflow: vi.fn(),
    hideWorkflow: vi.fn(),
    listWorkflows: vi.fn(),
    listHiddenWorkflows: vi.fn(),
    listSystemWorkflows: vi.fn(),
    push: vi.fn(),
    unhideWorkflow: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.push,
}));
vi.mock("@/app/lib/beaverApi", () => ({
    deleteWorkflow: mocks.deleteWorkflow,
    hideWorkflow: mocks.hideWorkflow,
    unhideWorkflow: mocks.unhideWorkflow,
    listWorkflows: mocks.listWorkflows,
    listHiddenWorkflows: mocks.listHiddenWorkflows,
    listSystemWorkflows: mocks.listSystemWorkflows,
}));
vi.mock("./NewWorkflowModal", () => ({ NewWorkflowModal: () => null }));
vi.mock("./UseWorkflowModal", () => ({
    UseWorkflowModal: ({ workflow }: { workflow: Workflow | null }) =>
        workflow ? <p>Using {workflow.metadata.title}</p> : null,
}));

const workflow = (
    id: string,
    title: string,
    type: "assistant" | "tabular",
    access: Partial<
        Pick<Workflow, "allow_edit" | "is_owner" | "is_system" | "user_id">
    > = {},
) =>
    ({
        id,
        user_id: "user-1",
        metadata: {
            title,
            description: null,
            type,
            contributors: [],
            language: "English",
            version: "1.0.0",
            practice: null,
            jurisdictions: null,
        },
        skill_md: null,
        columns_config: null,
        is_system: false,
        created_at: "2026-07-29T00:00:00.000Z",
        ...access,
    }) satisfies Workflow;

beforeEach(() => {
    mocks.deleteWorkflow.mockReset().mockResolvedValue(undefined);
    mocks.hideWorkflow.mockReset().mockResolvedValue(undefined);
    mocks.unhideWorkflow.mockReset().mockResolvedValue(undefined);
    mocks.push.mockReset();
    mocks.listWorkflows.mockReset().mockResolvedValue({ items: [
        workflow("assistant-1", "Draft contract", "assistant"),
        workflow("tabular-1", "Review leases", "tabular"),
    ], next_cursor: null });
    mocks.listHiddenWorkflows.mockReset();
    mocks.listHiddenWorkflows.mockResolvedValue([]);
    mocks.listSystemWorkflows.mockReset().mockResolvedValue([]);
});
it("filters loaded workflows and opens the selected one", async () => {
    render(<WorkflowList />);

    await screen.findByText("Draft contract");
    fireEvent.change(screen.getByPlaceholderText("Search workflows…"), {
        target: { value: "lease" },
    });
    expect(screen.queryByText("Draft contract")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByText("Review leases"));
    expect(screen.getByText("Using Review leases")).toBeInTheDocument();
});
it("uses workflow capabilities for row and bulk actions", async () => {
    mocks.listWorkflows.mockResolvedValue({ items: [
        workflow("owned", "Owned workflow", "assistant", {
            allow_edit: true,
            is_owner: true,
        }),
        workflow("shared-edit", "Editable share", "assistant", {
            allow_edit: true,
            is_owner: false,
        }),
        workflow("shared-read", "Read-only share", "assistant", {
            allow_edit: false,
            is_owner: false,
        }),
        workflow("system", "System workflow", "assistant", {
            allow_edit: false,
            is_owner: false,
            is_system: true,
            user_id: null,
        }),
    ], next_cursor: null });
    render(<WorkflowList />);

    await screen.findByText("Editable share");
    expect(screen.queryByRole("checkbox", {
        name: "Select Editable share",
    })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
        name: "More actions for Editable share",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit details" }));
    expect(mocks.push).toHaveBeenCalledWith(
        "/workflows/assistant/shared-edit",
    );

    expect(
        screen.queryByRole("button", {
            name: "More actions for Read-only share",
        }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", {
        name: "Select Read-only share",
    })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", {
        name: "Select System workflow",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() =>
        expect(mocks.hideWorkflow).toHaveBeenCalledWith("system"),
    );
});
