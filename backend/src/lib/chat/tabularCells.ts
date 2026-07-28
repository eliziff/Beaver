import type { TabularCellStore } from "./types";

export function readTabularCells(
  tabularStore: TabularCellStore,
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
        lines.push(`Summary: ${cell.summary}`);
        if (cell.flag) lines.push(`Flag: ${cell.flag}`);
        if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
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
