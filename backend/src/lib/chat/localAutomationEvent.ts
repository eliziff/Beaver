const TOOLS = new Set([
  "create_table_of_authorities",
  "fix_docx_supras",
  "link_docx_citations",
]);

const STAGES: Record<string, string> = {
  create_table_of_authorities: "Create book/table of authorities",
  link_docx_citations: "Auto-add hyperlinks to citations",
  fix_docx_supras: "Fix supra references",
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export type LocalAutomationEvent = Record<string, unknown> & {
  type: "automation_run";
  id: string;
};

function counts(tool: string, value: Record<string, unknown>) {
  const fields =
    tool === "fix_docx_supras"
      ? [
          ["Found", "detected"],
          ["Fixed", "converted"],
          ["Already linked", "already_linked"],
          ["Needs review", "review_required"],
        ]
      : tool === "link_docx_citations"
        ? [
            ["Linked", "linked_citations"],
            ["Unresolved", "unresolved_citations"],
          ]
        : [];
  const rows = fields.flatMap(([label, key]) => {
    const count = number(value[key]);
    return count === null ? [] : [{ label, value: count }];
  });
  return rows.length ? rows : undefined;
}

export function localAutomationEvent(
  tool: string,
  content: string | undefined,
  id: string,
): LocalAutomationEvent | null {
  if (!content) return null;
  let value: Record<string, unknown> | null = null;
  try {
    value = record(JSON.parse(content));
  } catch {
    return null;
  }
  if (!value) return null;
  if (tool === "Read" && record(value.job)) tool = "create_table_of_authorities";
  if (!TOOLS.has(tool)) return null;

  const failure = text(value.error);
  if (value.ok !== true) {
    return {
      type: "automation_run",
      id,
      tool,
      status: "error",
      stage: STAGES[tool],
      error: failure || "Automation failed",
    };
  }

  const job = record(value.job);
  if (job) {
    const outputs = Array.isArray(job.files)
      ? job.files.flatMap((file) => {
          const row = record(file);
          const name = text(row?.name);
          if (!name) return [];
          const url = text(row?.url);
          return [{ name, ...(url ? { url } : {}) }];
        })
      : [];
    const jobError = text(job.error);
    const jobId = text(job.id);
    return {
      type: "automation_run",
      id,
      tool,
      status: jobError ? "error" : text(job.state) || "complete",
      stage: text(job.operation) || STAGES[tool],
      ...(number(job.progress) !== null
        ? { progress: number(job.progress) }
        : {}),
      ...(text(job.message) ? { message: text(job.message) } : {}),
      ...(outputs.length
        ? {
            counts: [{ label: "Outputs", value: outputs.length }],
            outputs,
          }
        : {}),
      ...(jobError ? { error: jobError } : {}),
      ...(text(job.app_url) ? { app_url: text(job.app_url) } : {}),
      ...(jobId ? { job_id: jobId } : {}),
      ...(text(value.document_id)
        ? { document_id: text(value.document_id) }
        : {}),
      ...(text(value.version_id)
        ? { version_id: text(value.version_id) }
        : {}),
      ...(number(value.version_number) !== null
        ? { version_number: number(value.version_number) }
        : {}),
    };
  }

  const filename = text(value.filename);
  const resultCounts = counts(tool, value);
  return {
    type: "automation_run",
    id,
    tool,
    status: "complete",
    stage: STAGES[tool],
    ...(resultCounts ? { counts: resultCounts } : {}),
    ...(filename ? { outputs: [{ name: filename }] } : {}),
    ...(text(value.document_id)
      ? { document_id: text(value.document_id) }
      : {}),
    ...(text(value.version_id) ? { version_id: text(value.version_id) } : {}),
    ...(number(value.version_number) !== null
      ? { version_number: number(value.version_number) }
      : {}),
  };
}
