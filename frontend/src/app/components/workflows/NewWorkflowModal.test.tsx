import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";

const { createWorkflow, updateWorkflow } = vi.hoisted(() => ({
    createWorkflow: vi.fn(), updateWorkflow: vi.fn(),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    createWorkflow,
    updateWorkflow,
}));

beforeEach(() => vi.clearAllMocks());

it("creates a usable written workflow from visible instructions", async () => {
    const created = { id: "my-summary" } as Workflow;
    createWorkflow.mockResolvedValue(created);
    const onCreated = vi.fn();
    render(<NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />);

    expect(screen.getByRole("button", { name: "Assistant" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Workflow name"), {
        target: { value: "Matter summary" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
        target: { value: "Summarize the selected documents for counsel." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
            metadata: expect.objectContaining({
                category: "Drafting and document preparation",
            }),
            launcher: { kind: "instructions", variants: [
            expect.objectContaining({
                execution: "assistant",
                skill_md: "Summarize the selected documents for counsel.",
            }),
        ] } }),
    ));
    expect(onCreated).toHaveBeenCalledWith(created);
});

it("creates a table workflow without assistant instructions", async () => {
    createWorkflow.mockResolvedValue({ id: "my-table" } as Workflow);
    render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Issues" } });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.queryByLabelText("Instructions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ launcher: { kind: "instructions", variants: [
            expect.objectContaining({ execution: "tabular", skill_md: null,
                columns_config: [] }),
        ] } }),
    ));
});

it("edits the existing execution type instead of replacing it", async () => {
    const existing = { id: "existing", metadata: { title: "Issues", audiences: ["general"],
        category: "Drafting and document preparation", language: "English",
        jurisdictions: ["General"] }, launcher: { kind: "instructions", variants: [{
            id: "existing", label: "Issues", result: "Review table", execution: "tabular",
            skill_md: null, columns_config: [],
        }] } } as Workflow;
    updateWorkflow.mockResolvedValue(existing);
    render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()}
        editWorkflow={existing} onUpdated={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledWith("existing",
        expect.objectContaining({ launcher: { kind: "instructions", variants: [
            expect.objectContaining({ execution: "tabular", columns_config: [] }),
        ] } })));
});
