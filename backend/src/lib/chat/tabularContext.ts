import { appUrl } from "../appRoutes";
import type { TabularCellStore } from "./types";
import type { TabularApplication } from "../tabular/application";

type Detail = NonNullable<Awaited<ReturnType<TabularApplication["detail"]>>>;

export function tabularChatContext(detail: Detail) {
  const documentsById = new Map(
    detail.documents.map((document) => [document.id, document]),
  );
  const store: TabularCellStore = {
    review_id: detail.review.id,
    app_url: appUrl({
      kind: "tabular-review",
      id: detail.review.id,
      projectId: detail.review.project_id,
    }),
    columns: [...detail.review.columns_config].sort(
      (left, right) => left.index - right.index,
    ),
    documents: detail.review.document_ids.flatMap((id) => {
      const document = documentsById.get(id);
      return document ? [{ id, filename: document.filename.trim() }] : [];
    }),
    cells: new Map(
      detail.cells.map((cell) => [
        `${cell.column_index}:${cell.document_id}`,
        { content: cell.content, status: cell.status },
      ]),
    ),
  };
  const rows = store.documents
    .map((document, index) => `- ROW:${index} "${document.filename}"`)
    .join("\n");
  const columns = store.columns
    .map((column, index) => `- COL:${index} "${column.name}"`)
    .join("\n");
  return {
    store,
    prompt: `TABULAR REVIEW CONTEXT: ${detail.review.id}
"${detail.review.title || "Untitled Review"}"

DOCUMENTS (rows):
${rows || "- (none)"}

COLUMNS (fields):
${columns || "- (none)"}

Read this review with update_research_table to inspect its selected research and arrangement before organizing it. Keep completed no-match results distinct from incomplete or failed extraction.`,
  };
}
