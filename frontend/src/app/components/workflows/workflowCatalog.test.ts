import { expect, it } from "vitest";
import type { Workflow } from "../shared/types";
import { groupWorkflows, WORKFLOW_CATEGORIES } from "./workflowCatalog";
import { workflowDocumentTab, workflowPath, workflowVariants } from "./workflowRoutes";

const workflow = (id: string, title: string, category: string,
    launcher: Workflow["launcher"], isSystem = true): Workflow => ({
    id, user_id: null, is_system: isSystem, created_at: "2026-08-30T00:00:00Z",
    metadata: { title, description: null, category, audiences: ["general"],
        contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
    launcher,
});
const variant = (id: string, label: string, execution: "assistant" | "tabular",
    result: string | null = null) => ({ id, label, result, execution,
        skill_md: execution === "assistant" ? label : null,
        columns_config: execution === "tabular" ? [] : null });

it("keeps each workflow once with its variants and a stable outcome label", () => {
    const drafting = workflow("drafting", "Drafting", "Drafting and document preparation", {
        kind: "instructions", variants: [
            variant("draft", "Draft or revise", "assistant"),
            variant("proofread", "Proofread", "assistant"),
            variant("create-template", "Create a reusable template", "assistant"),
            variant("builtin-draft-from-template", "Draft from a template", "assistant"),
        ],
    });
    const transaction = workflow("transaction-management", "Transaction Management",
        "Transactions and closing", { kind: "instructions", variants: [
            variant("checklist", "Checklist", "assistant"),
        ] });
    const groups = groupWorkflows([drafting, transaction, drafting]);
    expect(groups.map(({ label, items }) => ({ label,
        choices: items.map((entry) => [entry.label, entry.variants.length]) }))).toEqual([
        { label: "Use documents", choices: [
            ["Draft, revise or proofread", 4],
            ["Prepare a conditions checklist", 1],
        ] },
    ]);
    expect(workflowVariants(drafting)).toHaveLength(4);
    if (drafting.launcher.kind !== "instructions") throw new Error("invalid fixture");
    expect(workflowDocumentTab({ workflow: drafting,
        variant: drafting.launcher.variants[3] })).toBe("templates");
});

it("keeps execution alternatives inside one workflow item", () => {
    const agreements = workflow("agreement-work", "Agreement Work", "Agreements", {
        kind: "instructions", variants: [
            variant("lease-write", "Commercial lease", "assistant", "Written review"),
            variant("lease-table", "Commercial lease", "tabular", "Review table"),
        ],
    });
    const [choice] = groupWorkflows([agreements])[0].items;
    expect(choice.label).toBe("Review an agreement");
    expect(choice.variants.map(({ execution }) => execution)).toEqual(["assistant", "tabular"]);
    expect(groupWorkflows([agreements], "", "assistant")[0].items[0].variants)
        .toHaveLength(1);
    expect(groupWorkflows([agreements], "table")[0].items[0].variants[0].id)
        .toBe("lease-table");
});

it("puts custom workflows in the contextual document section without duplicates", () => {
    const custom = (id: string, title: string) => workflow(id, title, "Templates", {
        kind: "instructions", variants: [variant(`${id}-variant`, title, "assistant")],
    }, false);
    const groups = groupWorkflows([custom("one", "One"), custom("two", "Two"),
        custom("one", "Duplicate One")], "", undefined, "the selected files");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("With the selected files");
    expect(groups[0].items.map(({ workflow, label }) => [workflow.id, label]))
        .toEqual([["one", "Duplicate One"], ["two", "Two"]]);
});

it("changes section priority only when document context exists", () => {
    const quote = workflow("quote-checking", "Quote Checking", "Research and verification", {
        kind: "instructions", variants: [variant("quotes", "Check", "assistant")],
    });
    const research = workflow("legal-research", "Legal Research", "Research and verification", {
        kind: "instructions", variants: [variant("research", "Research", "assistant")],
    });
    const authorities = workflow("authorities", "Authorities",
        "Court and hearing materials", { kind: "authorities" });
    const courtRecords = workflow("court-records", "Court Records",
        "Court and hearing materials", { kind: "court_records" });
    const input = [quote, research, authorities, courtRecords];
    expect(groupWorkflows(input, "", "assistant").map(({ label }) => label))
        .toEqual(["Start something", "Use documents"]);
    const contextual = groupWorkflows(input, "", "assistant", "brief.docx");
    expect(contextual.map(({ label }) => label))
        .toEqual(["With brief.docx", "Start something"]);
    expect(contextual.map(({ items }) => items.map(({ workflow }) => workflow.id))).toEqual([
        ["quote-checking"],
        ["legal-research", "authorities", "court-records"],
    ]);
    expect(groupWorkflows([authorities, courtRecords], "", "tabular")).toEqual([]);
    expect(workflowPath(authorities)).toBe("/table-of-authorities");
    expect(workflowPath(courtRecords)).toBe("/court-records");
});

it("keeps workflow-editing categories available", () => {
    expect(WORKFLOW_CATEGORIES).toContainEqual(["Agreements", "Agreements"]);
    expect(WORKFLOW_CATEGORIES).toContainEqual([
        "Court and hearing materials", "Court materials",
    ]);
    expect(WORKFLOW_CATEGORIES).toContainEqual(["Templates", "Templates"]);
});
