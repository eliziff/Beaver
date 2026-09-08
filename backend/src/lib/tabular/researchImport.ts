import { z } from "zod";
import { ApplicationError } from "../applicationError";
import { sha256 } from "../hash";
import { researchLabelPath, researchSourceResource, type ResearchEvidence, type ResearchFile } from "../researchFile";
import { legalEvidenceResourceReference } from "../chat/legalEvidence";
import type { ResearchFinding } from "../researchChat";
import { researchSelectionLabels, type ResearchSubject } from "../researchSelection";
import type { TabularColumn } from "../tabularStore";
import type { ResearchArrangement } from "./researchArrangement";

export type ResearchImportInput = { rows: "sources" | "passages"; labelId?: string };
type Item = ResearchArrangement["cells"][number]["items"][number];
type Kind = "classification" | "passages" | "note" | "answer";
type Entry = { id: string; rowId: string; reference: Item; kind: Kind; text: string;
  column: TabularColumn; evidenceIds: string[]; default: boolean };
export type ResearchImportCatalog = { title: string; question: string | null; fingerprint: string;
  columns?: Array<TabularColumn & { scope: "source" | "highlight" }>;
  labels: { id: string; path: string; scope: "source" | "highlight"; definition?: string }[];
  rows: ResearchArrangement["rows"]; entries: Entry[] };
const id = z.string().min(1).max(200);
export const researchImportDesignSchema = z.object({
  title: z.string().trim().min(1).max(300),
  columns: z.array(z.object({ index: z.number().int().min(0).max(10_000),
    name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(20_000),
    format: z.enum(["text", "bulleted_list", "number", "currency", "yes_no", "date", "tag", "percentage", "monetary_amount"]).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  }).strict()).min(1).max(100),
  cells: z.array(z.object({ rowId: id, columnIndex: z.number().int().min(0).max(10_000),
    itemIds: z.array(id).min(1).max(500) }).strict()).max(50_000),
}).strict();
export type ResearchImportDesign = z.infer<typeof researchImportDesignSchema>;
const clip = (value: string, max = 200) => value.replace(/\s+/gu, " ").trim().slice(0, max);
const key = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 24);

export function researchImportCatalog(file: ResearchFile, subjects: ResearchSubject[],
  parts: Map<string, Record<string, ResearchEvidence>>, findings: ResearchFinding[], input: ResearchImportInput): ResearchImportCatalog {
  if (input.labelId && file.state.labels[input.labelId]?.scope !== "highlight")
    throw new ApplicationError(400, "Choose a highlight type");
  const types = input.labelId ? researchSelectionLabels(file.state, [input.labelId]) : null;
  const allowed = new Map<string, Set<string> | null>();
  for (const subject of subjects) {
    if (!subject.evidence || allowed.get(subject.sourceId) === null) allowed.set(subject.sourceId, null);
    else allowed.set(subject.sourceId, new Set([...(allowed.get(subject.sourceId) ?? []), ...subject.evidence.map(({ evidence_id }) => evidence_id)]));
  }
  const rows: ResearchArrangement["rows"] = [], entries: Entry[] = [];
  const questions = [...new Set(findings.filter(({ reference }) => reference.kind === "answer").map(({ question }) => question.prompt))];
  const add = (rowId: string, reference: Item, kind: Kind, text: string,
    column: Omit<TabularColumn, "index">, evidenceIds: string[] = [], use = true) => {
    entries.push({ id: `item${entries.length}`, rowId, reference, kind, text,
      column: { ...column, index: 0 }, evidenceIds, default: use });
  };
  for (const [sourceId, permitted] of allowed) {
    const source = file.state.sources[sourceId];
    if (!source) throw new ApplicationError(409, "A selected source is unavailable");
    const saved = Object.values(parts.get(sourceId) ?? {}).filter(({ receipt, labelIds }) =>
      labelIds.length && (!types || labelIds.some((id) => types.has(id))) && (!permitted || permitted.has(receipt.evidence_id)));
    if (types && !saved.length) continue;
    const selected = input.rows === "passages" ? [...new Set(saved.map(({ receipt }) => receipt.evidence_id))].map((id) => [id])
      : [permitted ? [...permitted] : undefined];
    for (const evidenceIds of selected) {
      const rowId = input.rows === "sources" ? sourceId : `${sourceId}:${evidenceIds![0]}`,
        rowPassages = evidenceIds ? saved.filter(({ receipt }) => evidenceIds.includes(receipt.evidence_id)) : saved,
        title = clip(source.reference.title || source.reference.citation || sourceId, 300);
      rows.push({ id: rowId, sourceId, title: input.rows === "passages"
        ? `${title} · ${clip(rowPassages[0].receipt.locator.label, 180)}` : title,
        ...(evidenceIds ? { evidenceIds } : {}) });
      for (const labelId of source.labelIds) {
        const label = file.state.labels[labelId];
        if (label?.scope !== "source") continue;
        add(rowId, { kind: "label", sourceId, labelId, display: "path" }, "classification",
          researchLabelPath(file.state, labelId),
          { name: researchLabelPath(file.state, labelId), prompt: label.definition || `What does this source establish about ${label.name}?`, format: "text" });
      }
      if (source.note && input.rows === "sources") add(rowId, { kind: "note", sourceId }, "note", source.note,
        { name: "Research note", prompt: "The note retained for this source.", format: "text" });
      for (const passage of rowPassages) {
        const path = researchLabelPath(file.state, passage.labelIds[0]);
        add(rowId, { kind: "passage", sourceId, evidenceId: passage.highlightId ?? passage.receipt.evidence_id }, "passages",
          passage.receipt.span_text ?? "", { name: path,
            prompt: file.state.labels[passage.labelIds[0]].definition || `What does this source establish about ${path}?`, format: "text" },
          [passage.receipt.evidence_id]);
        if (input.rows === "passages" && passage.note) add(rowId, { kind: "note", sourceId,
          evidenceId: passage.highlightId ?? passage.receipt.evidence_id }, "note", passage.note,
          { name: "Research note", prompt: "The note retained for this passage.", format: "text" });
      }
      for (const finding of findings.filter((value) => value.sourceId === sourceId || value.reference.kind === "cell" &&
        value.evidence.some((receipt) => legalEvidenceResourceReference(receipt) === researchSourceResource(source.reference)))) {
        const owned = new Set(finding.evidence.filter((receipt) => legalEvidenceResourceReference(receipt) === researchSourceResource(source.reference)).map(({ evidence_id }) => evidence_id));
        const relevant = finding.answer.claims.map((claim, index) => ({ claim, index })).filter(({ claim }) =>
          !evidenceIds || claim.evidence_ids.some((id) => owned.has(id)) && claim.evidence_ids.filter((id) => owned.has(id)).every((id) => evidenceIds.includes(id)));
        if (evidenceIds && !relevant.length) continue;
        const question = { name: finding.reference.kind === "answer" ? "Finding" : clip(finding.question.title, 60) || "Finding", prompt: finding.question.prompt || "Recorded finding",
          format: finding.question.format ?? "text", ...(finding.question.tags ? { tags: finding.question.tags } : {}) };
        const complete = relevant.length === finding.answer.claims.length;
        if (complete) add(rowId, finding.reference, "answer", finding.answer.summary ?? (finding.answer.value == null ? finding.answer.claims.map(({ text }) => text).join("\n\n") :
          Array.isArray(finding.answer.value) ? finding.answer.value.join("\n") : String(finding.answer.value)), question,
          [...new Set(finding.answer.claims.flatMap(({ evidence_ids }) => evidence_ids.filter((id) => owned.has(id))))]);
        // A semantic layout may put separate claims from one Chat answer in different columns.
        if (finding.reference.kind === "answer" && (!complete || finding.answer.claims.length > 1)) for (const { claim, index } of relevant)
          add(rowId, { ...finding.reference, claimIndices: [finding.reference.claimIndices?.[index] ?? index] }, "answer", claim.text, question,
            claim.evidence_ids.filter((id) => owned.has(id)), !complete);
      }
    }
  }
  if (rows.length > 500 || entries.length > 25_000)
    throw new ApplicationError(413, "Narrow this research selection before converting it; no rows were dropped");
  const title = clip((file.document.filename ?? "Research").replace(/\.research\.md$/iu, ""), 300) || "Research";
  return { title, question: questions[0] ?? null, rows, entries,
    labels: Object.values(file.state.labels).map(({ id, scope, definition }) => ({ id, path: researchLabelPath(file.state, id), scope,
      ...(definition ? { definition } : {}) })),
    fingerprint: sha256(JSON.stringify([file.document.id, file.versionId, file.workingRevision, subjects, rows, entries, findings])) };
}

export function defaultResearchImport(catalog: ResearchImportCatalog): ResearchImportDesign {
  const columns = new Map<string, TabularColumn>(), cells = new Map<string, ResearchImportDesign["cells"][number]>();
  for (const label of catalog.labels) if (!columns.has(label.path)) columns.set(label.path,
    { index: columns.size, name: label.path, prompt: label.definition || `What does this source establish about ${label.path}?`, format: "text" });
  const structured = columns.size > 0;
  if (!structured) columns.set("Finding", { index: 0, name: "Finding", format: "text",
    prompt: catalog.question || "What does this source establish about the research question?" });
  for (const entry of catalog.entries.filter((entry) => entry.default && entry.kind !== "classification")) {
    const column = columns.get(structured ? entry.column.name : "Finding");
    if (!column) continue;
    const columnIndex = column.index, cellKey = `${entry.rowId}:${columnIndex}`,
      cell = cells.get(cellKey) ?? { rowId: entry.rowId, columnIndex, itemIds: [] };
    cell.itemIds.push(entry.id); cells.set(cellKey, cell);
  }
  if (columns.size > 100) throw new ApplicationError(413, "This selection needs more than 100 columns; narrow it before converting");
  return researchImportDesignSchema.parse({ title: catalog.title, columns: [...columns.values()], cells: [...cells.values()] });
}

/** Resolve reviewed mappings against the current inventory. Unknown or cross-row references fail closed. */
export function researchImportPlan(catalog: ResearchImportCatalog, value: ResearchImportDesign) {
  const design = researchImportDesignSchema.parse(value), byId = new Map(catalog.entries.map((item) => [item.id, item])),
    rowIds = new Set(catalog.rows.map(({ id }) => id)), columnIds = new Set(design.columns.map(({ index }) => index)),
    seen = new Set<string>();
  if (columnIds.size !== design.columns.length) throw new ApplicationError(400, "Column indices must be unique");
  const stats = design.columns.map((column) => ({ index: column.index, reused: 0,
    kinds: [] as Kind[], evidence: 0 }));
  const samples: Array<{ rowId: string; columnIndex: number; text: string; kinds: Kind[] }> = [];
  const cells = design.cells.map((cell) => {
    const cellKey = `${cell.rowId}:${cell.columnIndex}`;
    if (!rowIds.has(cell.rowId) || !columnIds.has(cell.columnIndex) || seen.has(cellKey))
      throw new ApplicationError(400, "Each mapping must identify one selected row and column");
    seen.add(cellKey);
    const items = [...new Set(cell.itemIds)].map((id) => {
      const entry = byId.get(id);
      if (!entry || entry.rowId !== cell.rowId) throw new ApplicationError(400, "A mapping refers to work outside this row's selection");
      return entry;
    });
    const column = design.columns.find(({ index }) => index === cell.columnIndex)!, format = column.format ?? "text";
    if (format !== "text" && format !== "bulleted_list" && (items.length !== 1 || items[0].kind !== "answer" ||
        items[0].reference.kind === "answer" && items[0].reference.claimIndices ||
        (items[0].column.format ?? "text") !== format ||
        JSON.stringify(column.tags ?? []) !== JSON.stringify(items[0].column.tags ?? [])))
      throw new ApplicationError(400, "Only a compatible existing answer can populate a typed value; keep excerpts as text");
    const claimSelections = new Map<string, Set<number> | null>();
    for (const { reference } of items) if (reference.kind === "answer") {
      const id = key([reference.chatId, reference.answerId, reference.resource]);
      if (claimSelections.has(id)) {
        const previous = claimSelections.get(id);
        if (!previous || !reference.claimIndices || reference.claimIndices.some((index) => previous.has(index)))
          throw new ApplicationError(400, "This mapping repeats overlapping Chat claims");
        reference.claimIndices.forEach((index) => previous.add(index));
      } else claimSelections.set(id, reference.claimIndices ? new Set(reference.claimIndices) : null);
    }
    const stat = stats.find(({ index }) => index === cell.columnIndex)!;
    stat.reused++; stat.kinds = [...new Set([...stat.kinds, ...items.map(({ kind }) => kind)])];
    stat.evidence += new Set(items.flatMap(({ evidenceIds }) => evidenceIds)).size;
    if (catalog.rows.slice(0, 3).some(({ id }) => id === cell.rowId)) samples.push({ rowId: cell.rowId,
      columnIndex: cell.columnIndex, text: clip(items.map(({ text }) => text).join("\n\n"), 300), kinds: [...new Set(items.map(({ kind }) => kind))] });
    return { rowId: cell.rowId, columnIndex: cell.columnIndex, items: items.map(({ reference }) => reference) };
  });
  return { design, fingerprint: catalog.fingerprint, rows: catalog.rows, stats, samples,
    columns_config: design.columns as TabularColumn[], arrangement: { rows: catalog.rows, cells } };
}
