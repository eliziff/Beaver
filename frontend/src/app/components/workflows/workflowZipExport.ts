import type { ColumnConfig, Workflow } from "@/app/components/shared/types";
import { apiBlobRequest } from "@/app/lib/beaverApi";
import { downloadBlob } from "@/app/lib/download";
type ZipFile = {
    path: string;
    content: string;
};
const TABLE_CONFIG_SCHEMA = "../schema/table-config.schema.yaml";
function slugify(input: string, fallback: string): string {
    const slug = input
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || fallback;
}
function yamlScalar(value: string | null): string {
    if (value === null) return "null";
    return JSON.stringify(value);
}
function yamlBlock(value: string): string {
    return value
        .replace(/\r\n/g, "\n")
        .trim()
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n");
}
function tableConfigYaml(columns: ColumnConfig[]): string {
    const lines = [`$schema: ${yamlScalar(TABLE_CONFIG_SCHEMA)}`, "columns_config:"];
    columns
        .slice()
        .sort((a, b) => a.index - b.index)
        .forEach((column) => {
            lines.push(`  - index: ${column.index}`);
            lines.push(`    name: ${yamlScalar(column.name)}`);
            if (column.format) {
                lines.push(`    format: ${yamlScalar(column.format)}`);
            }
            if (column.tags?.length) {
                lines.push("    tags:");
                column.tags.forEach((tag) =>
                    lines.push(`      - ${yamlScalar(tag)}`),
                );
            }
            lines.push("    prompt: >-");
            lines.push(yamlBlock(column.prompt));
        });
    return `${lines.join("\n")}\n`;
}
function skillFrontmatter(workflow: Workflow, slug: string): string {
    const contributors =
        workflow.metadata.contributors.length > 0
            ? workflow.metadata.contributors
            : [
                  {
                      name: "User",
                      organisation: null,
                      role: null,
                      linkedin: null,
                  },
              ];
    const lines = [
        "---",
        `name: ${yamlScalar(slug)}`,
        `display_name: ${yamlScalar(workflow.metadata.title)}`,
        `description: ${yamlScalar(
            workflow.metadata.description ??
                `Run the ${workflow.metadata.title} workflow.`,
        )}`,
        `type: ${yamlScalar(workflow.metadata.type)}`,
        `language: ${yamlScalar(workflow.metadata.language || "English")}`,
        `version: ${yamlScalar(workflow.metadata.version || "1.0.0")}`,
        `practice: ${yamlScalar(workflow.metadata.practice)}`,
        "jurisdictions:",
        ...(workflow.metadata.jurisdictions?.length
            ? workflow.metadata.jurisdictions.map(
                  (jurisdiction) => `  - ${yamlScalar(jurisdiction)}`,
              )
            : ["  - \"General\""]),
        "contributors:",
        ...contributors.flatMap((contributor) => [
            `  - name: ${yamlScalar(contributor.name)}`,
            `    organisation: ${yamlScalar(contributor.organisation)}`,
            `    role: ${yamlScalar(contributor.role)}`,
            `    linkedin: ${yamlScalar(contributor.linkedin)}`,
        ]),
        "---",
        "",
    ];
    return lines.join("\n");
}
function workflowFiles(
    workflow: Workflow,
    skillMd: string,
    columns: ColumnConfig[],
): { files: ZipFile[]; slug: string } {
    const type = workflow.metadata.type;
    const slug = slugify(workflow.metadata.title, workflow.id || "workflow");
    const basePath = slug;
    const files: ZipFile[] = [
        {
            path: `${basePath}/SKILL.md`,
            content: `${skillFrontmatter(workflow, slug)}${skillMd.trimEnd()}\n`,
        },
    ];
    if (type === "tabular") {
        files.push({
            path: `${basePath}/table-config.yaml`,
            content: tableConfigYaml(columns),
        });
    }
    return { files, slug };
}
export async function downloadWorkflowZip(
    workflow: Workflow,
    skillMd: string,
    columns: ColumnConfig[],
) {
    const { files, slug } = workflowFiles(workflow, skillMd, columns);
    const { blob } = await apiBlobRequest("/workflows/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
    });
    downloadBlob(blob, `${slug}.zip`);
}
