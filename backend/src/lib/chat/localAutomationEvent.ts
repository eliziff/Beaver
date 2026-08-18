type AutomationTool =
  | "create_table_of_authorities"
  | "link_docx_citations"
  | "fix_docx_supras";
type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? value
  : undefined;

export type LocalAutomationEvent = Row & { type: "automation_run"; id: string };

function event(
  tool: AutomationTool,
  stage: string,
  fields: ReadonlyArray<readonly [label: string, key: string]>,
  value: unknown,
  id: string,
): LocalAutomationEvent | null {
  const result = row(value);
  if (!result) return null;
  const job = row(result.job);
  const error = text(job?.error ?? result.error);
  const base = { type: "automation_run" as const, id, tool, stage };
  if (result.ok !== true || error) {
    return { ...base, status: "error", error: error || "Automation failed" };
  }
  if (job) {
    const outputs = Array.isArray(job.files)
      ? job.files.flatMap((value) => {
          const file = row(value);
          const name = text(file?.name);
          const url = text(file?.url);
          return name ? [{ name, ...(url && { url }) }] : [];
        })
      : [];
    return {
      ...base,
      status: text(job.state) || "complete",
      stage: text(job.operation) || stage,
      ...(number(job.progress) !== undefined && { progress: number(job.progress) }),
      ...(text(job.message) && { message: text(job.message) }),
      ...(outputs.length && { counts: [{ label: "Outputs", value: outputs.length }], outputs }),
      ...(text(job.app_url) && { app_url: text(job.app_url) }),
      ...(text(job.id) && { job_id: text(job.id) }),
    };
  }
  const counts = fields.flatMap(([label, key]) =>
    number(result[key]) === undefined ? [] : [{ label, value: number(result[key])! }]);
  return {
    ...base,
    status: "complete",
    ...(counts.length && { counts }),
    ...(text(result.filename) && { outputs: [{ name: text(result.filename) }] }),
    ...Object.fromEntries(["document_id", "version_id"].flatMap((key) =>
      text(result[key]) ? [[key, text(result[key])]] : [])),
    ...(number(result.version_number) !== undefined && { version_number: number(result.version_number) }),
  };
}

export const tableOfAuthoritiesEvent = (value: unknown, id: string) =>
  event("create_table_of_authorities", "Create book/table of authorities", [], value, id);

export const citationLinkingEvent = (value: unknown, id: string) =>
  event("link_docx_citations", "Auto-add hyperlinks to citations", [
    ["Linked", "linked_citations"],
    ["Unresolved", "unresolved_citations"],
  ], value, id);

export const supraFixEvent = (value: unknown, id: string) =>
  event("fix_docx_supras", "Fix supra references", [
    ["Found", "detected"],
    ["Fixed", "converted"],
    ["Already linked", "already_linked"],
    ["Needs review", "review_required"],
  ], value, id);
