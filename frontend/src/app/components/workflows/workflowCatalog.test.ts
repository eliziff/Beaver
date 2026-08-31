import { expect, it } from "vitest";
import type { Workflow } from "../shared/types";
import { groupWorkflows } from "./workflowCatalog";
import { workflowDocumentTab, workflowPath, workflowVariants } from "./workflowRoutes";

const workflow = (id: string, title: string, category: string,
    launcher: Workflow["launcher"], isSystem = true): Workflow => ({
    id, user_id: null, is_system: isSystem, created_at: "2026-08-30T00:00:00Z",
    metadata: { title, description: null, category, audiences: ["general"],
        contributors: [], language: "English", version: "1", jurisdictions: ["General"] },
    launcher,
});

it("flattens singleton workflows and discloses terminal variants once", () => {
    const templates = workflow("templates", "Templates", "Templates", {
        kind: "instructions", variants: [
            { id: "create-template", label: "Create a reusable template", result: null,
                execution: "assistant", skill_md: "Create", columns_config: null },
            { id: "builtin-draft-from-template", label: "Draft from a template", result: null,
                execution: "assistant", skill_md: "Draft", columns_config: null },
        ],
    });
    const transaction = workflow("transaction-management", "Transaction Management",
        "Transactions and closing", { kind: "instructions", variants: [
            { id: "checklist", label: "Checklist", result: null,
                execution: "assistant", skill_md: "Build", columns_config: null },
        ] });
    const groups = groupWorkflows([templates, transaction, templates]);
    expect(groups.map(({ label, branch, items }) => ({ label, branch,
        choices: items.map((item) => item.label) }))).toEqual([
        { label: "Templates", branch: true,
            choices: ["Create a reusable template", "Draft from a template"] },
        { label: "Transactions & closing", branch: false,
            choices: ["Checklist"] },
    ]);
    expect(workflowVariants(templates)).toHaveLength(2);
    if (templates.launcher.kind !== "instructions") throw new Error("invalid fixture");
    expect(workflowDocumentTab({ workflow: templates,
        variant: templates.launcher.variants[1] })).toBe("templates");
});

it("keeps one task row when chat and table are alternative destinations", () => {
    const agreements = workflow("agreement-work", "Agreement Work", "Agreements", {
        kind: "instructions", variants: [
            { id: "lease-write", label: "Commercial lease", result: "Written review",
                execution: "assistant", skill_md: "Review", columns_config: null },
            { id: "lease-table", label: "Commercial lease", result: "Review table",
                execution: "tabular", skill_md: null, columns_config: [] },
        ],
    });
    const [choice] = groupWorkflows([agreements])[0].items;
    expect(choice.label).toBe("Commercial lease");
    expect(choice.variants.map(({ execution }) => execution)).toEqual(["assistant", "tabular"]);
});

it("groups custom workflows only when there is a real choice", () => {
    const custom = (id: string, title: string) => workflow(id, title, "Templates", {
        kind: "instructions", variants: [{ id: `${id}-variant`, label: title,
            result: "Written response", execution: "assistant", skill_md: "Do it",
            columns_config: null }],
    }, false);
    expect(groupWorkflows([custom("one", "One")])[0]).toMatchObject({
        label: "One", branch: false,
    });
    expect(groupWorkflows([custom("one", "One"), custom("two", "Two")])[0])
        .toMatchObject({ label: "My workflows", branch: true });
});

it("maps closed launchers to their focused workspace", () => {
    const authorities = workflow("authorities", "Authorities",
        "Court and hearing materials", { kind: "authorities" });
    const courtRecords = workflow("court-records", "Court Records",
        "Court and hearing materials", { kind: "court_records" });
    expect(workflowPath(authorities))
        .toBe("/table-of-authorities");
    expect(workflowPath(courtRecords))
        .toBe("/court-records");
    expect(groupWorkflows([authorities, courtRecords], "", "assistant")[0]
        .items.map(({ workflow }) => workflow.id)).toEqual(["court-records", "authorities"]);
    expect(workflowPath(workflow("drafting", "Drafting",
        "Drafting and document preparation", { kind: "instructions", variants: [] })))
        .toBe("/workflows/drafting");
});
