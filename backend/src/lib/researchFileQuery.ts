import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { createLegalEvidenceTurnState, legalSourceEvidence, registerLegalResearchQueries,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import type { DocumentStore } from "./documentStore";
import { readLegalSourcePassage } from "./legalSourceRegistry";
import { readResearchFile, saveResearchFile, type PublicResearchFileAction,
  type ResearchFileAction, type ResearchFileState, type ResearchQueryReceipt } from "./researchFile";
import { structureNative } from "./structureNative";
import { escapeRegExp } from "./text";

export const researchCaptureRuleSchema = z.object({ phrase: z.string().trim().min(1).max(500),
  direction: z.enum(["before", "after"]), unit: z.enum(["sentence", "line", "paragraph", "chars"]),
  chars: z.number().int().min(1).max(50_000).optional(), slot: z.string().trim().min(1).max(200) }).strict();
export type ResearchCaptureRule = z.infer<typeof researchCaptureRuleSchema>;
export type ResearchFileQueryInput = { versionId: string; text?: string;
  syntax: "literal" | "terms"; target: "sources" | "passages";
  sourceIds?: string[]; labelIds?: string[]; limit?: number; rules?: ResearchCaptureRule[];
  conflict?: "prompt" | "first" | "longer" | "shorter" | "append" };
type ResearchPassageReader = typeof readLegalSourcePassage;
const clean = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const exactQuote = (text: string, quote: string) => new RegExp(quote.split(" ").map((part) =>
  escapeRegExp(part)).join("\\s+"), "u").exec(text);
const allowed = new Set(["document", "paragraph", "section", "page", "footnote"]);
const MAX_CAPTURE_CHARS = 1_000_000;

const adjacent = (text: string, lower: string, rule: ResearchCaptureRule) => {
  const at = lower.indexOf(rule.phrase.toLowerCase()); if (at < 0) return null;
  let start = rule.direction === "after" ? at + rule.phrase.length : 0,
    end = rule.direction === "before" ? at : text.length;
  const chars = rule.chars ?? 100, before = text.slice(0, end), after = text.slice(start);
  if (rule.unit === "chars") {
    if (rule.direction === "before") start = Math.max(0, end - chars); else end = start + chars;
  } else if (rule.unit === "line") {
    if (rule.direction === "before") start = before.lastIndexOf("\n") + 1;
    else { const at = after.indexOf("\n"); end = at < 0 ? start + chars : start + at; }
  } else if (rule.unit === "paragraph") {
    if (rule.direction === "before") {
      const at = Math.max(before.lastIndexOf("\n\n"), before.lastIndexOf("\r\n\r\n"));
      start = at < 0 ? Math.max(0, end - chars) : at + (before.startsWith("\r\n", at) ? 4 : 2);
    } else { const at = after.search(/\r?\n\s*\r?\n/u); end = at < 0 ? start + chars : start + at; }
  } else if (rule.direction === "before") {
    start = Math.max(before.lastIndexOf("."), before.lastIndexOf("?"), before.lastIndexOf("!")) + 1;
    if (!start) start = Math.max(0, end - chars);
  } else { const found = /[.!?](?:\s|$)/u.exec(after); end = found ? start + found.index + 1 : start + chars; }
  end = Math.min(text.length, end); while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && /\s/u.test(text[end - 1])) end--;
  if (rule.direction === "after") while (start < end && /[,;:]/u.test(text[start])) start++;
  return start < end ? { start, end, text: text.slice(start, end) } : null;
};

export async function verifyResearchPassage(documents: DocumentStore, scope: ApplicationScope,
  documentId: string, versionId: string, action: PublicResearchFileAction,
  reader: ResearchPassageReader = readLegalSourcePassage): Promise<ResearchFileAction> {
  if (action.type !== "passage") return action;
  const file = await readResearchFile(documents, scope, documentId);
  if (!file || file.versionId !== versionId)
    throw new ApplicationError(409, "This research file changed. Reload it before continuing.");
  const source = file.state.sources[action.sourceId]?.reference;
  if (!source) throw new ApplicationError(400, "Research source not found");
  const read = await reader({ source, locator: action.locator, contextBlocks: 0 });
  const selected = read.status === "found" ? read.values.filter(({ role }) => role === "selected") : [];
  if (!selected.length) throw new ApplicationError(409, "The canonical source passage is unavailable");
  const first = selected[0], last = selected.at(-1)!, native = structureNative(),
    text = native.documentText(first.documentArtifact), from = first.blockArtifact?.start ?? 0,
    match = exactQuote(text.slice(from, last.blockArtifact?.end ?? text.length), clean(action.quote));
  if (!match) throw new ApplicationError(400, "The quote is not contained in the canonical passage");
  const start = from + match.index, label = action.locator.endValue
    ? `${action.locator.value}-${action.locator.endValue}` : action.locator.value;
  const evidence = legalSourceEvidence(first, { text: match[0], start, end: start + match[0].length,
    blockId: `${action.locator.kind}:${label}:${start}:${start + match[0].length}`,
    locator: { kind: action.locator.kind, label } });
  if (!evidence) throw new ApplicationError(409, "The canonical source passage is unavailable");
  return { type: "merge", evidence: [evidence] };
}

const selectedLabels = (state: ResearchFileState, ids: string[]) => {
  const selected = new Set(ids), children = new Map<string, string[]>();
  if (ids.some((id) => !state.labels[id])) throw new ApplicationError(400, "Label not found");
  Object.values(state.labels).forEach((label) => { if (label.parentId) {
    const values = children.get(label.parentId);
    if (values) values.push(label.id); else children.set(label.parentId, [label.id]);
  } });
  for (const id of selected) children.get(id)?.forEach((child) => selected.add(child));
  return selected;
};
const labelled = (ids: string[], selected: Set<string>) =>
  !selected.size || ids.some((id) => selected.has(id));

export async function runResearchFileQuery(documents: DocumentStore, scope: ApplicationScope,
  documentId: string, input: ResearchFileQueryInput, options: {
    signal?: AbortSignal; actor?: { model?: string; callId?: string };
    reader?: ResearchPassageReader } = {}) {
  const file = await readResearchFile(documents, scope, documentId);
  if (!file || file.versionId !== input.versionId)
    throw new ApplicationError(409, "This research file changed. Reload it before querying.");
  const state = file.state, query = input.text?.trim() ?? "";
  let rules: Array<ResearchCaptureRule & { chars: number }>;
  try { rules = z.array(researchCaptureRuleSchema).max(50).parse(input.rules ?? [])
    .map((rule) => ({ ...rule, chars: rule.chars ?? 100 })); }
  catch { throw new ApplicationError(400, "Capture rules are invalid"); }
  if ((!query && !rules.length) || query.length > 10_000)
    throw new ApplicationError(400, "Query text is invalid");
  if (rules.length && input.target !== "sources")
    throw new ApplicationError(400, "Capture rules search saved sources");
  const needles = [...new Set((input.syntax === "literal" ? [query] : query.split(/\s+/u))
    .filter(Boolean).map((term) => term.toLowerCase()))];
  if (needles.length > 100) throw new ApplicationError(400, "Query has too many terms");
  const matches = (text: string) => { const value = text.toLowerCase();
    return needles.every((term) => value.includes(term)); };
  const labels = selectedLabels(state, input.labelIds ?? []),
    limit = Math.max(1, Math.min(5_000, input.limit ?? 500));
  const requested = input.sourceIds?.length ? [...new Set(input.sourceIds)] : Object.keys(state.sources);
  if (requested.length > 10_000 || requested.some((id) => !state.sources[id]))
    throw new ApplicationError(400, "Invalid source selection");
  const sources = requested.map((id) => state.sources[id]);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const evidence: LegalEvidenceReceipt[] = [], seen = new Set<string>(), failures: Array<{
    sourceId: string; code: string }> = [], attempted: string[] = [], attemptedSet = new Set<string>();
  const slots: Record<string, string[]> = {}, labelsByEvidence: Record<string, string[]> = {};
  let captured = 0, cursor = 0;
  const add = (span: string, receipt: () => LegalEvidenceReceipt | undefined, slot?: string,
    assign = true) => {
    const found = receipt(); if (!found || !seen.has(found.evidence_id) &&
      (evidence.length >= limit || captured + span.length > MAX_CAPTURE_CHARS)) return;
    if (!seen.has(found.evidence_id)) { seen.add(found.evidence_id); captured += span.length;
      evidence.push(found); }
    if (slot) {
      const names = slots[found.evidence_id] ??= []; if (!names.includes(slot)) names.push(slot);
      if (state.labels[slot]) { if (state.labels[slot].scope !== "highlight")
        throw new ApplicationError(400, "Capture slots must use highlight labels");
        if (assign) { const ids = labelsByEvidence[found.evidence_id] ??= [];
          if (!ids.includes(slot)) ids.push(slot); } }
    }
  };
  if (input.target === "passages") for (const item of Object.values(state.evidence)) {
    const source = sourceById.get(item.sourceId), span = item.receipt.span_text ?? "";
    if (source && (labelled(source.labelIds, labels) || labelled(item.labelIds, labels))) {
      if (!attemptedSet.has(source.id)) { attemptedSet.add(source.id); attempted.push(source.id); }
      if (matches(span)) add(span, () => item.receipt);
    }
    if (evidence.length === limit || captured === MAX_CAPTURE_CHARS) break;
  }
  const searchable = sources.filter((source) => labelled(source.labelIds, labels));
  const native = input.target === "sources" && searchable.length ? structureNative() : null;
  const scan = async () => {
    while (input.target === "sources" && cursor < searchable.length && evidence.length < limit) {
      const source = searchable[cursor++]; attempted.push(source.id);
      try {
        const read = await (options.reader ?? readLegalSourcePassage)({
          source: source.reference, signal: options.signal });
        if (read.status !== "found") { failures.push({ sourceId: source.id, code: read.status }); continue; }
        const passage = read.values.find(({ role }) => role === "document") ?? read.values[0];
        if (!passage) { failures.push({ sourceId: source.id, code: "not_found" }); continue; }
        const adapter = native!, text = adapter.documentText(passage.documentArtifact),
          anchors = adapter.documentAnchors(passage.documentArtifact), blocks = anchors.length
            ? anchors : adapter.legalSourceViewer(passage.documentArtifact,
              source.reference.kind === "legislation" ? "section" : "paragraph").slices.map(
                ({ start, end }) => ({ kind: "document" as const,
                  label: `characters ${start + 1}-${end}`, start, end }));
        if (rules.length) {
          const chosen = new Map<string, Array<{ start: number; end: number; text: string }>>();
          const lower = text.toLowerCase();
          rules.forEach((rule) => { const span = adjacent(text, lower, rule); if (!span) return;
            const current = chosen.get(rule.slot) ?? [], prior = current[0];
            if (!prior || input.conflict === "append" || input.conflict === "prompt")
              chosen.set(rule.slot, [...current, span]);
            else if (input.conflict === "longer" && span.text.length > prior.text.length ||
                input.conflict === "shorter" && span.text.length < prior.text.length)
              chosen.set(rule.slot, [span]);
          });
          chosen.forEach((values, slot) => values.forEach((span) => {
            const block = blocks.find((item) => allowed.has(item.kind) &&
              item.start <= span.start && item.end >= span.end);
            add(span.text, () => legalSourceEvidence(passage, { ...span, ...(block?.kind === "document"
              ? {} : block ? { blockId: `${block.kind}:${block.label}:${span.start}:${span.end}`,
                locator: { kind: block.kind as LegalEvidenceReceipt["locator"]["kind"],
                  label: block.label } } : {}) }), slot, input.conflict !== "prompt");
          }));
        } else for (const block of blocks) {
          if (evidence.length === limit) break;
          if (!allowed.has(block.kind)) continue;
          const span = text.slice(block.start, block.end);
          if (matches(clean(span))) add(span,
            () => legalSourceEvidence(passage, { text: span, start: block.start, end: block.end,
              ...(block.kind === "document" ? {} : {
                blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
                locator: { kind: block.kind as LegalEvidenceReceipt["locator"]["kind"],
                  label: block.label } }) }));
        }
      } catch { options.signal?.throwIfAborted();
        failures.push({ sourceId: source.id, code: "unavailable" }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, searchable.length) }, scan));
  const base = { call_id: options.actor?.callId ?? randomUUID(), tool: "Read" as const,
    executed_at: new Date().toISOString(), executor_version: "legal-source-pattern-v1" as const,
    input: { ...(rules.length ? { rules, conflict: input.conflict ?? "first" }
      : { pattern: query, syntax: input.syntax }), target: input.target,
      source_ids: requested, label_ids: input.labelIds ?? [], limit },
    results: evidence.slice(0, 100).map(({ evidence_id }, rank) => ({ rank: rank + 1, evidence_id })) };
  const turn = createLegalEvidenceTurnState();
  registerLegalResearchQueries(turn, [base], options.actor?.model ?? "human");
  const standard = [...turn.queries.values()][0];
  const receipt: ResearchQueryReceipt = { ...standard, sourceIds: attempted,
    evidenceIds: evidence.map(({ evidence_id }) => evidence_id), failures, slots };
  const updated = await saveResearchFile(documents, scope, documentId, input.versionId,
    { type: "merge", evidence, queries: [receipt], labels: labelsByEvidence }, !!options.actor?.model);
  if (!updated) throw new ApplicationError(409, "This research file changed. Reload it.");
  return { file: updated, queryId: receipt.query_id, counts: {
    attemptedSources: attempted.length,
    matchedSources: new Set(evidence.map(({ stable_source_id }) => stable_source_id)).size,
    matches: evidence.length, failures: failures.length }, failures };
}
