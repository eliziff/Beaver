import type { TabularCellStore } from "./types";
import { createTabularEvidence, registerLegalEvidence, type LegalEvidenceTurnState } from "./legalEvidence";
import { toolText, type BeaverTool } from "./toolRegistry";

const object = (properties: Record<string, object>) => ({
  type: "object" as const, properties, additionalProperties: false,
});

export const tabularTool = <Context>(
  tabular: TabularCellStore, evidence: LegalEvidenceTurnState,
): BeaverTool<Context> => ({
  name: "read_table_cells",
  annotations: { readOnlyHint: true },
  description:
    "Read extracted cells from the tabular review. Pass zero-based column or row indices for a subset; omit either to read all.",
  inputSchema: object({ col_indices: { type: "array", items: { type: "integer" } },
    row_indices: { type: "array", items: { type: "integer" } } }),
  reader: ["CA", "US", "UK"],
  activity: () => "Reading table cells",
  async execute(input) {
    const read = readTabularCells(tabular, evidence,
      input.col_indices as number[] | undefined,
      input.row_indices as number[] | undefined,
    );
    return { result: toolText(read.content) };
  },
});

export function readTabularCells(
  tabularStore: TabularCellStore,
  evidence: LegalEvidenceTurnState,
  colIndices?: number[],
  rowIndices?: number[],
) {
  const columns = colIndices?.length
    ? tabularStore.columns.filter((_, index) => colIndices.includes(index))
    : tabularStore.columns;
  const documents = rowIndices?.length
    ? tabularStore.documents.filter((_, index) => rowIndices.includes(index))
    : tabularStore.documents;
  const label = `${columns.length} ${columns.length === 1 ? "column" : "columns"} × ${documents.length} ${documents.length === 1 ? "row" : "rows"}`;
  const lines: string[] = [];

  for (const column of columns) {
    const columnPosition = tabularStore.columns.findIndex(
      (candidate) => candidate.index === column.index,
    );
    for (const document of documents) {
      const rowPosition = tabularStore.documents.findIndex(
        (candidate) => candidate.id === document.id,
      );
      const cell = tabularStore.cells.get(`${column.index}:${document.id}`);
      lines.push(
        `[COL:${columnPosition} "${column.name}" | ROW:${rowPosition} "${document.filename}"]`,
      );
      if (cell?.summary) {
        const text = [
          `Summary: ${cell.summary}`,
          cell.flag && `Flag: ${cell.flag}`,
          cell.reasoning && `Reasoning: ${cell.reasoning}`,
        ].filter(Boolean).join("\n");
        const receipt = createTabularEvidence({
          reviewId: tabularStore.review_id,
          documentId: document.id,
          documentName: document.filename,
          columnId: column.index,
          columnName: column.name,
          columnIndex: columnPosition,
          rowIndex: rowPosition,
          text,
        });
        registerLegalEvidence(evidence, receipt);
        lines.push(`Evidence: ${receipt.evidence_id}`, text);
      } else {
        lines.push("(not yet generated)");
      }
      lines.push("");
    }
  }

  return {
    label,
    content:
      `${tabularStore.app_url ? `Review app_url: ${tabularStore.app_url}\n\n` : ""}${
        lines.join("\n") || "No cells found."
      }`,
  };
}
