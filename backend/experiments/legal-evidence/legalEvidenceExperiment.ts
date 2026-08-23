import crypto from "node:crypto";

import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
} from "../../src/lib/legalSources/a2aj";
import {
  buildA2AJDocumentPinpointUrl,
  buildA2AJParagraphRangeUrl,
  buildLegalSourcePinpointUrl,
  hasCanadianDecisionLink,
  type QuoteSource,
} from "../../src/lib/legalSourceLinks";
import {
  documentTextNative,
  hasCitationInTextNative as hasCitationInText,
  quoteRepairSuggestionNative,
  type NativeDocument,
} from "../../src/lib/structureNative";
import {
  alienPhrases,
  lintLegalClaim,
  type LintFeatureReceipt,
  type LintThresholds,
} from "../../../experiments/legal_grounding_framing/legalClaimLint";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type OpenAIToolSchema,
  type UserApiKeys,
} from "../../src/lib/llm";
import { normalizeWhitespace } from "../../src/lib/text";

export const LEGAL_EVIDENCE_TOOL_NAME = "submit_grounded_answer";
export const LEGAL_EVIDENCE_PLAN_TOOL_NAME = "plan_grounded_evidence";
const LEGAL_EVIDENCE_VERIFY_TOOL_NAME = "verify_grounded_claims";
const LEGAL_EVIDENCE_HOLISTIC_VERIFY_TOOL_NAME =
  "verify_grounded_answer";

export const LEGAL_EVIDENCE_EXPERIMENT_MODES = [
  "compose_check",
  "evidence_first",
  "holistic_check",
  "tiered_check",
  "quote_first",
  "attested_framing",
  "required_slot",
  "witness_panel",
  "lint_gated",
] as const;

function formatLegalLocator(kind: string, label: string) {
  const value = label
    .trim()
    .replace(/^(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/iu, "")
    .replace(/\s*[-\u2013\u2014]\s*/gu, "\u2013")
    .replace(/\u2013(?:paragraph|para|par|section|sec|s|page|p|footnote|note|fn)[\s._=-]*/giu, "\u2013");
  const range = value.includes("\u2013");
  if (kind === "paragraph") return `${range ? "paras." : "para."} ${value}`;
  if (kind === "page") return `${range ? "pp." : "p."} ${value}`;
  if (kind === "footnote") return `${range ? "nn." : "n."} ${value}`;
  return label;
}

function buildLegalSourceMultiPassageUrl(
  url: string,
  passages: Array<{
    blockText: QuoteSource;
    documentText?: QuoteSource;
    quotes: string[];
  }>,
) {
  const directives: string[] = [];
  let base = url;
  for (const passage of passages) {
    if (!passage.quotes.length) continue;
    const target = buildLegalSourcePinpointUrl({
      url,
      blockText: passage.blockText,
      documentText: passage.documentText,
    }, passage.quotes);
    const marker = target?.indexOf(":~:") ?? -1;
    if (!target || marker < 0) return null;
    base = target.slice(0, marker);
    directives.push(target.slice(marker + 3));
  }
  return directives.length ? `${base}:~:${directives.join("&")}` : url;
}

/**
 * Stage 7 frozen operating points (Frozen Hypothesis 7). Computed by
 * scripts/freeze-stage7-thresholds.ts on the RegLab expert-label
 * validation set: each threshold is the maximum claim-level value over
 * grounded responses among claims with >=12 lint content words, so the
 * gate flags ZERO grounded max-pooled responses at freeze time
 * (94 grounded / 7 misgrounded / 5 ungrounded responses, US-index
 * features). The lint is SOFT: it can only send claims back for one
 * named revision or annotate the checker prompt — never approve.
 */
export const STAGE7_LINT_THRESHOLDS: LintThresholds = {
  novelContentFraction: 0.666667,
  unattestedShare: 0.823529,
  promptOnlyShare: 0.333333,
  minContentWords: 12,
};

export type LegalEvidenceExperimentMode =
  (typeof LEGAL_EVIDENCE_EXPERIMENT_MODES)[number];
export type LegalEvidenceMode =
  | "citation_structure"
  | LegalEvidenceExperimentMode;

/**
 * witness_panel (Stage 10 H18) carries required_slot's ENTIRE submission
 * contract unchanged; the arms differ only in the composition prompt
 * (the pre-composition facts panel, injected runner-side). Every gate
 * keyed on required_slot must key on this predicate instead.
 */
function slotContractMode(mode: LegalEvidenceMode | null): boolean {
  return mode === "required_slot" || mode === "witness_panel";
}

/**
 * PROVISIONAL, NOT PRODUCTION-VALIDATED EXPERIMENT.
 *
 * Exact receipt-backed citation placement is the production baseline. The
 * optional modes add experimental model checks for claim/passage support; they
 * do not establish authority, treatment, or current-law status. There is
 * deliberately no compatibility alias for the former boolean flag.
 */
export function legalEvidenceExperimentMode():
  | LegalEvidenceExperimentMode
  | null {
  const value = process.env.MIKE_LEGAL_EVIDENCE_EXPERIMENT;
  return LEGAL_EVIDENCE_EXPERIMENT_MODES.includes(
    value as LegalEvidenceExperimentMode,
  )
    ? (value as LegalEvidenceExperimentMode)
    : null;
}

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
  /** Exact-byte passage identity; `span_sha256` remains normalized for lint compatibility. */
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
    kind: "document" | "paragraph" | "page" | "section" | "footnote";
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
  source?: NativeDocument;
};

/**
 * Stage 8b typed claim roles. `premise_correction` is the schema-level
 * premise distinction: the contested premise travels as `premise_text`,
 * a verbatim substring of the named source (the user's question, or the
 * assistant's own prior answer in multi-turn settings), so the anchor is
 * deterministically checkable and the correction body is never mistaken
 * for overreach by novelty lints. Absent `kind` is the legacy untyped
 * claim and keeps pre-8b behavior exactly.
 */
export type LegalClaimKind = "quotation" | "conclusion" | "premise_correction";

export type GroundedLegalClaim = {
  text: string;
  evidence_ids: string[];
  kind?: LegalClaimKind;
  premise_source?: "question" | "prior_answer";
  premise_text?: string;
};

export type LegalClaimVerification = {
  index: number;
  context_status: "preserved" | "changed" | "ambiguous";
  evidence_status: "supported" | "contradicted" | "insufficient";
};

export type LegalEvidenceTurnState = {
  mode: LegalEvidenceMode | null;
  evidence: Map<string, RegisteredEvidence>;
  answerability: "sufficient" | "insufficient" | null;
  plannedEvidenceIds: Set<string> | null;
  answer: GroundedLegalClaim[] | null;
  rejectedAnswer: GroundedLegalClaim[] | null;
  verification: LegalClaimVerification[] | null;
  holisticVerdict:
    | "supported"
    | "partially_supported"
    | "unsupported"
    | null;
  coverage: "complete" | "incomplete" | null;
  /**
   * tiered_check only: per-claim result of the deterministic verbatim-quote
   * tier, aligned with `answer`. All-true means the answer rendered without
   * any model checker call; the receipt records coverage as not_run because
   * the deterministic tier verifies grounding, never coverage.
   */
  deterministicSupport: boolean[] | null;
  /**
   * What the deterministic lint needs beyond the claim and its spans —
   * the user question (H14) and the jurisdiction-matched alienness
   * index (H13). lint_gated GATES on it; every other structured mode
   * uses only the index path, for the Stage 9 bounce-time alienness
   * ADVISORY (H13-advisory: appended to rejections that already
   * happened, never a cause of one). Null leaves those features off
   * exactly as lintLegalClaim documents.
   */
  lintContext: {
    question: string | null;
    alienessIndexPath?: string;
  } | null;
  /** lint_gated only: the one pre-registered revision bounce was spent. */
  lintBounced: boolean;
  /**
   * Premise anchoring sources for typed premise_correction claims. Null
   * means the harness supplied no anchor texts: premise typing is then
   * ignored (legacy callers), never rejected. A null field inside means
   * that source does not exist this turn and naming it is a typed error.
   */
  premiseContext: { question: string | null; priorAnswer: string | null } | null;
  /**
   * required_slot only: cited case citations whose characterization slot
   * must be filled — by a verbatim quote of an attested characterization
   * (citator receipt) or by the exact typed no-attestation statement.
   */
  requiredCharacterizations: string[] | null;
  /**
   * Stage 8b instrumentation: every typed submission rejection, with the
   * claims as submitted (pre-bounce text) and the rejection strings —
   * closes the Stage 7 gap where only surviving revisions were archived.
   */
  bounces: Array<{ claims: GroundedLegalClaim[]; errors: string[] }>;
  /**
   * lint_gated only: full lint receipts per accepted claim (aligned with
   * `answer`; empty array for claims the verbatim tier cleared). Fired
   * receipts enter the checker prompt; all of them enter the receipt
   * event for calibration.
   */
  lintReceipts: LintFeatureReceipt[][] | null;
  attempted: boolean;
  failure: string | null;
};

export function createLegalEvidenceTurnState(
  mode: LegalEvidenceMode | null = legalEvidenceExperimentMode(),
): LegalEvidenceTurnState {
  return {
    mode,
    evidence: new Map(),
    answerability: null,
    plannedEvidenceIds: null,
    answer: null,
    rejectedAnswer: null,
    verification: null,
    holisticVerdict: null,
    coverage: null,
    deterministicSupport: null,
    lintContext: null,
    lintBounced: false,
    premiseContext: null,
    requiredCharacterizations: null,
    bounces: [],
    lintReceipts: null,
    attempted: false,
    failure: null,
  };
}

function sha256(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function evidenceId(
  receipt: Omit<LegalEvidenceReceipt, "evidence_id">,
) {
  const identity = JSON.stringify([
    receipt.provider,
    receipt.stable_source_id,
    receipt.source_sha256,
    receipt.scope,
    receipt.block_id,
    receipt.exact_span_sha256 ?? receipt.span_sha256,
    receipt.resolver_version,
  ]);
  return `e_${crypto.createHash("sha256").update(identity).digest("base64url").slice(0, 18)}`;
}

function withEvidenceId(
  receipt: Omit<LegalEvidenceReceipt, "evidence_id">,
): LegalEvidenceReceipt {
  return { evidence_id: evidenceId(receipt), ...receipt };
}

function stableSourceId(source: {
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
  const source = a2ajLegalSourceProvider.source(document);
  const sourceText = source ? documentTextNative(source) : document.text;
  return withEvidenceId({
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableSourceId(document),
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
    locator: {
      kind: args.locatorKind ?? "section",
      label: args.locatorLabel,
    },
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

/**
 * Receipt for an ATTESTED CHARACTERIZATION of a cited case (H12): the
 * span text is another court's prose about the cited decision, taken
 * verbatim from a citator edge excerpt's classified prose window. A
 * claim naming this evidence_id clears the deterministic verbatim tier
 * only by quoting the citing court's own words — the receipt records
 * WHOSE words they are, so rendering can attribute ("as the ONCA put
 * it") instead of presenting borrowed framing as synthesis.
 */
export function attestedCharacterizationReceipt(args: {
  /** the CITED case the claim is about, e.g. "2016 SCC 27" */
  citedCitation: string;
  characterization: {
    text: string;
    citingCitation: string | null;
    citingName: string | null;
    citingCourt: string | null;
    citingDate: string | null;
    spanSha256: string;
    /** "case" (default; a citing court's prose) or "commentary" (a
     * journal footnote's editor-verified proposition). */
    sourceKind?: "case" | "commentary";
    journalName?: string | null;
    /** the citing case's own URL (case_doc.url); lets the rendered
     * attribution link out to the case whose words these are. */
    citingUrl?: string | null;
  };
  jurisdiction?: string;
  language?: "en" | "fr";
}): LegalEvidenceReceipt {
  const commentary = args.characterization.sourceKind === "commentary";
  const citing = commentary
    ? (args.characterization.journalName ?? "journal commentary")
    : (args.characterization.citingCitation ??
      args.characterization.citingName ??
      "unknown citing case");
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
        : `as characterized by ${citing}${
            args.characterization.citingCourt
              ? ` (${args.characterization.citingCourt})`
              : ""
          }`,
    },
    resolver_version: "citator-standsfor-v1",
  });
}

/** Exact citing passage returned by the deterministic note-up graph. */
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
  const paragraph = args.entry.paragraph === null ? "passage" : `para:${args.entry.paragraph}`;
  return withEvidenceId({
    provider: "citator",
    jurisdiction: "CA",
    source_class: "case",
    stable_source_id: `citator:noteup:${normalizeWhitespace(source).toLowerCase()}`,
    source_sha256: sha256(args.entry.excerpt),
    scope: "passage",
    block_id: `noteup:${source}:${paragraph}`,
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

/**
 * Receipt for a SPECIFIC passage of a journal article the agent pulled via
 * public_legal_source_lookup (provider "journal", locator_type page/footnote/
 * paragraph/section). The span is the looked-up block's own text and the
 * locator is the block's kind+label, so a quote of that passage renders with
 * a real pinpoint locator and resolves against a turn-local evidence_id — the
 * model never has to guess an id from a non-citeable "hit_id".
 */
export function createPublicJournalPassageEvidence(args: {
  /** the article's canonical citation, e.g. "(2020) 65:1 McGill LJ 1" */
  citation: string;
  name: string | null;
  date: string | null;
  url: string | null;
  /** the exact looked-up block text the agent received (span identity) */
  text: string;
  articleId: string;
  locatorKind: "paragraph" | "section" | "page" | "footnote";
  locatorLabel: string;
  language?: "en" | "fr";
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

/**
 * Deterministic stands-for lexicon (Stage 8, frozen): language that
 * characterizes what an authority stands for rather than reporting its
 * words. A claim matching this while citing case evidence must clear
 * the widened verbatim tier under attested_framing — the lexicon reuses
 * the abstraction vocabulary the overreach stages measured plus the
 * characterization verb frames.
 */
export const STANDS_FOR_LANGUAGE_RE =
  /\b(?:stands?\s+for|is\s+authority\s+for|(?:held|holds?|holding)\s+that|establish(?:es|ed|ing)?\b|recogni[sz](?:es|ed|ing)\s+that|confirm(?:s|ed|ing)\s+that|represents?\s+the\s+(?:proposition|principle)|settl(?:es|ed|ing)\s+the\s+law|leading\s+(?:case|authority)|landmark\s+(?:case|decision)|doctrine|framework|regime|governs?\b|regulat(?:es|ed|ing)|codif(?:ies|ied|ying))\b/iu;

export function registerLegalEvidence(
  state: LegalEvidenceTurnState,
  receipt: LegalEvidenceReceipt | undefined,
  source: {
    document?: A2AJDocument;
    source?: NativeDocument;
  } = {},
) {
  if (!receipt) return;
  state.evidence.set(receipt.evidence_id, { receipt, ...source });
}

function storedLegalEvidenceReceipt(value: unknown): LegalEvidenceReceipt | null {
  const row = object(value);
  const locator = object(row?.locator);
  if (
    !row ||
    typeof row.evidence_id !== "string" ||
    !row.evidence_id.startsWith("e_") ||
    typeof row.stable_source_id !== "string" ||
    typeof row.source_sha256 !== "string" ||
    typeof row.span_sha256 !== "string" ||
    (row.span_text !== null && typeof row.span_text !== "string") ||
    typeof row.citation !== "string" ||
    typeof row.dataset !== "string" ||
    typeof row.jurisdiction !== "string" ||
    !locator ||
    typeof locator.kind !== "string" ||
    typeof locator.label !== "string"
  ) {
    return null;
  }
  return row as LegalEvidenceReceipt;
}

/** Recover every verified receipt persisted by either the parent or a reader. */
export function priorLegalEvidenceReceipts(events: readonly unknown[]) {
  const receipts = new Map<string, LegalEvidenceReceipt>();
  for (const value of events) {
    const event = object(value);
    if (!event) continue;
    const source =
      event.type === "legal_evidence_receipt" && event.status === "passed"
        ? event
        : event.type === "subagent_run" && event.status === "completed"
          ? object(event.grounding)
          : null;
    if (!source || source.status !== "passed" || !Array.isArray(source.evidence)) {
      continue;
    }
    for (const item of source.evidence) {
      const receipt = storedLegalEvidenceReceipt(item);
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

export function priorLegalEvidencePrompt(
  receipts: readonly LegalEvidenceReceipt[],
) {
  const passages = receipts.filter(
    (receipt) => receipt.scope === "passage" && receipt.span_text,
  );
  if (!passages.length) return "";
  return [
    "VERIFIED EVIDENCE AVAILABLE FROM PRIOR TURNS:",
    "These exact passages and evidence_ids are already registered in this turn. Use them directly in submit_grounded_answer. Do not re-fetch them, ask the user to resend them, or delegate work merely to recover or restate them. Treat reader findings as candidates: test each exact passage against every element of the current request and omit merely analogous, adjacent, or conceptually related material.",
    ...passages.map((receipt) =>
      JSON.stringify({
        evidence_id: receipt.evidence_id,
        citation: receipt.citation,
        name: receipt.name,
        locator: receipt.locator,
        exact_passage: receipt.span_text,
      }),
    ),
  ].join("\n");
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uniqueStrings(value: unknown, allowEmpty = false): string[] | null {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > 16
  )
    return null;
  const values = value.filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim()),
  );
  return values.length === value.length &&
    new Set(values).size === values.length
    ? values
    : null;
}

function passageErrors(
  evidenceIds: string[],
  state: LegalEvidenceTurnState,
  path: string,
) {
  const errors: string[] = [];
  const unknown = evidenceIds.filter((id) => !state.evidence.has(id));
  if (unknown.length) errors.push(`${path} has unknown evidence_ids: ${unknown.join(", ")}`);
  const nonPassages = evidenceIds.filter(
    (id) => state.evidence.get(id)?.receipt.scope !== "passage",
  );
  if (nonPassages.length)
    errors.push(`${path} requires an exact passage for every evidence_id`);
  return errors;
}

export function planLegalEvidence(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  if (state.mode !== "evidence_first")
    return { ok: false, errors: ["evidence planning is not active"] };
  if (
    Object.keys(args).some(
      (key) => !["answerability", "evidence_ids"].includes(key),
    )
  )
    return { ok: false, errors: ["plan has unknown fields"] };
  const answerability =
    args.answerability === "sufficient" ||
    args.answerability === "insufficient"
      ? args.answerability
      : null;
  if (!answerability)
    return {
      ok: false,
      errors: ["answerability must be sufficient or insufficient"],
    };
  const evidenceIds = uniqueStrings(
    args.evidence_ids,
    answerability === "insufficient",
  );
  if (!evidenceIds)
    return {
      ok: false,
      errors: ["evidence_ids must contain 0 to 16 unique handles"],
    };
  if (answerability === "sufficient" && evidenceIds.length === 0)
    return {
      ok: false,
      errors: ["a sufficient plan requires at least one evidence_id"],
    };
  if (answerability === "insufficient" && evidenceIds.length > 0)
    return {
      ok: false,
      errors: ["an insufficient plan cannot include evidence_ids"],
    };
  const errors = passageErrors(evidenceIds, state, "plan");
  if (errors.length) return { ok: false, errors };
  state.answerability = answerability;
  state.plannedEvidenceIds = new Set(evidenceIds);
  if (answerability === "insufficient") {
    state.attempted = true;
    state.failure =
      "The retrieved passages do not contain enough information to answer this question.";
    return { ok: true, terminal: true };
  }
  state.failure = null;
  return { ok: true };
}

const CLAIM_KINDS: LegalClaimKind[] = [
  "quotation",
  "conclusion",
  "premise_correction",
];

function parseClaims(value: unknown):
  | { ok: true; claims: GroundedLegalClaim[] }
  | { ok: false; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return { ok: false, errors: ["claims must contain 1 to 64 items"] };
  const errors: string[] = [];
  const claims: GroundedLegalClaim[] = [];
  for (const [index, raw] of value.entries()) {
    const row = object(raw);
    const knownKeys = [
      "text",
      "evidence_ids",
      "kind",
      "premise_source",
      "premise_text",
    ];
    if (row && Object.keys(row).some((key) => !knownKeys.includes(key))) {
      errors.push(`claims[${index}] has unknown fields`);
    }
    const text = typeof row?.text === "string" ? row.text.trim() : "";
    const evidenceIds = uniqueStrings(row?.evidence_ids);
    if (!text || text.length > 4_000)
      errors.push(`claims[${index}].text must contain 1 to 4000 characters`);
    if (!evidenceIds)
      errors.push(`claims[${index}].evidence_ids must contain 1 to 16 handles`);
    // Typed claim roles (Stage 8b). Strict-schema models emit null for
    // inapplicable fields; null and absent both mean "not supplied".
    const kind =
      row?.kind == null
        ? undefined
        : CLAIM_KINDS.includes(row.kind as LegalClaimKind)
          ? (row.kind as LegalClaimKind)
          : null;
    if (kind === null)
      errors.push(
        `claims[${index}].kind must be quotation, conclusion, or premise_correction`,
      );
    const premiseSource =
      row?.premise_source == null
        ? undefined
        : row.premise_source === "question" ||
            row.premise_source === "prior_answer"
          ? row.premise_source
          : null;
    if (premiseSource === null)
      errors.push(
        `claims[${index}].premise_source must be question or prior_answer`,
      );
    const premiseText =
      row?.premise_text == null
        ? undefined
        : typeof row.premise_text === "string" &&
            row.premise_text.trim().length >= 1 &&
            row.premise_text.length <= 2_000
          ? row.premise_text
          : null;
    if (premiseText === null)
      errors.push(
        `claims[${index}].premise_text must contain 1 to 2000 characters`,
      );
    if (kind === "premise_correction" && (!premiseSource || !premiseText))
      errors.push(
        `claims[${index}] is a premise_correction and must carry premise_source and premise_text (the contested words copied verbatim from that source)`,
      );
    if (kind !== "premise_correction" && (premiseSource || premiseText))
      errors.push(
        `claims[${index}] carries premise fields but is not kind premise_correction`,
      );
    if (text && evidenceIds)
      claims.push({
        text,
        evidence_ids: evidenceIds,
        ...(kind ? { kind } : {}),
        ...(premiseSource ? { premise_source: premiseSource } : {}),
        ...(premiseText ? { premise_text: premiseText } : {}),
      });
  }
  return errors.length ? { ok: false, errors } : { ok: true, claims };
}

/**
 * Deterministic premise anchoring for premise_correction claims: the
 * contested premise must be a contiguous verbatim substring (normalized
 * whitespace/quotes, >= 10 characters) of the named source text. Returns
 * null when the claim is not a typed premise correction or the harness
 * supplied no premiseContext (legacy callers) — meaning "no verdict";
 * boolean otherwise. A named-but-absent source is a definite false.
 */
export function premiseAnchorSupport(
  claim: GroundedLegalClaim,
  state: LegalEvidenceTurnState,
): boolean | null {
  if (claim.kind !== "premise_correction") return null;
  if (!state.premiseContext) return null;
  const source =
    claim.premise_source === "question"
      ? state.premiseContext.question
      : claim.premise_source === "prior_answer"
        ? state.premiseContext.priorAnswer
        : null;
  if (!source || !claim.premise_text) return false;
  const anchor = normalizeQuote(claim.premise_text);
  return anchor.length >= 10 && normalizeQuote(source).includes(anchor);
}

/**
 * H10-minimal (Stage 9): a neutral citation carries its own decision
 * year, so "2005 BCCA 293 followed 2012 SCC 57" asserts an impossible
 * temporal order — the follower predates the followed. Active voice
 * only (passive "was followed in/by" inverts the relation and is
 * skipped), both citations required in the same clause, years strictly
 * inverted. Registered prediction: zero false flags on the matrix;
 * every fire is a caught fabrication (audited either way).
 */
export function temporalOrderInversion(text: string): {
  earlier: string;
  later: string;
  verb: string;
} | null {
  const citationRe = /\b((?:19|20)\d{2})\s+[A-Z][A-Z0-9-]{1,15}\s+\d{1,5}\b/gu;
  const verbRe =
    /\b(followed|applied|adopted|affirmed|endorsed|overruled|distinguished)\b/giu;
  const citations = [...text.matchAll(citationRe)].map((match) => ({
    text: match[0],
    year: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (citations.length < 2) return null;
  for (const verb of text.matchAll(verbRe)) {
    const start = verb.index;
    const end = start + verb[0].length;
    if (
      /\b(?:was|were|been|being|be|is|are)\s+(?:\w+\s+)?$/iu.test(
        text.slice(Math.max(0, start - 24), start),
      ) ||
      /^\s+(?:by|in)\b/iu.test(text.slice(end))
    )
      continue;
    // Clause boundary: semicolon, or a period opening a capitalized
    // word — NOT the abbreviation dots inside case names ("R. v. B,").
    // A style-of-cause like "v. Boe" also reads as a boundary, which
    // only ever suppresses a flag (conservative by registration).
    const boundary = /;|\.(?=\s+[A-Z][a-z])/u;
    const subject = citations.filter(
      (candidate) =>
        candidate.end <= start &&
        start - candidate.end <= 90 &&
        !boundary.test(text.slice(candidate.end, start)),
    );
    const object = citations.find(
      (candidate) =>
        candidate.start >= end &&
        candidate.start - end <= 90 &&
        !boundary.test(text.slice(end, candidate.start)),
    );
    const last = subject[subject.length - 1];
    if (last && object && last.year < object.year)
      return {
        earlier: last.text,
        later: object.text,
        verb: verb[0].toLowerCase(),
      };
  }
  return null;
}

export function submitLegalEvidenceAnswer(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  state.attempted = true;
  // Stage 8b instrumentation: every typed rejection archives the claims
  // as submitted plus the rejection text, so bounce-shaped audits see the
  // pre-revision answer, not only the survivor.
  const reject = (
    errors: string[],
    claims: GroundedLegalClaim[] = [],
  ): { ok: false; errors: string[] } => {
    // H13-advisory (Stage 9): a rejection that is ALREADY happening may
    // additionally name the conclusion claim's corpus-alien phrasing.
    // Advisory only — it never causes a bounce, gates nothing, and is
    // absent when no lint context or index is installed.
    if (claims.length && state.lintContext) {
      const conclusion = claims.find((claim) => claim.kind === "conclusion");
      const phrases = conclusion
        ? alienPhrases(conclusion.text, {
            indexPath: state.lintContext.alienessIndexPath,
          })
        : null;
      if (phrases?.length)
        errors = [
          ...errors,
          `advisory (style, not a rule): the conclusion claim uses phrasing unattested in the legal corpus: ${phrases
            .map((phrase) => `"${phrase}"`)
            .join(", ")} — prefer the source's own words where possible`,
        ];
    }
    state.bounces.push({ claims, errors });
    return { ok: false, errors };
  };
  if (Object.keys(args).some((key) => key !== "claims"))
    return reject(["answer has unknown fields"]);
  if (
    state.mode === "evidence_first" &&
    state.answerability !== "sufficient"
  )
    return reject(["a sufficient evidence plan is required before composing"]);
  const parsed = parseClaims(args.claims);
  if (!parsed.ok) return reject(parsed.errors);
  const errors = parsed.claims.flatMap((claim, index) => {
    const claimErrors = passageErrors(
      claim.evidence_ids,
      state,
      `claims[${index}]`,
    );
    if (
      state.mode === "evidence_first" &&
      (!state.plannedEvidenceIds ||
        claim.evidence_ids.some((id) => !state.plannedEvidenceIds?.has(id)))
    ) {
      claimErrors.push(`claims[${index}] uses evidence outside the accepted plan`);
    }
    return claimErrors;
  });
  if (state.mode === null) {
    const pillText = (value: string) =>
      normalizeWhitespace(value)
        .replace(/[\u2013\u2014]/gu, "-")
        .toLocaleLowerCase("en-CA");
    for (const [index, claim] of parsed.claims.entries()) {
      const normalized = pillText(claim.text);
      for (const evidenceId of claim.evidence_ids) {
        const receipt = state.evidence.get(evidenceId)?.receipt;
        if (!receipt) continue;
        const formal = [
          receipt.citation,
          receipt.locator.kind === "document"
            ? ""
            : formatLegalLocator(receipt.locator.kind, receipt.locator.label),
        ]
          .map(pillText)
          .filter(Boolean);
        if (formal.some((value) => normalized.includes(value))) {
          errors.push(
            `claims[${index}].text contains citation or pinpoint text for ${evidenceId}; omit it and keep the source only in evidence_ids`,
          );
          break;
        }
      }
    }
  }
  if (errors.length) return reject(errors.slice(0, 12), parsed.claims);
  // Typed premise anchoring (Stage 8b, every mode the harness arms with
  // premiseContext): a premise_correction claim whose premise_text is
  // not a verbatim substring of its named source is rejected with the
  // compliant recipe restated — never silently accepted.
  const premiseSupport = parsed.claims.map((claim) =>
    premiseAnchorSupport(claim, state),
  );
  const premiseFailures = premiseSupport.flatMap((ok, index) =>
    ok === false ? [index] : [],
  );
  if (premiseFailures.length)
    return reject(
      premiseFailures.slice(0, 12).map((index) => {
        const source =
          parsed.claims[index].premise_source === "prior_answer"
            ? "the assistant's prior answer"
            : "the user's question";
        return `claims[${index}].premise_text is not a verbatim substring of ${source}${
          parsed.claims[index].premise_source === "prior_answer" &&
          !state.premiseContext?.priorAnswer
            ? " (no prior assistant answer exists this turn)"
            : ""
        }: copy at least 10 contiguous characters of the contested premise exactly as they appear there, or drop the premise_correction typing`;
      }),
      parsed.claims,
    );
  // H10-minimal temporal flag (Stage 9): rides every structured mode.
  const temporalErrors = parsed.claims.flatMap((claim, index) => {
    const inversion = temporalOrderInversion(claim.text);
    return inversion
      ? [
          `claims[${index}] asserts that ${inversion.earlier} ${inversion.verb} ${inversion.later}, but the neutral citations date the first decision BEFORE the second — that temporal order is impossible. State the relation the passages actually support, or quote them.`,
        ]
      : [];
  });
  if (temporalErrors.length)
    return reject(temporalErrors.slice(0, 12), parsed.claims);
  // quote_first enforces its composition contract DETERMINISTICALLY at
  // submission, not by prompt hope: every claim except at most one
  // conclusion claim must be a verbatim quotation of its cited passage
  // (the same tier that later renders them checker-free). The rejection
  // names the offending claims so the model can requote and retry.
  // attested_framing (Stage 8 / H12) inherits that contract and closes
  // its residual: the one paraphrase allowance never covers stands-for
  // language about a case — such claims must clear the WIDENED tier
  // (verbatim in the cited passage or an attested characterization
  // named in their evidence_ids), or be replaced by a typed statement.
  // required_slot (Stage 8b / H15) inherits attested_framing and adds
  // the mandatory characterization slot below. Typed roles key the
  // contract: kind "quotation" must clear the tier; a VERIFIED premise
  // correction does not consume the conclusion allowance (its novelty is
  // by design), but the stands-for bar still applies to it unchanged —
  // premise typing never launders a case characterization.
  if (
    state.mode === "quote_first" ||
    state.mode === "attested_framing" ||
    slotContractMode(state.mode)
  ) {
    const support = parsed.claims.map((claim) =>
      deterministicClaimSupport(claim, state),
    );
    // H16′ diff-carrying rejections (ALR-Quote-Verifier port): when a
    // failed quotation overlaps a cited span enough, the bounce carries
    // the span's own closest contiguous excerpt — deterministic, and
    // verbatim by construction, so requoting it always clears the tier.
    const repairHint = (claim: GroundedLegalClaim): string | null =>
      quoteRepairSuggestionNative(
        stripCitationTails(claim.text).replace(/^["'“‘]+|["'”’]+$/gu, ""),
        claim.evidence_ids.flatMap((id) => {
          const span = state.evidence.get(id)?.receipt.span_text;
          return span ? [span] : [];
        }),
      );
    const brokenQuotes = parsed.claims.flatMap((claim, index) =>
      claim.kind === "quotation" && !support[index] ? [index] : [],
    );
    if (brokenQuotes.length)
      return reject(
        brokenQuotes.slice(0, 12).map((index) => {
          const hint = repairHint(parsed.claims[index]);
          return `claims[${index}] is typed kind "quotation" but is not verbatim: copy at least 25 contiguous characters of one cited span exactly — no edits, elisions, or added framing — or retype it as the conclusion${
            hint ? `. Its ${hint}` : ""
          }`;
        }),
        parsed.claims,
      );
    if (
      state.mode === "attested_framing" ||
      slotContractMode(state.mode)
    ) {
      const standsFor = parsed.claims.flatMap((claim, index) =>
        !support[index] &&
        STANDS_FOR_LANGUAGE_RE.test(claim.text) &&
        claim.evidence_ids.some(
          (id) => state.evidence.get(id)?.receipt.source_class === "case",
        )
          ? [index]
          : [],
      );
      if (standsFor.length) {
        return reject(
          standsFor.slice(0, 12).map((index) => {
            const hint = repairHint(parsed.claims[index]);
            return `claims[${index}] characterizes case law (stands-for language) without verbatim support. Compliant paths, choose one: (1) quote the cited passage exactly; (2) quote one supplied attested characterization exactly, citing its evidence id; (3) write the claim exactly as: No attested characterization of [neutral citation] is available.${
              hint ? ` Its ${hint}` : ""
            }`;
          }),
          parsed.claims,
        );
      }
      // H15 required characterization slot: every cited case must have
      // its slot filled by an attested-verbatim quote (citator receipt)
      // or the exact typed refusal — free paraphrase is not a slot value.
      if (
        slotContractMode(state.mode) &&
        state.requiredCharacterizations?.length
      ) {
        const unfilled = state.requiredCharacterizations.filter(
          (citation) => {
            const refusal = normalizeQuote(
              `No attested characterization of ${citation} is available.`,
            );
            return !parsed.claims.some((claim, index) => {
              if (normalizeQuote(claim.text).includes(refusal)) return true;
              if (!support[index]) return false;
              const body = claimQuoteBody(claim);
              return (
                body !== null &&
                claim.evidence_ids.some((id) => {
                  const receipt = state.evidence.get(id)?.receipt;
                  return (
                    receipt?.resolver_version === "citator-standsfor-v1" &&
                    receipt.citation === citation &&
                    receipt.span_text !== null &&
                    normalizeQuote(receipt.span_text).includes(body)
                  );
                })
              );
            });
          },
        );
        if (unfilled.length)
          return reject(
            unfilled.slice(0, 12).map(
              (citation) =>
                `the characterization slot for ${citation} is unfilled: either quote one of its supplied attested characterizations exactly (kind "quotation", citing that evidence id), or include a claim reading exactly: No attested characterization of ${citation} is available.`,
            ),
            parsed.claims,
          );
      }
    }
    const nonVerbatim = support.flatMap((ok, index) =>
      ok || premiseSupport[index] === true ? [] : [index],
    );
    if (nonVerbatim.length > 1) {
      return reject(
        [
          `claims ${nonVerbatim.join(", ")} are not verbatim quotations of their cited passages and exceed the single conclusion allowance. To comply: (1) retype each supporting claim as kind "quotation" copying at least 25 contiguous characters of one cited span exactly; (2) keep exactly ONE kind "conclusion" claim stating the direct answer${
            state.mode === "quote_first"
              ? ""
              : `; (3) to speak to a case with no usable attested characterization, make a claim read exactly: No attested characterization of [neutral citation] is available.`
          } A premise_correction claim with verified premise_text does not count against the conclusion allowance.`,
          ...nonVerbatim.slice(0, 3).flatMap((index) => {
            const hint = repairHint(parsed.claims[index]);
            return hint ? [`claims[${index}]: ${hint}`] : [];
          }),
        ],
        parsed.claims,
      );
    }
  }
  // lint_gated (Stage 7 / H7+H13+H14): the soft pre-checker gate. Claims
  // the verbatim tier clears are untouched; composed claims run through
  // the deterministic lint at the frozen operating points. A flagged
  // claim costs exactly ONE typed revision bounce naming the features;
  // after the bounce the answer proceeds and the fired receipts ride
  // into the checker prompt instead. The gate never approves anything.
  // Stage 8b keys the bounce on kind: a VERIFIED premise correction is
  // novel by design and never bounces, but its receipts are still
  // computed and recorded for calibration.
  if (state.mode === "lint_gated") {
    const lint = parsed.claims.map((claim) =>
      deterministicClaimSupport(claim, state)
        ? null
        : lintLegalClaim(
            {
              claim: claim.text,
              spans: claim.evidence_ids.flatMap((id) => {
                const span = state.evidence.get(id)?.receipt.span_text;
                return span ? [span] : [];
              }),
              question: state.lintContext?.question ?? null,
              alienessIndexPath: state.lintContext?.alienessIndexPath,
            },
            STAGE7_LINT_THRESHOLDS,
          ),
    );
    const flagged = lint.flatMap((result, index) =>
      result?.flagged && premiseSupport[index] !== true ? [index] : [],
    );
    if (flagged.length && !state.lintBounced) {
      state.lintBounced = true;
      return reject(
        flagged.slice(0, 12).map((index) => {
          const fired = lint[index]!.receipts.filter(
            (receipt) => receipt.fired === true,
          );
          return `claims[${index}] triggers deterministic lint (${fired
            .map(
              (receipt) =>
                `${receipt.feature} ${receipt.value.toFixed(2)} > ${receipt.threshold}`,
            )
            .join(
              ", ",
            )}): revise it to track the cited passage's own words, quote the passage verbatim, or — if it corrects a false premise — retype it as kind "premise_correction" with the contested words copied verbatim into premise_text`;
        }),
        parsed.claims,
      );
    }
    state.lintReceipts = lint.map((result) => result?.receipts ?? []);
  }
  state.answer = parsed.claims;
  state.rejectedAnswer = null;
  state.verification = null;
  state.holisticVerdict = null;
  state.coverage = null;
  state.deterministicSupport = null;
  state.failure = null;
  return { ok: true, terminal: true };
}

export function submitLegalEvidenceVerification(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  if (Object.keys(args).some((key) => !["coverage", "claims"].includes(key)))
    return { ok: false, errors: ["verification has unknown fields"] };
  if (!state.answer)
    return { ok: false, errors: ["there is no answer to verify"] };
  if (!["complete", "incomplete"].includes(String(args.coverage)))
    return {
      ok: false,
      errors: ["coverage must be complete or incomplete"],
    };
  if (!Array.isArray(args.claims) || args.claims.length !== state.answer.length)
    return {
      ok: false,
      errors: ["verification must cover every claim exactly once"],
    };
  const rows: LegalClaimVerification[] = [];
  const errors: string[] = [];
  for (const [offset, raw] of args.claims.entries()) {
    const row = object(raw);
    const index = row?.index;
    const contextStatus = row?.context_status;
    const evidenceStatus = row?.evidence_status;
    if (
      !row ||
      Object.keys(row).some(
        (key) =>
          !["index", "context_status", "evidence_status"].includes(key),
      ) ||
      !Number.isInteger(index) ||
      index !== offset ||
      !["preserved", "changed", "ambiguous"].includes(String(contextStatus)) ||
      !["supported", "contradicted", "insufficient"].includes(
        String(evidenceStatus),
      )
    ) {
      errors.push(`claims[${offset}] must verify claim index ${offset}`);
      continue;
    }
    rows.push({
      index: offset,
      context_status:
        contextStatus as LegalClaimVerification["context_status"],
      evidence_status:
        evidenceStatus as LegalClaimVerification["evidence_status"],
    });
  }
  if (errors.length) return { ok: false, errors };
  state.verification = rows;
  state.coverage = args.coverage as "complete" | "incomplete";
  return { ok: true, terminal: true };
}

export function submitHolisticLegalEvidenceVerification(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  if (
    Object.keys(args).some((key) => key !== "verdict") ||
    !["supported", "partially_supported", "unsupported"].includes(
      String(args.verdict),
    )
  )
    return {
      ok: false,
      errors: [
        "verdict must be supported, partially_supported, or unsupported",
      ],
    };
  state.holisticVerdict = args.verdict as NonNullable<
    LegalEvidenceTurnState["holisticVerdict"]
  >;
  state.coverage =
    state.holisticVerdict === "supported" ? "complete" : "incomplete";
  return { ok: true, terminal: true };
}

const claimItems = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      maxLength: 4_000,
      description:
        "One independently checkable support unit in natural Markdown. Prefer one to three short exact source spans woven into the analysis; disjoint spans may share this unit so one citation highlights each span. Paraphrase only when synthesis is materially clearer. Preserve meaning-critical context, but omit formal citation and pinpoint text (for example, '2010 BCCA 170' or 'paras. 10-12'); keep sources only in evidence_ids.",
    },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string" },
      description:
        "Turn-local evidence_id values whose exact passages jointly support the whole claim.",
    },
    kind: {
      type: "string",
      enum: ["quotation", "conclusion", "premise_correction"],
      description:
        "Role of this unit. 'quotation': a supplied span's words copied exactly. 'conclusion': the direct answer in your own words (at most one). 'premise_correction': the question (or a prior assistant answer) asserts something the passages contradict, and this unit corrects it.",
    },
    premise_source: {
      type: ["string", "null"],
      enum: ["question", "prior_answer", null],
      description:
        "premise_correction only: where the contested premise appears — the user's question or the assistant's prior answer. Null for other kinds.",
    },
    premise_text: {
      type: ["string", "null"],
      maxLength: 2_000,
      description:
        "premise_correction only: the contested premise copied verbatim from the named source (at least 10 contiguous characters, exactly as written there). Null for other kinds.",
    },
  },
  required: ["text", "evidence_ids", "kind", "premise_source", "premise_text"],
} as const;

export const LEGAL_EVIDENCE_SUBMIT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_TOOL_NAME,
    strict: true,
    description:
      "Finish a legal answer as independently checkable support units tied to exact passage evidence. Prefer concise direct quotations, including up to three disjoint exact spans woven into one support unit, so its citation can highlight those spans. Paraphrase only when synthesis is materially clearer. Put citations and pinpoints only in evidence_ids, not in text. Every substantive proposition needs evidence. This call is the final answer, so do not emit a separate copy.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        claims: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: claimItems,
        },
      },
      required: ["claims"],
    },
  },
};

export const LEGAL_EVIDENCE_PLAN_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_PLAN_TOOL_NAME,
    strict: true,
    description:
      "Before composing, decide whether the exact passages can answer the question. If sufficient, commit only the minimal evidence IDs needed; if insufficient, return no IDs and stop.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        answerability: {
          type: "string",
          enum: ["sufficient", "insufficient"],
        },
        evidence_ids: {
          type: "array",
          minItems: 0,
          maxItems: 16,
          items: { type: "string" },
        },
      },
      required: ["answerability", "evidence_ids"],
    },
  },
};

const LEGAL_EVIDENCE_VERIFY_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_VERIFY_TOOL_NAME,
    strict: true,
    description:
      "Check coverage, contextual meaning preservation, and passage support for every submitted support unit.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        coverage: {
          type: "string",
          enum: ["complete", "incomplete"],
          description:
            "Whether the support units retain every verifiable proposition from the originating answer.",
        },
        claims: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              index: { type: "integer", minimum: 0 },
              context_status: {
                type: "string",
                enum: ["preserved", "changed", "ambiguous"],
                description:
                  "Whether the unit preserves its intended meaning in the request and answer context.",
              },
              evidence_status: {
                type: "string",
                enum: ["supported", "contradicted", "insufficient"],
                description:
                  "Whether only the cited passages support the unit's entire contextualized meaning.",
              },
            },
            required: ["index", "context_status", "evidence_status"],
          },
        },
      },
      required: ["coverage", "claims"],
    },
  },
};

const LEGAL_EVIDENCE_HOLISTIC_VERIFY_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_HOLISTIC_VERIFY_TOOL_NAME,
    strict: true,
    description:
      "Classify the whole candidate answer against the supplied exact passages.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: {
          type: "string",
          enum: [
            "supported",
            "partially_supported",
            "unsupported",
          ],
        },
      },
      required: ["verdict"],
    },
  },
};

export function legalEvidenceExperimentTools(
  mode = legalEvidenceExperimentMode(),
): OpenAIToolSchema[] {
  if (mode === null) return [LEGAL_EVIDENCE_SUBMIT_TOOL];
  if (
    mode === "compose_check" ||
    mode === "holistic_check" ||
    mode === "tiered_check" ||
    mode === "quote_first" ||
    mode === "attested_framing" ||
    slotContractMode(mode) ||
    mode === "lint_gated"
  )
    return [LEGAL_EVIDENCE_SUBMIT_TOOL];
  if (mode === "evidence_first")
    return [LEGAL_EVIDENCE_PLAN_TOOL, LEGAL_EVIDENCE_SUBMIT_TOOL];
  return [];
}

function evidencePrompt(state: LegalEvidenceTurnState) {
  return [...state.evidence.values()].map(({ receipt }) => ({
    evidence_id: receipt.evidence_id,
    jurisdiction: receipt.jurisdiction,
    source_class: receipt.source_class,
    citation: receipt.citation,
    locator: receipt.locator.label,
    span_text: receipt.span_text,
  }));
}

function verificationPrompt(args: {
  state: LegalEvidenceTurnState;
  requestContext?: string;
  originText: string;
}) {
  const { state } = args;
  return {
    request_context: args.requestContext ?? null,
    origin_answer: args.originText,
    submitted_answer: state.answer?.map((claim) => claim.text).join("\n\n"),
    claims: state.answer?.map((claim, index) => ({
      index,
      claim: claim.text,
      evidence: claim.evidence_ids.map((id) => {
        const receipt = state.evidence.get(id)?.receipt;
        return receipt
          ? {
              evidence_id: id,
              citation: receipt.citation,
              locator: receipt.locator.label,
              span_text: receipt.span_text,
            }
          : { evidence_id: id, missing: true };
      }),
    })),
  };
}

function mergeUsage(
  left: NormalizedLlmUsage,
  right?: NormalizedLlmUsage,
): NormalizedLlmUsage {
  const add = (
    a: number | null,
    b: number | null | undefined,
  ): number | null => (a === null && b == null ? null : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: add(left.inputTokens, right?.inputTokens),
    outputTokens: add(left.outputTokens, right?.outputTokens),
    reasoningTokens: add(left.reasoningTokens, right?.reasoningTokens),
    cacheReadInputTokens: add(
      left.cacheReadInputTokens,
      right?.cacheReadInputTokens,
    ),
    cacheWriteInputTokens: add(
      left.cacheWriteInputTokens,
      right?.cacheWriteInputTokens,
    ),
  };
}

const emptyUsage = (): NormalizedLlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: null,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

/**
 * Quote normalization for the deterministic tier: whitespace collapse plus
 * the punctuation variants renditions differ on (curly quotes, dash widths,
 * NBSP, ellipsis). Case and every substantive character are preserved — a
 * one-word substitution inside a quotation must not survive this.
 */
function normalizeQuote(value: string) {
  return normalizeWhitespace(
    value
      .replace(/[‘’‚′]/gu, "'")
      .replace(/[“”„″]/gu, '"')
      .replace(/[–—−]/gu, "-")
      .replace(/ /gu, " ")
      .replace(/…/gu, "..."),
  );
}

/**
 * Strip trailing parenthetical citation tails, balanced so nested parens in
 * pinpoints ("(ALA. CODE § 35-9A-421(b))") strip whole. At most three tails;
 * anything else stays part of the claim body.
 */
function stripCitationTails(value: string) {
  let text = value.trim();
  for (let round = 0; round < 3 && text.endsWith(")"); round += 1) {
    let depth = 0;
    let open = -1;
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (text[index] === ")") depth += 1;
      else if (text[index] === "(") {
        depth -= 1;
        if (depth === 0) {
          open = index;
          break;
        }
      }
    }
    if (open <= 0) break;
    text = text.slice(0, open).trim();
  }
  return text;
}

/**
 * Deterministic verbatim-quote support: after stripping citation tails and
 * surrounding quote marks, the normalized claim body must be a contiguous
 * substring of ONE cited passage and at least 25 characters. Anything else —
 * paraphrase, mutation, spliced quotes, prose framing — escalates to the
 * model checker. This tier verifies grounding only; it never judges
 * coverage or contextual use, and a quote wrenched out of context is the
 * documented residual risk it shares with the product's quote-only lane.
 */
export function deterministicClaimSupport(
  claim: GroundedLegalClaim,
  state: LegalEvidenceTurnState,
): boolean {
  const body = claimQuoteBody(claim);
  if (body === null) return false;
  return claim.evidence_ids.some((id) => {
    const span = state.evidence.get(id)?.receipt.span_text;
    return Boolean(span) && normalizeQuote(span as string).includes(body);
  });
}

/** The normalized quoted body the deterministic tier matches, or null
 * when the claim is too short to count as a quotation (< 25 chars). */
function claimQuoteBody(claim: GroundedLegalClaim): string | null {
  const body = normalizeQuote(
    stripCitationTails(claim.text).replace(/^["'“‘]+|["'”’]+$/gu, ""),
  );
  return body.length < 25 ? null : body;
}

function allClaimsSupported(state: LegalEvidenceTurnState) {
  if (state.mode === "citation_structure")
    return Boolean(state.answer);
  if (
    state.mode === "tiered_check" ||
    state.mode === "quote_first" ||
    state.mode === "attested_framing" ||
    slotContractMode(state.mode) ||
    state.mode === "lint_gated"
  )
    return (
      Boolean(state.answer) &&
      (state.deterministicSupport?.every(Boolean) === true ||
        state.holisticVerdict === "supported")
    );
  if (state.mode === "holistic_check")
    return (
      Boolean(state.answer) &&
      state.holisticVerdict === "supported"
    );
  return (
    state.coverage === "complete" &&
    Boolean(state.verification?.length) &&
    state.verification!.every(
      (row) =>
        row.context_status === "preserved" &&
        row.evidence_status === "supported",
    )
  );
}

function holisticVerificationPrompt(args: {
  state: LegalEvidenceTurnState;
  requestContext?: string;
}) {
  const evidenceIds = new Set(
    args.state.answer?.flatMap((claim) => claim.evidence_ids) ?? [],
  );
  // Stage 7 cascade: fired lint receipts ride INTO the checker prompt as
  // deterministic observations — the checker weighs them, the lint never
  // decides. Absent or clean lint adds nothing.
  const lintFlags =
    args.state.mode === "lint_gated"
      ? (args.state.lintReceipts ?? []).flatMap((receipts, index) =>
          receipts
            .filter((receipt) => receipt.fired === true)
            .map((receipt) => ({
              claim_index: index,
              feature: receipt.feature,
              value: receipt.value,
              threshold: receipt.threshold,
            })),
        )
      : [];
  return {
    question: args.requestContext ?? null,
    candidate_answer:
      args.state.answer?.map((claim) => claim.text).join("\n\n") ?? "",
    ...(lintFlags.length ? { deterministic_lint_flags: lintFlags } : {}),
    exact_passages: [...evidenceIds].flatMap((id) => {
      const receipt = args.state.evidence.get(id)?.receipt;
      return receipt
        ? [
            {
              evidence_id: id,
              citation: receipt.citation,
              span_text: receipt.span_text,
            },
          ]
        : [];
    }),
  };
}

async function structuredAnswerPass(args: {
  state: LegalEvidenceTurnState;
  model: string;
  prompt: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}) {
  return streamChatWithTools({
    model: args.model,
    systemPrompt:
      "Return no prose. Call submit_grounded_answer once. Do not add facts absent from the supplied evidence.",
    messages: [{ role: "user", content: args.prompt }],
    tools: [LEGAL_EVIDENCE_SUBMIT_TOOL],
    maxIterations: 2,
    apiKeys: args.apiKeys,
    reasoningEffort: args.reasoningEffort,
    enableThinking: false,
    abortSignal: args.abortSignal,
    runTools: async (calls) =>
      calls.map((call) => {
        const submitted =
          call.name === LEGAL_EVIDENCE_TOOL_NAME
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

async function verificationPass(args: {
  state: LegalEvidenceTurnState;
  model: string;
  /** Run the checker on a different model than the composer (crossed). */
  checkerModel?: string;
  requestContext?: string;
  originText: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}) {
  return streamChatWithTools({
    model: args.checkerModel ?? args.model,
    systemPrompt:
      "Act as a strict contextual grounding checker. First determine each support unit's intended meaning from the request and answer context; context may resolve meaning but is never evidence. Mark changed when a unit asserts more or something different than the originating answer, and ambiguous when its intended meaning cannot be resolved confidently. Then use only the cited passages to classify its entire contextualized meaning as supported, contradicted, or insufficient. Coverage is complete only if the submitted units retain every verifiable proposition in the originating answer. Return no prose and call verify_grounded_claims once.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(verificationPrompt(args)),
      },
    ],
    tools: [LEGAL_EVIDENCE_VERIFY_TOOL],
    maxIterations: 2,
    apiKeys: args.apiKeys,
    reasoningEffort: args.reasoningEffort,
    enableThinking: false,
    abortSignal: args.abortSignal,
    runTools: async (calls) =>
      calls.map((call) => {
        const submitted =
          call.name === LEGAL_EVIDENCE_VERIFY_TOOL_NAME
            ? submitLegalEvidenceVerification(call.input, args.state)
            : { ok: false, errors: [`Unexpected tool: ${call.name}`] };
        return {
          tool_use_id: call.id,
          content: JSON.stringify(submitted),
          terminal: "terminal" in submitted && submitted.terminal === true,
        };
      }),
  });
}

/**
 * Run the existing strict evidence checker over one or more already-atomic
 * claims without invoking the answer-repair loop. Benchmark and routing
 * callers use this entry point so their verdicts share the product prompt,
 * tool schema, and receipt state instead of growing a second checker.
 */
export async function semanticClaimVerificationPass(args: {
  state: LegalEvidenceTurnState;
  model: string;
  checkerModel?: string;
  requestContext?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}) {
  if (!args.state.answer?.length)
    throw new Error("semantic claim verification requires at least one claim");
  return verificationPass({
    ...args,
    originText: args.state.answer.map((claim) => claim.text).join("\n\n"),
  });
}

/**
 * One whole-answer checker call. Exported so the checker-family crossing
 * can re-judge BANKED compositions with a different family over the exact
 * same system prompt, tool and payload the original run used — a re-check
 * that diverged from this function would measure the re-check harness, not
 * the checker family.
 */
export async function holisticVerificationPass(args: {
  state: LegalEvidenceTurnState;
  model: string;
  /** Run the checker on a different model than the composer (crossed). */
  checkerModel?: string;
  requestContext?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}) {
  return streamChatWithTools({
    model: args.checkerModel ?? args.model,
    systemPrompt:
      "Judge the candidate answer holistically against the exact passages. Do not decompose it into claims. Treat all outside knowledge as unavailable. Return supported only when every material assertion is attributable to the passages and the answer covers the substance those passages can answer. Return partially_supported when it mixes supported and unsupported material or materially omits answerable substance. Return unsupported when the passages do not establish the core answer. Ignore style and verbosity. Return no prose and call verify_grounded_answer once.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(holisticVerificationPrompt(args)),
      },
    ],
    tools: [LEGAL_EVIDENCE_HOLISTIC_VERIFY_TOOL],
    maxIterations: 2,
    apiKeys: args.apiKeys,
    reasoningEffort: args.reasoningEffort,
    enableThinking: false,
    abortSignal: args.abortSignal,
    runTools: async (calls) =>
      calls.map((call) => {
        const submitted =
          call.name === LEGAL_EVIDENCE_HOLISTIC_VERIFY_TOOL_NAME
            ? submitHolisticLegalEvidenceVerification(
                call.input,
                args.state,
              )
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

async function finalizeLegalEvidenceExperimentUnsafe(args: {
  state: LegalEvidenceTurnState;
  model: string;
  /**
   * Crossed-checker control: verification passes run on this model while
   * composition (including the compose_check repair pass) stays on the
   * composer model. Absent means same-model checking.
   */
  checkerModel?: string;
  draft: string;
  requestContext?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  abortSignal?: AbortSignal;
}): Promise<LegalEvidenceFinalizationResult> {
  const { state } = args;
  let usage = emptyUsage();
  let modelCalls = 0;
  if (
    !state.mode &&
    !state.answer &&
    (hasCitationInText(args.draft) ||
      hasCanadianDecisionLink(args.draft) ||
      [...state.evidence.values()].some(
        ({ receipt }) => receipt.provider !== "library",
      ))
  ) {
    state.mode = "citation_structure";
  }
  if (!state.mode)
    return { passed: true, modelCalls, usage, diagnostic: null };
  if (
    !state.answer &&
    !hasCitationInText(args.draft) &&
    !hasCanadianDecisionLink(args.draft)
  )
    return { passed: true, modelCalls, usage, diagnostic: null };
  state.attempted = true;
  if (
    state.mode === "evidence_first" &&
    state.answerability === "insufficient"
  )
    return { passed: false, modelCalls, usage, diagnostic: null };

  if (
    state.mode === "citation_structure" &&
    !state.answer &&
    args.draft.trim()
  ) {
    const result = await structuredAnswerPass({
      state,
      model: args.model,
      prompt: JSON.stringify({
        instruction:
          "Convert the candidate answer into prose-only support units. Keep only propositions supported by their exact passages; omit citation and pinpoint text.",
        request: args.requestContext,
        candidate_answer: args.draft,
        evidence: evidencePrompt(state),
      }),
      apiKeys: args.apiKeys,
      reasoningEffort: args.reasoningEffort,
      abortSignal: args.abortSignal,
    });
    usage = mergeUsage(usage, result.usage);
    modelCalls += 1;
  }

  if (!state.answer) {
    state.failure = "The model did not submit a grounded answer.";
    return { passed: false, modelCalls, usage, diagnostic: null };
  }

  if (state.mode === "citation_structure")
    return { passed: true, modelCalls, usage, diagnostic: null };

  if (
    state.mode === "tiered_check" ||
    state.mode === "quote_first" ||
    state.mode === "attested_framing" ||
    slotContractMode(state.mode) ||
    state.mode === "lint_gated"
  ) {
    state.deterministicSupport = state.answer.map((claim) =>
      deterministicClaimSupport(claim, state),
    );
    if (state.deterministicSupport.every(Boolean)) {
      // Every claim is a verified verbatim quote of its cited passage:
      // grounding holds by construction and no checker call is spent.
      // Coverage stays not_run — the deterministic tier never judges it.
      return { passed: true, modelCalls, usage, diagnostic: null };
    }
    // Escalate the whole answer to the single holistic check, with
    // bounded retries on transport-class failures (provider overload,
    // stream aborts, malformed no-verdict replies). Semantic verdicts
    // are never retried; the per-cell abort signal still governs.
    let transportDiagnostic: string | null = null;
    for (let attempt = 0; attempt < 3 && !state.holisticVerdict; attempt += 1) {
      try {
        const result = await holisticVerificationPass(args);
        usage = mergeUsage(usage, result.usage);
        modelCalls += 1;
      } catch (error) {
        if (
          args.abortSignal?.aborted ||
          (error as { name?: unknown })?.name === "AbortError"
        )
          throw error;
        transportDiagnostic =
          error instanceof Error ? error.message : String(error);
        if (attempt === 2) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 750 * (attempt + 1)),
        );
      }
    }
    if (allClaimsSupported(state))
      return { passed: true, modelCalls, usage, diagnostic: transportDiagnostic };
    state.rejectedAnswer = state.answer;
    state.answer = null;
    state.failure =
      "The answer could not be verified against the retrieved passages.";
    return { passed: false, modelCalls, usage, diagnostic: transportDiagnostic };
  }

  if (state.mode === "holistic_check") {
    const result = await holisticVerificationPass(args);
    usage = mergeUsage(usage, result.usage);
    modelCalls += 1;
    if (allClaimsSupported(state))
      return { passed: true, modelCalls, usage, diagnostic: null };
    state.rejectedAnswer = state.answer;
    state.answer = null;
    state.failure =
      "The answer could not be verified against the retrieved passages.";
    return { passed: false, modelCalls, usage, diagnostic: null };
  }

  const originText = state.answer
    .map((claim) => claim.text)
    .join("\n\n");
  let result = await verificationPass({ ...args, originText });
  usage = mergeUsage(usage, result.usage);
  modelCalls += 1;
  if (allClaimsSupported(state))
    return { passed: true, modelCalls, usage, diagnostic: null };

  const firstAnswer = state.answer;
  const firstVerification = state.verification;
  state.rejectedAnswer = firstAnswer;
  state.answer = null;
  state.verification = null;
  state.coverage = null;
  result = await structuredAnswerPass({
    ...args,
    prompt: JSON.stringify({
      instruction:
        "Repair the answer once. Keep only claims wholly supported by their cited exact passages; correct overstatement and contradictions.",
      rejected_claims: firstAnswer,
      verification: firstVerification,
      evidence: evidencePrompt(state),
    }),
  });
  usage = mergeUsage(usage, result.usage);
  modelCalls += 1;

  if (state.answer) {
    result = await verificationPass({ ...args, originText });
    usage = mergeUsage(usage, result.usage);
    modelCalls += 1;
  }
  if (allClaimsSupported(state))
    return { passed: true, modelCalls, usage, diagnostic: null };

  if (state.answer) state.rejectedAnswer = state.answer;
  state.answer = null;
  state.failure = "The answer could not be verified against the retrieved passages.";
  return { passed: false, modelCalls, usage, diagnostic: null };
}

export async function finalizeLegalEvidenceExperiment(
  args: Parameters<typeof finalizeLegalEvidenceExperimentUnsafe>[0],
): Promise<LegalEvidenceFinalizationResult> {
  try {
    return await finalizeLegalEvidenceExperimentUnsafe(args);
  } catch (error) {
    if (
      args.abortSignal?.aborted ||
      (error as { name?: unknown })?.name === "AbortError"
    ) {
      throw error;
    }
    args.state.attempted = true;
    if (args.state.answer) args.state.rejectedAnswer = args.state.answer;
    args.state.answer = null;
    args.state.failure = "The answer could not be verified against the retrieved passages.";
    return {
      passed: false,
      modelCalls: 0,
      usage: emptyUsage(),
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderLegalEvidenceAnswer(
  state: LegalEvidenceTurnState,
): string | null {
  const citation = (entry: RegisteredEvidence) => {
    const { receipt, document } = entry;
    const source = entry.source ?? (document
      ? a2ajLegalSourceProvider.source(document) : null);
    const paragraphRange =
      receipt.locator.kind === "paragraph"
        ? receipt.locator.label.match(
            /^par(\d+)(?:-|\u2013|\u2014)par(\d+)$/iu,
          )
        : null;
    // Attested-characterization receipts carry WHOSE words they are in
    // locator.label ("as characterized by the ONCA (2020)"); render that
    // attribution after an em dash so borrowed framing is not presented as
    // the assistant's own synthesis. Note-up receipts are excluded: their
    // citation already names the citing case, so their label would repeat it.
    const citatorAttribution =
      receipt.resolver_version === "citator-standsfor-v1";
    const a2ajLocator = ["paragraph", "page", "section"].includes(
      receipt.locator.kind,
    ) ? receipt.locator as {
        kind: "paragraph" | "page" | "section";
        label: string;
      } : null;
    const url =
      document && paragraphRange
        ? buildA2AJParagraphRangeUrl(
            receipt.citation,
            paragraphRange[1],
            paragraphRange[2],
            [document],
          )
        : document && receipt.span_text && a2ajLocator
          ? buildA2AJDocumentPinpointUrl(
              document,
              a2ajLocator,
              receipt.span_text,
              [],
              source,
            )
          : citatorAttribution &&
              receipt.external_url &&
              receipt.span_text &&
              receipt.dataset !== "journal-commentary"
            ? // A citing court's characterization deep-links to the exact
              // prose within the citing case (text-fragment), like any other
              // pinpoint. Journal commentary is excluded: the article URL is
              // a PDF galley, where text-fragments cannot resolve.
              buildLegalSourceMultiPassageUrl(receipt.external_url, [
                {
                  blockText: receipt.span_text,
                  quotes: [receipt.span_text],
                },
              ]) ?? receipt.external_url
            : receipt.external_url;
    const locator = paragraphRange
      ? `paras. ${Number(paragraphRange[1])}\u2013${Number(paragraphRange[2])}`
      : citatorAttribution
        ? receipt.locator.label
        : receipt.locator.kind === "document"
          ? ""
          : formatLegalLocator(receipt.locator.kind, receipt.locator.label);
    const label = [
      receipt.citation,
      locator
        ? receipt.locator.kind === "section"
          ? `, ${locator}`
          : citatorAttribution
            ? ` \u2014 ${locator}`
            : ` at ${locator}`
        : "",
    ].join("");
    const markdown = url
      ? `[${label.replace(/[\\[\]]/gu, "\\$&")}](${url.replace(/\)/gu, "%29")})`
      : label;
    const locatorVariants = locator
      ? [
          locator,
          locator.replace(/\u2013/gu, "-"),
          locator.replace(/\./gu, ""),
          locator.replace(/\./gu, "").replace(/\u2013/gu, "-"),
        ]
      : [];
    return {
      markdown,
      candidates: [...new Set([label, receipt.citation, ...locatorVariants])]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length),
    };
  };
  // A premise correction whose anchor re-verifies deterministically
  // renders visibly AS a correction, not as an ordinary sentence.
  const decorate = (claim: GroundedLegalClaim, text: string): string =>
    claim.kind === "premise_correction" &&
    premiseAnchorSupport(claim, state) === true
      ? `**Premise correction** — ${
          claim.premise_source === "prior_answer"
            ? "the earlier answer"
            : "the question"
        } states "${claim.premise_text}": ${text}`
      : text;
  const renderClaim = (claim: GroundedLegalClaim): string => {
      const citations = [
          ...new Map(
            claim.evidence_ids.flatMap((id) => {
              const entry = state.evidence.get(id);
              return entry
                ? [[
                    `${entry.receipt.stable_source_id}|${entry.receipt.locator.kind}|${entry.receipt.locator.label}`,
                    citation(entry),
                  ] as const]
                : [];
            }),
          ).values(),
        ];
      if (!citations.length) return decorate(claim, claim.text);
      let text = claim.text;
      const pending: string[] = [];
      const replacements = new Map<string, string>();
      for (const [index, placement] of citations.entries()) {
        const normalized = text.toLocaleLowerCase("en-CA");
        const candidate = placement.candidates.find((value) =>
          normalized.includes(value.toLocaleLowerCase("en-CA")),
        );
        if (!candidate) {
          pending.push(placement.markdown);
          continue;
        }
        const start = normalized.indexOf(
          candidate.toLocaleLowerCase("en-CA"),
        );
        const token = `\u0000legal-citation-${index}\u0000`;
        text =
          text.slice(0, start) +
          token +
          text.slice(start + candidate.length);
        replacements.set(token, placement.markdown);
      }
      if (pending.length) {
        const punctuation = text.match(/[.!?]$/u)?.[0] ?? "";
        const body = punctuation ? text.slice(0, -1) : text;
        text = `${body} ${pending.join("; ")}${punctuation}`;
      }
      for (const [token, markdown] of replacements) {
        text = text.replace(token, markdown);
      }
      return decorate(claim, text);
  };

  // Verified premise corrections and typed unavailability statements are
  // receipts-backed content the user should see even when the submission
  // as a whole failed — surfaced above the typed abstention line, never
  // parsed from prose. Salvage draws from the last checker-rejected
  // answer or, failing that, the last bounce (excluding claims its typed
  // errors name), and re-verifies each premise anchor deterministically
  // at render time.
  if (state.failure) {
    const lastBounce = state.bounces[state.bounces.length - 1];
    const claims = state.rejectedAnswer ?? lastBounce?.claims ?? [];
    const fromBounce = !state.rejectedAnswer && !!lastBounce;
    const unavailability =
      /^No attested characterization of .+ is available\.$/u;
    const salvaged = claims.flatMap((claim, index) => {
      if (
        fromBounce &&
        lastBounce!.errors.some((error) => error.includes(`claims[${index}]`))
      )
        return [];
      if (
        claim.kind === "premise_correction" &&
        premiseAnchorSupport(claim, state) === true
      )
        return [renderClaim(claim)];
      if (unavailability.test(claim.text.trim())) return [claim.text.trim()];
      return [];
    });
    return salvaged.length
      ? [...salvaged, state.failure].join("\n\n")
      : state.failure;
  }
  if (!state.answer) return null;
  if (state.mode === null) {
    const refs = new Map(
      legalEvidenceCitationEntries(state).map(({ ref, receipt }) => [
        receipt.evidence_id,
        ref,
      ]),
    );
    return state.answer
      .map((claim) => {
        const markers = [
          ...new Set(
            claim.evidence_ids.flatMap((id) => {
              const ref = refs.get(id);
              return ref === undefined ? [] : [`[${ref}]`];
            }),
          ),
        ];
        return decorate(
          claim,
          `${claim.text}${markers.length ? ` ${markers.join("")}` : ""}`,
        );
      })
      .join("\n\n");
  }
  if (state.mode && !allClaimsSupported(state)) return null;
  return state.answer.map(renderClaim).join("\n\n");
}

/** First-use citation order for the strict production evidence schema. */
export function legalEvidenceCitationEntries(
  state: LegalEvidenceTurnState,
): Array<RegisteredEvidence & { ref: number }> {
  if (!state.answer) return [];
  const entries: Array<RegisteredEvidence & { ref: number }> = [];
  const seen = new Set<string>();
  for (const claim of state.answer) {
    for (const evidenceId of claim.evidence_ids) {
      if (seen.has(evidenceId)) continue;
      const entry = state.evidence.get(evidenceId);
      if (!entry) continue;
      seen.add(evidenceId);
      entries.push({ ...entry, ref: entries.length + 1 });
    }
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
    answerability: "sufficient" | "insufficient" | "not_run";
    holistic:
      | "supported"
      | "partially_supported"
      | "unsupported"
      | "not_run";
    semantic: "model_checked" | "failed" | "not_run";
    coverage: "complete" | "incomplete" | "not_run";
    authority: "not_run";
  };
  claims: Array<
    GroundedLegalClaim & {
      text_sha256: string;
      context_status: LegalClaimVerification["context_status"] | "not_run";
      evidence_status: LegalClaimVerification["evidence_status"] | "not_run";
      /** tiered_check only: this claim cleared the verbatim-quote tier. */
      deterministic_support?: boolean;
      /** premise_correction only: premise_text anchored verbatim in its
       * named source (null = harness supplied no premiseContext). */
      premise_support?: boolean | null;
      /** lint_gated only: full lint receipts (fired and clean alike). */
      lint?: LintFeatureReceipt[];
    }
  >;
  evidence: LegalEvidenceReceipt[];
  /** Stage 8b: every typed submission rejection this turn — the claims
   * as submitted (pre-bounce) and the rejection strings. */
  bounces: Array<{
    claims: Array<GroundedLegalClaim & { text_sha256: string }>;
    errors: string[];
  }>;
  failure: string | null;
};

export function legalEvidenceReceiptEvent(
  state: LegalEvidenceTurnState,
): LegalEvidenceReceiptEvent | null {
  if (!state.attempted) return null;
  const claims = state.answer ?? state.rejectedAnswer ?? [];
  const ids = new Set(claims.flatMap((claim) => claim.evidence_ids));
  const passed =
    Boolean(state.answer) &&
    (state.mode === null || allClaimsSupported(state));
  return {
    type: "legal_evidence_receipt",
    schema_version: 6,
    mode: state.mode,
    status: passed ? "passed" : "failed",
    verification: {
      reference: "verified",
      answerability: state.answerability ?? "not_run",
      holistic: state.holisticVerdict ?? "not_run",
      semantic: state.verification || state.holisticVerdict
        ? passed
          ? "model_checked"
          : "failed"
        : "not_run",
      coverage: state.coverage ?? "not_run",
      authority: "not_run",
    },
    claims: claims.map((claim, index) => ({
      ...claim,
      text_sha256: sha256(claim.text),
      context_status:
        state.verification?.[index]?.context_status ?? "not_run",
      evidence_status:
        state.verification?.[index]?.evidence_status ?? "not_run",
      ...(state.deterministicSupport
        ? { deterministic_support: state.deterministicSupport[index] ?? false }
        : {}),
      ...(claim.kind === "premise_correction"
        ? { premise_support: premiseAnchorSupport(claim, state) }
        : {}),
      ...(state.lintReceipts?.[index]?.length
        ? { lint: state.lintReceipts[index] }
        : {}),
    })),
    evidence: [...ids].flatMap((id) => {
      const entry = state.evidence.get(id);
      return entry ? [entry.receipt] : [];
    }),
    bounces: state.bounces.map((bounce) => ({
      claims: bounce.claims.map((claim) => ({
        ...claim,
        text_sha256: sha256(claim.text),
      })),
      errors: bounce.errors,
    })),
    failure: state.failure,
  };
}
