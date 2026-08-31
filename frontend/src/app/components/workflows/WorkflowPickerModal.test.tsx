import { render, screen } from "@testing-library/react";
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
    listWorkflows.mockResolvedValue([
        workflow("Draft", { kind: "instructions", variants: [{ id: "draft", label: "Draft",
            result: null, execution: "assistant", skill_md: null, columns_config: null }] }),
        workflow("Court Records", { kind: "court_records" }),
        workflow("Authorities", { kind: "authorities" }),
    ]);

    render(<WorkflowPickerModal open onClose={vi.fn()} onSelect={vi.fn()}
        execution="assistant" breadcrumbs={["Choose workflow"]} />);

    expect(await screen.findByRole("button", { name: "Start Draft in Chat" })).toBeVisible();
    expect(screen.queryByText("Court Records")).toBeNull();
    expect(screen.queryByText("Authorities")).toBeNull();
});
