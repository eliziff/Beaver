import type { ResearchTableDetail } from "./tabularCells";

export function tabularChatPrompt(detail: ResearchTableDetail) {
  const rows = detail.documents
    .map((document, index) => `- ROW:${index} "${document.filename}"`)
    .join("\n");
  const columns = [...detail.review.columns_config].sort((left, right) => left.index - right.index)
    .map((column, index) => `- COL:${index} "${column.name}"`)
    .join("\n");
  return `TABULAR REVIEW CONTEXT: ${detail.review.id}
"${detail.review.title || "Untitled Review"}"

DOCUMENTS (rows):
${rows || "- (none)"}

COLUMNS (fields):
${columns || "- (none)"}

Read this review with update_research_table to inspect its selected research and arrangement before organizing it. Keep completed no-match results distinct from incomplete or failed extraction.`;
}
