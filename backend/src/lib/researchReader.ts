import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentStore } from "./documentStore";
import { documentProjectionService } from "./documentProjectionService";
import { parseResourceReference, resourceReference } from "./resourceReferences";
import { provenBlockLocator } from "./documentLocators";
import { structureNative, type NativeDocument, type NativeDocumentBlock } from "./structureNative";
import { legalSourceOperations } from "./legalSourceApplication";
import type { LegalSourcePassage, LegalSourceReference } from "./legalSources";
import type { A2AJCompiledDocument } from "./legalSources/a2aj";
import { pageResearchItems, researchHighlightCount, researchSourceFromResource, researchSourceResource, researchSourceReferenceSchema,
  type ResearchFile, type ResearchEvidence, type ResearchQueryReceipt } from "./researchFile";
import { createA2AJPassageEvidence, createLibraryEvidence, legalSourceEvidence,
  legalEvidenceSourceReference, legalEvidenceResourceReference, restorePriorLegalEvidence, storedLegalEvidenceReceipt,
  createLegalEvidenceTurnState, registerLegalEvidence, registerLegalResearchQueries, legalEvidenceReceiptEvent,
  type LegalEvidenceReceipt, type LegalEvidenceSpan, type RegisteredEvidence,
  type LegalEvidenceTurnState } from "./chat/legalEvidence";
import { createLegalSourceSearchCitations } from "./chat/citations";
import { findTextMatches } from "./chat/tools/documentOps";
import type { A2AJReferenceDirection } from "./chat/tools/a2ajTools";
import type { ReadSubagentAssignment, LegalEvidenceReceiptEvent } from "./chat/assistantEvents";
import type { NormalizedToolCall } from "./llm";
import { toolText, withoutUrls, type BeaverOutcome } from "./chat/toolRegistry";
import { jsonRecord as objectRecord, trimmedText as trimmed } from "./value";
import { utf16PrefixCeil } from "./text";
import type { ResearchChange } from "./researchHistory";
import type { ResearchSubject } from "./researchSelection";
import type { ResearchOperationContext } from "./researchProvenance";

import { researchFindingReferenceSchema } from "./researchFindingReference";

const result = (value: unknown): BeaverOutcome => ({ result: toolText(value, objectRecord(value)?.ok === false) });
const fail = (error: string) => result({ ok: false, error });

const readCursor = z.object({ resource: z.string().min(1).max(4_000), offset: z.number().int().min(1),
  start_char: z.number().int().nonnegative().optional() }).strict();
const readProgress = z.object({ next: z.array(readCursor), fingerprints: z.record(z.string()) }).strict();
export const researchReadContextSchema = z.object({
  workspace: z.object({ documentId: z.string(), versionId: z.string(),
    workingRevision: z.number().int().nonnegative() }).strict().optional(),
  restricted: z.boolean().optional(),
  findingRefs: z.array(researchFindingReferenceSchema).max(500).optional(),
  subjects: z.array(z.object({ sourceId: z.string(), resource: z.string().min(1).max(4_000),
    rowId: z.string().optional(), reference: researchSourceReferenceSchema,
    evidence: z.array(z.custom<LegalEvidenceReceipt>((value) => storedLegalEvidenceReceipt(value) !== null)).optional(),
    sourceSha256: z.string().optional(), sourceSha256s: z.array(z.string()).optional(),
  }).strict()).optional(),
  reads: z.record(readProgress).optional(),
}).strict();
export type ResearchReadContext = z.infer<typeof researchReadContextSchema>;
export type ResearchReadCursor = z.infer<typeof readCursor>;
type ResearchResultScope = { resource: string; evidence?: readonly LegalEvidenceReceipt[] };
export function researchResultFilter(context: ResearchReadContext | undefined) {
  const subjects = context?.subjects ?? [], resources = new Set(subjects.map(({ resource }) => resource)),
    wholeSources = new Set(subjects.filter(({ evidence }) => evidence === undefined).map(({ resource }) => resource)),
    passages = new Set(subjects.flatMap(({ evidence }) => evidence?.map(({ evidence_id }) => evidence_id) ?? []));
  return ({ resource, evidence }: ResearchResultScope) => !context?.restricted ||
    (evidence === undefined ? resources : wholeSources).has(resource) ||
    !!evidence?.some((receipt) => passages.has(receipt.evidence_id) || wholeSources.has(legalEvidenceResourceReference(receipt) ?? ""));
}
export type ResearchObserver = (event: LegalEvidenceReceiptEvent, operation: ResearchOperationContext) => void | Promise<void>;
export function researchReadReceipt(outcome: Pick<BeaverOutcome, "evidence" | "queryReceipts">, model: string) {
  const observed = createLegalEvidenceTurnState();
  outcome.evidence?.forEach((receipt) => registerLegalEvidence(observed, receipt));
  registerLegalResearchQueries(observed, outcome.queryReceipts ?? [], model);
  return legalEvidenceReceiptEvent(observed);
}

const progress = (context: ResearchReadContext, resource: string) =>
  (context.reads ??= {})[resource] ??= { next: [{ resource, offset: 1, start_char: 0 }], fingerprints: {} };
export function researchReadCursors(context: ResearchReadContext) {
  if (context.restricted) context.subjects?.forEach(({ resource }) => progress(context, resource));
  return Object.values(context.reads ?? {}).flatMap(({ next }) => next);
}
export function researchReadContextPrompt(context: ResearchReadContext | undefined) {
  if (!context) return "";
  return [context.findingRefs ? `SELECTED RESEARCH RESULTS: ${JSON.stringify(context.findingRefs)}. Read findings or read_table_cells for the original answers and their support.` : "",
  context.workspace ? `CURRENT RESEARCH WORKSPACE: ${resourceReference.document(
    context.workspace.documentId, context.workspace.versionId)}` : "",
  context.subjects ? `${context.subjects.length} ${context.restricted ? "selected" : "saved"} source scopes:\n` +
    context.subjects.slice(0, 5).map(({ resource, evidence }) => resource +
      (evidence ? ` (${evidence.length} selected passages)` : "")).join("\n") +
    (context.subjects.length > 5 ? "\nRead selection to page the complete scoped inventory and remaining reads." : "") : ""].filter(Boolean).join("\n");
}
export function readResearchContextInventory(context: ResearchReadContext, args: { offset?: number; limit?: number }) {
  const offset = Math.max(0, (args.offset ?? 1) - 1), limit = Math.max(1, Math.min(50, args.limit ?? 20)),
    subjects = context.subjects ?? [], selected = subjects.slice(offset, offset + limit);
  return result({ workspace: context.workspace, restricted: !!context.restricted, total: subjects.length,
    items: selected.map(({ sourceId, resource, reference, evidence }) => ({ sourceId, resource,
      title: reference.title ?? reference.citation, ...(evidence ? { passage_count: evidence.length } : {}),
      next_reads: context.reads?.[resource]?.next ?? [{ resource, offset: 1, start_char: 0 }] })),
    next_offset: offset + selected.length < subjects.length ? offset + selected.length + 1 : null });
}

/** Child assignments narrow the resolved scope; they cannot add another source or passage. */
export function childResearchReadContext(context: ResearchReadContext | undefined,
  assignment: Pick<ReadSubagentAssignment, "resources" | "evidence_ids">,
  available: LegalEvidenceReceipt[]): ResearchReadContext | undefined {
  if (!assignment.resources && !assignment.evidence_ids) return context && structuredClone(context);
  if (!context?.subjects) throw new ApplicationError(400, "Select workspace sources before narrowing a reader assignment");
  const resources = assignment.resources && new Set(assignment.resources), ids = assignment.evidence_ids && new Set(assignment.evidence_ids),
    found = new Set<string>(), subjects: ResearchSubject[] = [];
  if (resources && [...resources].some((resource) => !context.subjects!.some((subject) => subject.resource === resource)))
    throw new ApplicationError(400, "Reader source is outside the selected workspace scope");
  for (const subject of context.subjects) {
    if (resources && !resources.has(subject.resource)) continue;
    const evidence = ids ? (subject.evidence ?? available).filter((receipt) => ids.has(receipt.evidence_id) &&
      legalEvidenceResourceReference(receipt) === subject.resource) : subject.evidence;
    evidence?.forEach(({ evidence_id }) => found.add(evidence_id));
    if (ids && !evidence?.length) continue;
    subjects.push({ ...subject, ...(evidence ? { evidence } : {}) });
  }
  if (ids && [...ids].some((id) => !found.has(id)))
    throw new ApplicationError(400, "Reader passage is outside the selected workspace scope");
  return { workspace: context.workspace, restricted: true, subjects };
}

/** The same source checks, frozen passage scope, fingerprints and continuations serve every reader. */
export async function readResearchContext(documents: DocumentStore, scope: ApplicationScope,
  context: ResearchReadContext, input: Parameters<typeof readResearchResource>[2] & { remainingOnly?: boolean }): Promise<ResearchRead> {
  const direct = context.subjects?.filter(({ resource }) => resource === input.resource) ?? [],
    parent = direct.length ? input.resource : Object.entries(context.reads ?? {}).find(([, state]) =>
      state.next.some(({ resource }) => resource === input.resource))?.[0],
    subjects = direct.length ? direct : context.subjects?.filter(({ resource }) => resource === parent) ?? [];
  if (context.restricted && !subjects.length) throw new ApplicationError(400, "Source is outside the selected research scope");
  const state = progress(context, parent ?? input.resource), offset = input.offset ?? 1, start = input.start_char ?? 0,
    cursor = state.next.findIndex((item) => item.resource === input.resource && item.offset === offset && (item.start_char ?? 0) === start);
  if (input.remainingOnly && cursor < 0) throw new ApplicationError(400, "Read one of the remaining source pages");
  const evidence = subjects.length && subjects.every((subject) => subject.evidence !== undefined)
    ? [...new Map(subjects.flatMap((subject) => subject.evidence!).map((receipt) => [receipt.evidence_id, receipt])).values()] : input.evidence,
    output = await readResearchResource(documents, scope, { ...input, evidence,
      expectedSourceSha256: subjects[0]?.sourceSha256 ?? input.expectedSourceSha256 }),
    fingerprints = { ...state.fingerprints };
  for (const receipt of output.evidence ?? []) {
    if (subjects.some((subject) => subject.sourceSha256s?.length && !subject.sourceSha256s.includes(receipt.source_sha256)))
      throw new ApplicationError(409, "Source changed since this research scope was selected");
    const key = legalEvidenceResourceReference(receipt) ?? `${receipt.provider}:${receipt.stable_source_id}`;
    if (fingerprints[key] && fingerprints[key] !== receipt.source_sha256)
      throw new ApplicationError(409, "Source changed during reading; start the selection again");
    fingerprints[key] = receipt.source_sha256;
  }
  state.fingerprints = fingerprints;
  if (!output.result.isError && (output.coverage.complete || output.coverage.next.length)) {
    if (cursor >= 0) state.next.splice(cursor, 1);
    for (const item of output.coverage.next) if (!state.next.some((pending) => pending.resource === item.resource &&
      pending.offset === item.offset && (pending.start_char ?? 0) === (item.start_char ?? 0))) state.next.push(item);
  }
  return { ...output, coverage: { complete: state.next.length === 0, next: state.next },
    result: { ...output.result, content: [...output.result.content,
      { type: "text", text: JSON.stringify({ next_reads: state.next }) }] } };
}

/** Page the document's existing parts without materializing its entire evidence inventory. */
export async function readResearchWorkspace(documents: DocumentStore, scope: ApplicationScope,
  saved: ResearchFile, args: Record<string, unknown>, signal: AbortSignal, state?: LegalEvidenceTurnState,
  context?: ResearchReadContext) {
  const chunk = 6000, labels = Object.values(saved.state.labels).sort((a, b) => a.order - b.order),
    sources = Object.values(saved.state.sources).filter((source) => source.collected), counts = [Math.ceil(saved.state.note.length / chunk),
      labels.length, sources.length, saved.state.queries?.count ?? 0,
      sources.reduce((sum, source) => sum + researchHighlightCount(source), 0), saved.state.history?.count ?? 0],
    names = ["notes", "labels", "sources", "searches", "passages", "history"],
    kinds = ["note", "label", "source", "search", "passage", "change"],
    offset = Math.max(0, Math.trunc(Number(args.offset) || 1) - 1),
    limit = Math.max(1, Math.min(20, Math.trunc(Number(args.limit) || 20))),
    queries = new Map<number, ResearchQueryReceipt>(), passages = new Map<number, ResearchEvidence>(),
    changes = new Map<number, ResearchChange>(),
    header = { document_id: saved.document.id, filename: saved.document.filename,
      resource: resourceReference.document(saved.document.id, saved.versionId) };
  const rows = async (category: number, start: number, count: number): Promise<Record<string, unknown>[]> => {
    if (category >= 3) for (const item of (await pageResearchItems(documents, scope, saved,
      category === 3 ? "queries" : category === 4 ? "passages" : "history", start, count)).items) {
      if (item.kind === "query") queries.set(item.index, item.value);
      else if (item.kind === "passage") passages.set(item.index, item.value);
      else if (item.kind === "change") changes.set(item.index, item.value);
    }
    return Array.from({ length: count }, (_, position) => {
      const index = start + position, kind = kinds[category];
      if (category === 0) return { kind, markdown: saved.state.note.slice(index * chunk, (index + 1) * chunk) };
      if (category === 1) return { kind, ...labels[index] };
      if (category === 5) return { kind, change_index: index + 1, ...changes.get(index) };
      if (category === 2) { const source = sources[index]; return { kind, source_index: index + 1,
        sourceId: source.id, resource: researchSourceResource(source.reference), reference: source.reference,
        labelIds: source.labelIds, note: source.note }; }
      if (category === 3) { const query = queries.get(index)!; return { kind, search_index: index + 1,
        query_id: query.query_id, executed_at: query.executed_at, tool: query.tool, input: query.input,
        results: query.results, [query.tool === "search_sources" ? "result_source_ids" : "attempted_source_ids"]: query.sourceIds,
        source_references: query.sourceReferences ?? {}, label_paths: query.labelPaths ?? {},
        matched_source_ids: query.matchedSourceIds, evidence_ids: query.evidenceIds, slots: query.slots,
        failures: query.failures, sources: query.sourceIds.length || query.results.length,
        matches: query.evidenceIds.length || query.results.length, truncated: false }; }
      const { receipt, sourceId, labelIds, note } = passages.get(index)!;
      return { kind, passage_index: index + 1, sourceId, evidence_id: receipt.evidence_id,
        citation: receipt.citation, locator: receipt.locator, exact_passage: receipt.span_text, labelIds, note };
    });
  };
  const register = async (items: Record<string, unknown>[]) => {
    const inScope = researchResultFilter(context);
    items = items.filter((item) => {
      // A narrow reading scope must not leak other passages through memo, query or undo payloads.
      if (context?.restricted && ["note", "search", "change"].includes(String(item.kind))) return false;
      if (item.kind === "source") return inScope({ resource: String(item.resource) });
      if (item.kind !== "passage") return true;
      const receipt = passages.get(Number(item.passage_index) - 1)!.receipt;
      return inScope({ resource: legalEvidenceResourceReference(receipt) ?? "", evidence: [receipt] }); });
    for (const item of items) if (item.kind === "search") {
      const query = queries.get(Number(item.search_index) - 1)!;
      state?.queries.set(query.query_id, query); state?.priorQueryIds.add(query.query_id);
    }
    const restored = await restoreResearchEvidence(documents, scope, items.flatMap((item) =>
      item.kind === "passage" ? [passages.get(Number(item.passage_index) - 1)!.receipt] : []), signal),
      verified = new Set(restored.map(({ receipt }) => receipt.evidence_id));
    return { items: items.map((item) => { if (item.kind !== "passage" || verified.has(String(item.evidence_id))) return item;
      const { exact_passage: _text, ...summary } = item; return { ...summary, kind: "unavailable_passage" }; }),
      evidence: restored.map(({ receipt }) => receipt),
      evidenceSources: new Map(restored.map(({ receipt, ...source }) => [receipt.evidence_id, source])) };
  };
  const section = /^(search|source|passage|change):(\d+)$/u.exec(trimmed(args.section));
  if (args.section && !section) return fail("Research section not found");
  if (section) {
    const category = kinds.indexOf(section[1]), index = Number(section[2]) - 1;
    if (index < 0 || index >= counts[category]) return fail("Research section not found");
    const { items: safe, ...evidence } = await register(await rows(category, index, 1));
    if (!safe.length) return fail("Research passage is outside the current selection");
    const json = JSON.stringify(withoutUrls(safe[0])), total = Math.ceil(json.length / chunk),
      count = Math.min(3, limit, Math.max(0, total - offset)),
      items = Array.from({ length: count }, (_, index) => ({ kind: "search_continuation", section: section[0],
        field: "receipt", encoding: "json", offset: (offset + index) * chunk + 1,
        json: json.slice((offset + index) * chunk, (offset + index + 1) * chunk) }));
    return { ...result({ ...header, section: section[0], offset: offset + 1, total,
      next_offset: offset + count < total ? offset + count + 1 : null, items }), ...evidence };
  }
  const page: Record<string, unknown>[] = [], categories: Record<string, { count: number; start: number }> = {};
  let start = 0;
  for (let category = 0; category < counts.length; category++) {
    const count = counts[category], from = Math.max(0, offset - start),
      take = Math.max(0, Math.min(count - from, offset + limit - start - from));
    categories[names[category]] = { count, start: start + 1 }; start += count;
    if (take) for (const item of await rows(category, from, take)) {
      if (category < 2 || JSON.stringify(item).length <= 30_000) { page.push(item); continue; }
      const kind = String(item.kind), indexKey = `${kind}_index`, reference = objectRecord(item.reference),
        text = String(objectRecord(item.input)?.pattern ?? objectRecord(item.input)?.query ?? ""),
        name = String(reference?.title || reference?.citation || reference?.id || ""),
        summary: Record<string, unknown> = { kind, [indexKey]: item[indexKey],
          section: `${kind}:${item[indexKey]}`, continued: true, truncated: true };
      for (const key of ["sourceId", "evidence_id", "query_id", "citation", "tool", "sources", "matches"])
        if (item[key] !== undefined && String(item[key]).length <= (key === "citation" ? 500 : 200)) summary[key] = item[key];
      if (kind === "search") Object.assign(summary, text.length <= 500 ? { text } : { text_chars: text.length });
      else if (kind === "change") Object.assign(summary, { id: item.id, title: item.title, status: item.status,
        executor: item.executor, createdAt: item.createdAt, counts: item.counts });
      else Object.assign(summary, { labels: (item.labelIds as string[]).length, note_chars: String(item.note).length },
        kind === "source" ? name.length <= 500 ? { name } : {} : { passage_chars: String(item.exact_passage ?? "").length });
      page.push(summary);
    }
  }
  while (page.length > 1 && JSON.stringify(page).length > 40_000) page.pop();
  const { items, ...evidence } = await register(page);
  return { ...result({ ...header, offset: offset + 1, total: start, categories,
    views: { tables: saved.state.tables ?? [], chats: saved.state.chats ?? [] },
    proposals: saved.state.proposals ?? [],
    next_offset: offset + page.length < start ? offset + page.length + 1 : null, items }), ...evidence };
}

export type ResearchRead = BeaverOutcome & { coverage: {
  complete: boolean; next: { resource: string; offset: number; start_char?: number }[] } };

const boundedRow = (row: ReturnType<ReturnType<typeof structureNative>["readDocumentTextWindow"]>["rows"][number]) => {
  const text = JSON.stringify(row.text).length > 28_000 ? utf16PrefixCeil(row.text, 4_000) : row.text;
  return { ...row, text, span: [row.span[0], row.span[0] + text.length] as [number, number],
    truncatedEnd: row.truncatedEnd || text.length < row.text.length };
};

/** The addressable range of a source, so a pinpoint read need not be guessed. */
function sourceExtent(artifact: NativeDocument) {
  const anchors = structureNative().documentAnchors(artifact);
  for (const kind of ["paragraph", "section", "page"] as const) {
    const labels = anchors.flatMap((anchor) => anchor.kind === kind ? [anchor.label] : []);
    if (labels.length) return { locator_kind: kind, first: labels[0], last: labels[labels.length - 1],
      count: labels.length };
  }
  return null;
}

/** The same native window and receipt identities serve chat and extraction. */
export function readLibraryResearchWindow(input: { documentId: string; versionId: string;
  filename: string; document: NativeDocument; offset?: number; start_char?: number; limit?: number }): ResearchRead {
  const native = structureNative(), offset = input.offset ?? 1,
    window = native.readDocumentTextWindow(input.document, offset, input.start_char ?? 0,
      Math.max(1, Math.min(2_000, input.limit ?? 100))),
    resource = resourceReference.document(input.documentId, input.versionId);
  if (window.status !== "ready") return { ...fail(window.status === "invalid_line"
    ? offset > (window.totalLines ?? 0) ? `(offset ${offset} is past the end of the file; total lines: ${window.totalLines})` : "(empty file)"
    : window.status === "split_character" ? `(start_char ${input.start_char} splits a Unicode character on line ${offset})`
    : `(start_char ${input.start_char} is past the end of line ${offset}; line chars: ${window.lineLength ?? 0})`),
    coverage: { complete: false, next: [{ resource, offset, start_char: input.start_char ?? 0 }] } };
  const sourceSha256 = native.documentRevision(input.document), evidence: LegalEvidenceReceipt[] = [],
    sourceText = native.documentText(input.document), cells = native.documentTableCells(input.document), lines: string[] = [];
  let chars = 0, next = window.nextOffset === null ? null
    : { resource, offset: window.nextOffset, start_char: window.nextStartChar ?? 0 };
  for (const original of window.rows) {
    const row = boundedRow(original), lineStart = sourceText.lastIndexOf("\n", row.span[0] - 1) + 1;
    if (lines.length && chars + JSON.stringify(row.text).length > 32_000) {
      next = { resource, offset: row.lineNumber, start_char: row.span[0] - lineStart };
      break;
    }
    const block = native.smallestContainingDocumentBlock(input.document, row.span[0], row.span[1]),
      selected = cells.filter((cell) => cell.start < row.span[1] && cell.end > row.span[0]);
    for (const span of selected.length ? selected.map((cell) => ({ start: Math.max(cell.start, row.span[0]),
      end: Math.min(cell.end, row.span[1]), locator: { kind: "cell" as const,
        label: `${cell.tableName}!${cell.address}`, sheet: cell.tableName, cells: cell.address } }))
      : [{ start: row.span[0], end: row.span[1], ...(() => {
        const locator = provenBlockLocator(input.document, block, { start: row.span[0], end: row.span[1] });
        return locator ? { locator } : {};
      })() }])
      if (span.end > span.start) {
        const receipt = createLibraryEvidence({ documentId: input.documentId,
          versionId: input.versionId, filename: input.filename, sourceSha256, ...span,
          spanText: sourceText.slice(span.start, span.end) });
        evidence.push(receipt);
        lines.push(`${receipt.evidence_id} ${span.locator?.kind === "cell"
          ? span.locator.label : row.lineNumber}\t${receipt.span_text}`);
      }
    chars += JSON.stringify(row.text).length;
    if (row.text.length < original.text.length) {
      next = { resource, offset: row.lineNumber, start_char: row.span[1] - lineStart }; break;
    }
  }
  const continuation = next ? `\n\n[TRUNCATED: continue with Read(file_path=${JSON.stringify(resource)}, offset=${next.offset}, limit=${input.limit ?? 100}, start_char=${next.start_char ?? 0}).]` : "";
  return { ...result(lines.join("\n") + continuation), evidence,
    evidenceSources: new Map(evidence.map(({ evidence_id }) => [evidence_id, { source: input.document }])),
    coverage: { complete: next === null, next: next ? [next] : [] } };
}

export async function readResearchResource(documents: DocumentStore, scope: ApplicationScope,
  input: { resource: string; offset?: number; start_char?: number; limit?: number;
    evidence?: LegalEvidenceReceipt[]; signal?: AbortSignal; callId?: string; maxBytes?: number;
    expectedSourceSha256?: string; reader?: ReadSubagentAssignment }): Promise<ResearchRead> {
  const reference = parseResourceReference(input.resource);
  if (!reference || !["source", "document"].includes(reference.kind))
    throw new ApplicationError(400, "Select a document or source to read");
  const source = reference.kind === "source" ? researchSourceFromResource(input.resource) : null,
    boundary = source && readerBoundary(source, input.reader);
  if (boundary) throw new ApplicationError(400, boundary);
  const meta = reference.kind === "document" ? await documents.metadata(scope, reference.documentId) : null;
  if (reference.kind === "document" && !meta) throw new ApplicationError(404, "Document not found");
  const projection = reference.kind === "document"
    ? await documents.projectionSource(scope, reference.documentId, reference.versionId) : null;
  if (reference.kind === "document" && !projection) throw new ApplicationError(404, "Document version not found");
  if (projection && input.expectedSourceSha256 && projection.sourceSha256 !== input.expectedSourceSha256)
    throw new ApplicationError(409, "Source changed after the extraction scope was selected");
  if (reference.kind === "document" && input.maxBytes !== undefined) {
    const version = (await documents.versions(scope, reference.documentId))?.versions
      .find(({ id }) => id === reference.versionId);
    if (!version) throw new ApplicationError(404, "Document version not found");
    if (version.size_bytes > input.maxBytes) throw new ApplicationError(413, "This document is too large for tabular extraction");
  }
  const document = projection ? await documentProjectionService.read(projection, { signal: input.signal }) : null;
  if (input.evidence !== undefined) {
    if (input.evidence.some((receipt) => legalEvidenceResourceReference(receipt) !== input.resource))
      throw new ApplicationError(400, "Passage does not belong to the selected source");
    const offset = Math.max(0, (input.offset ?? 1) - 1), limit = Math.max(1, Math.min(100, input.limit ?? 100)),
      selected = input.evidence.slice(offset, offset + limit),
      restored = await restorePriorLegalEvidence(selected, input.signal, true,
        document ? selected.map((receipt) => ({ receipt, source: document })) : []);
    if (restored.length !== selected.length) throw new ApplicationError(409, "Selected passage is unavailable");
    const evidence = restored.map(({ receipt }) => receipt),
      next = offset + selected.length < input.evidence.length
        ? [{ resource: input.resource, offset: offset + selected.length + 1 }] : [];
    return { ...result({ resource: input.resource, passages: evidence.map((receipt) => ({
      evidence_id: receipt.evidence_id, locator: receipt.locator, text: receipt.span_text })), next }), evidence,
      evidenceSources: new Map(restored.map(({ receipt, ...value }) => [receipt.evidence_id, value])),
      coverage: { complete: !next.length, next } };
  }
  if (reference.kind === "document") {
    return readLibraryResearchWindow({ ...input, documentId: reference.documentId,
      versionId: reference.versionId, filename: meta!.filename, document: document! });
  }
  const outcome = await readLegalSourceResource({ name: "Read", id: input.callId ?? "research-read",
    input: {} }, { file_path: input.resource, offset: input.offset ?? 1,
      start_char: input.start_char ?? 0, limit: input.limit ?? 100 }, {
        userId: scope.userId, signal: input.signal, reader: input.reader, knownSources: new Map() });
  if (!outcome || outcome.result.isError) throw new ApplicationError(409, "Source could not be read");
  const payload = outcome.result.content.find((item) => item.type === "text"),
    value = payload?.type === "text" ? objectRecord(JSON.parse(payload.text)) : null,
    continuations = Array.isArray(value?.next) ? value.next as { file_path: string; offset: number; start_char?: number }[] : [],
    next = continuations.map(({ file_path, ...cursor }) => ({ resource: file_path, ...cursor }));
  return { ...outcome, coverage: { complete: !next.length, next } };
}

export async function restoreResearchEvidence(documents: DocumentStore, scope: ApplicationScope,
  receipts: readonly LegalEvidenceReceipt[], signal?: AbortSignal) {
  const sources = new Map<string, Promise<NativeDocument | null>>();
  const available = await Promise.all(receipts.filter((receipt) => receipt.provider === "library")
    .map(async (receipt): Promise<RegisteredEvidence[]> => {
      const resource = legalEvidenceResourceReference(receipt); if (!resource || !receipt.version) return [];
      let source = sources.get(resource);
      if (!source) { source = documents.projectionSource(scope, receipt.stable_source_id, receipt.version)
        .then((value) => value ? documentProjectionService.read(value, { signal }) : null)
        .catch((error) => { if (signal?.aborted) throw error; return null; }); sources.set(resource, source); }
      const native = await source; return native ? [{ receipt, source: native }] : [];
    }));
  return restorePriorLegalEvidence(receipts, signal, true, available.flat());
}

export function oneHopLegalScope(
  document: NativeDocument,
  block: NativeDocumentBlock,
  direction: "inbound" | "outbound" | "both",
  includeUnits = false,
) {
  const follow = direction === "inbound"
    ? "in"
    : direction === "outbound" ? "out" : "both";
  return structureNative().graphScope(
    document, block.label, follow, 1, true, includeUnits);
}

type EvidenceSource = Omit<RegisteredEvidence, "receipt">;
function legalEvidenceSource(passage: LegalSourcePassage): EvidenceSource {
  const source = passage.documentArtifact;
  if (passage.source.provider !== "a2aj") return { source };
  const native = objectRecord(passage.native);
  return typeof native?.citation === "string"
    ? { document: native as unknown as A2AJCompiledDocument }
    : { source };
}

function cleanSearchEvidenceSpan(
  passage: LegalSourcePassage,
  hit: { at: number; excerpt: string },
): LegalEvidenceSpan {
  const matchEnd = hit.at + hit.excerpt.length;
  const source = passage.documentArtifact;
  if (passage.role === "document" || !passage.blockArtifact) {
    const block = structureNative()
      .smallestContainingDocumentBlock(source, hit.at, matchEnd);
    if (block) return {
      text: block.text,
      start: block.start,
      end: block.end,
      blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
      ...(["paragraph", "page", "section", "footnote"].includes(block.kind)
        ? { locator: { kind: block.kind as "paragraph" | "page" | "section" | "footnote", label: block.label } }
        : {}),
    };
  }

  const text = passage.text;
  let start = text.lastIndexOf("\n", Math.max(0, hit.at - 1)) + 1;
  const nextLine = text.indexOf("\n", matchEnd);
  let end = nextLine < 0 ? text.length : nextLine;
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { text: text.slice(start, end), start, end };
}

export const sourceActivityCitations = (sources: readonly LegalSourceReference[]) =>
  createLegalSourceSearchCitations([...new Map(sources.map((source) =>
    [researchSourceResource(source), source])).values()].map((source) => ({
      ...source, identifier: source.id, source_type: source.kind,
    })));

const modelLegalPassage = (receipt: LegalEvidenceReceipt) => ({
  evidence_id: receipt.evidence_id, kind: receipt.locator.kind,
  locator: receipt.locator.label, text: receipt.span_text,
});

function readerBoundary(source: LegalSourceReference, reader: ReadSubagentAssignment | undefined) {
  const region = source.provider === "courtlistener" || source.provider === "govinfo"
    ? "US" : source.provider === "tna" || source.provider === "govuk-et" ? "UK" : "CA";
  if (reader && region !== reader.jurisdiction) return `This source is outside the reader's ${reader.jurisdiction} boundary.`;
  if (reader?.collections?.length && source.collection && !reader.collections.some((value) =>
    value.toLowerCase() === source.collection!.toLowerCase())) return "This source is outside the reader's collection boundary.";
  if (reader?.source_types?.length && !reader.source_types.includes(source.kind)) return "This source is outside the reader's source-type boundary.";
}

export async function readLegalSourceResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  options: {
    userId: string;
    signal?: AbortSignal;
    reader?: ReadSubagentAssignment;
    knownSources: Map<string, LegalSourceReference>;
  },
): Promise<BeaverOutcome | null> {
  if (call.name !== "Read") return null;
  const resource = parseResourceReference(trimmed(args.file_path));
  if (resource?.kind !== "source" || resource.provider === "pdf") return null;
  const locator = trimmed(args.locator);
  const locatorKind = trimmed(args.locator_kind);
  const endLocator = trimmed(args.end_locator);
  if (Boolean(locator) !== Boolean(locatorKind))
    return fail("locator_kind and locator are required together.");
  if (locator && !["paragraph", "section", "page", "footnote"].includes(locatorKind))
    return fail("Unsupported legal-source locator kind.");
  const source = researchSourceFromResource(trimmed(args.file_path));
  if (!source) return fail(`Invalid ${resource.provider} resource.`);
  const boundary = readerBoundary(source, options.reader);
  if (boundary) return fail(boundary);
  const references = (args.references ?? "none") as
    "none" | "inbound" | "outbound" | "both";
  if (references !== "none") {
    if (source.provider !== "a2aj" || source.kind !== "legislation" ||
        locatorKind !== "section")
      return fail("references is available only for A2AJ statutory sections.");
  }
  try {
    const read = await legalSourceOperations.readWithRenditions({
      source,
      ...(locator
        ? {
            locator: {
              kind: locatorKind as "paragraph" | "section" | "page" | "footnote",
              value: locator,
              ...(endLocator ? { endValue: endLocator } : {}),
            },
            contextBlocks: Math.min(
              2,
              Math.max(0, Math.trunc(Number(args.context_blocks) || 0)),
            ),
          }
        : {}),
      signal: options.signal,
    }, options.userId);
    if (read.status !== "found") {
      return fail(
        read.status === "unsupported"
          ? "Legal source provider is unavailable."
          : "The requested legal source passage was not found.",
      );
    }
    const sources = read.values.map(({ source }) => {
      const known = options.knownSources.get(researchSourceResource(source));
      return { ...source, title: source.title ?? known?.title,
        citation: source.citation ?? known?.citation, url: source.url ?? known?.url };
    });
    sources.forEach((source) => options.knownSources.set(researchSourceResource(source), source));
    const activityCitations = sourceActivityCitations(sources);

    const pattern = trimmed(args.pattern), next: Array<{
      file_path: string; offset: number; start_char: number;
    }> = [], unclassified = new Set<string>();
    let remaining = Math.min(2_000, Math.max(1, Math.trunc(Number(args.limit) || 20))), chars = 0;
    const registered = read.values.flatMap((passage) => {
      if (locator || pattern) return [{ passage, receipt: legalSourceEvidence(passage),
        source: legalEvidenceSource(passage) }];
      const native = structureNative(), artifact = passage.documentArtifact,
        resource = researchSourceResource(passage.source), offset = Number(args.offset) || 1,
        startChar = Number(args.start_char) || 0, firstParagraph = passage.source.kind === "case"
          ? native.documentAnchors(artifact).find(({ kind }) => kind === "paragraph") : undefined;
      if (passage.source.kind === "case" && !firstParagraph) unclassified.add(resource);
      const window = args.offset === undefined && args.start_char === undefined && firstParagraph
        ? native.readDocumentTextRange(artifact, firstParagraph.start, passage.text.length,
            undefined, Math.max(1, remaining))
        : native.readDocumentTextWindow(artifact, offset, startChar, Math.max(1, remaining));
      if (window.status !== "ready") throw new Error(`Invalid legal-source text window: ${window.status}`);
      const selected: Array<{ passage: LegalSourcePassage; receipt: LegalEvidenceReceipt | undefined;
        source: EvidenceSource }> = [];
      for (const originalRow of window.rows) {
        const row = boundedRow(originalRow), split = row.text.length < originalRow.text.length;
        const block = native.smallestContainingDocumentBlock(artifact, row.span[0], row.span[1]),
          kind = block?.kind as LegalEvidenceReceipt["locator"]["kind"],
          located = block && ["paragraph", "page", "section", "footnote"].includes(kind),
          whole = located && block.text === row.text ? block : null,
          start = row.span[0], end = row.span[1],
          receipt = whole ? legalSourceEvidence({ ...passage, role: "selected", text: whole.text,
            blockArtifact: whole, locator: { requested: { kind: kind as "paragraph" | "page" | "section" | "footnote",
              value: whole.label }, label: whole.label } })
            : legalSourceEvidence(passage, { text: row.text, start, end,
            ...(block ? { blockId: `${block.kind}:${block.label}:${start}:${end}`,
              ...(located ? { locator: { kind, label: block.label } } : {}) } : {}) });
        if (!receipt) throw new Error("The source cannot provide exact passage evidence");
        const size = JSON.stringify(modelLegalPassage(receipt)).length;
        if (!remaining || chars + size > 32_000) {
          if (!chars) throw new Error("The source passage metadata exceeds the Read limit");
          next.push({ file_path: resource, offset: row.lineNumber,
            start_char: row.span[0] - (passage.text.lastIndexOf("\n", row.span[0] - 1) + 1) });
          return selected;
        }
        chars += size; remaining--;
        selected.push({ passage: { ...passage, role: "selected", text: row.text },
          receipt, source: legalEvidenceSource(passage) });
        if (split) {
          next.push({ file_path: resource, offset: row.lineNumber,
            start_char: row.span[1] - (passage.text.lastIndexOf("\n", row.span[0] - 1) + 1) });
          return selected;
        }
      }
      if (window.nextOffset !== null) next.push({ file_path: resource,
        offset: window.nextOffset, start_char: window.nextStartChar ?? 0 });
      return selected;
    });
    const evidenceSources = new Map<string, EvidenceSource>();
    for (const { receipt, source } of registered) {
      if (receipt) evidenceSources.set(receipt.evidence_id, source);
    }
    const { pdfRenditions } = read;

    const sourceDetails = [...new Map(read.values.map((passage) => {
      const resource = researchSourceResource(passage.source), source = options.knownSources.get(resource)!,
        opinions = objectRecord(passage.native)?.case,
        opinion = source.part && Array.isArray(objectRecord(opinions)?.opinions)
          ? (objectRecord(opinions)!.opinions as unknown[]).map(objectRecord).find((value) =>
              String(value?.opinionId ?? value?.id ?? value?.opinion_id) === source.part) : null;
      const extent = sourceExtent(passage.documentArtifact);
      return [resource, { resource, title: source.title, citation: source.citation,
        ...(extent ? { extent } : {}),
        ...(source.date ? { date: source.date } : {}),
        ...(source.collection ? { collection: source.collection } : {}),
        ...(source.language ? { language: source.language } : {}),
        ...(opinion?.type ? { opinion_type: opinion.type } : {}),
        ...(opinion?.author ? { author: opinion.author } : {}),
        ...(unclassified.has(resource) ? { qualification:
          "No native judgment boundary; this text may include editorial material." } : {}) }] as const;
    })).values()];
    const modelPassage = (receipt: LegalEvidenceReceipt) => {
      const reference = legalEvidenceSourceReference(receipt);
      return { ...modelLegalPassage(receipt), ...(sourceDetails.length > 1 && reference
        ? { source: sourceDetails.findIndex(({ resource }) => resource === researchSourceResource(reference)) + 1 }
        : {}) };
    };
    if (pattern) {
      const maxResults = Math.min(50, Math.max(1, Math.trunc(Number(args.max_results) || 20)));
      const contextChars = Math.min(2_000, Math.max(40,
        Math.trunc(Number(args.context_chars) || 160)));
      let total = 0;
      const hits = registered.flatMap(({ passage }) => {
        const found = findTextMatches({
          text: passage.text,
          query: pattern,
          maxResults: Math.max(0, maxResults - total),
          contextChars,
          startIndex: total,
        });
        total += found.totalMatches;
        return found.hits.map((hit) => {
          const span = passage.locator.requested
            ? { start: 0, end: passage.text.length, text: passage.text }
            : cleanSearchEvidenceSpan(passage, hit);
          const receipt = passage.locator.requested
            ? legalSourceEvidence(passage)
            : legalSourceEvidence(passage, span);
          if (receipt) {
            evidenceSources.set(receipt.evidence_id, legalEvidenceSource(passage));
          }
          const before = passage.text.slice(Math.max(0, hit.at - contextChars), span.start),
            after = passage.text.slice(span.end, Math.min(passage.text.length,
              hit.at + hit.excerpt.length + contextChars));
          return {
            at: hit.at, receipt,
            ...(receipt ? { evidence_id: receipt.evidence_id,
              ...(before ? { before } : {}), ...(after ? { after } : {}) }
              : { context: hit.context, locator: passage.locator.label }),
          };
        });
      });
      const evidence = [...new Map(hits.flatMap(({ receipt }) =>
        receipt ? [[receipt.evidence_id, receipt] as const] : [],
      )).values()];
      const visibleHits = hits.map(({ receipt: _receipt, ...hit }) => hit);
      return {
        activityCitations,
        ...result({
          ok: true,
          sources: sourceDetails,
          total_matches: total,
          ...(total > hits.length ? { truncated: true } : {}),
          hits: visibleHits,
          ...(evidence.length ? { passages: evidence.map(modelPassage) } : {}),
          ...(pdfRenditions.length ? { pdf_renditions: pdfRenditions } : {}),
        }),
        ...(evidence.length ? { evidence } : {}),
        ...(evidenceSources.size ? { evidenceSources } : {}),
        queryReceipts: [{
          call_id: call.id,
          tool: "Read",
          executed_at: new Date().toISOString(),
          executor_version: "legal-source-pattern-v1",
          input: {
            resource: trimmed(args.file_path),
            pattern,
            ...(locator ? { locator_kind: locatorKind, locator } : {}),
            ...(endLocator ? { end_locator: endLocator } : {}),
            context_blocks: locator
              ? Math.min(2, Math.max(0, Math.trunc(Number(args.context_blocks) || 0)))
              : 0,
            max_results: maxResults,
            context_chars: contextChars,
          },
          results: evidence.map(({ evidence_id }, rank) => ({
            rank: rank + 1,
            evidence_id,
          })),
        }],
      };
    }

    let referenceNeighborhood: Record<string, unknown> | undefined;
    const relatedEvidence: LegalEvidenceReceipt[] = [];
    if (references !== "none") {
      const selected = registered.find(({ passage }) =>
        passage.role === "selected" && passage.blockArtifact);
      const artifact = selected?.passage.documentArtifact;
      const block = selected?.passage.blockArtifact;
      const metadata = selected && objectRecord(selected.passage.native);
      if (artifact && block && metadata && typeof metadata.citation === "string" &&
          typeof metadata.dataset === "string" &&
          (metadata.language === "en" || metadata.language === "fr")) {
        const scope = oneHopLegalScope(
          artifact,
          block,
          references as Exclude<A2AJReferenceDirection, "none">,
          true,
        );
        const candidates = scope?.nodes ?? [];
        const sections: Array<{ label: string; evidence_ids: string[] }> = [];
        const omitted: string[] = [];
        const sourceSha256 = structureNative().documentRevision(artifact);
        let chars = 0;
        for (const [index, related] of candidates.entries()) {
          if (sections.length === 50 || chars + related.text.length > 32_000) {
            omitted.push(...candidates.slice(index).map(({ label }) => label));
            break;
          }
          chars += related.text.length;
          const receipts = (related.units ?? [related]).filter((unit): unit is NativeDocumentBlock & {
            kind: "paragraph" | "page" | "section" | "footnote";
          } =>
            unit.kind === "paragraph" || unit.kind === "page" ||
            unit.kind === "section" || unit.kind === "footnote"
          ).map((unit) => createA2AJPassageEvidence({
            citation: metadata.citation as string,
            name: typeof metadata.name === "string" ? metadata.name : null,
            dataset: metadata.dataset as string,
            language: metadata.language as "en" | "fr",
            sourceSha256,
            spanText: unit.text,
            start: unit.start,
            end: unit.end,
            externalUrl: typeof metadata.url === "string" ? metadata.url : null,
            sourceClass: "legislation",
            blockId: `${unit.kind}:${unit.label}:${unit.start}:${unit.end}`,
            locator: { kind: unit.kind, label: unit.label },
          }));
          relatedEvidence.push(...receipts);
          receipts.forEach((receipt) => evidenceSources.set(receipt.evidence_id, {
            document: metadata as unknown as A2AJCompiledDocument,
          }));
          sections.push({ label: related.label,
            evidence_ids: receipts.map(({ evidence_id }) => evidence_id) });
        }
        referenceNeighborhood = {
          direction: references,
          ...(omitted.length ? { omitted: [...new Set(omitted)],
            limit_reason: sections.length === 50 ? "sections" : "characters" } : {}),
          ...(scope ? {} : { failures: ["reference graph source unavailable"] }),
          sections,
        };
      }
    }

    const evidences = [...new Map(
      [...registered.map(({ receipt }) => receipt), ...relatedEvidence].flatMap((receipt) =>
        receipt ? [[receipt.evidence_id, receipt] as const] : [],
      ),
    ).values()];
    const contextIds = new Set(registered.flatMap(({ passage, receipt }) =>
      passage.role === "context" && receipt ? [receipt.evidence_id] : []));
    const passages = evidences.map((receipt) => ({ ...modelPassage(receipt),
      ...(contextIds.has(receipt.evidence_id) ? { role: "context" } : {}) }));
    const payload = {
      ok: true,
      sources: sourceDetails,
      passages,
      ...(next.length ? { next } : {}),
      ...(pdfRenditions.length ? { pdf_renditions: pdfRenditions } : {}),
      ...(referenceNeighborhood
        ? { reference_neighborhood: referenceNeighborhood }
        : {}),
    };
    return {
      ...result(payload),
      activityCitations,
      evidence: evidences,
      ...(evidenceSources.size ? { evidenceSources } : {}),
    };
  } catch (error) {
    return fail(
      error instanceof Error
        ? error.message
        : "Legal source read failed.",
    );
  }
}
