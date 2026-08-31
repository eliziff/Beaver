import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { createLegalEvidenceTurnState, legalSourceEvidence, registerLegalResearchQueries,
  type LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readLegalSourcePassage } from "./legalSourceRegistry";
import { decodeResearchSetState, type PublicResearchSetAction, type ResearchQueryFailure,
  type ResearchQueryReceipt, type ResearchSetAction, type ResearchSetActor } from "./researchSet";
import { structureNative } from "./structureNative";
import type { WorkProductApplication } from "./workProductApplication";

export type ResearchSetQueryInput = { revision: number; text: string;
  syntax: "literal" | "terms"; target: "sources" | "passages";
  sourceIds?: string[]; labelIds?: string[]; limit?: number };
export type ResearchPassageReader = typeof readLegalSourcePassage;
const clean = (value: string) => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const exactQuote = (text: string, quote: string) => new RegExp(quote.split(" ").map((part) =>
  part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+"), "u").exec(text);
const allowed = new Set(["document", "paragraph", "section", "page", "footnote"]);
const MAX_CAPTURE_CHARS = 1_000_000;

export async function verifyPublicResearchPassageAction(application: Pick<WorkProductApplication, "get">,
  scope: ApplicationScope, id: string, revision: number, action: PublicResearchSetAction,
  reader: ResearchPassageReader = readLegalSourcePassage): Promise<ResearchSetAction> {
  if (action.type !== "passage") return action;
  const product = await application.get(scope, id);
  if (product.kind !== "research-set" || product.revision !== revision)
    throw new ApplicationError(409, "This research set changed. Reload it before continuing.");
  const source = decodeResearchSetState(product.state)?.sources[action.sourceId]?.reference;
  if (!source) throw new ApplicationError(400, "Research source not found");
  const read = await reader({ source, locator: action.locator, contextBlocks: 0 });
  const selected = read.status === "found" ? read.values.filter(({ role }) => role === "selected") : [];
  if (!selected.length) throw new ApplicationError(409, "The canonical source passage is unavailable");
  const first = selected[0], last = selected.at(-1)!, native = structureNative(),
    documentText = native.documentText(first.documentArtifact), from = first.blockArtifact?.start ?? 0,
    match = exactQuote(documentText.slice(from, last.blockArtifact?.end ?? documentText.length),
      clean(action.quote));
  if (!match) throw new ApplicationError(400, "The quote is not contained in the canonical passage");
  const start = from + match.index, label = action.locator.endValue
    ? `${action.locator.value}-${action.locator.endValue}` : action.locator.value;
  const evidence = legalSourceEvidence(first, { text: match[0], start, end: start + match[0].length,
    blockId: `${action.locator.kind}:${label}:${start}:${start + match[0].length}`,
    locator: { kind: action.locator.kind, label } });
  if (!evidence) throw new ApplicationError(409, "The canonical source passage is unavailable");
  return { type: "merge", evidence: [evidence] };
}

const selectedLabels = (state: NonNullable<ReturnType<typeof decodeResearchSetState>>, ids: string[]) => {
  const selected = new Set(ids), labels = Object.values(state.labels);
  if (ids.some((id) => !state.labels[id])) throw new ApplicationError(400, "Label not found");
  for (const id of selected) labels.forEach((label) => { if (label.parentId === id) selected.add(label.id); });
  return selected;
};
const labelled = (ids: string[], selected: Set<string>) =>
  !selected.size || ids.some((id) => selected.has(id));

export function createResearchSetQueryService(application: Pick<WorkProductApplication,
  "get" | "applyResearchSetAction">, reader: ResearchPassageReader = readLegalSourcePassage) {
  return { async run(scope: ApplicationScope, id: string, input: ResearchSetQueryInput,
    options: { signal?: AbortSignal; actor?: ResearchSetActor } = {}) {
    const product = await application.get(scope, id);
    if (product.kind !== "research-set" || product.revision !== input.revision)
      throw new ApplicationError(409, "This research set changed. Reload it before querying.");
    const state = decodeResearchSetState(product.state);
    if (!state) throw new ApplicationError(409, "Research set state is invalid");
    const query = input.text.trim();
    if (!query || query.length > 10_000) throw new ApplicationError(400, "Query text is invalid");
    const needles = [...new Set((input.syntax === "literal" ? [query] : query.split(/\s+/u))
      .map((term) => term.toLowerCase()))];
    if (needles.length > 100) throw new ApplicationError(400, "Query has too many terms");
    const matches = (text: string) => { const value = text.toLowerCase();
      return needles.every((term) => value.includes(term)); };
    const labels = selectedLabels(state, input.labelIds ?? []),
      limit = Math.max(1, Math.min(5_000, input.limit ?? 500));
    const requested = input.sourceIds?.length ? input.sourceIds : Object.keys(state.sources);
    if (requested.length > 10_000) throw new ApplicationError(400, "Too many sources selected");
    if (requested.some((sourceId) => !state.sources[sourceId]))
      throw new ApplicationError(400, "Source not found");
    const sources = requested.map((sourceId) => state.sources[sourceId]);
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const evidence: LegalEvidenceReceipt[] = [], seen = new Set<string>();
    const failures: ResearchQueryFailure[] = [], attempted: string[] = [], attemptedSet = new Set<string>();
    let captured = 0, cursor = 0;
    const add = (key: string, span: string, value: () => LegalEvidenceReceipt | undefined) => {
      if (seen.has(key) || evidence.length >= limit || captured + span.length > MAX_CAPTURE_CHARS) return;
      const found = value();
      if (found) { seen.add(key); captured += span.length; evidence.push(found); }
    };
    if (input.target === "passages") for (const item of Object.values(state.evidence)) {
      const source = sourceById.get(item.sourceId), span = item.receipt.span_text ?? "";
      if (source && (labelled(source.labelIds, labels) || labelled(item.labelIds, labels))) {
        if (!attemptedSet.has(source.id)) { attemptedSet.add(source.id); attempted.push(source.id); }
        if (matches(span)) add(item.receipt.evidence_id, span, () => item.receipt);
      }
      if (evidence.length === limit || captured === MAX_CAPTURE_CHARS) break;
    }
    const searchable = sources.filter((source) => labelled(source.labelIds, labels));
    const scan = async () => {
      while (input.target === "sources" && cursor < searchable.length && evidence.length < limit) {
        const source = searchable[cursor++]; attempted.push(source.id);
        try {
          const read = await reader({ source: source.reference, signal: options.signal });
          if (read.status !== "found") { failures.push({ sourceId: source.id, code: read.status }); continue; }
          const passage = read.values.find(({ role }) => role === "document") ?? read.values[0];
          if (!passage) { failures.push({ sourceId: source.id, code: "not_found" }); continue; }
          const native = structureNative(), text = native.documentText(passage.documentArtifact);
          const anchors = native.documentAnchors(passage.documentArtifact), blocks = anchors.length
            ? anchors : native.legalSourceViewer(passage.documentArtifact,
              source.reference.kind === "legislation" ? "section" : "paragraph").slices.map(
                ({ start, end }) => ({ kind: "document" as const,
                  label: `characters ${start + 1}–${end}`, start, end }));
          for (const block of blocks) {
            if (evidence.length === limit) break;
            if (!allowed.has(block.kind)) continue;
            const span = text.slice(block.start, block.end);
            if (matches(clean(span))) add(`${source.id}:${block.start}:${block.end}`, span,
              () => legalSourceEvidence(passage, { text: span, start: block.start, end: block.end,
                ...(block.kind === "document" ? {} : {
                  blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
                  locator: { kind: block.kind as LegalEvidenceReceipt["locator"]["kind"],
                    label: block.label } }) }));
          }
        } catch (error) {
          options.signal?.throwIfAborted(); failures.push({ sourceId: source.id, code: "unavailable" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, searchable.length) }, scan));
    const actor = options.actor ?? { kind: "human" as const, id: scope.userId };
    const base = { call_id: options.actor?.origin?.callId ?? randomUUID(), tool: "Read" as const,
      executed_at: new Date().toISOString(),
      executor_version: "legal-source-pattern-v1" as const,
      input: { pattern: input.text, syntax: input.syntax, target: input.target,
        source_ids: requested, label_ids: input.labelIds ?? [], capture_limit_chars: MAX_CAPTURE_CHARS },
      results: evidence.slice(0, 100).map(({ evidence_id }, rank) => ({ rank: rank + 1, evidence_id })) };
    const turn = createLegalEvidenceTurnState();
    registerLegalResearchQueries(turn, [base], actor.kind === "model" ? actor.id : "human");
    const standard = [...turn.queries.values()][0];
    const saved: ResearchQueryReceipt = { ...standard, sourceIds: attempted,
      evidenceIds: evidence.map(({ evidence_id }) => evidence_id), failures };
    const updated = await application.applyResearchSetAction(scope, id,
      { revision: input.revision, action: { type: "merge", evidence, queries: [saved] } }, actor);
    return { product: updated, queryId: saved.query_id, counts: { attemptedSources: attempted.length,
      matchedSources: new Set(evidence.map(({ stable_source_id }) => stable_source_id)).size,
      matches: evidence.length, failures: failures.length }, failures };
  } };
}

export type ResearchSetQueryService = ReturnType<typeof createResearchSetQueryService>;
