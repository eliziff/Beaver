import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Workflow } from "@/app/lib/api/workflows";
import { WorkflowPickerModal } from "./WorkflowPickerModal";

const listWorkflows = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/api/workflows", () => ({
  listWorkflows
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { features: { authorities: true } } }),
}));

const workflow = (id: string, launcher: Workflow["launcher"]): Workflow => ({
    id, launcher, user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
    metadata: { title: id, description: null, category: "Drafting and document preparation",
        audiences: ["general"], contributors: [], language: "English", version: "1",
        jurisdictions: ["General"] },
});

it("offers only workflows that can launch in the requested execution surface", async () => {
    const drafting = workflow("drafting", { kind: "instructions", variants: [{ id: "draft", label: "Draft",
            result: null, execution: "assistant", skill_md: null, columns_config: null }] });
    listWorkflows.mockResolvedValue([
        drafting,
        workflow("Court Records", { kind: "court_records" }),
        workflow("Authorities", { kind: "authorities" }),
    ]);

    const onSelect = vi.fn();
    render(<WorkflowPickerModal open onClose={vi.fn()} onSelect={onSelect}
        execution="assistant" breadcrumbs={["Choose workflow"]} />);

    await screen.findByRole("button", { name: /^Open chat:/i });
    const launch = document.querySelector<HTMLButtonElement>(
        "button[data-workflow-variant-id='draft']",
    )!;
    expect(screen.queryByText("Court Records")).toBeNull();
    expect(screen.queryByText("Authorities")).toBeNull();
    await userEvent.click(launch);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
        workflow: drafting, variant: expect.objectContaining({ id: "draft" }),
    }));
});

it("offers solicitor-only reviews immediately in a tabular picker", async () => {
    const review = workflow("Agreement review", { kind: "instructions", variants: [{
        id: "review", label: "Review agreements", result: "Review table",
        execution: "tabular", skill_md: null, columns_config: [],
    }] });
    review.metadata.audiences = ["solicitor"];
    listWorkflows.mockResolvedValue([review]);
    const onSelect = vi.fn();
    render(<WorkflowPickerModal open onClose={vi.fn()} onSelect={onSelect}
        execution="tabular" breadcrumbs={["Choose workflow"]} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start Tabular Review: Agreement review" }));
    expect(onSelect).toHaveBeenCalledWith({ workflow: review, variant: review.launcher.kind === "instructions" ? review.launcher.variants[0] : undefined });
});

it("closes before handing off to the next picker", async () => {
    const drafting = workflow("drafting", {
        kind: "instructions", variants: [{ id: "draft", label: "Draft",
            result: null, execution: "assistant", skill_md: null, columns_config: null }],
    });
    listWorkflows.mockResolvedValue([drafting]);
    function Harness() {
        const [surface, setSurface] = useState<"workflows" | "files" | null>("workflows");
        return <><output>{surface}</output><WorkflowPickerModal
            open={surface === "workflows"} onClose={() => setSurface(null)}
            onSelect={async () => { await Promise.resolve(); setSurface("files"); }}
            execution="assistant" breadcrumbs={["Choose workflow"]} /></>;
    }
    render(<Harness />);

    await screen.findByRole("button", { name: /^Open chat:/i });
    await userEvent.click(document.querySelector<HTMLButtonElement>(
        "button[data-workflow-variant-id='draft']",
    )!);

    await waitFor(() => expect(screen.getByText("files")).toBeVisible());
});
