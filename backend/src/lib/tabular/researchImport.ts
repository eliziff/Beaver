import { isResearchHighlight, researchLabelPath, type ResearchEvidence, type ResearchFile } from "../researchFile";
import type { ResearchFinding } from "../researchChat";
import { researchSelectionLabels, type ResearchSubject } from "../researchSelection";
import type { TabularColumn } from "../tabularStore";
import type { ResearchArrangement } from "./researchArrangement";

const MAX_ROWS = 400, MAX_COLUMNS = 100;
export type ResearchImportInput = { rows: "sources" | "passages"; labelId?: string };
type Item = ResearchArrangement["cells"][number]["items"][number];
type Row = ResearchArrangement["rows"][number];
type ImportColumn = TabularColumn & { items(row: Row): Item[] };
type ImportChat = { title: string; findings: ResearchFinding[] };

const clip = (value: string, max: number) => value.replace(/\s+/gu, " ").trim().slice(0, max);
const sourceName = (file: ResearchFile, sourceId: string) => {
  const reference = file.state.sources[sourceId]?.reference;
  return clip(reference?.title || reference?.citation || sourceId, 300) || sourceId;
};
const passageName = (receipt: ResearchEvidence["receipt"]) =>
  clip(receipt.locator.label && receipt.locator.kind !== "document"
    ? `${receipt.locator.kind} ${receipt.locator.label}`
    : receipt.span_text ?? receipt.evidence_id, 180);

/**
 * Turn saved research into a table without a model: every cell references the workspace
 * item it displays, so the review reads the originals instead of copying them.
 */
export function researchTableArrangement(file: ResearchFile, subjects: ResearchSubject[],
  parts: Map<string, Record<string, ResearchEvidence>>, chats: ImportChat[],
  input: ResearchImportInput): { columns_config: TabularColumn[]; arrangement: ResearchArrangement } {
  const pen = input.labelId ? researchSelectionLabels(file.state, [input.labelId]) : null,
    inPen = (item: ResearchEvidence) => !pen || item.labelIds.some((id) => pen.has(id));
  const sourceIds = [...new Set(subjects.map(({ sourceId }) => sourceId))]
    .filter((id) => file.state.sources[id]);
  const allowed = new Map<string, Set<string> | null>();
  for (const subject of subjects) {
    const previous = allowed.get(subject.sourceId);
    if (!subject.evidence || previous === null) { allowed.set(subject.sourceId, null); continue; }
    const chosen = previous ?? new Set<string>();
    subject.evidence.forEach(({ evidence_id }) => chosen.add(evidence_id));
    allowed.set(subject.sourceId, chosen);
  }
  const scoped = new Map(sourceIds.map((sourceId) => { const limit = allowed.get(sourceId) ?? null;
    return [sourceId, Object.values(parts.get(sourceId) ?? {}).filter((item) =>
      inPen(item) && (limit ? limit.has(item.receipt.evidence_id) : isResearchHighlight(item)))]; }));

  const rows: ResearchArrangement["rows"] = [];
  for (const sourceId of sourceIds) {
    if (rows.length >= MAX_ROWS) break;
    if (input.rows === "sources") {
      if (pen && !scoped.get(sourceId)!.length) continue;
      rows.push({ id: sourceId, title: sourceName(file, sourceId), sourceId,
        ...(file.state.sources[sourceId].labelIds.length ? { group: [...file.state.sources[sourceId].labelIds] } : {}) });
      continue;
    }
    for (const item of scoped.get(sourceId)!) {
      if (rows.length >= MAX_ROWS) break;
      rows.push({ id: `${sourceId}:${item.receipt.evidence_id}`,
        title: `${sourceName(file, sourceId)} · ${passageName(item.receipt)}`,
        sourceId, evidenceIds: [item.receipt.evidence_id] });
    }
  }
  const rowEvidence = new Map(rows.map((row) => [row.id, row.evidenceIds?.[0]]));
  const passagesOf = (row: Row) => {
    const values = scoped.get(row.sourceId) ?? [], only = rowEvidence.get(row.id);
    return only ? values.filter(({ receipt }) => receipt.evidence_id === only) : values;
  };

  const pens = [...new Set(rows.flatMap((row) => passagesOf(row).flatMap(({ labelIds }) => labelIds)))]
    .filter((id) => file.state.labels[id]?.scope === "highlight")
    .sort((a, b) => researchLabelPath(file.state, a).localeCompare(researchLabelPath(file.state, b)));
  const bound = chats.filter(({ findings }) => findings.some(({ sourceId }) =>
    rows.some((row) => row.sourceId === sourceId)));

  const passageItems = (row: Row, values: ResearchEvidence[]): Item[] => values.map(({ receipt }) =>
    ({ kind: "passage", sourceId: row.sourceId, evidenceId: receipt.evidence_id }));
  const declared: ImportColumn[] = [
    { index: 0, name: "Labels", prompt: "Labels carried by this source in the workspace.", format: "text",
      items: (row) => file.state.sources[row.sourceId].labelIds.map((labelId) =>
        ({ kind: "label", labelId, sourceId: row.sourceId, display: "path" })) },
    { index: 0, name: "Note", prompt: "The note saved on this row in the workspace.", format: "text",
      items: (row) => [{ kind: "note", sourceId: row.sourceId,
        ...(rowEvidence.get(row.id) ? { evidenceId: rowEvidence.get(row.id)! } : {}) }] },
    ...(input.rows === "passages" ? [{ index: 0, name: "Passage",
      prompt: "The highlighted text saved for this row.", format: "text",
      items: (row: Row) => passageItems(row, passagesOf(row)) }] : []),
    ...pens.map((labelId): ImportColumn => ({ index: 0, name: clip(file.state.labels[labelId].name, 200),
      prompt: `Passages highlighted with ${clip(researchLabelPath(file.state, labelId), 200)}.`, format: "text",
      items: (row) => passageItems(row, passagesOf(row).filter(({ labelIds }) => labelIds.includes(labelId))) })),
    ...bound.map((chat): ImportColumn => ({ index: 0, name: clip(chat.title, 200) || "Chat answers",
      prompt: `Answers saved from the ${clip(chat.title, 200) || "linked"} chat.`, format: "text",
      items: (row) => chat.findings.flatMap((finding) => finding.sourceId === row.sourceId &&
        finding.reference.kind === "answer" ? [finding.reference] : []) })),
  ];
  const columns = declared.slice(0, MAX_COLUMNS).map((column, index) => ({ ...column, index }));

  return { columns_config: columns.map(({ items: _items, ...column }) => column),
    arrangement: { rows, cells: rows.flatMap((row) => columns.map((column) =>
      ({ rowId: row.id, columnIndex: column.index, items: column.items(row) }))) } };
}
