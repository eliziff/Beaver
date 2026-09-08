import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResearchOperationContext } from "./researchProvenance";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { createLegalEvidenceTurnState, createLibraryEvidence, legalSourceEvidence, registerLegalResearchQueries,
  type LegalEvidenceSpan,
  type LegalEvidenceReceipt, type LegalResearchQueryReceipt } from "./chat/legalEvidence";
import type { DocumentStore } from "./documentStore";
import { legalSourceOperations } from "./legalSourceApplication";
import { commitResearchFile, readResearchFile,
  researchLabelPath, researchSourceKey, researchSourceResource, readResearchQueries,
  type PublicResearchFileAction,
  type ResearchFile, type ResearchFileAction, type ResearchFileState,
  type ResearchQueryReceipt, type ResearchSourceReference } from "./researchFile";
import { provenBlockLocator } from "./documentLocators";
import { structureNative } from "./structureNative";
import { escapeRegExp } from "./text";
import { hasSearchOperators, searchMatcher } from "./searchQuery";
import { sha256 } from "./hash";
import { documentProjectionService } from "./documentProjectionService";
import { resolveResearchSelection, researchSelectionSchema, researchSelectionLabels, intersectResearchSubjects,
  type ResearchSelection } from "./researchSelection";
import type { ResearchReadContext } from "./researchReader";

export const researchCaptureRuleSchema = z.object({ phrase: z.string().trim().min(1).max(500),
  direction: z.enum(["before", "after", "around"]), unit: z.enum(["sentence", "line", "paragraph", "chars"]),
  chars: z.number().int().min(1).max(50_000).optional(), slot: z.string().trim().min(1).max(200).optional() }).strict();
export type ResearchCaptureRule = z.infer<typeof researchCaptureRuleSchema>;
export type ResearchFileQueryInput = ResearchSelection & { versionId: string; workingRevision: number; text?: string;
  syntax: "literal" | "terms"; limit?: number; after?: string; rules?: ResearchCaptureRule[];
  conflict?: "prompt" | "first" | "longer" | "shorter" | "append" };
type ResearchPassageReader = typeof legalSourceOperations.readPassage;
const clean = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const allowed = new Set(["document", "paragraph", "section", "page", "footnote"]);
const MAX_CAPTURE_CHARS = 1_000_000, MAX_CAPTURE_CANDIDATES = 50_000;
const MALFORMED_QUERY = "Check the search: AND, OR, NOT, matching brackets and closed quotes.";

const paragraphBreak = /\r?\n\s*\r?\n/gu, sentenceEnd = /[.!?](?:\s|$)/gu;
const next = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at; return pattern.exec(text);
};
const adjacent = (text: string, at: number, phraseLength: number, rule: ResearchCaptureRule) => {
  const chars = rule.chars ?? 100, { unit, direction } = rule;
  const backward = (end: number) => {
    if (unit === "chars") return Math.max(0, end - chars);
    if (unit === "line") return text.lastIndexOf("\n", end - 1) + 1;
    if (unit === "paragraph") {
      const found = Math.max(text.lastIndexOf("\n\n", end - 1), text.lastIndexOf("\r\n\r\n", end - 1));
      return found < 0 ? Math.max(0, end - chars) : found + (text.startsWith("\r\n", found) ? 4 : 2);
    }
    const found = Math.max(text.lastIndexOf(".", end - 1), text.lastIndexOf("?", end - 1),
      text.lastIndexOf("!", end - 1)) + 1;
    return found || Math.max(0, end - chars);
  };
  const forward = (start: number) => {
    if (unit === "chars") return start + chars;
    if (unit === "line") { const found = text.indexOf("\n", start); return found < 0 ? start + chars : found; }
    if (unit === "paragraph") { const found = next(paragraphBreak, text, start); return found ? found.index : start + chars; }
    const found = next(sentenceEnd, text, start); return found ? found.index + 1 : start + chars;
  };
  // "before" and "after" capture the text beside the phrase; "around" keeps the phrase inside its unit.
  let start = direction === "after" ? at + phraseLength : backward(at),
    end = direction === "before" ? at : forward(at + phraseLength);
  end = Math.min(text.length, end); while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && /\s/u.test(text[end - 1])) end--;
  if (direction === "after") while (start < end && /[,;:]/u.test(text[start])) start++;
  return start < end ? { start, end, text: text.slice(start, end) } : null;
};

type CanonicalDocument = { documentArtifact: Parameters<ReturnType<typeof structureNative>["documentText"]>[0];
  evidence: (span: LegalEvidenceSpan) => LegalEvidenceReceipt | undefined };

/**
 * The canonical document behind a research source, paired with the receipt factory for spans in
 * it. Library documents come from the stored projection, legal sources from their provider.
 */
async function openResearchSource(reference: ResearchSourceReference,
  native: ReturnType<typeof structureNative>, options: { documents?: DocumentStore; scope?: ApplicationScope;
    reader?: ResearchPassageReader; signal?: AbortSignal }): Promise<{ sourceSha256?: string;
      failure?: "not_found" | "unsupported"; passages: CanonicalDocument[] }> {
  if (reference.kind === "document") {
    const projection = options.documents && options.scope
      && await options.documents.projectionSource(options.scope, reference.id, reference.versionId);
    if (!projection) throw new ApplicationError(404, "Document version not found");
    const documentArtifact = await documentProjectionService.read(projection, { signal: options.signal });
    return { sourceSha256: projection.sourceSha256, passages: [{ documentArtifact, evidence: (span) =>
      createLibraryEvidence({ documentId: reference.id, versionId: reference.versionId,
        filename: reference.title ?? reference.id, sourceSha256: native.documentRevision(documentArtifact),
        start: span.start, end: span.end, spanText: span.text, locator: span.locator }) }] };
  }
  const read = await (options.reader ?? legalSourceOperations.readPassage)({ source: reference, signal: options.signal });
  if (read.status !== "found") return { failure: read.status, passages: [] };
  const selected = read.values.filter(({ role }) => role === "document");
  return { passages: (selected.length ? selected : read.values.slice(0, 1)).map((passage) => ({
    documentArtifact: passage.documentArtifact, evidence: (span) => legalSourceEvidence(passage, span) })) };
}

export async function verifyResearchPassage(file: ResearchFile, action: PublicResearchFileAction,
  reader: ResearchPassageReader = legalSourceOperations.readPassage,
  context?: { documents: DocumentStore; scope: ApplicationScope }): Promise<ResearchFileAction> {
  if (action.type !== "passage") return action;
  const source = file.state.sources[action.sourceId]?.reference;
  if (!source) throw new ApplicationError(400, "Research source not found");
  const native = structureNative();
  const [passage] = (await openResearchSource(source, native,
    { documents: context?.documents, scope: context?.scope, reader })).passages;
  if (!passage) throw new ApplicationError(404, "This source could not be opened for reading");
  const document = passage.documentArtifact, text = native.documentText(document);
  if (action.revision !== native.documentRevision(document))
    throw new ApplicationError(409, "This source changed while you were reading it; open it again to highlight");
  const { start, end } = action;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > text.length || end <= start)
    throw new ApplicationError(400, "Invalid selection span", { code: "invalid_span" });
  const span = { start, end };
  const block = native.smallestContainingDocumentBlock(document, span.start, span.end);
  const receipt = passage.evidence({ ...span, text: text.slice(span.start, span.end),
    ...((locator) => locator ? { blockId: `${locator.kind}:${locator.label}:${span.start}:${span.end}`,
      locator } : {})(provenBlockLocator(document, block, span)) });
  if (!receipt) throw new ApplicationError(404, "This source could not be opened for reading");
  return { type: "merge", evidence: [receipt], labels: { [receipt.evidence_id]: action.labelIds ?? [] } };
}

type Capture = { start: number; end: number; slot: string; order: number; assign: boolean };
const overlap = (left: Capture, right: Capture) => left.start < right.end && right.start < left.end;
const resolveCaptures = (values: Capture[], conflict: ResearchFileQueryInput["conflict"]) => {
  if (conflict === "append") return values;
  if (conflict === "prompt") {
    const review = new Set<number>(), ordered = [...values].sort((a, b) => a.start - b.start || a.end - b.end);
    let end = -1, owner = -1;
    for (const value of ordered) {
      if (value.start < end) { review.add(value.order); review.add(owner); }
      if (value.end > end) { end = value.end; owner = value.order; }
    }
    return values.map((value) => ({ ...value, assign: !review.has(value.order) }));
  }
  const preferred = [...values].sort((a, b) => conflict === "longer"
    ? b.end - b.start - (a.end - a.start) || a.order - b.order
    : conflict === "shorter" ? a.end - a.start - (b.end - b.start) || a.order - b.order
      : a.order - b.order), starts = [...new Set(values.map(({ start }) => start))]
        .sort((a, b) => a - b), indexes = new Map(starts.map((start, index) => [start, index + 1])),
    tree = new Uint32Array(starts.length + 1), selected: Array<Capture | undefined> = [], kept: Capture[] = [];
  const count = (end: number) => { let total = 0;
    for (; end; end -= end & -end) total += tree[end]; return total; };
  const nth = (rank: number) => { let index = 0;
    for (let step = 1 << Math.floor(Math.log2(tree.length)); step; step >>= 1) {
      const next = index + step;
      if (next < tree.length && tree[next] < rank) { index = next; rank -= tree[next]; }
    }
    return index + 1;
  };
  for (const value of preferred) {
    const index = indexes.get(value.start)!, before = count(index),
      left = before ? selected[nth(before)] : undefined,
      right = before < kept.length ? selected[nth(before + 1)] : undefined;
    if (left && overlap(left, value) || right && overlap(right, value)) continue;
    selected[index] = value; kept.push(value);
    for (let at = index; at < tree.length; at += at & -at) tree[at]++;
  }
  return kept.sort((a, b) => a.order - b.order);
};

export async function runResearchFileQuery(documents: DocumentStore, scope: ApplicationScope,
  documentId: string, input: ResearchFileQueryInput, options: {
    signal?: AbortSignal; actor?: { model?: string; callId?: string };
    operation?: ResearchOperationContext;
    context?: ResearchReadContext;
    assistant?: { turnVersionId?: string; turnId?: string };
    priorQueries?: Iterable<LegalResearchQueryReceipt>;
    reader?: ResearchPassageReader } = {}) {
  const file = await readResearchFile(documents, scope, documentId);
  if (!file || file.versionId !== input.versionId ||
      file.workingRevision !== input.workingRevision)
    throw new ApplicationError(409, "This research file changed. Reload it before querying.",
      { code: "revision_conflict" });
  const state = file.state, query = input.text?.trim() ?? "";
  let rules: Array<ResearchCaptureRule & { chars: number }>;
  try { rules = z.array(researchCaptureRuleSchema).max(50).parse(input.rules ?? [])
    .map((rule) => ({ ...rule, chars: rule.chars ?? 100 })); }
  catch { throw new ApplicationError(400, "Capture rules are invalid"); }
  if ((!query && !rules.length) || !!query === !!rules.length || query.length > 10_000)
    throw new ApplicationError(400, "Query text is invalid");
  if (rules.some(({ slot }) => slot !== undefined &&
      state.labels[slot]?.scope !== "highlight"))
    throw new ApplicationError(400, "Choose an existing highlight type for a capture");
  /** "terms" is the Boolean syntax — AND/OR/NOT, &|-, quotes, brackets; "literal" stays one phrase. */
  const search = input.syntax === "terms" && query ? searchMatcher(query) : null;
  if (input.syntax === "terms" && query && !search) throw new ApplicationError(400, MALFORMED_QUERY,
    { code: "invalid_query" });
  const needle = query.toLowerCase();
  const matches = (text: string) => { const value = text.toLowerCase();
    return search ? search.test(value) : value.includes(needle); };
  const compiled = rules.map((rule) => {
    if (!hasSearchOperators(rule.phrase)) return { rule, source: escapeRegExp(rule.phrase), test: null };
    const parsed = searchMatcher(rule.phrase);
    if (!parsed) throw new ApplicationError(400, MALFORMED_QUERY, { code: "invalid_query" });
    // A Boolean capture anchors on every term it admits, in text the whole expression accepts.
    return { rule, source: parsed.terms.map(escapeRegExp).join("|"), test: parsed.test };
  });
  const scopeInput = researchSelectionSchema.parse({ target: input.target, sourceIds: input.sourceIds,
    evidenceIds: input.evidenceIds, members: input.members, labelIds: input.labelIds, unlabelled: input.unlabelled }),
    labels = researchSelectionLabels(state, input.labelIds ?? []),
    limit = Math.max(1, Math.min(5_000, input.limit ?? 500)),
    contextResources = options.context?.restricted && new Set(options.context.subjects?.map(({ resource }) => resource)),
    baseline = input.members?.map(({ sourceId }) => sourceId) ?? input.sourceIds ?? Object.values(state.sources)
      .filter((source) => source.collected || input.evidenceIds !== undefined ||
        contextResources && contextResources.has(researchSourceResource(source.reference))).map(({ id }) => id),
    requested = [...new Set(baseline)].filter((id) => {
      if (!state.sources[id]) throw new ApplicationError(400, "Invalid source selection");
      return (!input.sourceIds || input.sourceIds.includes(id)) &&
        (!contextResources || contextResources.has(researchSourceResource(state.sources[id].reference)));
    });
  let sources = requested.map((id) => state.sources[id]);
  const selection = sha256(JSON.stringify([query, input.syntax, input.target, rules, input.conflict,
    scopeInput, [...labels], options.context?.restricted ? options.context.subjects?.map(({ resource, evidence }) =>
      [resource, evidence?.map(({ evidence_id, source_sha256 }) => [evidence_id, source_sha256])]) : null,
    sources.map(({ id, reference, labelIds, passages }) => [id, researchSourceKey(reference), labelIds,
      input.target === "passages" && !input.evidenceIds && !input.members ? passages?.sha256 : null])]));
  let cursor: [string, string, string, string, boolean] | undefined;
  if (input.after !== undefined) {
    try { cursor = z.tuple([z.string(), z.string(), z.string(), z.string(), z.boolean()]).parse(
      JSON.parse(Buffer.from(z.string().max(2_000).parse(input.after), "base64url").toString())); }
    catch { throw new ApplicationError(400, "Invalid research continuation"); }
    const issued = (receipt: LegalResearchQueryReceipt) =>
      (receipt.input.coverage as { next_after?: unknown } | undefined)?.next_after === input.after;
    if (![...(options.priorQueries ?? [])].some(issued) &&
        !(await readResearchQueries(documents, scope, file)).some(issued))
      throw new ApplicationError(409, "Research continuation receipt is unavailable. Restart the search.");
    if (cursor[3] !== selection || !sources.some(({ id }) => id === cursor![0]))
      throw new ApplicationError(409, "Research selection changed. Restart the search.");
    sources = sources.slice(sources.findIndex(({ id }) => id === cursor![0]));
  }
  let cursorFound = !cursor, lastMatch: [string, string] | undefined;
  const cursorSkipped = new Set<string>();
  const evidence: LegalEvidenceReceipt[] = [], seen = new Set<string>(), failures: Array<{
    sourceId: string; code: string }> = [], attempted: string[] = [];
  const matched = new Set<string>();
  const ambiguousTypes = new Set<string>();
  const slots: Record<string, string[]> = {}, labelsByEvidence: Record<string, string[]> = {},
    sourceFingerprints: Record<string, string[]> = {}, fingerprintSets = new Map<string, Set<string>>();
  let captured = 0, captureFull = false;
  const rememberFingerprint = (sourceId: string, value: string) => {
    const hash = value.replace(/^sha256:/u, ""); if (!/^[a-f0-9]{64}$/u.test(hash)) return;
    const seen = fingerprintSets.get(sourceId) ?? new Set<string>();
    if (!fingerprintSets.has(sourceId)) fingerprintSets.set(sourceId, seen);
    if (!seen.has(hash)) { seen.add(hash); (sourceFingerprints[sourceId] ??= []).push(hash); }
  };
  const failureKeys = new Set<string>(), fail = (sourceId: string, code: string) => {
    const key = `${sourceId}:${code}`;
    if (!failureKeys.has(key)) { failureKeys.add(key); failures.push({ sourceId, code }); }
  };
  const add = (span: string, found: LegalEvidenceReceipt | undefined, sourceId: string, slot?: string,
    assign = true) => {
    if (!found) return;
    if (!seen.has(found.evidence_id)) {
      if (evidence.length >= limit) { fail(sourceId, "result_limit"); return; }
      if (span.length > MAX_CAPTURE_CHARS) { fail(sourceId, "capture_size_limit"); return; }
      if (captureFull || captured + span.length > MAX_CAPTURE_CHARS)
        { captureFull = true; fail(sourceId, "result_limit"); return; }
    }
    if (!seen.has(found.evidence_id)) { seen.add(found.evidence_id); captured += span.length;
      evidence.push(found); matched.add(sourceId); lastMatch = [sourceId, found.evidence_id];
      captureFull = captured === MAX_CAPTURE_CHARS; }
    if (slot) {
      const names = slots[found.evidence_id] ??= []; if (!names.includes(slot)) names.push(slot);
      if (assign && !ambiguousTypes.has(found.evidence_id)) {
        const previous = labelsByEvidence[found.evidence_id]?.[0];
        if (previous && previous !== slot) {
          delete labelsByEvidence[found.evidence_id]; ambiguousTypes.add(found.evidence_id);
          fail(sourceId, "highlight_type_conflict");
        } else labelsByEvidence[found.evidence_id] = [slot];
      }
    }
  };
  const afterCursor = (sourceId: string, found: LegalEvidenceReceipt | undefined) => {
    if (!found || cursorSkipped.has(found.evidence_id)) return false;
    if (!cursor || sourceId !== cursor[0] || cursorFound) return true;
    cursorSkipped.add(found.evidence_id);
    if (found.evidence_id === cursor[1]) cursorFound = true;
    return false;
  };
  const verifyCursor = (sourceId: string, hashes: string[]) => {
    if (cursor?.[0] === sourceId && cursor[2] !== sha256(JSON.stringify([...new Set(hashes)].sort())))
      throw new ApplicationError(409, "Research source changed. Restart the search.");
  };
  let native: ReturnType<typeof structureNative> | undefined;
  const scan = async (savedSource: ResearchFileState["sources"][string]): Promise<{ sourceId: string;
    sourceSha256s?: string[]; failure?: string; found: Array<{ span: string;
      receipt: LegalEvidenceReceipt | undefined; slot?: string; assign?: boolean }> }> => {
    const sourceId = savedSource.id;
    try {
      const resolved = await resolveResearchSelection(documents, scope, { ...scopeInput,
        sourceIds: [sourceId], researchFileId: documentId }, file, { allowUnmatchedEvidenceIds: true }),
        subjects = options.context?.restricted ? intersectResearchSubjects(resolved.subjects, options.context.subjects ?? []) : resolved.subjects,
        subject = subjects[0];
      if (!subject) return { sourceId, found: [] };
      const source = { ...savedSource, evidence: subject.evidence }, boundaries = options.context?.restricted
        ? options.context.subjects?.filter(({ resource }) => resource === subject.resource) ?? [] : [];
      if (source.evidence && !rules.length) {
        const sourceSha256s = source.evidence.map(({ source_sha256 }) => source_sha256.replace(/^sha256:/u, "")),
          found: Array<{ span: string; receipt: LegalEvidenceReceipt }> = [];
        verifyCursor(source.id, sourceSha256s);
        for (const receipt of source.evidence) {
          const span = receipt.span_text ?? "";
          if (matches(span) && afterCursor(source.id, receipt)) found.push({ span, receipt });
          if (found.length === limit) break;
        }
        return { sourceId: source.id, sourceSha256s, found };
      }
      native ??= structureNative();
      const opened = await openResearchSource(source.reference, native,
        { documents, scope, reader: options.reader, signal: options.signal });
      if (opened.sourceSha256 && boundaries.some(({ sourceSha256 }) => sourceSha256 && sourceSha256 !== opened.sourceSha256))
        throw new ApplicationError(409, "Selected source changed during research");
      const passages = opened.passages;
      if (!passages.length) return { sourceId: source.id, failure: opened.failure ?? "not_found", found: [] };
      const adapter = native!, sourceSha256s = passages.map(({ documentArtifact }) =>
        adapter.documentRevision(documentArtifact)), found: Array<{
        span: string; receipt: LegalEvidenceReceipt | undefined; slot?: string; assign?: boolean }> = [],
        foundEvidence = new Set<string>();
      let truncated = false, resultLimited = false, sizeLimited = false, pageFull = false,
        foundChars = 0, candidates = 0;
      verifyCursor(source.id, sourceSha256s);
      if (boundaries.some(({ sourceSha256s: expected }) => expected?.length &&
          sourceSha256s.some((hash) => !expected.includes(hash))))
        throw new ApplicationError(409, "Selected source changed during research");
      const verified = new Set<string>(), windows = passages.map((passage) => {
        const text = adapter.documentText(passage.documentArtifact), revision = adapter.documentRevision(passage.documentArtifact),
          ranges = source.evidence ? source.evidence.flatMap((receipt) => {
            if (receipt.source_sha256.replace(/^sha256:/u, "") !== revision.replace(/^sha256:/u, "")) return [];
            const span = receipt.span;
            if (!span || text.slice(span.start, span.end) !== receipt.span_text) return [];
            verified.add(receipt.evidence_id); return [span];
          }) : [{ start: 0, end: text.length }];
        return { ...passage, text, ranges };
      });
      if (source.evidence?.some(({ evidence_id }) => !verified.has(evidence_id)))
        throw new ApplicationError(409, "Selected passage changed or is unavailable");
      for (const passage of windows) {
        const { text } = passage;
        const slices = adapter.legalSourceViewer(passage.documentArtifact,
          source.reference.kind === "legislation" ? "section" : "paragraph", text.length).slices;
        const blocks = slices.length ? slices.map(({ primary, start, end }) => primary ??
          { kind: "document" as const, label: `characters ${start + 1}-${end}`, start, end })
          : adapter.documentAnchors(passage.documentArtifact);
        if (rules.length) {
          const captures: Capture[] = [], captureKeys = new Set<string>();
          captureRules: for (const [order, { rule, source: phrase, test }] of compiled.entries())
            for (const range of passage.ranges) {
            const selectedText = text.slice(range.start, range.end);
            const pattern = new RegExp(phrase, "giu"); let match: RegExpExecArray | null;
            while ((match = pattern.exec(selectedText))) {
              const at = range.start + match.index, length = match[0].length;
              const block = blocks.find(({ start, end }) => start <= at && end >= at + length);
              const bounds = block ? { start: Math.max(range.start, block.start), end: Math.min(range.end, block.end) } : range;
              if (test && (!block || !test(clean(text.slice(bounds.start, bounds.end))))) continue;
              const span = rule.unit === "paragraph" && rule.direction === "around" && block
                ? { start: bounds.start - range.start, end: bounds.end - range.start }
                : adjacent(selectedText, match.index, match[0].length, rule);
              if (span) {
                span.start += range.start; span.end += range.start;
                const key = `${order}:${span.start}:${span.end}`;
                if (captureKeys.has(key)) continue;
                captureKeys.add(key);
                // ponytail: hostile-input ceiling; paginate if 50k captures/source becomes a real need.
                if (candidates++ === MAX_CAPTURE_CANDIDATES) { truncated = true; break captureRules; }
                captures.push({ start: span.start, end: span.end, slot: rule.slot ?? "",
                  order: captures.length, assign: true });
              }
            }
          }
          const admitted = new Map<string, { value: string; receipt: LegalEvidenceReceipt }>();
          for (const span of resolveCaptures(captures, input.conflict)) {
            const key = `${span.start}:${span.end}`; let match = admitted.get(key);
            if (!match) {
              if (pageFull || foundEvidence.size === limit) { resultLimited = true; continue; }
              const length = span.end - span.start;
              const value = text.slice(span.start, span.end), block = adapter.smallestContainingDocumentBlock(
                passage.documentArtifact, span.start, span.end), receipt = passage.evidence(
                  { ...span, text: value,
                ...((locator) => locator ? {
                  blockId: `${locator.kind}:${locator.label}:${span.start}:${span.end}`,
                  locator } : {})(provenBlockLocator(passage.documentArtifact, block, span)) });
              if (!receipt || !afterCursor(source.id, receipt)) continue;
              if (length > MAX_CAPTURE_CHARS) { sizeLimited = true; continue; }
              if (foundChars + length > MAX_CAPTURE_CHARS)
                { pageFull = true; resultLimited = true; continue; }
              match = { value, receipt }; admitted.set(key, match); foundChars += length;
              foundEvidence.add(receipt.evidence_id);
            }
            found.push({ span: match.value, receipt: match.receipt, slot: span.slot, assign: span.assign });
          }
        } else {
          for (const block of blocks) {
            if (foundEvidence.size === limit) break;
            if (!allowed.has(block.kind)) continue;
            const span = text.slice(block.start, block.end);
            if (matches(clean(span))) {
              const receipt = passage.evidence({ text: span, start: block.start, end: block.end,
                ...(block.kind === "document" ? {} : {
                  blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
                  locator: { kind: block.kind as LegalEvidenceReceipt["locator"]["kind"],
                    label: block.label } }) });
              if (receipt && afterCursor(source.id, receipt)) {
                if (span.length > MAX_CAPTURE_CHARS) { sizeLimited = true; continue; }
                if (foundChars + span.length > MAX_CAPTURE_CHARS)
                  { pageFull = true; resultLimited = true; break; }
                foundChars += span.length; foundEvidence.add(receipt.evidence_id);
                found.push({ span, receipt }); }
            }
          }
        }
        if (truncated || pageFull || foundEvidence.size === limit || foundChars === MAX_CAPTURE_CHARS) {
          resultLimited = true; break;
        }
      }
      if (truncated) return { sourceId: source.id, sourceSha256s,
        failure: "capture_limit", found };
      return { sourceId: source.id, sourceSha256s,
        ...(sizeLimited ? { failure: "capture_size_limit" }
          : resultLimited ? { failure: "result_limit" } : {}), found };
    } catch (error) { options.signal?.throwIfAborted();
      if (error instanceof ApplicationError && cursor?.[0] === sourceId) throw error;
      return { sourceId, failure: "unavailable", found: [] }; }
  };
  for (let offset = 0; offset < sources.length && evidence.length < limit && !captureFull; offset += 4) {
    const results = await Promise.all(sources.slice(offset, offset + 4).map(scan));
    for (const result of results) { attempted.push(result.sourceId);
      result.sourceSha256s?.forEach((value) =>
        rememberFingerprint(result.sourceId, value));
      if (result.failure) fail(result.sourceId, result.failure);
      for (const { span, receipt, slot, assign } of result.found) {
        add(span, receipt, result.sourceId, slot, assign);
      }
    }
  }
  if (!cursorFound) throw new ApplicationError(409, "Research continuation is unavailable. Restart the search.");
  const bounded = evidence.length === limit || captureFull || failures.some(({ code }) =>
    code === "result_limit" || code === "capture_limit"),
    incomplete = !!cursor?.[4] || failures.some(({ code }) => code !== "result_limit"),
    coverage = { complete: !bounded && !failures.length && !incomplete,
      next_after: bounded && lastMatch ? Buffer.from(JSON.stringify([
        ...lastMatch, sha256(JSON.stringify([...(sourceFingerprints[lastMatch[0]] ?? [])].sort())),
        selection, incomplete])).toString("base64url") : null,
      attempted_sources: attempted.length,
      selected_sources: sources.length };
  const base = { call_id: options.actor?.callId ?? randomUUID(), tool: "Read" as const,
    executed_at: new Date().toISOString(), executor_version: "legal-source-pattern-v1" as const,
    input: { ...(rules.length ? { rules, conflict: input.conflict ?? "first" }
      : { pattern: query, syntax: input.syntax }), target: input.target,
      source_ids: requested, label_ids: input.labelIds ?? [],
      ...(input.evidenceIds ? { evidence_ids: input.evidenceIds } : {}),
      ...(input.members ? { members: input.members } : {}),
      ...(options.context?.restricted ? { scope: options.context.subjects?.map(({ resource, evidence }) =>
        ({ resource, ...(evidence ? { evidence_ids: evidence.map(({ evidence_id }) => evidence_id) } : {}) })) } : {}),
      ...(input.unlabelled ? { unlabelled: true } : {}), limit,
      ...(input.after ? { after: input.after } : {}), coverage },
    results: evidence.slice(0, 100).map(({ evidence_id }, rank) => ({ rank: rank + 1, evidence_id })) };
  const turn = createLegalEvidenceTurnState();
  registerLegalResearchQueries(turn, [base], options.actor?.model ?? "human");
  const standard = [...turn.queries.values()][0];
  const receipt: ResearchQueryReceipt = { ...standard, sourceIds: attempted,
    matchedSourceIds: [...matched],
    evidenceIds: evidence.map(({ evidence_id }) => evidence_id), failures, slots, sourceFingerprints,
    sourceReferences: Object.fromEntries(attempted.map((id) =>
      [id, structuredClone(state.sources[id].reference)])),
    labelPaths: Object.fromEntries([...new Set([...(input.labelIds ?? []), ...rules.flatMap(
      ({ slot }) => slot ? [slot] : [])])].flatMap((id) => {
      const path = researchLabelPath(state, id); return path ? [[id, path]] : []; })) };
  const checkpointed = !!options.assistant;
  const updated = await commitResearchFile(documents, scope, file,
      { type: "merge", evidence, queries: [receipt], labels: labelsByEvidence }, options.assistant, options.operation);
  if (!updated) throw new ApplicationError(409, "This research file changed. Reload it.",
    { code: "revision_conflict" });
  return { file: updated, receipt, evidence, checkpointed, coverage };
}
