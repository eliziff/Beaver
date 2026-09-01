import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowPickerModal } from "./WorkflowPickerModal";

const listWorkflows = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/beaverApi", () => ({ listWorkflows }));
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

    const launch = await screen.findByRole("button", {
        name: /Draft, revise or proofread.*Chat/i,
    });
    expect(screen.queryByText("Court Records")).toBeNull();
    expect(screen.queryByText("Authorities")).toBeNull();
    await userEvent.click(launch);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
        workflow: drafting, variant: expect.objectContaining({ id: "draft" }),
    }));
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

    await userEvent.click(await screen.findByRole("button", {
        name: /Draft, revise or proofread.*Chat/i,
    }));

    await waitFor(() => expect(screen.getByText("files")).toBeVisible());
});
