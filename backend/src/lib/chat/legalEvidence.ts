import crypto from "node:crypto";

import {
  getA2AJDocumentSourceDoc,
  getA2AJLookupDocument,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../a2aj";
import { hasCitationInText } from "../citationKey";
import {
  buildA2AJParagraphRangeUrl,
  buildA2AJPinpointUrl,
  formatLegalLocator,
  hasCanadianDecisionLink,
} from "../legalSourceLinks";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type OpenAIToolSchema,
  type UserApiKeys,
} from "../llm";
import { normalizeWhitespace } from "../text";

export const LEGAL_EVIDENCE_TOOL_NAME = "submit_grounded_answer";
export type LegalEvidenceMode = "citation_structure";
export type LegalSourceClass = "case" | "legislation" | "commentary";

export type LegalEvidenceReceipt = {
  evidence_id: string;
  provider: "a2aj" | "benchmark" | "citator" | "journal" | "library";
  jurisdiction: string;
  source_class: LegalSourceClass;
  stable_source_id: string;
  source_sha256: string;
  scope: "document" | "passage";
  block_id: string;
  exact_span_sha256?: string;
  span_sha256: string;
  span_text: string | null;
  citation: string;
  name: string | null;
  dataset: string;
  language: "en" | "fr";
  version: string | null;
  external_url: string | null;
  locator: {
    kind: "document" | A2AJLocatorLookup["requested"]["kind"] | "footnote";
    label: string;
  };
  resolver_version:
    | "a2aj-inline-v1"
    | "benchmark-span-v1"
    | "citator-standsfor-v1"
    | "citator-noteup-v1"
    | "public-journal-v1"
    | "library-read-v1";
};

export type RegisteredEvidence = {
  receipt: LegalEvidenceReceipt;
  document?: A2AJDocument;
  lookup?: A2AJLocatorLookup;
};

export type GroundedLegalClaim = {
  text: string;
  evidence_ids: string[];
};

export type LegalEvidenceTurnState = {
  mode: LegalEvidenceMode | null;
  evidence: Map<string, RegisteredEvidence>;
  answer: GroundedLegalClaim[] | null;
  attempted: boolean;
  failure: string | null;
};

export function createLegalEvidenceTurnState(
  mode: LegalEvidenceMode | null = null,
): LegalEvidenceTurnState {
  return { mode, evidence: new Map(), answer: null, attempted: false, failure: null };
}

function sha256(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function withEvidenceId(
  receipt: Omit<LegalEvidenceReceipt, "evidence_id">,
): LegalEvidenceReceipt {
  const identity = JSON.stringify([
    receipt.provider,
    receipt.stable_source_id,
    receipt.source_sha256,
    receipt.scope,
    receipt.block_id,
    receipt.exact_span_sha256 ?? receipt.span_sha256,
    receipt.resolver_version,
  ]);
  return {
    evidence_id: `e_${crypto.createHash("sha256").update(identity).digest("base64url").slice(0, 18)}`,
    ...receipt,
  };
}

function stableA2AJSourceId(source: {
  dataset: string;
  citation: string;
  language: "en" | "fr";
}) {
  return [
    "a2aj",
    source.language,
    source.dataset.trim().toLowerCase(),
    normalizeWhitespace(source.citation).toLowerCase(),
  ].join(":");
}

export function createA2AJDocumentEvidence(
  document: A2AJDocument,
  sourceClass: LegalSourceClass = "case",
): LegalEvidenceReceipt {
  const sourceText = getA2AJDocumentSourceDoc(document).text;
  return withEvidenceId({
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableA2AJSourceId(document),
    source_sha256: sha256(sourceText),
    scope: "document",
    block_id: "document",
    exact_span_sha256: sha256(sourceText),
    span_sha256: sha256(normalizeWhitespace(sourceText)),
    span_text: null,
    citation: document.citation,
    name: document.name,
    dataset: document.dataset,
    language: document.language,
    version: document.date,
    external_url: document.url,
    locator: { kind: "document", label: "document" },
    resolver_version: "a2aj-inline-v1",
  });
}

export function createA2AJLookupEvidence(
  lookup: A2AJLocatorLookup,
  sourceClass: LegalSourceClass = "case",
): LegalEvidenceReceipt | null {
  if (lookup.status !== "found" || !lookup.block) return null;
  const sourceText = getA2AJLookupDocument(lookup)?.text ?? lookup.block.text;
  return withEvidenceId({
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableA2AJSourceId(lookup),
    source_sha256: sha256(sourceText),
    scope: "passage",
    block_id: [lookup.block.kind, lookup.block.label, lookup.block.start, lookup.block.end].join(":"),
    exact_span_sha256: sha256(lookup.block.text),
    span_sha256: sha256(normalizeWhitespace(lookup.block.text)),
    span_text: lookup.block.text,
    citation: lookup.citation,
    name: lookup.name,
    dataset: lookup.dataset,
    language: lookup.language,
    version: null,
    external_url: lookup.url,
    locator: { kind: lookup.requested.kind, label: lookup.requested.label },
    resolver_version: "a2aj-inline-v1",
  });
}

export function createBenchmarkEvidence(args: {
  jurisdiction: string;
  sourceClass: LegalSourceClass;
  stableSourceId: string;
  sourceText: string;
  spanText: string;
  citation: string;
  name?: string | null;
  dataset: string;
  language?: "en" | "fr";
  version?: string | null;
  externalUrl?: string | null;
  locatorKind?: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabel: string;
}): LegalEvidenceReceipt {
  return withEvidenceId({
    provider: "benchmark",
    jurisdiction: args.jurisdiction,
    source_class: args.sourceClass,
    stable_source_id: args.stableSourceId,
    source_sha256: sha256(args.sourceText),
    scope: "passage",
    block_id: `${args.locatorKind ?? "section"}:${args.locatorLabel}`,
    exact_span_sha256: sha256(args.spanText),
    span_sha256: sha256(normalizeWhitespace(args.spanText)),
    span_text: args.spanText,
    citation: args.citation,
    name: args.name ?? null,
    dataset: args.dataset,
    language: args.language ?? "en",
    version: args.version ?? null,
    external_url: args.externalUrl ?? null,
    locator: { kind: args.locatorKind ?? "section", label: args.locatorLabel },
    resolver_version: "benchmark-span-v1",
  });
}

export function createLibraryEvidence(args: {
  documentId: string;
  versionId: string;
  filename: string;
  sourceText: string;
  spanText: string;
  start: number;
  end: number;
}): LegalEvidenceReceipt {
  return withEvidenceId({
    provider: "library",
    jurisdiction: "matter",
    source_class: "commentary",
    stable_source_id: args.documentId,
    source_sha256: sha256(args.sourceText),
    scope: "passage",
    block_id: `chars:${args.start}-${args.end}`,
    exact_span_sha256: sha256(args.spanText),
    span_sha256: sha256(normalizeWhitespace(args.spanText)),
    span_text: args.spanText,
    citation: args.filename,
    name: args.filename,
    dataset: "library",
    language: "en",
    version: args.versionId,
    external_url: null,
    locator: { kind: "document", label: "document" },
    resolver_version: "library-read-v1",
  });
}

export function attestedCharacterizationReceipt(args: {
  citedCitation: string;
  characterization: {
    text: string;
    citingCitation: string | null;
    citingName: string | null;
    citingCourt: string | null;
    citingDate: string | null;
    spanSha256: string;
    sourceKind?: "case" | "commentary";
    journalName?: string | null;
    citingUrl?: string | null;
  };
  jurisdiction?: string;
  language?: "en" | "fr";
}): LegalEvidenceReceipt {
  const commentary = args.characterization.sourceKind === "commentary";
  const citing = commentary
    ? (args.characterization.journalName ?? "journal commentary")
    : (args.characterization.citingCitation ?? args.characterization.citingName ?? "unknown citing case");
  return withEvidenceId({
    provider: "citator",
    jurisdiction: args.jurisdiction ?? "CA",
    source_class: "case",
    stable_source_id: `citator:standsfor:${citing}`,
    source_sha256: sha256(args.characterization.text),
    scope: "passage",
    block_id: `standsfor:${citing}`,
    exact_span_sha256: sha256(args.characterization.text),
    span_sha256: sha256(normalizeWhitespace(args.characterization.text)),
    span_text: args.characterization.text,
    citation: args.citedCitation,
    name: args.characterization.citingName,
    dataset: commentary ? "journal-commentary" : "citator",
    language: args.language ?? "en",
    version: args.characterization.citingDate,
    external_url: args.characterization.citingUrl ?? null,
    locator: {
      kind: "document",
      label: commentary
        ? `as characterized in ${citing}`
        : `as characterized by ${citing}${args.characterization.citingCourt ? ` (${args.characterization.citingCourt})` : ""}`,
    },
    resolver_version: "citator-standsfor-v1",
  });
}

export function citatorNoteUpReceipt(args: {
  citedCitation: string;
  entry: {
    citation: string | null;
    name: string | null;
    court: string | null;
    date: string | null;
    url: string | null;
    paragraph: number | null;
    excerpt: string;
  };
}): LegalEvidenceReceipt {
  const source = args.entry.citation ?? args.entry.name ?? "unknown-citing-case";
  return withEvidenceId({
    provider: "citator",
    jurisdiction: "CA",
    source_class: "case",
    stable_source_id: `citator:noteup:${normalizeWhitespace(source).toLowerCase()}`,
    source_sha256: sha256(args.entry.excerpt),
    scope: "passage",
    block_id: `noteup:${source}:${args.entry.paragraph === null ? "passage" : `para:${args.entry.paragraph}`}`,
    exact_span_sha256: sha256(args.entry.excerpt),
    span_sha256: sha256(normalizeWhitespace(args.entry.excerpt)),
    span_text: args.entry.excerpt,
    citation: args.entry.citation ?? args.citedCitation,
    name: args.entry.name,
    dataset: "citator",
    language: "en",
    version: args.entry.date,
    external_url: args.entry.url,
    locator: {
      kind: "document",
      label: `${source}${args.entry.paragraph === null ? "" : ` at para ${args.entry.paragraph}`}`,
    },
    resolver_version: "citator-noteup-v1",
  });
}

function createJournalEvidence(args: {
  citation: string;
  name: string | null;
  date: string | null;
  url: string | null;
  text: string;
  articleId: string;
  language?: "en" | "fr";
  locatorKind: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabel: string;
}): LegalEvidenceReceipt {
  return withEvidenceId({
    provider: "journal",
    jurisdiction: "CA",
    source_class: "commentary",
    stable_source_id: `journal:${args.articleId}`,
    source_sha256: sha256(args.text),
    scope: "passage",
    block_id: `article:${args.articleId}:${args.locatorKind}:${args.locatorLabel}`,
    exact_span_sha256: sha256(args.text),
    span_sha256: sha256(normalizeWhitespace(args.text)),
    span_text: args.text,
    citation: args.citation,
    name: args.name,
    dataset: "journal",
    language: args.language ?? "en",
    version: args.date,
    external_url: args.url,
    locator: { kind: args.locatorKind, label: args.locatorLabel },
    resolver_version: "public-journal-v1",
  });
}

export function createPublicJournalDocumentEvidence(
  args: Omit<Parameters<typeof createJournalEvidence>[0], "locatorKind" | "locatorLabel">,
) {
  return createJournalEvidence({ ...args, locatorKind: "document", locatorLabel: "article" });
}

export function createPublicJournalPassageEvidence(
  args: Omit<Parameters<typeof createJournalEvidence>[0], "locatorKind"> & {
    locatorKind: "paragraph" | "section" | "page" | "footnote";
  },
) {
  return createJournalEvidence(args);
}

export function registerLegalEvidence(
  state: LegalEvidenceTurnState,
  receipt: LegalEvidenceReceipt | undefined,
  source: { document?: A2AJDocument; lookup?: A2AJLocatorLookup } = {},
) {
  if (receipt) state.evidence.set(receipt.evidence_id, { receipt, ...source });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedReceipt(value: unknown): LegalEvidenceReceipt | null {
  const row = object(value);
  const locator = object(row?.locator);
  return row &&
    typeof row.evidence_id === "string" && row.evidence_id.startsWith("e_") &&
    typeof row.stable_source_id === "string" && typeof row.source_sha256 === "string" &&
    typeof row.span_sha256 === "string" &&
    (row.span_text === null || typeof row.span_text === "string") &&
    typeof row.citation === "string" && typeof row.dataset === "string" &&
    typeof row.jurisdiction === "string" && locator &&
    typeof locator.kind === "string" && typeof locator.label === "string"
    ? row as LegalEvidenceReceipt
    : null;
}

export function priorLegalEvidenceReceipts(events: readonly unknown[]) {
  const receipts = new Map<string, LegalEvidenceReceipt>();
  for (const value of events) {
    const event = object(value);
    const source = event?.type === "legal_evidence_receipt" && event.status === "passed"
      ? event
      : event?.type === "subagent_run" && event.status === "completed"
        ? object(event.grounding)
        : null;
    if (source?.status !== "passed" || !Array.isArray(source.evidence)) continue;
    for (const value of source.evidence) {
      const receipt = storedReceipt(value);
      if (receipt) receipts.set(receipt.evidence_id, receipt);
    }
  }
  return [...receipts.values()];
}

export function registerPriorLegalEvidence(
  state: LegalEvidenceTurnState,
  receipts: readonly LegalEvidenceReceipt[],
) {
  for (const receipt of receipts) registerLegalEvidence(state, receipt);
}

export function priorLegalEvidencePrompt(receipts: readonly LegalEvidenceReceipt[]) {
  const passages = receipts.filter((receipt) => receipt.scope === "passage" && receipt.span_text);
  return passages.length
    ? [
        "VERIFIED EVIDENCE AVAILABLE FROM PRIOR TURNS:",
        "These exact passages and evidence_ids are already registered in this turn. Use them directly in submit_grounded_answer. Do not re-fetch them. Test each passage against the current request and omit merely related material.",
        ...passages.map((receipt) => JSON.stringify({
          evidence_id: receipt.evidence_id,
          citation: receipt.citation,
          name: receipt.name,
          locator: receipt.locator,
          exact_passage: receipt.span_text,
        })),
      ].join("\n")
    : "";
}

function parseClaims(value: unknown, state: LegalEvidenceTurnState) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    return { claims: null, errors: ["claims must contain 1 to 64 items"] };
  const claims: GroundedLegalClaim[] = [];
  const errors: string[] = [];
  value.forEach((value, index) => {
    const row = object(value);
    const text = typeof row?.text === "string" ? row.text.trim() : "";
    const rawIds = row?.evidence_ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    if (!row || Object.keys(row).some((key) => !["text", "evidence_ids"].includes(key)))
      errors.push(`claims[${index}] has unknown fields`);
    if (!text || text.length > 4_000) errors.push(`claims[${index}].text is invalid`);
    if (!ids.length || ids.length > 16 || ids.length !== (Array.isArray(rawIds) ? rawIds.length : 0) || new Set(ids).size !== ids.length)
      errors.push(`claims[${index}].evidence_ids must contain 1 to 16 unique handles`);
    for (const id of ids) {
      const receipt = state.evidence.get(id)?.receipt;
      if (!receipt) errors.push(`claims[${index}] has unknown evidence_id: ${id}`);
      else if (receipt.scope !== "passage") errors.push(`claims[${index}] requires passage evidence for ${id}`);
    }
    claims.push({ text, evidence_ids: ids });
  });
  return { claims, errors };
}

export function submitLegalEvidenceAnswer(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  state.attempted = true;
  if (Object.keys(args).some((key) => key !== "claims"))
    return { ok: false, errors: ["answer has unknown fields"] };
  const { claims, errors } = parseClaims(args.claims, state);
  if (!claims || errors.length) return { ok: false, errors: errors.slice(0, 12) };
  state.answer = claims;
  state.failure = null;
  return { ok: true, terminal: true };
}

const claimSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      maxLength: 4_000,
      description: "One independently checkable support unit in natural Markdown. Omit citation and pinpoint text.",
    },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string" },
      description: "Turn-local evidence_id values whose exact passages jointly support the whole unit.",
    },
  },
  required: ["text", "evidence_ids"],
} as const;

export const LEGAL_EVIDENCE_SUBMIT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_TOOL_NAME,
    strict: true,
    description: "Finish a legal answer as independently checkable support units tied to exact passage evidence. Put sources only in evidence_ids. This call is the final answer.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: { type: "array", minItems: 1, maxItems: 64, items: claimSchema },
      },
      required: ["claims"],
    },
  },
};

export function legalEvidenceTools(): OpenAIToolSchema[] {
  return [LEGAL_EVIDENCE_SUBMIT_TOOL];
}

const emptyUsage = (): NormalizedLlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

async function structureDraft(args: {
  state: LegalEvidenceTurnState;
  model: string;
  draft: string;
  requestContext?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}) {
  return streamChatWithTools({
    model: args.model,
    systemPrompt: "Return no prose. Call submit_grounded_answer once. Do not add facts absent from the supplied evidence.",
    messages: [{
      role: "user",
      content: JSON.stringify({
        instruction: "Convert the candidate answer into prose-only support units. Keep only propositions supported by their exact passages; omit citation and pinpoint text.",
        request: args.requestContext,
        candidate_answer: args.draft,
        evidence: [...args.state.evidence.values()].map(({ receipt }) => ({
          evidence_id: receipt.evidence_id,
          citation: receipt.citation,
          locator: receipt.locator.label,
          span_text: receipt.span_text,
        })),
      }),
    }],
    tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
    maxIterations: 2,
    apiKeys: args.apiKeys,
    reasoningEffort: args.reasoningEffort,
    enableThinking: false,
    abortSignal: args.abortSignal,
    runTools: async (calls) => calls.map((call) => {
      const submitted = call.name === LEGAL_EVIDENCE_TOOL_NAME
        ? submitLegalEvidenceAnswer(call.input, args.state)
        : { ok: false, errors: [`Unexpected tool: ${call.name}`] };
      return {
        tool_use_id: call.id,
        content: JSON.stringify(submitted),
        terminal: "terminal" in submitted && submitted.terminal === true,
      };
    }),
  });
}

export type LegalEvidenceFinalizationResult = {
  passed: boolean;
  modelCalls: number;
  usage: NormalizedLlmUsage;
  diagnostic: string | null;
};

export async function finalizeLegalEvidenceExperiment(args: {
  state: LegalEvidenceTurnState;
  model: string;
  draft: string;
  requestContext?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}): Promise<LegalEvidenceFinalizationResult> {
  const usage = emptyUsage();
  const { state } = args;
  if (!state.mode && !state.answer && (
    hasCitationInText(args.draft) ||
    hasCanadianDecisionLink(args.draft) ||
    [...state.evidence.values()].some(({ receipt }) => receipt.provider !== "library")
  )) state.mode = "citation_structure";
  if (!state.mode || (!state.answer && !hasCitationInText(args.draft) && !hasCanadianDecisionLink(args.draft)))
    return { passed: true, modelCalls: 0, usage, diagnostic: null };
  state.attempted = true;
  try {
    const result = !state.answer && args.draft.trim() ? await structureDraft(args) : null;
    if (!state.answer) {
      state.failure = "The model did not submit a grounded answer.";
      return { passed: false, modelCalls: result ? 1 : 0, usage: result?.usage ?? usage, diagnostic: null };
    }
    return { passed: true, modelCalls: result ? 1 : 0, usage: result?.usage ?? usage, diagnostic: null };
  } catch (error) {
    if (args.abortSignal?.aborted || (error as { name?: unknown })?.name === "AbortError") throw error;
    state.answer = null;
    state.failure = "The answer could not be structured against the retrieved passages.";
    return { passed: false, modelCalls: 0, usage, diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

function citationFor(entry: RegisteredEvidence) {
  const { receipt, lookup } = entry;
  const range = receipt.locator.kind === "paragraph"
    ? receipt.locator.label.match(/^par(\d+)(?:-|–|—)par(\d+)$/iu)
    : null;
  const url = lookup && range
    ? buildA2AJParagraphRangeUrl(receipt.citation, range[1], range[2], [lookup], entry.document ? [entry.document] : [])
    : lookup
      ? buildA2AJPinpointUrl(lookup, [])
      : receipt.external_url;
  const locator = range
    ? `paras. ${Number(range[1])}–${Number(range[2])}`
    : receipt.locator.kind === "document"
      ? ""
      : formatLegalLocator(receipt.locator.kind, receipt.locator.label);
  const label = `${receipt.citation}${locator ? receipt.locator.kind === "section" ? `, ${locator}` : ` at ${locator}` : ""}`;
  return {
    markdown: url
      ? `[${label.replace(/[\\[\]]/gu, "\\$&")}](${url.replace(/\)/gu, "%29")})`
      : label,
    candidates: [label, receipt.citation, locator].filter(Boolean).sort((a, b) => b.length - a.length),
  };
}

export function renderLegalEvidenceAnswer(state: LegalEvidenceTurnState): string | null {
  if (state.failure) return state.failure;
  if (!state.answer) return null;
  if (state.mode === null) {
    const refs = new Map(legalEvidenceCitationEntries(state).map(({ ref, receipt }) => [receipt.evidence_id, ref]));
    return state.answer.map((claim) => {
      const markers = [...new Set(claim.evidence_ids.flatMap((id) => refs.has(id) ? [`[${refs.get(id)}]`] : []))];
      return `${claim.text}${markers.length ? ` ${markers.join("")}` : ""}`;
    }).join("\n\n");
  }
  return state.answer.map((claim) => {
    const citations = [...new Map(claim.evidence_ids.flatMap((id) => {
      const entry = state.evidence.get(id);
      return entry ? [[`${entry.receipt.stable_source_id}|${entry.receipt.locator.kind}|${entry.receipt.locator.label}`, citationFor(entry)] as const] : [];
    })).values()];
    let text = claim.text;
    const pending: string[] = [];
    citations.forEach((citation, index) => {
      const normalized = text.toLocaleLowerCase("en-CA");
      const candidate = citation.candidates.find((value) => normalized.includes(value.toLocaleLowerCase("en-CA")));
      if (!candidate) return void pending.push(citation.markdown);
      const start = normalized.indexOf(candidate.toLocaleLowerCase("en-CA"));
      const token = `\u0000legal-citation-${index}\u0000`;
      text = text.slice(0, start) + token + text.slice(start + candidate.length);
      text = text.replace(token, citation.markdown);
    });
    if (!pending.length) return text;
    const punctuation = text.match(/[.!?]$/u)?.[0] ?? "";
    return `${punctuation ? text.slice(0, -1) : text} ${pending.join("; ")}${punctuation}`;
  }).join("\n\n");
}

export function legalEvidenceCitationEntries(
  state: LegalEvidenceTurnState,
): Array<RegisteredEvidence & { ref: number }> {
  const entries: Array<RegisteredEvidence & { ref: number }> = [];
  const seen = new Set<string>();
  for (const claim of state.answer ?? []) for (const id of claim.evidence_ids) {
    const entry = state.evidence.get(id);
    if (!entry || seen.has(id)) continue;
    seen.add(id);
    entries.push({ ...entry, ref: entries.length + 1 });
  }
  return entries;
}

export type LegalEvidenceReceiptEvent = {
  type: "legal_evidence_receipt";
  schema_version: 6;
  mode: LegalEvidenceMode | null;
  status: "passed" | "failed";
  verification: {
    reference: "verified";
    answerability: "not_run";
    holistic: "not_run";
    semantic: "not_run";
    coverage: "not_run";
    authority: "not_run";
  };
  claims: Array<GroundedLegalClaim & {
    text_sha256: string;
    context_status: "not_run";
    evidence_status: "not_run";
  }>;
  evidence: LegalEvidenceReceipt[];
  bounces: [];
  failure: string | null;
};

export function legalEvidenceReceiptEvent(
  state: LegalEvidenceTurnState,
): LegalEvidenceReceiptEvent | null {
  if (!state.attempted) return null;
  const claims = state.answer ?? [];
  const ids = new Set(claims.flatMap((claim) => claim.evidence_ids));
  return {
    type: "legal_evidence_receipt",
    schema_version: 6,
    mode: state.mode,
    status: state.answer ? "passed" : "failed",
    verification: {
      reference: "verified",
      answerability: "not_run",
      holistic: "not_run",
      semantic: "not_run",
      coverage: "not_run",
      authority: "not_run",
    },
    claims: claims.map((claim) => ({
      ...claim,
      text_sha256: sha256(claim.text),
      context_status: "not_run",
      evidence_status: "not_run",
    })),
    evidence: [...ids].flatMap((id) => {
      const receipt = state.evidence.get(id)?.receipt;
      return receipt ? [receipt] : [];
    }),
    bounces: [],
    failure: state.failure,
  };
}
