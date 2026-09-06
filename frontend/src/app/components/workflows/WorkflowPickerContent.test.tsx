import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { Workflow, WorkflowVariant } from "@/app/lib/api/workflows";
import { WorkflowPickerContent } from "./WorkflowPickerContent";
import { useWorkflowPickerState } from "./WorkflowPickerModal";

const listWorkflows = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/api/workflows", () => ({ listWorkflows }));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));

const variant = (id = "check", label = "Check against source",
    result: string | null = null, execution: WorkflowVariant["execution"] = "assistant",
    description: string | null = null): WorkflowVariant => ({
    id, label, result, execution, description,
    skill_md: "SYSTEM_PROMPT_MUST_NOT_RENDER",
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

it("keeps audience and launch filters independent", async () => {
    const solicitor = workflow("leases", "Extract lease terms.", {
        kind: "instructions", variants: [variant("leases", "Lease terms", null, "tabular")],
    });
    solicitor.metadata.audiences = ["solicitor"];
    const litigator = workflow("evidence", "Review evidence.", {
        kind: "instructions", variants: [variant("evidence", "Evidence", null, "tabular")],
    });
    litigator.metadata.audiences = ["litigator"];
    listWorkflows.mockResolvedValue([solicitor, litigator]);
    function Harness() {
        const state = useWorkflowPickerState();
        return <WorkflowPickerContent workflows={state.workflows} onSelect={vi.fn()}
            search={state.search} onSearchChange={state.setSearch}
            audience={state.audience} onAudienceChange={state.setAudience} loading={state.loading} />;
    }
    render(<Harness />);
    await screen.findByText("No workflows are available.");
    await userEvent.click(within(screen.getByRole("tablist", { name: "Workflow launch type" }))
        .getByRole("tab", { name: "Tabular" }));
    expect(within(screen.getByRole("tablist", { name: "Workflow audience" }))
        .getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Start Tabular Review: leases" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start Tabular Review: evidence" })).toBeNull();
    await userEvent.click(within(screen.getByRole("tablist", { name: "Workflow audience" }))
        .getByRole("tab", { name: "Solicitor" }));
    expect(screen.getByRole("button", { name: "Start Tabular Review: leases" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start Tabular Review: evidence" })).toBeNull();
    expect(within(screen.getByRole("tablist", { name: "Workflow launch type" }))
        .getByRole("tab", { name: "Tabular" })).toHaveAttribute("aria-selected", "true");
});

it("opens exact workflow details without exposing model instructions", async () => {
    const onSelect = vi.fn();
    const summary = workflow("quote-checking", "Compare quotations with their sources.", {
        kind: "instructions", variants: [
            variant("check", "Check against source", "Source-linked findings", "assistant",
                "Verify quoted text and proposition support against the source."),
            variant("citations", "Check citations", "Citation locations and corrections"),
        ],
    }, "Check quotations");
    summary.metadata.jurisdictions = ["Alberta"];
    summary.metadata.contributors = [{ name: "Open Legal Products", organisation: null,
        role: null, linkedin: null }];
    render(<WorkflowPickerContent {...props} workflows={[summary, summary]}
        contextLabel="Factum.docx" onSelect={onSelect} />);

    expect(screen.getByText("Using Factum.docx")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Research & verify" })).toBeVisible();
    expect(screen.getAllByText(summary.metadata.description!)).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Details for Check quotations" }));
    expect(screen.getAllByText("Check against source")).toHaveLength(1);
    expect(screen.getByText("Source-linked findings")).toBeVisible();
    expect(screen.queryByText("Verify quoted text and proposition support against the source."))
        .toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Info about Check against source" }));
    const dialog = screen.getByRole("dialog", { name: "Check against source" });
    expect(await within(dialog).findByText(
        "Verify quoted text and proposition support against the source.")).toBeVisible();
    expect(within(dialog).getByText("Alberta")).toBeVisible();
    expect(within(dialog).getByText("Open Legal Products")).toBeVisible();
    expect(within(dialog).queryByText("SYSTEM_PROMPT_MUST_NOT_RENDER")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Open chat: Check against source" }));
    expect(onSelect).toHaveBeenCalledWith(summary,
        expect.objectContaining({ id: "check", execution: "assistant" }));
});

it("keeps a singleton compact with separate equal Info and Chat actions", async () => {
    const onSelect = vi.fn();
    const research = workflow("legal-research", "Research with cited sources.", {
        kind: "instructions", variants: [variant("research", "Research a legal issue",
            "Grounded research memo with linked sources", "assistant",
            "Research the issue using authoritative legal sources and pinpoints.")],
    }, "Research a legal issue");
    render(<WorkflowPickerContent {...props} workflows={[research]} onSelect={onSelect}
        workflowAction={() => <button type="button">More</button>} />);

    const actions = screen.getByRole("group", { name: "Research a legal issue actions" });
    const info = within(actions).getByRole("button", { name: "Info about Research a legal issue" });
    const launch = within(actions).getByRole("button", { name: "Open chat: Research a legal issue" });
    expect(info).toHaveTextContent("Info");
    expect(launch).toHaveTextContent("Chat");
    expect(within(actions).getByRole("button", { name: "More" })).toBeVisible();


    await userEvent.click(info);
    const dialog = screen.getByRole("dialog", { name: "Research a legal issue" });
    expect(await within(dialog).findByText(
        "Research the issue using authoritative legal sources and pinpoints.")).toBeVisible();
    expect(within(dialog).queryByText(research.metadata.description!)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open chat: Research a legal issue" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSelect).toHaveBeenCalledWith(research, expect.objectContaining({ id: "research" }));
});

it("groups the same variant label once while preserving Chat and Tab", async () => {
    const fullDescription = "Review one lease and report prioritized risks with clause references.";
    const grouped = workflow("agreement-work", "Review or extract agreement terms.", {
        kind: "instructions", variants: [
            variant("review", "Commercial lease", "Material risks and recommended changes",
                "assistant", fullDescription),
            { ...variant("extract", "Commercial lease", "Key terms across each selected lease",
                "tabular", "Extract the principal lease terms."), columns_config: [{ index: 0,
                name: "Termination right", prompt: "MODEL_COLUMN_PROMPT_MUST_NOT_RENDER",
                format: "text", tags: ["Landlord", "Tenant"] }] },
        ],
    }, "Agreement work");
    render(<WorkflowPickerContent {...props} workflows={[grouped]} onSelect={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Details for Agreement work" }));
    expect(screen.getAllByText("Commercial lease")).toHaveLength(1);
    expect(screen.getByText(/Material risks and recommended changes/u)).toBeVisible();
    expect(screen.getByText(/Key terms across each selected lease/u)).toBeVisible();
    const info = screen.getByRole("button", { name: "Info about Commercial lease" });
    const chat = screen.getByRole("button", { name: "Open chat: Commercial lease" });
    const tab = screen.getByRole("button", { name: "Start Tabular Review: Commercial lease" });
    expect(chat.className).toBe(tab.className);

    await userEvent.click(info);
    const dialog = screen.getByRole("dialog", { name: "Commercial lease" });
    expect(await within(dialog).findByText(fullDescription)).toBeVisible();
    expect(within(dialog).getByText("Termination right")).toBeVisible();
    expect(within(dialog).getByText(/Landlord.*Tenant/u)).toBeVisible();
    expect(within(dialog).queryByText("MODEL_COLUMN_PROMPT_MUST_NOT_RENDER")).toBeNull();
});

it.each([
    ["court-records", "Prepare court materials.", { kind: "court_records" } as const,
        "Court Records", "Court Records"],
    ["authorities", "Build the filing set.", { kind: "authorities" } as const,
        "Create table/book of authorities", "Authorities"],
])("shows one workspace label and one Open action for %s", async (id, description, launcher, title,
    destination) => {
    const direct = workflow(id, description, launcher, title);
    render(<WorkflowPickerContent {...props} workflows={[direct]} onSelect={vi.fn()} />);

    expect(screen.getAllByText(title)).toHaveLength(1);
    const info = screen.getByRole("button", { name: `Info about ${title}` });
    expect(info).toHaveTextContent("Info");
    expect(screen.getByRole("button", { name: `Open: ${title}` })).toHaveTextContent("Open");
    await userEvent.click(info);
    expect(within(screen.getByRole("dialog", { name: title })).getByText(description)).toBeVisible();
});

it("names a direct tabular destination as an action", () => {
    const review = workflow("evidence-review", "Organize evidence by document.", {
        kind: "instructions", variants: [variant("review", "Review evidence",
            "Evidence organized by document", "tabular",
            "Extract dates, people, summaries, and privilege flags by document.")],
    }, "Review evidence");
    render(<WorkflowPickerContent {...props} workflows={[review]} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Info about Review evidence" }))
        .toHaveTextContent("Info");
    const launch = screen.getByRole("button", { name: "Start Tabular Review: Review evidence" });
    expect(launch).toHaveAttribute("data-workflow-variant-id", "review");
    expect(launch).toHaveTextContent("Tab");
});

it("moves the open variant list when another workflow is requested", async () => {
    const first = workflow("quote-checking", "Check quotations.", {
        kind: "instructions", variants: [variant(), variant("other", "Check citations")],
    }, "Check quotations");
    const second = workflow("drafting", "Draft, revise or proofread.", {
        kind: "instructions", variants: [variant("proofread", "Proofread"),
            variant("draft", "Draft or revise")],
    }, "Drafting and templates");
    const view = render(<WorkflowPickerContent {...props} workflows={[first, second]}
        initialWorkflowId={first.id} onSelect={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open chat: Check against source" }))
        .toBeVisible();
    view.rerender(<WorkflowPickerContent {...props} workflows={[first, second]}
        initialWorkflowId={second.id} onSelect={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open chat: Proofread" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open chat: Check against source" })).toBeNull();
});

it("offers a retry when the catalogue cannot load", async () => {
    const retry = vi.fn();
    render(<WorkflowPickerContent {...props} workflows={[]} loadError
        onRetryLoad={retry} onSelect={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Workflows could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
});

it("filters launch types and preserves the selected variant when launching", async () => {
    const chatVariant = variant("chat", "Review agreement");
    const tableVariant = variant("table", "Review agreement", null, "tabular");
    const mixed = workflow("review", "Review agreements", {
        kind: "instructions", variants: [chatVariant, tableVariant],
    });
    const other = workflow("authorities", "Build authorities", { kind: "authorities" });
    const onSelect = vi.fn();
    render(<WorkflowPickerContent {...props} workflows={[mixed, other]} onSelect={onSelect} />);
    const filter = screen.getByRole("tablist", { name: "Workflow launch type" });
    await userEvent.click(within(filter).getByRole("tab", { name: "Chat" }));
    expect(screen.queryByRole("button", { name: "Open: authorities" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open chat: review" }));
    expect(onSelect).toHaveBeenLastCalledWith(mixed, chatVariant);
    await userEvent.click(within(filter).getByRole("tab", { name: "Tabular" }));
    expect(screen.queryByRole("button", { name: "Open chat: review" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start Tabular Review: review" }));
    expect(onSelect).toHaveBeenLastCalledWith(mixed, tableVariant);
    await userEvent.click(within(filter).getByRole("tab", { name: "Other" }));
    expect(screen.queryByRole("button", { name: "Start Tabular Review: review" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open: authorities" }));
    expect(onSelect).toHaveBeenLastCalledWith(other);
    await userEvent.click(within(filter).getByRole("tab", { name: "All" }));
    expect(screen.getByRole("button", { name: "Details for review" })).toBeVisible();
});
