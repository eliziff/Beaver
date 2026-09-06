import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "../applicationError";
import type { DocumentStore } from "../documentStore";
import { researchLabelPath, researchSourceResource, visitResearchEvidenceParts,
  type ResearchEvidence, type ResearchFile } from "../researchFile";
import { researchFindingReferenceSchema, type ResearchFinding, type ResearchFindingReference } from "../researchChat";
import { resolveResearchSelection, researchSelectionLabels, type ResearchSubject } from "../researchSelection";
import type { TabularCell, TabularCellContent, TabularColumn } from "../tabularStore";

const id = z.string().min(1).max(200), ids = z.array(id).max(500);
const item = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("label"), labelId: id, sourceId: id, evidenceId: id.optional(),
    display: z.enum(["name", "path"]).optional() }).strict(),
  z.object({ kind: z.literal("passage"), sourceId: id, evidenceId: id }).strict(),
  ...researchFindingReferenceSchema.options,
]);
export const researchArrangementSchema = z.object({
  rows: z.array(z.object({ id, title: z.string().trim().min(1).max(500), sourceId: id,
    evidenceIds: ids.optional(), group: ids.optional() }).strict()).max(500),
  cells: z.array(z.object({ rowId: id, columnIndex: z.number().int().min(0).max(10_000),
    items: z.array(item).max(500) }).strict()).max(50_000),
}).strict();
export type ResearchArrangement = z.infer<typeof researchArrangementSchema>;
const string = { type: "string" }, strings = { type: "array", items: string };
export const researchArrangementToolSchema = {
  type: "object", required: ["rows", "cells"], additionalProperties: false,
  description: "Arrange existing research by reference. Choose rows, named columns and grouping for the task. Labels and saved answers stay linked to their originals. Each row may represent a distinct passage or branch of one source.",
  properties: {
    rows: { type: "array", items: { type: "object", required: ["id", "title", "sourceId"],
      additionalProperties: false, properties: { id: string, title: string, sourceId: string,
        evidenceIds: strings, group: { ...strings, description: "Ordered grouping label IDs" } } } },
    cells: { type: "array", items: { type: "object", required: ["rowId", "columnIndex", "items"],
      additionalProperties: false, properties: { rowId: string, columnIndex: { type: "integer" },
        items: { type: "array", items: { type: "object", required: ["kind"], additionalProperties: false,
          properties: { kind: { type: "string", enum: ["label", "passage", "answer", "cell"] }, labelId: string,
            sourceId: string, evidenceId: string, chatId: string, answerId: string, resource: string,
            display: { type: "string", enum: ["name", "path"] }, reviewId: string, rowId: string,
            columnIndex: { type: "integer" } },
          description: "label: labelId,sourceId,evidenceId?,display? (name by default); passage: sourceId,evidenceId; answer: chatId,answerId,resource; cell: reviewId,rowId,columnIndex" } } } } },
  },
};

function missing(message: string): never { throw new ApplicationError(409, message); }

/** Resolve a chosen arrangement from canonical research, without storing a second answer or ontology. */
export async function resolveResearchArrangement(input: {
  documents: DocumentStore; scope: ApplicationScope; file: ResearchFile;
  arrangement: ResearchArrangement; columns: TabularColumn[]; storedCells: TabularCell[];
  resolveFinding?: (reference: ResearchFindingReference) => Promise<ResearchFinding | null>;
  strict?: boolean;
}) {
  const { documents, scope, file, columns, storedCells } = input,
    arrangement = researchArrangementSchema.parse(input.arrangement),
    rowIds = new Set(arrangement.rows.map(({ id }) => id));
  if (rowIds.size !== arrangement.rows.length) throw new ApplicationError(400, "Row IDs must be unique");
  const selection = await resolveResearchSelection(documents, scope, { researchFileId: file.document.id,
    target: "sources", sourceIds: [...new Set(arrangement.rows.map(({ sourceId }) => sourceId))]
      .filter((id) => input.strict || file.state.sources[id]) }, file, { availableOnly: !input.strict }),
    sources = new Map(selection.subjects.map((subject) => [subject.sourceId, subject])),
    parts = new Map<string, Record<string, ResearchEvidence>>();
  await visitResearchEvidenceParts(documents, scope, file, [...sources.keys()], (batch) =>
    batch.forEach((value, key) => parts.set(key, value)));
  const passage = (sourceId: string, evidenceId: string) => parts.get(sourceId)?.[evidenceId]
    ?? missing("A referenced passage is no longer in this workspace");
  const subjects: ResearchSubject[] = arrangement.rows.flatMap((row) => {
    const subject = sources.get(row.sourceId);
    if (!subject) return [];
    return [{ ...subject, rowId: row.id, ...(row.evidenceIds ? { evidence: row.evidenceIds.flatMap((id) =>
      input.strict ? [passage(row.sourceId, id).receipt] : parts.get(row.sourceId)?.[id]?.receipt ?? []) } : {}) }];
  });
  const rows = arrangement.rows.map((row) => ({ id: row.id, title: row.title,
    group: (row.group ?? []).map((id) => file.state.labels[id]?.name
      ?? (input.strict ? missing("A grouping label is no longer in this workspace") : "Removed label")) }));
  const cells = new Map(storedCells.map((cell) => [`${cell.document_id}:${cell.column_index}`, cell])),
    assigned = new Set<string>();
  for (const mapping of arrangement.cells) {
    const row = arrangement.rows.find(({ id }) => id === mapping.rowId),
      key = `${mapping.rowId}:${mapping.columnIndex}`;
    if (!row || !columns.some(({ index }) => index === mapping.columnIndex) || assigned.has(key))
      throw new ApplicationError(400, "Each mapped cell needs a unique existing row and column");
    assigned.add(key);
    const previous = cells.get(key), identity = { ...previous, id: previous?.id ?? `reference:${key}`,
      review_id: previous?.review_id ?? "", document_id: mapping.rowId, column_index: mapping.columnIndex };
    try {
      if (!file.state.sources[row.sourceId]) missing("This row source is no longer in the workspace");
      const resource = researchSourceResource(file.state.sources[row.sourceId].reference),
        values: string[] = [], claims: TabularCellContent["claims"] = [],
        receipts = new Map<string, TabularCellContent["evidence"][number]>();
      let singleFinding: ResearchFinding | undefined;
      for (const reference of mapping.items) {
        if (reference.kind === "answer" || reference.kind === "cell") {
          const answer = await input.resolveFinding?.(reference);
          if (!answer || answer.resource !== resource) missing("The referenced answer is unavailable for this row");
          if (mapping.items.length === 1) singleFinding = answer;
          values.push(answer.answer.summary ?? (answer.answer.value == null ? answer.answer.claims.map(({ text }) => text).join("\n\n")
            : Array.isArray(answer.answer.value) ? answer.answer.value.join("\n") : String(answer.answer.value)));
          claims.push(...answer.answer.claims);
          answer.evidence.forEach((receipt) => receipts.set(receipt.evidence_id, receipt));
          continue;
        }
        if (reference.sourceId !== row.sourceId) throw new ApplicationError(400, "A cell reference belongs to another row source");
        const evidence = reference.evidenceId ? passage(reference.sourceId, reference.evidenceId) : undefined;
        if (evidence && row.evidenceIds && !row.evidenceIds.includes(evidence.receipt.evidence_id))
          throw new ApplicationError(400, "A cell passage is outside the selected row scope");
        if (reference.kind === "label") {
          const label = file.state.labels[reference.labelId], descendants = label && researchSelectionLabels(file.state, [label.id]);
          if (!label || !(evidence?.labelIds ?? file.state.sources[reference.sourceId].labelIds)
              .some((id) => descendants!.has(id)))
            missing("A referenced label assignment has changed; revise this arrangement");
          values.push(reference.display === "path" ? researchLabelPath(file.state, reference.labelId) : label.name);
        } else values.push(evidence!.receipt.span_text ?? "");
        if (evidence) {
          receipts.set(evidence.receipt.evidence_id, evidence.receipt);
          if (evidence.receipt.span_text) claims.push({ text: evidence.receipt.span_text,
            evidence_ids: [evidence.receipt.evidence_id] });
        }
      }
      cells.set(key, { ...identity, status: "done", content: {
          summary: values.join("\n\n"), value: values.length === 1 ? values[0] : values,
          claims: [...new Map(claims.map((claim) => [JSON.stringify(claim), claim])).values()],
          evidence: [...receipts.values()], resource, outcome: "answered", coverage: "complete",
          ...(singleFinding ? { ...singleFinding.answer,
            summary: singleFinding.answer.summary ?? values.join("\n\n"),
            outcome: singleFinding.answer.outcome ?? "answered", coverage: singleFinding.answer.coverage ?? "partial" } : {}),
        } });
    } catch (error) {
      if (input.strict || !(error instanceof ApplicationError)) throw error;
      cells.set(key, { ...identity, status: "error", content: null, error: error.message });
    }
  }
  return { subjects, cells: [...cells.values()], rows };
}
