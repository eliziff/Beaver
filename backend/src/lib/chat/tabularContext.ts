import type { ResearchTableDetail } from "./tabularCells";

export function tabularChatPrompt(detail: ResearchTableDetail) {
  const rows = detail.documents
    .map((document, index) => `- ROW:${index} "${document.filename}"`)
    .join("\n");
  const columns = [...detail.review.columns_config].sort((left, right) => left.index - right.index)
    .map((column) => `- COL index=${column.index} "${column.name}" (${column.format ?? "text"})`)
    .join("\n");
  return `TABULAR REVIEW CONTEXT: ${detail.review.id}
"${detail.review.title || "Untitled Review"}"
EXPECTED_VERSION: ${detail.review.updated_at}

DOCUMENTS (rows):
${rows || "- (none)"}

COLUMNS (fields):
${columns || "- (none)"}

Read this review with update_research_table to inspect its selected research and arrangement before organizing it. Added columns, explicit renames and reorders apply directly: send the complete columns_config, whose array order is the column order. Rewritten prompts, changed formats or tags and removals of existing columns are proposals: send them with propose:true so the user reviews them in a form. Keep completed no-match results distinct from incomplete or failed extraction.`;
}
