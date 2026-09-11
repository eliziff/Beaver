import type { TabularApplication } from "../tabular/application";
import { appUrl } from "../appRoutes";
import { modelEvidencePassage, type LegalEvidenceReceipt } from "./legalEvidence";
import { objectSchema as object, toolText, type BeaverTool } from "./toolRegistry";
import { researchResultFilter, type ResearchReadContext } from "../researchReader";
import { tabularSubjectId } from "../tabularStore";

export type ResearchTableDetail = NonNullable<Awaited<ReturnType<TabularApplication["detail"]>>>;
export type ResearchTableResolver = (reviewId?: string) => Promise<ResearchTableDetail | null>;


export const tabularTool = <Context>(resolveTable: ResearchTableResolver, context?: ResearchReadContext): BeaverTool<Context> => ({
  name: "read_table_cells",
  annotations: { readOnlyHint: true },
  description:
    "Page extracted cells from a tabular review. Use review_id for a linked workspace table, or omit it for the current table. Column indices, row indices and offset are zero-based. Large answers return a Read findings reference for their complete content.",
  inputSchema: object({ review_id: { type: "string", minLength: 1 },
    col_indices: { type: "array", items: { type: "integer" } },
    row_indices: { type: "array", items: { type: "integer" } },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  reader: ["CA", "US", "UK"],
  activity: () => "Reading table cells",
  async execute(input) {
    const selected = await resolveTable(typeof input.review_id === "string" ? input.review_id : undefined);
    if (!selected) return { result: toolText("The selected table is unavailable. Use a linked review_id.", true) };
    const read = readTabularCells(selected,
      input.col_indices as number[] | undefined,
      input.row_indices as number[] | undefined,
      { offset: input.offset as number | undefined, limit: input.limit as number | undefined, context },
    );
    return { result: toolText(read.content), activityCitations: read.citations, evidence: read.evidence };
  },
});

export function readTabularCells(
  detail: ResearchTableDetail,
  colIndices?: number[],
  rowIndices?: number[],
  options: { offset?: number; limit?: number; context?: ResearchReadContext } = {},
) {
  const columns = [...detail.review.columns_config].sort((left, right) => left.index - right.index)
    .map((column, col_index) => ({ column, col_index }))
    .filter(({ col_index }) => !colIndices?.length || colIndices.includes(col_index));
  const byId = new Map(detail.documents.map((document) => [document.id, document])),
    documents = detail.review.document_ids.flatMap((id, row_index) => {
      const document = byId.get(id); return document ? [{ document, row_index }] : [];
    })
    .filter(({ row_index }) => !rowIndices?.length || rowIndices.includes(row_index));
  const label = `${columns.length} ${columns.length === 1 ? "column" : "columns"} × ${documents.length} ${documents.length === 1 ? "row" : "rows"}`,
    offset = Math.max(0, options.offset ?? 0), limit = Math.max(1, Math.min(50, options.limit ?? 20)),
    inScope = researchResultFilter(options.context),
    subjects = new Map(detail.review.scope_config?.subjects.map((subject) => [tabularSubjectId(subject), subject]));
  const cells: Record<string, unknown>[] = [];
  const citations: Record<string, unknown>[] = [];
  const passages = new Map<string, LegalEvidenceReceipt>(),
    stored = new Map(detail.cells.map((cell) => [`${cell.column_index}:${cell.document_id}`, cell]));

  let total = 0, size = 1_000, limitReached = false;
  for (const { column, col_index } of columns) {
    for (const { document, row_index } of documents) {
      if (options.context?.findingRefs && !options.context.findingRefs.some((ref) =>
          ref.kind === "cell" && ref.reviewId === detail.review.id && ref.rowId === document.id && ref.columnIndex === column.index)) continue;
      const cell = stored.get(`${column.index}:${document.id}`);
      const subject = subjects.get(document.id), resource = cell?.content?.resource ?? subject?.resource ?? document.resource ?? "";
      if (!inScope({ resource, evidence: cell?.content?.evidence ?? subject?.evidence })) continue;
      if (total++ < offset || cells.length >= limit || limitReached) continue;
      let entry: Record<string, unknown> = { col_index, row_index, status: cell?.status ?? "pending" };
      const evidence = cell?.status === "done" ? cell.content?.evidence ?? [] : [];
      if (cell?.status === "done" && cell.content) {
        const { evidence: _receipts, ...answer } = cell.content;
        Object.assign(entry, answer);
      }
      let length = JSON.stringify(entry).length + JSON.stringify(evidence.map(modelEvidencePassage)).length +
        document.filename.length + column.name.length + 300;
      if (length > 30_000) {
        const reference = { kind: "cell", reviewId: detail.review.id, rowId: document.id, columnIndex: column.index };
        entry = { col_index, row_index, status: cell?.status ?? "pending", reference,
          continued: true, read: { file_path: "findings", section: JSON.stringify(reference), offset: 1 } };
        length = JSON.stringify(entry).length + document.filename.length + column.name.length + 300;
      }
      if (size + length > 50_000) { limitReached = true; continue; }
      size += length;
      citations.push({ kind: "tabular", ref: citations.length + 1, quotes: [],
        review_id: detail.review.id, col_index, row_index,
        col_name: column.name, doc_name: document.filename });
      if (!entry.continued) for (const receipt of evidence) passages.set(receipt.evidence_id, receipt);
      cells.push(entry);
    }
  }

  return {
    label,
    citations,
    evidence: [...passages.values()],
    content: JSON.stringify({ review_id: detail.review.id,
      app_url: appUrl({ kind: "tabular-review", id: detail.review.id, projectId: detail.review.project_id }),
      offset, total, next_offset: offset + cells.length < total ? offset + cells.length : null,
      columns: columns.filter(({ col_index }) => cells.some((cell) => cell.col_index === col_index))
        .map(({ column, col_index }) => ({ col_index, col_name: column.name })),
      rows: documents.filter(({ row_index }) => cells.some((cell) => cell.row_index === row_index)).map(({ document, row_index }) => ({ row_index,
        document_id: document.id, doc_name: document.filename })),
      cells, ...(passages.size ? { evidence: [...passages.values()].map(modelEvidencePassage) } : {}) }),
  };
}
