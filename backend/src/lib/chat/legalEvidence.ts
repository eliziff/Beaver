import { legalSourceOperations } from "../legalSourceApplication";
import crypto from "node:crypto";

import {
  a2ajLegalSourceProvider,
  stableA2AJSourceId,
  type A2AJCompiledDocument,
} from "../legalSources/a2aj";
import {
  structureNative,
  type NativeDocument,
} from "../structureNative";
import {
  hasCanadianDecisionLink,
} from "../legalSourceLinks";
import {
  type LegalSourcePassage,
  type LegalSourceReference,
} from "../legalSources";
import { type Tool } from "../llm";
import { normalizeWhitespace } from "../text";
import { jsonRecord as object } from "../value";
import { collapseProvisionLabels } from "../provisionLabels";
import type { LegalEvidenceReceiptEvent } from "./assistantEvents";
import type { GroundedClaim } from "../groundedAnswer";
import { legalSourceResource, resourceReference } from "../resourceReferences";

export const LEGAL_EVIDENCE_TOOL_NAME = "submit_grounded_answer";
export type LegalEvidenceMode = "citation_structure";
export type LegalSourceClass = "case" | "legislation" | "commentary";

const GROUNDED_ANSWER_CONTRACT =
  "Finish evidence-dependent answers with this tool. Bind each claim to supporting passage evidence_ids. Citation chips supply source names, citations, pinpoints and links; include those details in prose only when needed for the analysis or requested by the user.";
const GROUNDED_CLAIM_GRANULARITY =
  "Use the smallest passage that supports the claim, with a native pinpoint when available. End a claim when its supporting evidence changes.";
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
const GROUNDED_SUMMARY_POLICY =
  "A summary may group one to three closely connected sentences when they perform the same function and are supported by the same narrow evidence—for example, one fact cluster, issue, holding, reasoning step, or disposition. Start a new claim when the function or supporting evidence changes.";

export type LegalEvidenceReceipt = {
  evidence_id: string;
  provider: "a2aj" | "courtlistener" | "tna" | "govuk-et" | "govinfo" |
    "hansard" | "citator" | "journal" | "library";
  jurisdiction: string;
  source_class: LegalSourceClass;
  stable_source_id: string;
  source_reference?: Pick<LegalSourceReference, "id" | "part" | "family">;
  source_sha256: string;
  scope: "document" | "passage";
  block_id: string;
  span?: { start: number; end: number };
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
    kind: "document" | "paragraph" | "page" | "section" | "footnote" | "sheet" | "cell";
    label: string;
    sheet?: string;
    cells?: string;
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
    | "library-read-v1";
};

export function legalEvidenceSourceReference(receipt: LegalEvidenceReceipt): LegalSourceReference | null {
  const reference = receipt.source_reference;
  const kind = receipt.source_class === "commentary"
    ? receipt.provider === "journal" ? "journal"
      : receipt.provider === "hansard" ? "hansard" : null
    : receipt.source_class;
  return reference && kind ? { provider: receipt.provider, id: reference.id,
    ...(reference.family ? { family: reference.family } : {}),
    ...(reference.part ? { part: reference.part } : {}), kind,
    title: receipt.name, citation: receipt.citation, date: receipt.version,
    collection: receipt.dataset, language: receipt.language, url: receipt.external_url } : null;
}

export function legalEvidenceResourceReference(receipt: LegalEvidenceReceipt): string | null {
  if (receipt.provider === "library") return receipt.version
    ? resourceReference.document(receipt.stable_source_id, receipt.version) : null;
  const source = legalEvidenceSourceReference(receipt);
  return source ? legalSourceResource(source) : null;
}

export type RegisteredEvidence = {
  receipt: LegalEvidenceReceipt;
  document?: A2AJCompiledDocument;
  source?: NativeDocument;
};

export type PriorLegalEvidence = LegalEvidenceReceipt | RegisteredEvidence;

export type GroundedLegalClaim = GroundedClaim;

export type LegalResearchQueryReceipt = {
  query_id: string;
  call_id: string;
  tool: "search_sources" | "Read";
  executed_at: string;
  model: string;
  executor_version: "legal-source-search-v1" | "legal-source-pattern-v1";
  input: Record<string, unknown>;
  results: Array<
    | { rank: number; resource: string }
    | { rank: number; evidence_id: string }
  >;
};

export type PendingLegalResearchQueryReceipt = Omit<
  LegalResearchQueryReceipt,
  "query_id" | "model"
>;

export type LegalEvidenceTurnState = {
  mode: LegalEvidenceMode | null;
  evidence: Map<string, RegisteredEvidence>;
  priorEvidenceIds: Set<string>;
  presentedEvidenceIds: Set<string>;
  priorEvidencePreviews: Map<string, string>;
  priorQueryIds: Set<string>;
  documentEvidenceIds: Set<string>;
  queries: Map<string, LegalResearchQueryReceipt>;
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
    presentedEvidenceIds: new Set(),
    priorEvidencePreviews: new Map(),
    priorQueryIds: new Set(),
    documentEvidenceIds: new Set(),
    queries: new Map(),
    answer: null,
    attempted: false,
    failure: null,
  };
}

function sha256(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function registerLegalResearchQueries(
  state: LegalEvidenceTurnState,
  receipts: readonly PendingLegalResearchQueryReceipt[],
  model: string,
) {
  for (const receipt of receipts) {
    const identity = JSON.stringify([
      receipt.call_id,
      receipt.tool,
      receipt.executor_version,
      receipt.input,
      receipt.results,
    ]);
    const value: LegalResearchQueryReceipt = {
      query_id: `q_${crypto.createHash("sha256").update(identity)
        .digest("base64url").slice(0, 18)}`,
      ...receipt,
      model,
    };
    state.priorQueryIds.delete(value.query_id);
    state.queries.set(value.query_id, value);
  }
}

function withEvidenceId(
  receipt: Omit<LegalEvidenceReceipt, "evidence_id">,
): LegalEvidenceReceipt {
  const identity = JSON.stringify([
    receipt.provider,
    receipt.stable_source_id,
    receipt.source_sha256,
    receipt.version,
    receipt.scope,
    receipt.span ? [receipt.span.start, receipt.span.end] : receipt.block_id,
    receipt.block_id.startsWith("pdf:") ? receipt.block_id : null,
    receipt.locator.sheet ?? null,
    receipt.locator.cells ?? null,
    receipt.exact_span_sha256 ?? receipt.span_sha256,
  ]);
  return {
    evidence_id: `e_${crypto.createHash("sha256").update(identity).digest("base64url").slice(0, 18)}`,
    ...receipt,
  };
}

type PassageEvidence = Omit<LegalEvidenceReceipt, "evidence_id" | "source_sha256" |
  "scope" | "exact_span_sha256" | "span_sha256" | "span_text" | "language"> & {
    sourceText?: string; sourceSha256?: string; spanText?: string;
    language?: "en" | "fr";
  };
function passageEvidence({ sourceText, sourceSha256, spanText = sourceText, language = "en",
  ...receipt }: PassageEvidence) {
  if (!spanText || (!sourceText && !sourceSha256))
    throw new Error("Passage evidence requires source identity and span text");
  return withEvidenceId({ ...receipt,
    source_sha256: sourceSha256 ?? sha256(sourceText!), scope: "passage",
    exact_span_sha256: sha256(spanText), span_sha256: sha256(normalizeWhitespace(spanText)),
    span_text: spanText, language });
}

export function createA2AJPassageEvidence(args: {
  citation: string;
  name: string | null;
  dataset: string;
  language: "en" | "fr";
  sourceText?: string;
  sourceSha256?: string;
  spanText: string;
  start: number;
  end: number;
  externalUrl: string | null;
  sourceClass: LegalSourceClass;
  sourceReference?: Pick<LegalSourceReference, "id" | "part" | "family">;
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
    ...(args.sourceReference ? { source_reference: { id: args.sourceReference.id,
      ...(args.sourceReference.family ? { family: args.sourceReference.family } : {}),
      ...(args.sourceReference.part ? { part: args.sourceReference.part } : {}) } } : {}),
    sourceText: args.sourceText,
    sourceSha256: args.sourceSha256,
    block_id: args.blockId ?? `chars:${args.start}-${args.end}`,
    span: { start: args.start, end: args.end },
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

type DirectSourceProvider = "a2aj" | "courtlistener" | "tna" | "govuk-et" | "govinfo" | "hansard";
type DirectSourceEvidenceArgs = {
  jurisdiction: string;
  sourceClass: LegalSourceClass;
  stableSourceId: string;
  sourceReference?: Pick<LegalSourceReference, "id" | "part" | "family">;
  sourceText?: string;
  sourceSha256?: string;
  spanText: string;
  citation: string;
  name?: string | null;
  dataset: string;
  language?: "en" | "fr";
  version?: string | null;
  externalUrl?: string | null;
  locatorKind?: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabel: string;
  span?: { start: number; end: number };
};

export function createDirectSourceEvidence(
  provider: DirectSourceProvider,
  args: DirectSourceEvidenceArgs,
): LegalEvidenceReceipt {
  return passageEvidence({
    provider,
    jurisdiction: args.jurisdiction,
    source_class: args.sourceClass,
    stable_source_id: args.stableSourceId,
    ...(args.sourceReference
      ? {
          source_reference: {
            id: args.sourceReference.id,
            ...(args.sourceReference.family ? { family: args.sourceReference.family } : {}),
            ...(args.sourceReference.part ? { part: args.sourceReference.part } : {}),
          },
        }
      : {}),
    sourceText: args.sourceText,
    sourceSha256: args.sourceSha256,
    block_id: `${args.locatorKind ?? "section"}:${args.locatorLabel}`,
    ...(args.span && { span: args.span }),
    spanText: args.spanText,
    citation: args.citation,
    name: args.name ?? null,
    dataset: args.dataset,
    language: args.language ?? "en",
    version: args.version ?? null,
    external_url: args.externalUrl ?? null,
    locator: { kind: args.locatorKind ?? "section", label: args.locatorLabel },
    resolver_version: provider === "a2aj" ? "a2aj-inline-v1" : `${provider}-span-v1`,
  });
}

const createCourtlistenerEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("courtlistener", args);
export const createTnaEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("tna", args);
const createGovUkEmploymentTribunalEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("govuk-et", args);
const createGovInfoEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("govinfo", args);
const createHansardEvidence = (args: DirectSourceEvidenceArgs) =>
  createDirectSourceEvidence("hansard", args);

export function createLibraryEvidence(args: {
  documentId: string;
  versionId: string;
  filename: string;
  sourceText?: string;
  sourceSha256?: string;
  spanText: string;
  start: number;
  end: number;
  blockId?: string;
  locator?: LegalEvidenceReceipt["locator"];
}): LegalEvidenceReceipt {
  return passageEvidence({
    provider: "library",
    jurisdiction: "matter",
    source_class: "commentary",
    stable_source_id: args.documentId,
    sourceText: args.sourceText,
    sourceSha256: args.sourceSha256,
    block_id: args.blockId ?? `chars:${args.start}-${args.end}`,
    span: { start: args.start, end: args.end },
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
    language?: "en" | "fr";
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
    language: args.passage.language ?? "en",
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
    language?: "en" | "fr";
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
    language: args.entry.language ?? "en",
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
  sourceSha256?: string;
  articleId: string;
  family?: string;
  collection?: string | null;
  language?: "en" | "fr";
  locatorKind: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabel: string;
  span?: { start: number; end: number };
}): LegalEvidenceReceipt {
  return passageEvidence({
    provider: "journal",
    jurisdiction: "CA",
    source_class: "commentary",
    stable_source_id: `journal:${args.articleId}`,
    source_reference: { id: args.articleId, ...(args.family ? { family: args.family } : {}) },
    sourceText: args.text,
    sourceSha256: args.sourceSha256,
    block_id: `article:${args.articleId}:${args.locatorKind}:${args.locatorLabel}`,
    ...(args.span && { span: args.span }),
    citation: args.citation,
    name: args.name,
    dataset: args.collection ?? "journal",
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

export type LegalEvidenceSpan = { text: string; start: number; end: number;
  blockId?: string; locator?: LegalEvidenceReceipt["locator"] };

export function legalSourceEvidence(passage: LegalSourcePassage,
  span?: LegalEvidenceSpan): LegalEvidenceReceipt | undefined {
  const block = passage.blockArtifact;
  span ??= block ? { text: block.text, start: block.start, end: block.end,
    blockId: `${block.kind}:${block.label}:${block.start}:${block.end}`,
    ...(["paragraph", "page", "section", "footnote"].includes(block.kind)
      ? { locator: { kind: block.kind as LegalEvidenceReceipt["locator"]["kind"],
        label: block.label } } : {}) } : undefined;
  if (passage.source.provider === "a2aj") {
    const native = object(passage.native);
    if (typeof native?.citation === "string" && typeof native.dataset === "string" &&
        (native.language === "en" || native.language === "fr")) {
      const selected = span;
      return selected ? createA2AJPassageEvidence({ citation: native.citation,
        name: typeof native.name === "string" ? native.name : null, dataset: native.dataset,
        language: native.language,
        sourceSha256: structureNative().documentRevision(passage.documentArtifact),
        spanText: selected.text, start: selected.start, end: selected.end,
        externalUrl: typeof native.url === "string" ? native.url : null,
        sourceClass: passage.source.kind === "legislation" ? "legislation" : "case",
        sourceReference: passage.source, blockId: selected.blockId, locator: selected.locator,
      }) : undefined;
    }
  }
  if (!span && passage.role === "document") return undefined;
  if (passage.source.provider === "journal") return createPublicJournalPassageEvidence({
    citation: passage.source.citation ?? passage.source.id, name: passage.source.title ?? null,
    date: passage.source.date ?? null, url: passage.source.url ?? null,
    text: span?.text ?? passage.text,
    ...(span && { span: { start: span.start, end: span.end } }),
    sourceSha256: structureNative().documentRevision(passage.documentArtifact),
    articleId: passage.source.id, family: passage.source.family,
    collection: passage.source.collection,
    language: passage.source.language,
    locatorKind: span?.locator?.kind ?? passage.locator.requested?.kind ?? "document",
    locatorLabel: span?.locator?.label ?? passage.locator.label,
  });
  const sourceClass = passage.source.kind === "legislation" ? "legislation"
    : passage.source.kind === "case" ? "case" : "commentary";
  const jurisdiction = passage.source.provider === "courtlistener" ||
      passage.source.provider === "govinfo" ? "US"
    : passage.source.provider === "tna" || passage.source.provider === "govuk-et" ? "UK" : "CA-ON";
  const createEvidence = { courtlistener: createCourtlistenerEvidence, tna: createTnaEvidence,
    "govuk-et": createGovUkEmploymentTribunalEvidence, govinfo: createGovInfoEvidence,
    hansard: createHansardEvidence }[passage.source.provider];
  if (!createEvidence) return undefined;
  return createEvidence({ jurisdiction, sourceClass,
    stableSourceId: [passage.source.id, passage.source.part ?? ""].join(":"),
    sourceReference: passage.source,
    sourceSha256: structureNative().documentRevision(passage.documentArtifact),
    ...(span && { span: { start: span.start, end: span.end } }),
    spanText: span?.text ?? passage.text, citation: passage.source.citation ?? passage.source.id,
    name: passage.source.title, dataset: passage.source.collection ?? passage.source.provider,
    language: passage.source.language, version: passage.source.date, externalUrl: passage.source.url,
    locatorKind: span?.locator?.kind ??
      (span ? "document" : passage.locator.requested?.kind ?? "document"),
    locatorLabel: span?.locator?.label ??
      (span ? `characters ${span.start + 1}–${span.end}` : passage.locator.label) });
}

export function registerLegalEvidence(
  state: LegalEvidenceTurnState,
  receipt: LegalEvidenceReceipt | undefined,
  source: Omit<RegisteredEvidence, "receipt"> = {},
) {
  if (!receipt) return;
  const previous = state.evidence.get(receipt.evidence_id);
  state.evidence.set(receipt.evidence_id, {
    ...(previous?.receipt.source_sha256 === receipt.source_sha256 ? previous : {}), receipt, ...source,
  });
  state.presentedEvidenceIds.add(receipt.evidence_id);
}

export function registerDocumentLegalEvidence(
  state: LegalEvidenceTurnState,
  evidenceIds: readonly string[],
) {
  evidenceIds.forEach((evidenceId) => state.documentEvidenceIds.add(evidenceId));
}

export function storedLegalEvidenceReceipt(value: unknown): LegalEvidenceReceipt | null {
  const row = object(value);
  const locator = object(row?.locator);
  const sourceReference = object(row?.source_reference);
  return row &&
    typeof row.evidence_id === "string" && row.evidence_id.startsWith("e_") &&
    typeof row.stable_source_id === "string" && typeof row.source_sha256 === "string" &&
    typeof row.span_sha256 === "string" &&
    (row.span_text === null || typeof row.span_text === "string") &&
    typeof row.citation === "string" && typeof row.dataset === "string" &&
    typeof row.jurisdiction === "string" && locator &&
    (row.source_reference === undefined || Boolean(
      sourceReference && typeof sourceReference.id === "string" &&
      (sourceReference.family === undefined || typeof sourceReference.family === "string") &&
      (sourceReference.part === undefined || typeof sourceReference.part === "string"),
    )) &&
    typeof locator.kind === "string" && typeof locator.label === "string"
    ? row as LegalEvidenceReceipt
    : null;
}

export function storedLegalResearchQueryReceipt(value: unknown): LegalResearchQueryReceipt | null {
  const row = object(value);
  if (!row || typeof row.query_id !== "string" || !row.query_id.startsWith("q_") ||
      typeof row.call_id !== "string" ||
      (row.tool !== "search_sources" && row.tool !== "Read") ||
      typeof row.executed_at !== "string" || Number.isNaN(Date.parse(row.executed_at)) ||
      typeof row.model !== "string" || !row.model ||
      (row.executor_version !== "legal-source-search-v1" &&
        row.executor_version !== "legal-source-pattern-v1") ||
      !object(row.input) || !Array.isArray(row.results) || row.results.length > 100) return null;
  const valid = row.results.every((value, index) => {
    const result = object(value);
    return result && result.rank === index + 1 &&
      (typeof result.resource === "string" && result.resource.startsWith("source://") ||
        typeof result.evidence_id === "string" && result.evidence_id.startsWith("e_"));
  });
  return valid ? row as unknown as LegalResearchQueryReceipt : null;
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
      const receipt = storedLegalEvidenceReceipt(value);
      if (receipt) {
        receipts.delete(receipt.evidence_id);
        receipts.set(receipt.evidence_id, receipt);
      }
    }
  }
  return [...receipts.values()];
}

export function priorLegalResearchQueryReceipts(events: readonly unknown[]) {
  const receipts = new Map<string, LegalResearchQueryReceipt>();
  for (const value of events) {
    const event = object(value);
    const source = event?.type === "legal_evidence_receipt"
      ? event
      : event?.type === "subagent_run" && event.status === "completed"
        ? object(event.grounding)
        : null;
    if (!source || !Array.isArray(source.queries)) continue;
    for (const value of source.queries) {
      const receipt = storedLegalResearchQueryReceipt(value);
      if (receipt) receipts.set(receipt.query_id, receipt);
    }
  }
  return [...receipts.values()];
}

export function registerPriorLegalResearchQueries(state: LegalEvidenceTurnState,
  receipts: readonly LegalResearchQueryReceipt[]) {
  receipts.forEach((receipt) => {
    state.queries.set(receipt.query_id, receipt); state.priorQueryIds.add(receipt.query_id);
  });
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
    state.presentedEvidenceIds.delete(receipt.evidence_id);
  }
  state.priorEvidencePreviews = new Map(recentInventory([...state.priorEvidenceIds].map(
    (id) => state.evidence.get(id)!.receipt), modelEvidencePreview, 6_000)
    .map(({ evidence_id, preview }) => [evidence_id, preview ?? ""]));
}

export async function restorePriorLegalEvidence(
  receipts: readonly LegalEvidenceReceipt[],
  signal?: AbortSignal,
  verifySpans = false,
  available: readonly RegisteredEvidence[] = [],
): Promise<RegisteredEvidence[]> {
  const sources = new Map<
    string,
    Promise<Omit<RegisteredEvidence, "receipt"> | null>
  >();
  const sourceKey = (receipt: LegalEvidenceReceipt) => JSON.stringify([receipt.provider,
    receipt.source_reference?.id ?? receipt.stable_source_id, receipt.source_reference?.part ?? "",
    receipt.source_sha256]);
  for (const { receipt, document, source } of available) if (document || source)
    sources.set(sourceKey(receipt), Promise.resolve({ ...(document && { document }), ...(source && { source }) }));
  const restoreSource = (receipt: LegalEvidenceReceipt) => {
    const providerSource = legalEvidenceSourceReference(receipt);
    if (receipt.provider !== "a2aj" && !providerSource) {
      return sources.get(sourceKey(receipt)) ?? Promise.resolve(null);
    }
    const key = sourceKey(receipt);
    let pending = sources.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          if (receipt.provider === "a2aj") {
            const document = await a2ajLegalSourceProvider.document({
              citation: receipt.citation,
              docType: receipt.source_class === "legislation" ? "laws" : "cases",
              language: receipt.language,
              dataset: receipt.dataset,
              sourceUrl: receipt.external_url,
              signal,
            });
            return document &&
                structureNative().documentRevision(document.native) === receipt.source_sha256
              ? { document }
              : null;
          }
          if (!providerSource) return null;
          const read = await legalSourceOperations.readPassage({
            source: providerSource,
            signal,
          });
          if (read.status !== "found") return null;
          const source = read.values.find(
            (passage) => passage.documentArtifact,
          )?.documentArtifact;
          return source && structureNative().documentRevision(source) === receipt.source_sha256
            ? { source }
            : null;
        } catch (error) {
          if (signal?.aborted) throw error;
          return null;
        }
      })();
      sources.set(key, pending);
    }
    return pending;
  };
  const restored = await Promise.all(receipts.map(async (receipt) => {
    const restored = await restoreSource(receipt);
    if (verifySpans) {
      const span = receipt.span_text, native = restored?.document?.native ?? restored?.source;
      const normalized = span && normalizeWhitespace(span);
      if (!span || !native || structureNative().documentRevision(native) !== receipt.source_sha256 ||
          receipt.exact_span_sha256 && sha256(span) !== receipt.exact_span_sha256 ||
          sha256(normalized!) !== receipt.span_sha256 ||
          receipt.span && !receipt.block_id.startsWith("pdf:") &&
            structureNative().documentText(native).slice(receipt.span.start, receipt.span.end) !== span ||
          !normalizeWhitespace(structureNative().documentText(native)).includes(normalized!)) return null;
    }
    return { receipt, ...(restored ?? {}) };
  }));
  return restored.filter((value): value is RegisteredEvidence => value !== null);
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

export function modelEvidencePassage({ evidence_id, citation, name, locator,
  span_text }: LegalEvidenceReceipt) {
  return { evidence_id, citation, name, locator, exact_passage: span_text };
}

export function readPriorLegalEvidence(state: LegalEvidenceTurnState, evidenceId: string) {
  const entry = state.evidence.get(evidenceId), receipt = entry?.receipt, span = receipt?.span_text;
  if (!span || sha256(normalizeWhitespace(span)) !== receipt.span_sha256 ||
    receipt.exact_span_sha256 && sha256(span) !== receipt.exact_span_sha256) return null;
  state.presentedEvidenceIds.add(evidenceId);
  return entry!;
}

export function modelEvidencePreview({ evidence_id, citation, name, locator, span_text }: LegalEvidenceReceipt) {
  return { evidence_id, citation: citation.slice(0, 240), name: name?.slice(0, 240),
    locator, preview: span_text?.slice(0, 160) };
}

export function modelResearchQueryPreview({ query_id, tool, input, results }: LegalResearchQueryReceipt) {
  return { query_id, tool, query: String(input.pattern ?? input.query ?? "").slice(0, 160), results: results.length };
}

function recentInventory<T, U>(values: readonly T[], format: (value: T) => U, budget: number) {
  const selected: U[] = [];
  for (let index = values.length - 1; index >= 0; index--) {
    const value = format(values[index]), size = JSON.stringify(value).length + 1;
    if (size > budget) break;
    selected.push(value); budget -= size;
  }
  return selected.reverse();
}

export function priorLegalEvidencePrompt(receipts: readonly LegalEvidenceReceipt[],
  queries: readonly LegalResearchQueryReceipt[] = []) {
  if (!receipts.length && !queries.length) return "";
  return ["PRIOR RESEARCH:",
    `${receipts.length} saved passages; ${queries.length} previous searches. Recent inventory follows.`,
    "Read(file_path=evidence_id) returns the saved exact passage; Read(file_path=query_id) returns the previous search. Read(file_path='evidence' or 'queries', offset, limit) lists older entries. Use saved evidence IDs for grounding; previews are not complete passages.",
    ...recentInventory(queries, modelResearchQueryPreview, 1_400).map((value) => JSON.stringify(value)),
    ...recentInventory(receipts, modelEvidencePreview, 6_000).map((value) => JSON.stringify(value)),
  ].join("\n");
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

export function validateGroundedClaims(value: unknown, state: LegalEvidenceTurnState,
  limits: { maxClaims?: number; maxTextLength?: number } = {}) {
  if (!Array.isArray(value) || !value.length || value.length > (limits.maxClaims ?? Infinity))
    return { claims: null, errors: [limits.maxClaims
      ? `claims must contain 1 to ${limits.maxClaims} items` : "claims must contain at least one item"] };
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
    if (!text || text.length > (limits.maxTextLength ?? Infinity))
      errors.push(`claims[${index}].text is invalid`);
    if (!ids.length || ids.length > 4 || ids.length !== (Array.isArray(rawIds) ? rawIds.length : 0) || new Set(ids).size !== ids.length)
      errors.push(`claims[${index}].evidence_ids must contain 1 to 4 unique handles`);
    if (ids.length > 1 && /\p{Ll}{4,}[.!?]["')\]]*\s+\p{Lu}/u.test(text))
      errors.push(`claims[${index}] must split sentences supported by different passages`);
    for (const id of ids) {
      const receipt = state.evidence.get(id)?.receipt;
      if (!receipt) errors.push(`claims[${index}] has unknown evidence_id: ${id}`);
      else if (receipt.scope !== "passage") errors.push(`claims[${index}] requires passage evidence for ${id}`);
      else if (!receipt.span_text) errors.push(`claims[${index}] requires exact passage text for ${id}`);
      else if (!readPriorLegalEvidence(state, id)) errors.push(`claims[${index}] has damaged passage evidence: ${id}`);
    }
    claims.push({ text, evidence_ids: ids });
  });
  if (!errors.length) for (const [index, claim] of claims.entries())
    errors.push(...legalEvidenceProseIntegrityErrors(claim.text, claim.evidence_ids, state)
      .map((error) => `claims[${index}] ${error}`));
  return { claims, errors };
}

export function legalEvidenceProseIntegrityErrors(
  text: string,
  citedEvidenceIds: readonly string[],
  state: LegalEvidenceTurnState,
) {
  const passages = new Map(state.priorEvidencePreviews);
  for (const id of [...state.presentedEvidenceIds, ...citedEvidenceIds]) {
    const text = state.evidence.get(id)?.receipt.span_text;
    if (text) passages.set(id, text);
  }
  const visible = [...passages].flatMap(([evidenceId, text]) => {
    const receipt = state.evidence.get(evidenceId)?.receipt;
    return receipt && text ? [{ evidenceId, text,
        labels: [receipt.name, receipt.citation].filter(
          (value): value is string => Boolean(value)) }] : [];
  });
  return structureNative().groundedProseErrors(text, citedEvidenceIds, visible);
}

export function submitLegalEvidenceAnswer(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  state.attempted = true;
  if (Object.keys(args).some((key) => key !== "claims"))
    return { ok: false, errors: ["answer has unknown fields"] };
  const { claims, errors } = validateGroundedClaims(args.claims, state,
    { maxClaims: 64, maxTextLength: 1_200 });
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
      maxLength: 1_200,
      description: "Answer segment in Markdown. For tables, use one claim per data row with leading and trailing pipes; include the header and separator in the first claim. Choose substantive columns; citation chips identify the sources in the final cell.",
    },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" },
      description: "Returned passage IDs supporting this claim. Prefer one; use several when they jointly support the proposition.",
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
  const citesAuthority = structureNative().hasCitationInText(draft) ||
    hasCanadianDecisionLink(draft);
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

const CASE_NAME = /(?:^|[^\p{L}])(?:R\.|[A-Z][\p{L}\p{M}'\u2019.&-]*(?:\s+(?:of|the|and|&|[A-Z][\p{L}\p{M}'\u2019.&-]*)){0,6})\s+v(?:\.|ersus)?\s+[A-Z][\p{L}\p{M}'\u2019.&-]*/mu;

export const hasCaseNameInText = (text: string) => CASE_NAME.test(text);

export function renderLegalEvidenceAnswer(state: LegalEvidenceTurnState): string | null {
  if (state.failure) return null;
  if (!state.answer) return null;
  const refs = new Map<string, number>();
  for (const group of legalEvidenceCitationGroups(state))
    for (const entry of group.members)
      refs.set(entry.receipt.evidence_id, group.ref);
  return state.answer.map((claim, index) => {
    const markers = [...new Set(claim.evidence_ids.flatMap((id) =>
      refs.has(id) ? [`[${refs.get(id)}]`] : []))];
    const table = claim.text.startsWith("|") && claim.text.endsWith("|");
    const citations = markers.join("");
    const text = table
      ? `${claim.text.slice(0, -1).trimEnd()} ${citations} |`
      : `${claim.text}${citations ? ` ${citations}` : ""}`;
    const separator = index === 0 ? "" : table && state.answer![index - 1].text.endsWith("|") ? "\n" : "\n\n";
    return separator + text;
  }).join("");
}

export function modelResearchQuery({ call_id: _call, model: _model, executor_version: _executor,
  sourceFingerprints: _fingerprints, ...query }: LegalResearchQueryReceipt & { sourceFingerprints?: unknown }) {
  return query;
}

type CitationEntry = RegisteredEvidence & { ref: number };
export type LegalEvidenceCitationGroup = {
  ref: number;
  members: CitationEntry[];
  /** The group's honest pinpoint kind, or `document` when it has none. */
  locatorKind: LegalEvidenceReceipt["locator"]["kind"];
  locatorLabels: string[];
};

function citationSourceKey({ receipt }: RegisteredEvidence) {
  if (receipt.provider === "library") {
    return [receipt.provider, receipt.stable_source_id, receipt.version].join("\u0000");
  }
  return [receipt.provider, receipt.citation, receipt.name, receipt.dataset,
    receipt.source_class].join("\u0000");
}

export function legalEvidenceCitationGroupsFromEntries(
  entries: readonly RegisteredEvidence[],
): LegalEvidenceCitationGroup[] {
  const groups: LegalEvidenceCitationGroup[] = [];
  const grouped = new Map<string, LegalEvidenceCitationGroup>();
  const pinpointKinds = new Map<string, Set<LegalEvidenceReceipt["locator"]["kind"]>>();
  for (const entry of entries) {
    const { kind } = entry.receipt.locator;
    if (kind === "document") continue;
    const source = citationSourceKey(entry);
    pinpointKinds.set(source, (pinpointKinds.get(source) ?? new Set()).add(kind));
  }
  for (const raw of entries) {
    const source = citationSourceKey(raw), kinds = pinpointKinds.get(source);
    // A passage the source could not pinpoint has no locator system of its own,
    // so it joins that authority's pinpointed chip rather than becoming a
    // second, locator-less chip for the same authority.
    const kind = raw.receipt.locator.kind !== "document" ? raw.receipt.locator.kind
      : kinds?.size === 1 ? [...kinds][0] : "document";
    const key = `${source}\u0000${kind}`;
    let group = grouped.get(key);
    if (!group) {
      group = { ref: groups.length + 1, members: [], locatorKind: kind, locatorLabels: [] };
      grouped.set(key, group);
      groups.push(group);
    }
    group.members.push({ ...raw, ref: group.ref });
  }
  for (const group of groups) {
    const kind = group.locatorKind;
    const labels = group.members.flatMap(({ receipt }) =>
      receipt.locator.kind === kind ? [receipt.locator.label] : []);
    group.locatorLabels = collapseProvisionLabels(labels, kind) ?? [...new Set(labels)];
  }
  return groups;
}

export function legalEvidenceCitationGroups(
  state: LegalEvidenceTurnState,
): LegalEvidenceCitationGroup[] {
  return legalEvidenceCitationGroupsFromEntries(legalEvidenceCitationEntries(state));
}

export function legalEvidenceCitationEntries(
  state: LegalEvidenceTurnState,
): Array<RegisteredEvidence & { ref: number }> {
  const entries: Array<RegisteredEvidence & { ref: number }> = [];
  const seen = new Set<string>();
  for (const claim of state.answer ?? []) {
    const claimEntries = claim.evidence_ids.flatMap((id) => state.evidence.get(id) ?? []);
    const pinpointed = new Set(claimEntries
      .filter(({ receipt }) => receipt.locator.kind !== "document")
      .map(citationSourceKey));
    for (const entry of claimEntries) {
      const { evidence_id, locator, span_text } = entry.receipt;
      if (!span_text || seen.has(evidence_id) ||
          (locator.kind === "document" && pinpointed.has(citationSourceKey(entry)))) continue;
      seen.add(evidence_id);
      entries.push({ ...entry, ref: entries.length + 1 });
    }
  }
  return entries;
}


export function legalEvidenceReceiptEvent(
  state: LegalEvidenceTurnState,
): LegalEvidenceReceiptEvent | null {
  const claims = state.answer ?? [];
  const ids = new Set([
    ...claims.flatMap((claim) => claim.evidence_ids),
    ...state.documentEvidenceIds,
    ...[...state.presentedEvidenceIds].filter((id) => !state.priorEvidenceIds.has(id)),
  ]);
  const queries = [...state.queries.values()].filter(({ query_id }) =>
    !state.priorQueryIds.has(query_id));
  if (!state.attempted && !ids.size && !queries.length) return null;
  const passed = !state.failure && Boolean(state.answer || ids.size || queries.length);
  return {
    type: "legal_evidence_receipt",
    schema_version: 7,
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
    queries,
    bounces: [],
    failure: state.failure,
  };
}
