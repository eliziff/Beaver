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

it("closes before handing off to the next picker", async () => {
    const drafting: Workflow = { id: "drafting", user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
        metadata: { title: "drafting", description: null, category: "Drafting and document preparation",
            audiences: ["general"], contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
        launcher: { kind: "instructions", variants: [{ id: "draft", label: "Draft",
            result: null, execution: "assistant", skill_md: null, columns_config: null }] } };
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
