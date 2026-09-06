import type { TabularCellStore } from "./types";
import { modelEvidencePassage, registerLegalEvidence, type LegalEvidenceTurnState } from "./legalEvidence";
import { toolText, type BeaverTool } from "./toolRegistry";

const object = (properties: Record<string, object>) => ({
  type: "object" as const, properties, additionalProperties: false,
});

export const tabularTool = <Context>(
  tabular: TabularCellStore | undefined, evidence: LegalEvidenceTurnState,
  resolveTabular?: (reviewId: string) => Promise<TabularCellStore | null>,
): BeaverTool<Context> => ({
  name: "read_table_cells",
  annotations: { readOnlyHint: true },
  description:
    "Read extracted cells from a tabular review. Use review_id for a linked workspace table, or omit it for the current table. Pass zero-based column or row indices for a subset; omit either to read all.",
  inputSchema: object({ review_id: { type: "string", minLength: 1 },
    col_indices: { type: "array", items: { type: "integer" } },
    row_indices: { type: "array", items: { type: "integer" } } }),
  reader: ["CA", "US", "UK"],
  activity: () => "Reading table cells",
  async execute(input) {
    const reviewId = typeof input.review_id === "string" ? input.review_id : tabular?.review_id,
      selected = reviewId === tabular?.review_id ? tabular : reviewId ? await resolveTabular?.(reviewId) : null;
    if (!selected) return { result: toolText("The selected table is unavailable. Use a linked review_id.", true) };
    const read = readTabularCells(selected, evidence,
      input.col_indices as number[] | undefined,
      input.row_indices as number[] | undefined,
    );
    return { result: toolText(read.content), activityCitations: read.citations };
  },
});

export function readTabularCells(
  tabularStore: TabularCellStore,
  evidence: LegalEvidenceTurnState,
  colIndices?: number[],
  rowIndices?: number[],
) {
  const columns = tabularStore.columns.map((column, col_index) => ({ column, col_index }))
    .filter(({ col_index }) => !colIndices?.length || colIndices.includes(col_index));
  const documents = tabularStore.documents.map((document, row_index) => ({ document, row_index }))
    .filter(({ row_index }) => !rowIndices?.length || rowIndices.includes(row_index));
  const label = `${columns.length} ${columns.length === 1 ? "column" : "columns"} × ${documents.length} ${documents.length === 1 ? "row" : "rows"}`;
  const cells: Record<string, unknown>[] = [];
  const citations: Record<string, unknown>[] = [];
  const passages = new Map<string, ReturnType<typeof modelEvidencePassage>>();

  for (const { column, col_index } of columns) {
    for (const { document, row_index } of documents) {
      const cell = tabularStore.cells.get(`${column.index}:${document.id}`);
      citations.push({ kind: "tabular", ref: citations.length + 1, quotes: [],
        review_id: tabularStore.review_id, col_index, row_index,
        col_name: column.name, doc_name: document.filename });
      const entry: Record<string, unknown> = { col_index, row_index, status: cell?.status ?? "pending" };
      if (cell?.status === "done" && cell.content) {
        for (const receipt of cell.content.evidence) {
          registerLegalEvidence(evidence, receipt);
          passages.set(receipt.evidence_id, modelEvidencePassage(receipt));
        }
        const { evidence: _receipts, ...answer } = cell.content;
        Object.assign(entry, answer);
      }
      cells.push(entry);
    }
  }

  return {
    label,
    citations,
    content: JSON.stringify({ review_id: tabularStore.review_id,
      ...(tabularStore.app_url ? { app_url: tabularStore.app_url } : {}),
      columns: columns.map(({ column, col_index }) => ({ col_index, col_name: column.name })),
      rows: documents.map(({ document, row_index }) => ({ row_index,
        document_id: document.id, doc_name: document.filename })),
      cells, ...(passages.size ? { evidence: [...passages.values()] } : {}) }),
  };
}
