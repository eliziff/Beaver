import { ApplicationError } from "../applicationError";
import { sha256 } from "../hash";
import { researchLabelPath, type ResearchEvidence, type ResearchFile } from "../researchFile";
import { selectFindingClaims, type ResearchFinding } from "../researchChat";
import { researchSelectionLabels, type ResearchSubject } from "../researchSelection";
import type { TabularColumn } from "../tabularStore";
import type { ResearchArrangement } from "./researchArrangement";

export type ResearchImportColumn = TabularColumn & { fieldIds: string[] };
export type ResearchImportInput = { rows: "sources" | "passages"; labelId?: string; columns?: ResearchImportColumn[] };
export type ResearchImportField = { id: string; name: string; prompt: string; kind: "classification" | "passages" | "finding" | "claim" | "note";
  format?: string; tags?: string[]; rows: number; samples: string[] };
type Item = ResearchArrangement["cells"][number]["items"][number];
type Row = ResearchArrangement["rows"][number];
type Field = Omit<ResearchImportField, "rows" | "samples"> & { primary?: boolean; items(row: Row): Item[] };
const clip = (text: string, max = 200) => text.replace(/\s+/gu, " ").trim().slice(0, max);
const questionKey = (finding: ResearchFinding) => sha256(JSON.stringify([
  finding.question.prompt.trim().replace(/\s+/gu, " "), finding.question.format ?? "text", finding.question.tags ?? [],
])).slice(0, 24);
const key = (value: Item) => JSON.stringify(value);
const exceeds = (what: string): never => { throw new ApplicationError(413, `${what}. Narrow the research selection before creating a review.`); };

/** A reusable field is existing work, not a model-authored answer. Mapping only selects
 * canonical references. Missing values stay unrun; membership never silently truncates. */
export function researchTableArrangement(file: ResearchFile, subjects: ResearchSubject[],
  parts: Map<string, Record<string, ResearchEvidence>>, chats: Array<{ title: string; findings: ResearchFinding[] }>,
  input: ResearchImportInput) {
  const sourceIds = [...new Set(subjects.map(({ sourceId }) => sourceId))].filter((id) => file.state.sources[id]);
  if (sourceIds.length > 500) exceeds("A review can contain at most 500 sources");
  const type = input.labelId ? researchSelectionLabels(file.state, [input.labelId]) : null;
  if (input.labelId && file.state.labels[input.labelId]?.scope !== "highlight")
    throw new ApplicationError(400, "Choose a highlight type, not a source label");
  const allowed = new Map<string, Set<string> | null>();
  for (const subject of subjects) {
    const previous = allowed.get(subject.sourceId);
    if (!subject.evidence || previous === null) allowed.set(subject.sourceId, null);
    else allowed.set(subject.sourceId, new Set([...(previous ?? []), ...subject.evidence.map(({ evidence_id }) => evidence_id)]));
  }
  const scoped = new Map(sourceIds.map((id) => [id, Object.values(parts.get(id) ?? {}).filter((item) => {
    const ids = allowed.get(id);
    // Exact evidence selection can use grounded support without colouring it as a highlight.
    return (ids ? ids.has(item.receipt.evidence_id) : item.labelIds.length > 0) &&
      (!type || item.labelIds.some((id) => type.has(id)));
  })]));
  const name = (id: string) => clip(file.state.sources[id].reference.title || file.state.sources[id].reference.citation || id, 300);
  const rows: Row[] = sourceIds.flatMap<Row>((sourceId) => {
    const evidence = scoped.get(sourceId)!;
    if (input.rows === "passages") return evidence.map(({ receipt }) => ({
      id: `${sourceId}:${receipt.evidence_id}`, sourceId, evidenceIds: [receipt.evidence_id],
      title: clip(`${name(sourceId)} · ${receipt.locator.kind === "document" ? receipt.span_text ?? receipt.evidence_id
        : `${receipt.locator.kind} ${receipt.locator.label}`}`, 500),
    }));
    if ((type || allowed.get(sourceId)) && !evidence.length) return [];
    return [{ id: sourceId, title: name(sourceId), sourceId,
      ...(allowed.get(sourceId) || type ? { evidenceIds: evidence.map(({ receipt }) => receipt.evidence_id) } : {}),
      ...(file.state.sources[sourceId].labelIds.length ? { group: [...file.state.sources[sourceId].labelIds] } : {}) }];
  });
  if (rows.length > 500) exceeds("A review can contain at most 500 passage rows");
  const passages = (row: Row) => scoped.get(row.sourceId)!.filter(({ receipt }) =>
    !row.evidenceIds || row.evidenceIds.includes(receipt.evidence_id));
  const fields: Field[] = [], labels = file.state.labels;
  for (const label of Object.values(labels).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    const descendants = researchSelectionLabels(file.state, [label.id]), highlight = label.scope === "highlight";
    fields.push({ id: `${highlight ? "highlights" : "labels"}:${label.id}`,
      name: clip(researchLabelPath(file.state, label.id)), kind: highlight ? "passages" : "classification", format: "text",
      prompt: highlight ? `Saved passages about ${researchLabelPath(file.state, label.id)}.` :
        `Existing source classification under ${researchLabelPath(file.state, label.id)}.`,
      primary: !label.parentId && (!highlight || input.rows === "sources"),
      items: (row) => highlight ? passages(row).filter(({ labelIds }) => labelIds.some((id) => descendants.has(id)))
        .map(({ receipt }) => ({ kind: "passage", sourceId: row.sourceId, evidenceId: receipt.evidence_id })) :
        file.state.sources[row.sourceId].labelIds.filter((id) => descendants.has(id))
          .map((labelId) => ({ kind: "label", labelId, sourceId: row.sourceId, display: "path" })) });
  }
  if (input.rows === "passages") fields.unshift({ id: "passage", name: "Passage", kind: "passages", format: "text", primary: true,
    prompt: "The exact passage selected for this row.", items: (row) => passages(row).map(({ receipt }) =>
      ({ kind: "passage", sourceId: row.sourceId, evidenceId: receipt.evidence_id })) },
    { id: "type", name: "Highlight type", kind: "classification", format: "text", primary: true,
      prompt: "The type assigned to this saved highlight.", items: (row) => passages(row).flatMap((item) => item.labelIds.map((labelId) =>
        ({ kind: "label", labelId, sourceId: row.sourceId, evidenceId: item.receipt.evidence_id, display: "path" }))) });
  fields.push({ id: "note", name: "Notes", kind: "note", format: "text", primary: true, prompt: "Existing research notes for this row.",
    items: (row) => input.rows === "passages" ? passages(row).filter(({ note }) => note.trim()).map(({ receipt }) =>
      ({ kind: "note", sourceId: row.sourceId, evidenceId: receipt.evidence_id })) :
      file.state.sources[row.sourceId].note.trim() ? [{ kind: "note", sourceId: row.sourceId }] : [] });
  const findings = new Map(chats.flatMap(({ findings }) => findings).map((finding) => [key(finding.reference), finding]));
  const questions = new Map<string, ResearchFinding[]>();
  for (const finding of findings.values()) {
    const id = questionKey(finding), values = questions.get(id) ?? []; values.push(finding); questions.set(id, values);
  }
  for (const [id, values] of questions) {
    const question = values[0].question;
    fields.push({ id: `question:${id}`, name: clip(question.title), prompt: question.prompt, kind: "finding", primary: true,
      format: question.format ?? "text", tags: question.tags, items: (row) => {
        const seen = new Set<string>();
        return values.filter((finding) => {
          if (finding.sourceId !== row.sourceId || row.evidenceIds &&
            !finding.evidence.some(({ evidence_id }) => row.evidenceIds!.includes(evidence_id))) return false;
          const identity = JSON.stringify([finding.answer, finding.evidence.map(({ evidence_id }) => evidence_id).sort()]);
          if (seen.has(identity)) return false; seen.add(identity); return true;
        }).map(({ reference }) => reference);
      } });
  }
  // Optional semantic design can split a multi-issue answer by its original claims.
  // Default imports still group whole findings by question, not one column per claim.
  for (const finding of [...findings.values()]) finding.answer.claims.forEach((claim, index) => {
    const reference = { ...finding.reference, claimIndices: [finding.reference.claimIndices?.[index] ?? index] };
    const selected = selectFindingClaims(finding, reference);
    findings.set(key(reference), selected);
    fields.push({ id: `claim:${sha256(key(reference)).slice(0, 24)}`, name: clip(claim.text),
      prompt: finding.question.prompt, kind: "claim", format: "text", primary: false,
      items: (row) => row.sourceId === finding.sourceId && (!row.evidenceIds ||
        claim.evidence_ids.some((id) => row.evidenceIds!.includes(id))) ? [reference] : [] });
  });
  const text = (item: Item): string => {
    if (item.kind === "answer" || item.kind === "cell") {
      const found = findings.get(key(item))!;
      return found.answer.summary ?? found.answer.claims.map(({ text }) => text).join("\n");
    }
    const passage = item.evidenceId ? parts.get(item.sourceId)?.[item.evidenceId] : undefined;
    return item.kind === "label" ? researchLabelPath(file.state, item.labelId) : item.kind === "note"
      ? (passage ?? file.state.sources[item.sourceId]).note : passage?.receipt.span_text ?? "";
  };
  const available = fields.map((field) => ({ field, mapped: new Map(rows.map((row) => [row.id, field.items(row)])) }))
    .filter(({ mapped }) => [...mapped.values()].some((items) => items.length));
  if (available.length > 500) exceeds("Too many reusable research fields");
  const catalog: ResearchImportField[] = available.map(({ field: { primary: _primary, items: _items, ...field }, mapped }) => ({
    ...field, rows: [...mapped.values()].filter((items) => items.length).length,
    samples: [...new Set([...mapped.values()].flat().map((item) => clip(text(item), 160)))].slice(0, 3),
  }));
  const columns = input.columns ?? available.filter(({ field }) => field.primary).map(({ field }, index) => ({
    index, name: field.name, prompt: field.prompt, format: field.format, tags: field.tags, fieldIds: [field.id],
  }));
  if (columns.length > 100) exceeds("A review can contain at most 100 columns");
  const uniqueColumns = new Set(columns.map(({ index }) => index));
  if (uniqueColumns.size !== columns.length) throw new ApplicationError(400, "Column indices must be unique");
  const cells: ResearchArrangement["cells"] = [];
  const reuse = columns.map((column) => {
    if (new Set(column.fieldIds).size !== column.fieldIds.length || column.fieldIds.some((id) => !catalog.some((field) => field.id === id)))
      throw new ApplicationError(400, "A mapped research field is unavailable; refresh the preview");
    const mappedFields = catalog.filter(({ id }) => column.fieldIds.includes(id)), format = column.format ?? "text";
    const typed = format !== "text" && format !== "bulleted_list";
    if (typed && mappedFields.length && (mappedFields.length !== 1 || mappedFields[0].kind !== "finding" ||
        (mappedFields[0].format ?? "text") !== format || JSON.stringify(mappedFields[0].tags ?? []) !== JSON.stringify(column.tags ?? [])))
      throw new ApplicationError(400, "Reuse classifications and excerpts as text. A typed result needs one finding with the same format.");
    let reused = 0;
    for (const row of rows) {
      const items = [...new Map(available.filter(({ field }) => column.fieldIds.includes(field.id))
        .flatMap(({ mapped }) => mapped.get(row.id)!).map((item) => [key(item), item])).values()];
      if (typed && items.length > 1) throw new ApplicationError(400, "Conflicting typed findings cannot become one value. Use text to compare them or run a new question.");
      if (items.length > 500) exceeds("Too many passages in one cell");
      if (items.length) { cells.push({ rowId: row.id, columnIndex: column.index, items }); reused++; }
    }
    return { index: column.index, reused, unrun: rows.length - reused,
      kinds: [...new Set(catalog.filter(({ id }) => column.fieldIds.includes(id)).map(({ kind }) => kind))] };
  });
  return { columns_config: columns.map(({ fieldIds: _ids, ...column }) => column), columns, fields: catalog, reuse,
    arrangement: { rows, cells }, preview: rows.slice(0, 3).map((row) => ({ title: row.title,
      values: columns.map((column) => clip((cells.find((cell) => cell.rowId === row.id && cell.columnIndex === column.index)?.items ?? [])
        .map(text).join("\n\n"), 300)) })) };
}
