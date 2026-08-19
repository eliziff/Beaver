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
      return document
        ? [{
            id,
            filename:
              typeof document.filename === "string" && document.filename.trim()
                ? document.filename.trim()
                : "Untitled document",
          }]
        : [];
    }),
    cells: new Map(
      detail.cells.map((cell) => [
        `${cell.column_index}:${cell.document_id}`,
        cell.content,
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
    prompt: `TABULAR REVIEW CONTEXT
You are working in the tabular review "${detail.review.title || "Untitled Review"}".
Use read_table_cells before relying on cell content.

DOCUMENTS (rows):
${rows || "- (none)"}

COLUMNS (fields):
${columns || "- (none)"}

When cell content supports the answer, finish with submit_grounded_answer using the evidence_id values returned by read_table_cells. Do not write citation markers or citation metadata yourself.`,
  };
}
