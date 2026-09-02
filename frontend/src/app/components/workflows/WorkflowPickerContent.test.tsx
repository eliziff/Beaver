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
    launcher: Workflow["launcher"], title = id): Workflow => ({
    id, launcher, user_id: null, is_system: true, created_at: "2026-08-30T00:00:00Z",
    metadata: { title, description, category: "Research and verification",
        audiences: ["general"], contributors: [], language: "English", version: "1",
        jurisdictions: ["General"] },
});
const props = { search: "", audience: "general" as const,
    onSearchChange: vi.fn(), onAudienceChange: vi.fn() };

it("shows explicit workflow details once without exposing model instructions", async () => {
    const onSelect = vi.fn();
    const summary = workflow("quote-checking", "Compare quotations with their sources.", {
        kind: "instructions", variants: [
            { ...variant("check", "Check against source", "Source-linked findings",
                "assistant", "SYSTEM_PROMPT_MUST_NOT_RENDER"),
                description: "Verify quoted text and proposition support against the source." },
            variant("citations", "Check citations", "Citation locations and corrections"),
        ],
    }, "Check quotations");

    render(<WorkflowPickerContent {...props} workflows={[summary, summary]}
        contextLabel="Factum.docx" onSelect={onSelect} />);

    expect(screen.getByText("Using Factum.docx")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Research & verify" })).toBeVisible();
    expect(screen.getAllByText(summary.metadata.description!)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Check quotations/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /details for/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Check quotations/i }));
    expect(screen.queryByText("SYSTEM_PROMPT_MUST_NOT_RENDER")).toBeNull();
    expect(screen.getByText("Source-linked findings")).toBeVisible();
    expect(screen.getByText("Verify quoted text and proposition support against the source."))
        .not.toBeVisible();
    await userEvent.click(screen.getByLabelText("Details for Check against source"));
    expect(screen.getByText("Verify quoted text and proposition support against the source.")).toBeVisible();
    expect(screen.getByText("Citation locations and corrections")).toBeVisible();
    await userEvent.click(screen.getByRole("button", {
        name: "Open chat: Check against source",
    }));

    expect(onSelect).toHaveBeenCalledWith(summary,
        expect.objectContaining({ id: "check", execution: "assistant" }));
});

it("launches a single workflow option directly with its destination visible", async () => {
    const onSelect = vi.fn();
    const research = workflow("legal-research", "Research with cited sources.", {
        kind: "instructions", variants: [{ ...variant("research", "Research a legal issue",
            "Grounded research memo with linked sources"),
            description: "Research the issue using authoritative legal sources and pinpoints." }],
    }, "Research a legal issue");
    render(<WorkflowPickerContent {...props} workflows={[research]} onSelect={onSelect} />);

    const details = screen.getByRole("button", { name: "Details for Research a legal issue" });
    expect(details).toHaveTextContent("Grounded research memo with linked sources");
    await userEvent.click(details);
    expect(screen.getByText("Research the issue using authoritative legal sources and pinpoints.")).toBeVisible();
    const launch = screen.getByRole("button", { name: "Open chat: Research a legal issue" });
    expect(launch).toHaveTextContent("Chat");
    await userEvent.click(launch);
    expect(onSelect).toHaveBeenCalledWith(research,
        expect.objectContaining({ id: "research" }));
});

it("shows one choice with concise outcomes and optional detail for both destinations", async () => {
    const fullDescription = "Review one lease and report prioritized risks with clause references, " +
        "recommended changes, and an overall risk assessment from the represented party's perspective.";
    const grouped = workflow("agreement-work", "Review or extract agreement terms.", {
        kind: "instructions", variants: [
            { ...variant("review", "Commercial lease", "Material risks and recommended changes"),
                description: fullDescription },
            { ...variant("extract", "Commercial lease", "Key terms across each selected lease", "tabular"),
                description: "Extract rent, term, repair, assignment, and termination terms by lease." },
        ],
    }, "Agreement work");
    render(<WorkflowPickerContent {...props} workflows={[grouped]} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /Agreement work/i }));
    expect(screen.getAllByText("Commercial lease")).toHaveLength(1);
    expect(screen.getByText("Material risks and recommended changes")).toBeVisible();
    expect(screen.getByText("Key terms across each selected lease")).toBeVisible();
    expect(screen.getByText(fullDescription)).not.toBeVisible();
    await userEvent.click(screen.getByLabelText("Details for Commercial lease (Chat)"));
    expect(screen.getByText(fullDescription)).toBeVisible();
    expect(screen.queryByText(/remaining/iu)).toBeNull();
    expect(screen.getByRole("button", { name: "Open chat: Commercial lease" })).toBeVisible();
    expect(screen.getByRole("button", {
        name: "Start Tabular Review: Commercial lease",
    })).toBeVisible();
});

it.each([
    ["court-records", "Prepare court materials.", { kind: "court_records" } as const,
        /Court Records/giu, "Court Records"],
    ["authorities", "Build the filing set.", { kind: "authorities" } as const,
        /Authorities/giu, "Create table/book of authorities"],
])("does not repeat an embedded destination for %s", (id, description, launcher, match, title) => {
    const direct = workflow(id, description, launcher, title);
    render(<WorkflowPickerContent {...props} workflows={[direct]} onSelect={vi.fn()} />);

    const button = screen.getByRole("button", { name: /^Open:/u });
    expect(button.textContent?.match(match)).toHaveLength(1);
});

it("names a direct tabular destination as an action", () => {
    const review = workflow("evidence-review", "Organize evidence by document.", {
        kind: "instructions",
        variants: [{ ...variant("review", "Review evidence", "Evidence organized by document", "tabular"),
            description: "Extract dates, people, summaries, and privilege flags by document." }],
    }, "Review evidence");
    render(<WorkflowPickerContent {...props} workflows={[review]} onSelect={vi.fn()} />);

    const details = screen.getByRole("button", { name: "Details for Review evidence" });
    expect(details).toHaveTextContent("Evidence organized by document");
    const launch = screen.getByRole("button", {
        name: "Start Tabular Review: Review evidence",
    });
    expect(launch).toHaveAttribute("data-workflow-variant-id", "review");
});

it("moves the open disclosure when another workflow is requested", async () => {
    const first = workflow("quote-checking", "Check quotations.", {
        kind: "instructions", variants: [variant(), variant("other", "Check citations")],
    }, "Check quotations");
    const secondVariant = variant("proofread", "Proofread");
    const second = workflow("drafting", "Draft, revise or proofread.", {
        kind: "instructions", variants: [secondVariant, variant("draft", "Draft or revise")],
    }, "Drafting and templates");
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
