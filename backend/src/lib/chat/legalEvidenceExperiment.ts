import crypto from "node:crypto";

import {
  getA2AJDocumentSourceDoc,
  getA2AJLookupDocument,
  type A2AJDocument,
  type A2AJLocatorLookup,
} from "../a2aj";
import {
  buildA2AJParagraphRangeUrl,
  buildA2AJPinpointUrl,
  formatLegalLocator,
} from "../legalSourceLinks";
import {
  streamChatWithTools,
  type NormalizedLlmUsage,
  type OpenAIToolSchema,
  type UserApiKeys,
} from "../llm";
import { normalizeWhitespace } from "../text";

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
] as const;

export type LegalEvidenceExperimentMode =
  (typeof LEGAL_EVIDENCE_EXPERIMENT_MODES)[number];
export type LegalEvidenceMode =
  | "citation_structure"
  | LegalEvidenceExperimentMode;

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

export type LegalSourceClass = "case" | "legislation";

export type LegalEvidenceReceipt = {
  evidence_id: string;
  provider: "a2aj" | "benchmark" | "citator";
  jurisdiction: string;
  source_class: LegalSourceClass;
  stable_source_id: string;
  source_sha256: string;
  scope: "document" | "passage";
  block_id: string;
  span_sha256: string;
  span_text: string | null;
  citation: string;
  name: string | null;
  dataset: string;
  language: "en" | "fr";
  version: string | null;
  external_url: string | null;
  locator: {
    kind: "document" | A2AJLocatorLookup["requested"]["kind"];
    label: string;
  };
  resolver_version:
    | "a2aj-inline-v1"
    | "benchmark-span-v1"
    | "citator-standsfor-v1";
};

type RegisteredEvidence = {
  receipt: LegalEvidenceReceipt;
  document?: A2AJDocument;
  lookup?: A2AJLocatorLookup;
};

export type GroundedLegalClaim = {
  text: string;
  evidence_ids: string[];
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
    attempted: false,
    failure: null,
  };
}

function sha256(value: string) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function evidenceId() {
  return `e_${crypto.randomBytes(9).toString("base64url")}`;
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
  const sourceText = getA2AJDocumentSourceDoc(document).text;
  return {
    evidence_id: evidenceId(),
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableSourceId(document),
    source_sha256: sha256(sourceText),
    scope: "document",
    block_id: "document",
    span_sha256: sha256(normalizeWhitespace(document.text)),
    span_text: null,
    citation: document.citation,
    name: document.name,
    dataset: document.dataset,
    language: document.language,
    version: document.date,
    external_url: document.url,
    locator: { kind: "document", label: "document" },
    resolver_version: "a2aj-inline-v1",
  };
}

export function createA2AJLookupEvidence(
  lookup: A2AJLocatorLookup,
  sourceClass: LegalSourceClass = "case",
): LegalEvidenceReceipt | null {
  if (lookup.status !== "found" || !lookup.block) return null;
  const sourceText = getA2AJLookupDocument(lookup)?.text ?? lookup.block.text;
  const spanText = lookup.block.text;
  return {
    evidence_id: evidenceId(),
    provider: "a2aj",
    jurisdiction: "CA",
    source_class: sourceClass,
    stable_source_id: stableSourceId(lookup),
    source_sha256: sha256(sourceText),
    scope: "passage",
    block_id: [
      lookup.block.kind,
      lookup.block.label,
      lookup.block.start,
      lookup.block.end,
    ].join(":"),
    span_sha256: sha256(normalizeWhitespace(spanText)),
    span_text: spanText,
    citation: lookup.citation,
    name: lookup.name,
    dataset: lookup.dataset,
    language: lookup.language,
    version: null,
    external_url: lookup.url,
    locator: {
      kind: lookup.requested.kind,
      label: lookup.requested.label,
    },
    resolver_version: "a2aj-inline-v1",
  };
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
  return {
    evidence_id: evidenceId(),
    provider: "benchmark",
    jurisdiction: args.jurisdiction,
    source_class: args.sourceClass,
    stable_source_id: args.stableSourceId,
    source_sha256: sha256(args.sourceText),
    scope: "passage",
    block_id: `${args.locatorKind ?? "section"}:${args.locatorLabel}`,
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
  };
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
  };
  jurisdiction?: string;
  language?: "en" | "fr";
}): LegalEvidenceReceipt {
  const citing =
    args.characterization.citingCitation ??
    args.characterization.citingName ??
    "unknown citing case";
  return {
    evidence_id: evidenceId(),
    provider: "citator",
    jurisdiction: args.jurisdiction ?? "CA",
    source_class: "case",
    stable_source_id: `citator:standsfor:${citing}`,
    source_sha256: sha256(args.characterization.text),
    scope: "passage",
    block_id: `standsfor:${citing}`,
    span_sha256: sha256(normalizeWhitespace(args.characterization.text)),
    span_text: args.characterization.text,
    citation: args.citedCitation,
    name: args.characterization.citingName,
    dataset: "citator",
    language: args.language ?? "en",
    version: args.characterization.citingDate,
    external_url: null,
    locator: {
      kind: "document",
      label: `as characterized by ${citing}${
        args.characterization.citingCourt
          ? ` (${args.characterization.citingCourt})`
          : ""
      }`,
    },
    resolver_version: "citator-standsfor-v1",
  };
}

export function registerLegalEvidence(
  state: LegalEvidenceTurnState,
  receipt: LegalEvidenceReceipt | undefined,
  source: {
    document?: A2AJDocument;
    lookup?: A2AJLocatorLookup;
  } = {},
) {
  if (!receipt) return;
  state.mode ??= "citation_structure";
  state.evidence.set(receipt.evidence_id, { receipt, ...source });
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

function parseClaims(value: unknown):
  | { ok: true; claims: GroundedLegalClaim[] }
  | { ok: false; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    return { ok: false, errors: ["claims must contain 1 to 64 items"] };
  const errors: string[] = [];
  const claims: GroundedLegalClaim[] = [];
  for (const [index, raw] of value.entries()) {
    const row = object(raw);
    if (
      row &&
      Object.keys(row).some((key) => !["text", "evidence_ids"].includes(key))
    ) {
      errors.push(`claims[${index}] has unknown fields`);
    }
    const text = typeof row?.text === "string" ? row.text.trim() : "";
    const evidenceIds = uniqueStrings(row?.evidence_ids);
    if (!text || text.length > 4_000)
      errors.push(`claims[${index}].text must contain 1 to 4000 characters`);
    if (!evidenceIds)
      errors.push(`claims[${index}].evidence_ids must contain 1 to 16 handles`);
    if (text && evidenceIds) claims.push({ text, evidence_ids: evidenceIds });
  }
  return errors.length ? { ok: false, errors } : { ok: true, claims };
}

export function submitLegalEvidenceAnswer(
  args: Record<string, unknown>,
  state: LegalEvidenceTurnState,
): { ok: boolean; terminal?: true; errors?: string[] } {
  state.attempted = true;
  if (Object.keys(args).some((key) => key !== "claims"))
    return { ok: false, errors: ["answer has unknown fields"] };
  if (
    state.mode === "evidence_first" &&
    state.answerability !== "sufficient"
  )
    return {
      ok: false,
      errors: ["a sufficient evidence plan is required before composing"],
    };
  const parsed = parseClaims(args.claims);
  if (!parsed.ok) return parsed;
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
  // quote_first enforces its composition contract DETERMINISTICALLY at
  // submission, not by prompt hope: every claim except at most one
  // conclusion claim must be a verbatim quotation of its cited passage
  // (the same tier that later renders them checker-free). The rejection
  // names the offending claims so the model can requote and retry.
  if (state.mode === "quote_first" && !errors.length) {
    const support = parsed.claims.map((claim) =>
      deterministicClaimSupport(claim, state),
    );
    const nonVerbatim = support.flatMap((ok, index) => (ok ? [] : [index]));
    if (nonVerbatim.length > 1) {
      return {
        ok: false,
        errors: [
          `claims ${nonVerbatim.join(", ")} are not verbatim quotations of their cited passages; at most ONE conclusion claim may paraphrase — every other claim must quote the passage exactly`,
        ],
      };
    }
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 12) };
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
        "One independently checkable support unit in natural Markdown. Preserve meaning-critical context, but omit formal citation and pinpoint text (for example, '2010 BCCA 170' or 'paras. 10-12'); Beaver appends it from evidence_ids.",
    },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string" },
      description:
        "Turn-local evidence_id values whose exact passages jointly support the whole claim.",
    },
  },
  required: ["text", "evidence_ids"],
} as const;

export const LEGAL_EVIDENCE_SUBMIT_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: LEGAL_EVIDENCE_TOOL_NAME,
    strict: true,
    description:
      "Finish a Canadian legal answer as independently checkable support units tied to exact passage evidence. Do not write citations in text; Beaver appends each evidence receipt's complete citation at the end of its unit. Every substantive proposition needs evidence. This call is the final answer, so do not emit a separate copy.",
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
    mode === "quote_first"
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
  const body = normalizeQuote(
    stripCitationTails(claim.text).replace(/^["'“‘]+|["'”’]+$/gu, ""),
  );
  if (body.length < 25) return false;
  return claim.evidence_ids.some((id) => {
    const span = state.evidence.get(id)?.receipt.span_text;
    return Boolean(span) && normalizeQuote(span as string).includes(body);
  });
}

function allClaimsSupported(state: LegalEvidenceTurnState) {
  if (state.mode === "citation_structure") return Boolean(state.answer);
  if (state.mode === "tiered_check" || state.mode === "quote_first")
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
  return {
    question: args.requestContext ?? null,
    candidate_answer:
      args.state.answer?.map((claim) => claim.text).join("\n\n") ?? "",
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

async function holisticVerificationPass(args: {
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
  if (!state.mode)
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

  if (state.mode === "tiered_check" || state.mode === "quote_first") {
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
  if (state.failure) return state.failure;
  if (!state.answer) return null;
  if (
    state.mode &&
    !allClaimsSupported(state)
  ) {
    return null;
  }
  const citation = (entry: RegisteredEvidence) => {
    const { receipt, lookup, document } = entry;
    const paragraphRange =
      receipt.locator.kind === "paragraph"
        ? receipt.locator.label.match(
            /^par(\d+)(?:-|\u2013|\u2014)par(\d+)$/iu,
          )
        : null;
    const url =
      lookup && paragraphRange
        ? buildA2AJParagraphRangeUrl(
            receipt.citation,
            paragraphRange[1],
            paragraphRange[2],
            [lookup],
            document ? [document] : [],
          )
        : lookup
          ? buildA2AJPinpointUrl(lookup, [])
          : receipt.external_url;
    const locator = paragraphRange
      ? `paras. ${Number(paragraphRange[1])}\u2013${Number(paragraphRange[2])}`
      : receipt.locator.kind === "document"
        ? ""
        : formatLegalLocator(receipt.locator.kind, receipt.locator.label);
    const label = [
      receipt.citation,
      locator
        ? receipt.locator.kind === "section"
          ? `, ${locator}`
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
  return state.answer
    .map((claim) => {
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
      if (!citations.length) return claim.text;
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
      return text;
    })
    .join("\n\n");
}

export type LegalEvidenceReceiptEvent = {
  type: "legal_evidence_receipt";
  schema_version: 5;
  mode: LegalEvidenceMode;
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
    }
  >;
  evidence: LegalEvidenceReceipt[];
  failure: string | null;
};

export function legalEvidenceReceiptEvent(
  state: LegalEvidenceTurnState,
): LegalEvidenceReceiptEvent | null {
  if (!state.mode || !state.attempted) return null;
  const claims = state.answer ?? state.rejectedAnswer ?? [];
  const ids = new Set(claims.flatMap((claim) => claim.evidence_ids));
  const passed =
    Boolean(state.answer) &&
    allClaimsSupported(state);
  return {
    type: "legal_evidence_receipt",
    schema_version: 5,
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
    })),
    evidence: [...ids].flatMap((id) => {
      const entry = state.evidence.get(id);
      return entry ? [entry.receipt] : [];
    }),
    failure: state.failure,
  };
}
