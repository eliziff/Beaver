import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Workflow, WorkflowVariant } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

const variant = (id = "check", label = "Check against source",
    result: string | null = null, execution: WorkflowVariant["execution"] = "assistant",
    skill_md: string | null = null): WorkflowVariant => ({
    id, label, result, execution, skill_md,
    columns_config: execution === "tabular" ? [] : null,
});
const workflow = (id: string, description: string,
    launcher: Workflow["launcher"]): Workflow => ({
    id, launcher, user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
    metadata: { title: id, description, category: "Research and verification",
        audiences: ["general"], contributors: [], language: "English", version: "1",
        jurisdictions: ["General"] },
});
const props = { search: "", audience: "general" as const,
    onSearchChange: vi.fn(), onAudienceChange: vi.fn() };

it("shows explicit workflow details once without exposing model instructions", async () => {
    const onSelect = vi.fn();
    const summary = workflow("quote-checking", "Compare quotations with their sources.", {
        kind: "instructions", variants: [
            variant("check", "Check against source", "Source-linked findings",
                "assistant", "SYSTEM_PROMPT_MUST_NOT_RENDER"),
            variant("citations", "Check citations", "Written review"),
        ],
    });

    render(<WorkflowPickerContent {...props} workflows={[summary, summary]}
        contextLabel="Factum.docx" onSelect={onSelect} />);

    expect(screen.getByRole("heading", { name: "With Factum.docx" })).toBeVisible();
    expect(screen.getAllByText(summary.metadata.description!)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Check quotations/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /details for|more information/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Check quotations/i }));
    expect(screen.queryByText("SYSTEM_PROMPT_MUST_NOT_RENDER")).toBeNull();
    expect(screen.getByText("Source-linked findings")).toBeVisible();
    expect(screen.queryByText("Written review")).toBeNull();
    await userEvent.click(screen.getByRole("button", {
        name: "Open chat: Check against source",
    }));

    expect(onSelect).toHaveBeenCalledWith(summary,
        expect.objectContaining({ id: "check", execution: "assistant" }));
});

it("launches a single workflow option directly with its destination visible", async () => {
    const onSelect = vi.fn();
    const research = workflow("legal-research", "Research with cited sources.", {
        kind: "instructions", variants: [variant("research", "Research a legal issue",
            "Grounded research memo with linked sources")],
    });
    render(<WorkflowPickerContent {...props} workflows={[research]} onSelect={onSelect} />);

    const launch = screen.getByRole("button", {
        name: "Open Research a legal issue in Chat",
    });
    expect(launch).toHaveTextContent("Chat");
    expect(launch).toHaveTextContent("Grounded research memo with linked sources");
    expect(launch).not.toHaveTextContent("Research with cited sources.");
    await userEvent.click(launch);
    expect(onSelect).toHaveBeenCalledWith(research,
        expect.objectContaining({ id: "research" }));
});

it.each([
    ["court-records", "Prepare court materials.", { kind: "court_records" } as const,
        /Court Records/giu],
    ["authorities", "Build the filing set.", { kind: "authorities" } as const,
        /Authorities/giu],
])("does not repeat an embedded destination for %s", (id, description, launcher, match) => {
    const direct = workflow(id, description, launcher);
    render(<WorkflowPickerContent {...props} workflows={[direct]} onSelect={vi.fn()} />);

    const button = screen.getByRole("button", { name: /^Open /u });
    expect(button.textContent?.match(match)).toHaveLength(1);
});

it("moves the open disclosure when another workflow is requested", async () => {
    const first = workflow("quote-checking", "Check quotations.", {
        kind: "instructions", variants: [variant(), variant("other", "Check citations")],
    });
    const secondVariant = variant("proofread", "Proofread");
    const second = workflow("drafting", "Draft, revise or proofread.", {
        kind: "instructions", variants: [secondVariant, variant("draft", "Draft or revise")],
    });
    const view = render(<WorkflowPickerContent {...props} workflows={[first, second]}
        initialWorkflowId={first.id} onSelect={vi.fn()} />);

    expect(await screen.findByRole("button", {
        name: "Open chat: Check against source",
    })).toBeVisible();
    view.rerender(<WorkflowPickerContent {...props} workflows={[first, second]}
        initialWorkflowId={second.id} onSelect={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open chat: Proofread" })).toBeVisible();
    expect(screen.queryByRole("button", {
        name: "Open chat: Check against source",
    })).toBeNull();
});

it("offers a retry when the catalogue cannot load", async () => {
    const retry = vi.fn();
    render(<WorkflowPickerContent {...props} workflows={[]} loadError
        onRetryLoad={retry} onSelect={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Workflows could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
});
