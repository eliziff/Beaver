import { expect, it } from "vitest";
import type { Workflow } from "@/app/lib/api/workflows";
import { groupWorkflows } from "./workflowCatalog";
import { workflowDocumentTab, workflowPath } from "./workflowRoutes";

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
    const drafting = workflow("drafting", "Drafting and templates", "Drafting and document preparation", {
        kind: "instructions", variants: [
            variant("draft", "Draft or revise", "assistant"),
            variant("proofread", "Proofread", "assistant"),
            variant("create-template", "Create a reusable template", "assistant"),
            variant("builtin-draft-from-template", "Draft from a template", "assistant"),
        ],
    });
    const transaction = workflow("transaction-management", "Prepare a conditions checklist",
        "Transactions and closing", { kind: "instructions", variants: [
            variant("checklist", "Checklist", "assistant"),
        ] });
    const groups = groupWorkflows([drafting, transaction, drafting]);
    expect(groups.map(({ label, items }) => ({ label,
        choices: items.map((entry) => [entry.label, entry.variants.length]) }))).toEqual([
        { label: "Drafting", choices: [["Drafting and templates", 4]] },
        { label: "Transactions & closing",
            choices: [["Prepare a conditions checklist", 1]] },
    ]);
    if (drafting.launcher.kind !== "instructions") throw new Error("invalid fixture");
    expect(drafting.launcher.variants).toHaveLength(4);
    expect(workflowDocumentTab({ workflow: drafting,
        variant: drafting.launcher.variants[3] })).toBe("templates");
});

it("keeps execution alternatives inside one workflow item", () => {
    const agreements = workflow("agreement-work", "Agreement work", "Agreements", {
        kind: "instructions", variants: [
            variant("lease-write", "Commercial lease", "assistant", "Risks and recommendations"),
            variant("lease-table", "Commercial lease", "tabular", "Key terms by lease"),
        ],
    });
    const [choice] = groupWorkflows([agreements])[0].items;
    expect(choice.label).toBe("Agreement work");
    expect(choice.variants.map(({ execution }) => execution)).toEqual(["assistant", "tabular"]);
    expect(groupWorkflows([agreements], "", "assistant")[0].items[0].variants)
        .toHaveLength(1);
    expect(groupWorkflows([agreements], "key terms")[0].items[0].variants[0].id)
        .toBe("lease-table");
});

it("puts custom workflows in their configured category without duplicates", () => {
    const custom = (id: string, title: string) => workflow(id, title, "Templates", {
        kind: "instructions", variants: [variant(`${id}-variant`, title, "assistant")],
    }, false);
    const groups = groupWorkflows([custom("one", "One"), custom("two", "Two"),
        custom("one", "Duplicate One")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Templates");
    expect(groups[0].items.map(({ workflow, label }) => [workflow.id, label]))
        .toEqual([["one", "Duplicate One"], ["two", "Two"]]);
});

it("uses category order without dropping assistant or product routes", () => {
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
    const groups = groupWorkflows(input, "", "assistant");
    expect(groups.map(({ label }) => label)).toEqual([
        "Research & verify", "Court materials",
    ]);
    expect(groups.map(({ items }) => items.map(({ workflow }) => workflow.id))).toEqual([
        ["quote-checking", "legal-research"],
        ["authorities", "court-records"],
    ]);
    expect(groupWorkflows([authorities, courtRecords], "", "tabular")).toEqual([]);
    expect(workflowPath(authorities)).toBe("/table-of-authorities");
    expect(workflowPath(courtRecords)).toBe("/court-records");
});
