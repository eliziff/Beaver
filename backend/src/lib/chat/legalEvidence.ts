import crypto from "node:crypto";

import {
  getA2AJDocumentSourceDoc,
  getA2AJLookupDocument,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../a2aj";
import { hasCitationInText } from "../citationKey";
import {
  hasCanadianDecisionLink,
} from "../legalSourceLinks";
import {
  type NormalizedLlmUsage,
  type Tool,
  type UserApiKeys,
} from "../llm";
import { normalizeWhitespace } from "../text";
import {
  citationPresentationText,
  presentLegalEvidence,
} from "./citationPresentation";
import { groundedProseIntegrityErrors } from "./quoteRepair";

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
  target_citation?: string;
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
    | "citator-analysis-v1"
    | "citator-noteup-v1"
    | "public-journal-v1"
    | "library-read-v1"
    | "tabular-cell-v1";
  tabular?: {
    review_id: string;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
  };
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
  documentEvidenceIds: Set<string>;
  answer: GroundedLegalClaim[] | null;
  attempted: boolean;
  failure: string | null;
};

export function createLegalEvidenceTurnState(
  mode: LegalEvidenceMode | null = null,
): LegalEvidenceTurnState {
  return {
    mode,
    evidence: new Map(),
    documentEvidenceIds: new Set(),
    answer: null,
    attempted: false,
    failure: null,
  };
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
  locator?: {
    kind: "paragraph" | "page" | "section" | "footnote";
    label: string;
  };
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
    locator: args.locator ?? { kind: "document", label: "document" },
    resolver_version: "library-read-v1",
  });
}

export function createTabularEvidence(args: {
  reviewId: string;
  documentId: string;
  documentName: string;
  columnId: number;
  columnName: string;
  columnIndex: number;
  rowIndex: number;
  text: string;
}): LegalEvidenceReceipt {
  return withEvidenceId({
    provider: "library",
    jurisdiction: "matter",
    source_class: "commentary",
    stable_source_id: `tabular:${args.reviewId}:${args.documentId}:${args.columnId}`,
    source_sha256: sha256(args.text),
    scope: "passage",
    block_id: `cell:${args.rowIndex}:${args.columnIndex}`,
    exact_span_sha256: sha256(args.text),
    span_sha256: sha256(normalizeWhitespace(args.text)),
    span_text: args.text,
    citation: `${args.columnName} · ${args.documentName}`,
    name: args.documentName,
    dataset: "tabular-review",
    language: "en",
    version: null,
    external_url: null,
    locator: { kind: "document", label: "cell" },
    resolver_version: "tabular-cell-v1",
    tabular: {
      review_id: args.reviewId,
      col_index: args.columnIndex,
      row_index: args.rowIndex,
      col_name: args.columnName,
      doc_name: args.documentName,
    },
  });
}

export function attestedPassageReceipt(args: {
  citedCitation: string;
  passage: {
    text: string;
    citingCitation: string | null;
    citingName: string | null;
    citingCourt: string | null;
    citingDate: string | null;
    paragraph: number | null;
    pageLabel: string | null;
    sourceKind: "case" | "commentary";
    journalName?: string | null;
    sourceArticleId: string | null;
    citingUrl?: string | null;
  };
}): LegalEvidenceReceipt {
  const journal = args.passage.sourceKind === "commentary";
  const citation = args.passage.citingCitation ??
    args.passage.journalName ?? "unknown source";
  const locator = journal && args.passage.pageLabel
    ? { kind: "page" as const, label: args.passage.pageLabel }
    : !journal && args.passage.paragraph !== null
      ? { kind: "paragraph" as const, label: `par${args.passage.paragraph}` }
      : { kind: "document" as const, label: citation };
  return withEvidenceId({
    provider: journal ? "journal" : "citator",
    jurisdiction: "CA",
    source_class: journal ? "commentary" : "case",
    stable_source_id: journal
      ? `journal:${args.passage.sourceArticleId ?? normalizeWhitespace(citation).toLowerCase()}`
      : `citator:discussion:${normalizeWhitespace(citation).toLowerCase()}`,
    source_sha256: sha256(args.passage.text),
    scope: "passage",
    block_id: `analysis:${citation}:${locator.kind}:${locator.label}`,
    exact_span_sha256: sha256(args.passage.text),
    span_sha256: sha256(normalizeWhitespace(args.passage.text)),
    span_text: args.passage.text,
    citation,
    target_citation: args.citedCitation,
    name: args.passage.citingName ?? args.passage.journalName ?? null,
    dataset: journal ? "journal-commentary" : "citator",
    language: "en",
    version: args.passage.citingDate,
    external_url: args.passage.citingUrl ?? null,
    locator,
    resolver_version: "citator-analysis-v1",
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

export function registerDocumentLegalEvidence(
  state: LegalEvidenceTurnState,
  evidenceIds: readonly string[],
) {
  evidenceIds.forEach((evidenceId) => state.documentEvidenceIds.add(evidenceId));
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

const CASE_NAME = /(?:^|[^\p{L}])(?:R\.|[A-Z][\p{L}\p{M}'\u2019.&-]*(?:\s+(?:of|the|and|&|[A-Z][\p{L}\p{M}'\u2019.&-]*)){0,6})\s+v(?:\.|ersus)?\s+[A-Z][\p{L}\p{M}'\u2019.&-]*/mu;

export function hasCaseNameInText(text: string) {
  return CASE_NAME.test(text);
}

export function legalEvidenceProseIntegrityErrors(
  text: string,
  citedEvidenceIds: readonly string[],
  state: LegalEvidenceTurnState,
) {
  return groundedProseIntegrityErrors(
    text,
    citedEvidenceIds,
    [...state.evidence.values()].flatMap(({ receipt }) => receipt.span_text
      ? [{
          evidenceId: receipt.evidence_id,
          text: receipt.span_text,
          labels: [receipt.name, receipt.citation].filter((value): value is string => Boolean(value)),
        }]
      : []),
  );
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
  const integrityErrors = claims.flatMap((claim, index) =>
    legalEvidenceProseIntegrityErrors(claim.text, claim.evidence_ids, state)
      .map((error) => `claims[${index}] ${error}`),
  );
  if (integrityErrors.length) return { ok: false, errors: integrityErrors.slice(0, 12) };
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

export const LEGAL_EVIDENCE_SUBMIT_TOOL: Tool = {
  name: LEGAL_EVIDENCE_TOOL_NAME,
  description: "Finish an answer that actually relies on retrieved passages as independently checkable support units. Do not use this for an answer that needs no sources. Put sources only in evidence_ids. This call is the final answer.",
  inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: { type: "array", minItems: 1, maxItems: 64, items: claimSchema },
      },
      required: ["claims"],
  },
};

const emptyUsage = (): NormalizedLlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

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
  const namesAuthority = hasCaseNameInText(args.draft);
  const citesAuthority = hasCitationInText(args.draft) ||
    hasCanadianDecisionLink(args.draft);
  if (!state.mode && !state.answer && (
    namesAuthority || citesAuthority ||
    [...state.evidence.values()].some(({ receipt }) => receipt.provider !== "library")
  )) state.mode = "citation_structure";
  if (!state.mode)
    return { passed: true, modelCalls: 0, usage, diagnostic: null };
  state.attempted = true;
  if (!state.answer && ![...state.evidence.values()].some(
    ({ receipt }) => receipt.scope === "passage",
  )) {
    state.failure = "The answer named legal authorities without verified passages.";
    return { passed: false, modelCalls: 0, usage, diagnostic: null };
  }
  if (!state.answer) {
    state.failure = "The model did not submit a grounded answer.";
    return { passed: false, modelCalls: 0, usage, diagnostic: null };
  }
  return { passed: true, modelCalls: 0, usage, diagnostic: null };
}

function citationFor(entry: RegisteredEvidence) {
  const presentation = presentLegalEvidence(entry);
  const authority = citationPresentationText(presentation.authority);
  const locator = presentation.locator?.text ?? "";
  const label = `${authority}${presentation.locator ? `${presentation.locator.separator}${locator}` : ""}`;
  return {
    markdown: presentation.passageUrl
      ? `[${label.replace(/[\\[\]]/gu, "\\$&")}](${presentation.passageUrl.replace(/\)/gu, "%29")})`
      : label,
    candidates: [label, authority, entry.receipt.citation, locator].filter(Boolean).sort((a, b) => b.length - a.length),
  };
}

export function renderLegalEvidenceAnswer(state: LegalEvidenceTurnState): string | null {
  if (state.failure) return null;
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
    const replacements = new Map<string, string>();
    citations.forEach((citation, index) => {
      const normalized = text.toLocaleLowerCase("en-CA");
      const candidate = citation.candidates.find((value) => normalized.includes(value.toLocaleLowerCase("en-CA")));
      if (!candidate) return void pending.push(citation.markdown);
      const start = normalized.indexOf(candidate.toLocaleLowerCase("en-CA"));
      const token = `\u0000legal-citation-${index}\u0000`;
      text = text.slice(0, start) + token + text.slice(start + candidate.length);
      replacements.set(token, citation.markdown);
    });
    if (pending.length) {
      const punctuation = text.match(/[.!?]$/u)?.[0] ?? "";
      text = `${punctuation ? text.slice(0, -1) : text} ${pending.join("; ")}${punctuation}`;
    }
    for (const [token, markdown] of replacements) text = text.replace(token, markdown);
    return text;
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
  if (!state.attempted && !state.documentEvidenceIds.size) return null;
  const claims = state.answer ?? [];
  const ids = new Set([
    ...claims.flatMap((claim) => claim.evidence_ids),
    ...state.documentEvidenceIds,
  ]);
  const passed = Boolean(state.answer || state.documentEvidenceIds.size);
  return {
    type: "legal_evidence_receipt",
    schema_version: 6,
    mode: state.mode,
    status: passed ? "passed" : "failed",
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
