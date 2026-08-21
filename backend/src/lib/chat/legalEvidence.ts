import crypto from "node:crypto";

import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../legalSources/a2aj";
import type { SourceDoc } from "../sourceDoc";
import { hasCitationInText } from "../citationKey";
import {
  hasCanadianDecisionLink,
} from "../legalSourceLinks";
import { type Tool } from "../llm";
import { normalizeWhitespace } from "../text";
import { groundedProseIntegrityErrors } from "./quoteRepair";
import { jsonRecord as object } from "../value";

export const LEGAL_EVIDENCE_TOOL_NAME = "submit_grounded_answer";
export type LegalEvidenceMode = "citation_structure";
export type LegalSourceClass = "case" | "legislation" | "commentary";

export const GROUNDED_ANSWER_CONTRACT =
  "Whenever a claim depends on retrieved evidence, attach the exact evidence_id returned for the passage that supports it and finish with submit_grounded_answer. A tool call by itself does not require grounding; ground the claims that rely on its results. Put evidence only in evidence_ids. Do not write citation markers, URLs, source links, or pinpoints yourself.";
export const GROUNDED_CLAIM_GRANULARITY =
  "Keep each claim as narrow as the answer reasonably allows. Ordinarily, use one independently verifiable proposition per claim and attach only the smallest responsive passage. Never rely on a broad page, paragraph range, or section when a shorter passage or native pinpoint fully supports the proposition. Split claims when their propositions require different evidence.";
export const GROUNDED_QUOTATION_POLICY_CURRENT =
  "Prefer direct quotation when the source itself states the proposition. Quote the shortest passage that preserves the source's meaning and necessary context. Paraphrase only when combining sources, explaining their effect, or expressing the point more clearly. Keep each claim to one proposition, and attach only the evidence that supports that proposition. Split the claim when different propositions require different evidence. Avoid long quotations unless their full wording is necessary.";
export const GROUNDED_QUOTATION_POLICY_CLASSIC =
  "Default to concise direct quotations when the source's own words answer the question or materially sharpen the analysis. Weave one to three short exact spans into your prose, with your explanation between them when useful, then attach the supporting evidence_id once at the end of that support unit. Disjoint quoted spans may share that one citation. Paraphrase only when synthesis is materially clearer; do not replace useful source language with a generic summary. Do not dump long block quotations or use quotation as a substitute for analysis.";
export function selectGroundedQuotationPolicy(flag?: string) {
  return flag?.trim().toLowerCase() === "classic"
    ? GROUNDED_QUOTATION_POLICY_CLASSIC
    : GROUNDED_QUOTATION_POLICY_CURRENT;
}
export const GROUNDED_QUOTATION_POLICY = selectGroundedQuotationPolicy(
  process.env.BEAVER_GROUNDED_QUOTATION_POLICY,
);
export const GROUNDED_SUMMARY_POLICY =
  "A summary may group one to three closely connected sentences when they perform the same function and are supported by the same narrow evidence—for example, one fact cluster, issue, holding, reasoning step, or disposition. Start a new claim when the function or supporting evidence changes.";

export type LegalEvidenceReceipt = {
  evidence_id: string;
  provider: "a2aj" | "courtlistener" | "tna" | "govuk-et" | "govinfo" |
    "hansard" | "citator" | "journal" | "library";
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
    | "courtlistener-span-v1"
    | "tna-span-v1"
    | "govuk-et-span-v1"
    | "govinfo-span-v1"
    | "hansard-span-v1"
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
  source?: SourceDoc;
};

export type PriorLegalEvidence = LegalEvidenceReceipt | RegisteredEvidence;

export type GroundedLegalClaim = {
  text: string;
  evidence_ids: string[];
};

export type LegalEvidenceTurnState = {
  mode: LegalEvidenceMode | null;
  evidence: Map<string, RegisteredEvidence>;
  priorEvidenceIds: Set<string>;
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
    priorEvidenceIds: new Set(),
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

type PassageEvidence = Omit<LegalEvidenceReceipt, "evidence_id" | "source_sha256" |
  "scope" | "exact_span_sha256" | "span_sha256" | "span_text" | "language"> & {
    sourceText: string; spanText?: string; language?: "en" | "fr";
  };
function passageEvidence({ sourceText, spanText = sourceText, language = "en",
  ...receipt }: PassageEvidence) {
  return withEvidenceId({ ...receipt, source_sha256: sha256(sourceText), scope: "passage",
    exact_span_sha256: sha256(spanText), span_sha256: sha256(normalizeWhitespace(spanText)),
    span_text: spanText, language });
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

export function createA2AJLookupEvidence(
  lookup: A2AJLocatorLookup,
  sourceClass: LegalSourceClass = "case",
): LegalEvidenceReceipt | null {
  if (lookup.status !== "found" || !lookup.block) return null;
  const sourceText = a2ajLegalSourceProvider.source(lookup)?.text ?? lookup.block.text;
  return passageEvidence({
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableA2AJSourceId(lookup),
    sourceText,
    block_id: [lookup.block.kind, lookup.block.label, lookup.block.start, lookup.block.end].join(":"),
    spanText: lookup.block.text,
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

export function createA2AJPassageEvidence(args: {
  citation: string;
  name: string | null;
  dataset: string;
  language: "en" | "fr";
  sourceText: string;
  spanText: string;
  start: number;
  end: number;
  externalUrl: string | null;
  sourceClass: LegalSourceClass;
  blockId?: string;
  locator?: LegalEvidenceReceipt["locator"];
}): LegalEvidenceReceipt {
  const locator = args.locator ?? {
    kind: "document" as const,
    label: `characters ${args.start + 1}–${args.end}`,
  };
  return passageEvidence({
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: args.sourceClass,
    stable_source_id: stableA2AJSourceId(args),
    sourceText: args.sourceText,
    block_id: args.blockId ?? `chars:${args.start}-${args.end}`,
    spanText: args.spanText,
    citation: args.citation,
    name: args.name,
    dataset: args.dataset,
    language: args.language,
    version: null,
    external_url: args.externalUrl,
    locator,
    resolver_version: "a2aj-inline-v1",
  });
}

type DirectSourceProvider = "courtlistener" | "tna" | "govuk-et" | "govinfo" | "hansard";
type DirectSourceEvidenceArgs = {
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
};

function createDirectSourceEvidence(
  provider: DirectSourceProvider,
  args: DirectSourceEvidenceArgs,
): LegalEvidenceReceipt {
  return passageEvidence({
    provider,
    jurisdiction: args.jurisdiction,
    source_class: args.sourceClass,
    stable_source_id: args.stableSourceId,
    sourceText: args.sourceText,
    block_id: `${args.locatorKind ?? "section"}:${args.locatorLabel}`,
    spanText: args.spanText,
    citation: args.citation,
    name: args.name ?? null,
    dataset: args.dataset,
    language: args.language ?? "en",
    version: args.version ?? null,
    external_url: args.externalUrl ?? null,
    locator: { kind: args.locatorKind ?? "section", label: args.locatorLabel },
    resolver_version: `${provider}-span-v1`,
  });
}

export const createCourtlistenerEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("courtlistener", args);
export const createTnaEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("tna", args);
export const createGovUkEmploymentTribunalEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("govuk-et", args);
export const createGovInfoEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("govinfo", args);
export const createHansardEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("hansard", args);

export function createLibraryEvidence(args: {
  documentId: string;
  versionId: string;
  filename: string;
  sourceText: string;
  spanText: string;
  start: number;
  end: number;
  blockId?: string;
  locator?: {
    kind: "paragraph" | "page" | "section" | "footnote";
    label: string;
  };
}): LegalEvidenceReceipt {
  return passageEvidence({
    provider: "library",
    jurisdiction: "matter",
    source_class: "commentary",
    stable_source_id: args.documentId,
    sourceText: args.sourceText,
    block_id: args.blockId ?? `chars:${args.start}-${args.end}`,
    spanText: args.spanText,
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
  return passageEvidence({
    provider: "library",
    jurisdiction: "matter",
    source_class: "commentary",
    stable_source_id: `tabular:${args.reviewId}:${args.documentId}:${args.columnId}`,
    sourceText: args.text,
    block_id: `cell:${args.rowIndex}:${args.columnIndex}`,
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
  return passageEvidence({
    provider: journal ? "journal" : "citator",
    jurisdiction: "CA",
    source_class: journal ? "commentary" : "case",
    stable_source_id: journal
      ? `journal:${args.passage.sourceArticleId ?? normalizeWhitespace(citation).toLowerCase()}`
      : `citator:discussion:${normalizeWhitespace(citation).toLowerCase()}`,
    sourceText: args.passage.text,
    block_id: `analysis:${citation}:${locator.kind}:${locator.label}`,
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
  return passageEvidence({
    provider: "citator",
    jurisdiction: "CA",
    source_class: "case",
    stable_source_id: `citator:noteup:${normalizeWhitespace(source).toLowerCase()}`,
    sourceText: args.entry.excerpt,
    block_id: `noteup:${source}:${args.entry.paragraph === null ? "passage" : `para:${args.entry.paragraph}`}`,
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
  return passageEvidence({
    provider: "journal",
    jurisdiction: "CA",
    source_class: "commentary",
    stable_source_id: `journal:${args.articleId}`,
    sourceText: args.text,
    block_id: `article:${args.articleId}:${args.locatorKind}:${args.locatorLabel}`,
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
    locatorKind: LegalEvidenceReceipt["locator"]["kind"];
  },
) {
  return createJournalEvidence(args);
}

export function registerLegalEvidence(
  state: LegalEvidenceTurnState,
  receipt: LegalEvidenceReceipt | undefined,
  source: Omit<RegisteredEvidence, "receipt"> = {},
) {
  if (receipt) state.evidence.set(receipt.evidence_id, { receipt, ...source });
}

export function registerDocumentLegalEvidence(
  state: LegalEvidenceTurnState,
  evidenceIds: readonly string[],
) {
  evidenceIds.forEach((evidenceId) => state.documentEvidenceIds.add(evidenceId));
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
  values: readonly PriorLegalEvidence[],
) {
  for (const value of values) {
    const entry = "receipt" in value ? value : { receipt: value };
    const { receipt, ...source } = entry;
    registerLegalEvidence(state, receipt, source);
    state.priorEvidenceIds.add(receipt.evidence_id);
  }
}

export async function restorePriorLegalEvidence(
  receipts: readonly LegalEvidenceReceipt[],
  signal?: AbortSignal,
): Promise<RegisteredEvidence[]> {
  const sources = new Map<string, Promise<{
    document: A2AJDocument;
    source: SourceDoc;
  } | null>>();
  const a2ajSource = (receipt: LegalEvidenceReceipt) => {
    let pending = sources.get(receipt.stable_source_id);
    if (!pending) {
      pending = (async () => {
        try {
          const document = await a2ajLegalSourceProvider.document({
            citation: receipt.citation,
            docType: receipt.source_class === "legislation" ? "laws" : "cases",
            language: receipt.language,
            dataset: receipt.dataset,
            signal,
          });
          if (!document) return null;
          const source = a2ajLegalSourceProvider.source(document);
          return source && sha256(source.text) === receipt.source_sha256
            ? { document, source }
            : null;
        } catch (error) {
          if (signal?.aborted) throw error;
          return null;
        }
      })();
      sources.set(receipt.stable_source_id, pending);
    }
    return pending;
  };
  return Promise.all(receipts.map(async (receipt) => {
    if (receipt.provider !== "a2aj") return { receipt };
    const restored = await a2ajSource(receipt);
    return { receipt, ...(restored ?? {}) };
  }));
}

const CITATION_REQUEST = /\b(?:cite|cites|citation|citations|source|sources|pinpoint|footnote)\b/iu;
const SOURCE_CORRECTION = /^\s*(?:(?:cite|link)\s+)?(?:to|from|use)\s+(?:the\s+)?(?:pdf|document|file|source)\b/iu;

export function legalEvidenceRequested(messages: readonly {
  role: "assistant" | "user";
  content: string;
}[]) {
  const requests = messages.filter(({ role }) => role === "user")
    .map(({ content }) => content.trim()).filter(Boolean).slice(-2);
  const current = requests.at(-1) ?? "";
  if (CITATION_REQUEST.test(current)) return true;
  return SOURCE_CORRECTION.test(current) &&
    CITATION_REQUEST.test(requests.at(-2) ?? "");
}

export const modelEvidencePassage = ({ evidence_id, citation, name, locator,
  span_text }: LegalEvidenceReceipt) => ({
  evidence_id, citation, name, locator, exact_passage: span_text,
});

export function priorLegalEvidencePrompt(receipts: readonly LegalEvidenceReceipt[]) {
  const passages = receipts.filter((receipt) => receipt.scope === "passage" && receipt.span_text);
  return passages.length
    ? [
        "VERIFIED EVIDENCE AVAILABLE FROM PRIOR TURNS:",
        "These exact passages and evidence_ids are already registered in this turn. Use them directly in submit_grounded_answer. Do not re-fetch them. Test each passage against the current request and omit merely related material.",
        ...passages.map((receipt) => JSON.stringify(modelEvidencePassage(receipt))),
      ].join("\n")
    : "";
}

/**
 * Chat claims never carry citation-handle markers: pills are derived from
 * evidence_ids at render time ([ref]), so an inline "[@handle]" can only be
 * leakage from the DOCX Write convention. Drop the tokens instead of
 * leaking raw handles into prose.
 */
function stripCitationHandleMarkers(text: string): string {
  return text.replace(/\s*\[@[^\][\n]{1,80}\]/gu, "");
}

function parseClaims(value: unknown, state: LegalEvidenceTurnState) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    return { claims: null, errors: ["claims must contain 1 to 64 items"] };
  const claims: GroundedLegalClaim[] = [];
  const errors: string[] = [];
  value.forEach((value, index) => {
    const row = object(value);
    const text = typeof row?.text === "string"
      ? stripCitationHandleMarkers(row.text).trim()
      : "";
    const rawIds = row?.evidence_ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    if (!row || Object.keys(row).some((key) => !["text", "evidence_ids"].includes(key)))
      errors.push(`claims[${index}] has unknown fields`);
    if (!text || text.length > 1_200) errors.push(`claims[${index}].text is invalid`);
    if (!ids.length || ids.length > 4 || ids.length !== (Array.isArray(rawIds) ? rawIds.length : 0) || new Set(ids).size !== ids.length)
      errors.push(`claims[${index}].evidence_ids must contain 1 to 4 unique handles`);
    for (const id of ids) {
      const receipt = state.evidence.get(id)?.receipt;
      if (!receipt) errors.push(`claims[${index}] has unknown evidence_id: ${id}`);
      else if (receipt.scope !== "passage") errors.push(`claims[${index}] requires passage evidence for ${id}`);
      else if (!receipt.span_text) errors.push(`claims[${index}] requires exact passage text for ${id}`);
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
      maxLength: 1_200,
      description: `${GROUNDED_QUOTATION_POLICY} ${GROUNDED_CLAIM_GRANULARITY} ${GROUNDED_SUMMARY_POLICY}`,
    },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" },
      description: "The smallest returned passage or passages that support this proposition. Prefer one evidence_id and one native pinpoint. Use several only when their narrow passages jointly support this same proposition; never use a broad span when a shorter passage fully supports it.",
    },
  },
  required: ["text", "evidence_ids"],
} as const;

export const LEGAL_EVIDENCE_SUBMIT_TOOL: Tool = {
  name: LEGAL_EVIDENCE_TOOL_NAME,
  description: [
    GROUNDED_ANSWER_CONTRACT,
    GROUNDED_QUOTATION_POLICY,
    GROUNDED_CLAIM_GRANULARITY,
    GROUNDED_SUMMARY_POLICY,
  ].join(" "),
  inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: { type: "array", minItems: 1, maxItems: 64, items: claimSchema },
      },
      required: ["claims"],
  },
};

export function finalizeLegalEvidence(
  state: LegalEvidenceTurnState,
  draft: string,
) {
  const namesAuthority = hasCaseNameInText(draft);
  const citesAuthority = hasCitationInText(draft) || hasCanadianDecisionLink(draft);
  if (!state.mode && !state.answer && (namesAuthority || citesAuthority))
    state.mode = "citation_structure";
  if (!state.mode) return true;
  state.attempted = true;
  if (!state.answer && ![...state.evidence.values()].some(
    ({ receipt }) => receipt.scope === "passage",
  )) {
    state.failure = "The answer named legal authorities without verified passages.";
    return false;
  }
  if (!state.answer) {
    state.failure = "The model did not submit a grounded answer.";
    return false;
  }
  return true;
}

export function renderLegalEvidenceAnswer(state: LegalEvidenceTurnState): string | null {
  if (state.failure) return null;
  if (!state.answer) return null;
  const refs = new Map(legalEvidenceCitationEntries(state)
    .map(({ ref, receipt }) => [receipt.evidence_id, ref]));
  return state.answer.map((claim) => {
    const markers = [...new Set(claim.evidence_ids.flatMap((id) =>
      refs.has(id) ? [`[${refs.get(id)}]`] : []))];
    return `${claim.text}${markers.length ? ` ${markers.join("")}` : ""}`;
  }).join("\n\n");
}

export function legalEvidenceCitationEntries(
  state: LegalEvidenceTurnState,
): Array<RegisteredEvidence & { ref: number }> {
  const entries: Array<RegisteredEvidence & { ref: number }> = [];
  const seen = new Set<string>();
  for (const claim of state.answer ?? []) for (const id of claim.evidence_ids) {
    const entry = state.evidence.get(id);
    if (!entry?.receipt.span_text || seen.has(id)) continue;
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
  const claims = state.answer ?? [];
  const ids = new Set([
    ...claims.flatMap((claim) => claim.evidence_ids),
    ...state.documentEvidenceIds,
    ...[...state.evidence.keys()].filter((id) => !state.priorEvidenceIds.has(id)),
  ]);
  if (!state.attempted && !ids.size) return null;
  const passed = !state.failure && Boolean(state.answer || ids.size);
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
