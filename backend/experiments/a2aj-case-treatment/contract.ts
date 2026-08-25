import { createHash } from "node:crypto";

import { createA2AJPassageEvidence, type LegalEvidenceReceipt } from "../../src/lib/chat/legalEvidence";
import { structureNative } from "../../src/lib/structureNative";

const { groundedProseErrors, markedQuoteSpans, quoteRepairSuggestion } = structureNative();
const wordCount = (value: string) => value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
import type {
  DecisionCitationInventory,
} from "../a2aj-decision-roster/caseDecisionMvp";
import { MIN_OPINION_WORDS } from "../a2aj-decision-roster/legalOpinionBoundaries";
import type { ModelSourceLine } from "../a2aj-decision-roster/caseTargetMvpReduced";

export const CASE_TREATMENT_CONTRACT_VERSION = "a2aj-proposition-treatment-v1";

export const RESULT_POSITIONS = [
  "supports_disposition",
  "opposes_disposition",
  "mixed",
  "unclear",
] as const;

export const REFERENCE_VOICES = [
  "current_opinion",
  "party_or_counsel",
  "decision_under_review",
  "quoted_decision",
  "other_quoted_source",
  "document_metadata",
  "unclear",
] as const;

export const TREATMENT_SIGNALS = [
  "explained",
  "approved",
  "followed",
  "applied",
  "extended",
  "distinguished",
  "limited",
  "criticized",
  "questioned",
  "not_followed",
  "overruled",
  "other",
] as const;

export const PROCEDURAL_STAGE_RELATIONS = [
  "decision_under_review",
  "earlier_stage_same_proceeding",
  "related_order_same_proceeding",
  "other_same_proceeding",
] as const;

export const PROCEDURAL_ACTIONS = [
  "affirmed",
  "reversed",
  "varied",
  "quashed",
  "remitted",
  "leave_granted",
  "leave_refused",
  "none",
  "other",
] as const;

export type ResultPosition = (typeof RESULT_POSITIONS)[number];
export type ReferenceVoice = (typeof REFERENCE_VOICES)[number];
export type TreatmentSignal = (typeof TREATMENT_SIGNALS)[number];
export type ProceduralStageRelation = (typeof PROCEDURAL_STAGE_RELATIONS)[number];
export type ProceduralAction = (typeof PROCEDURAL_ACTIONS)[number];

/**
 * Model-facing source span. Quotes are exact substrings of the numbered start
 * and end lines. The compiler resolves them to half-open source offsets.
 */
export type AnchoredSpan = {
  start_line: number;
  end_line: number;
  start_quote: string;
  end_quote: string;
};

export type PersonEvidence = { name: string; evidence: AnchoredSpan };

export type DecisionStructure = {
  disposition_spans: AnchoredSpan[];
  opinions: Array<{
    opinion_id: string;
    boundary: AnchoredSpan;
    collective_author: PersonEvidence | null;
    result_position: ResultPosition;
    result_evidence: AnchoredSpan | null;
  }>;
  participants: Array<{
    name: string;
    panel_evidence: AnchoredSpan;
    result_position: ResultPosition;
    result_evidence: AnchoredSpan | null;
    opinion_links: Array<{
      opinion_id: string;
      relation: "wrote" | "joined" | "joined_in_part";
      scope: string | null;
      evidence: AnchoredSpan;
    }>;
  }>;
  nonparticipants: PersonEvidence[];
};

export type DecisionAnalysis = {
  references: Array<{
    reference_id: string;
    detected_occurrence_id: string | null;
    reference_status: "decision_reference" | "not_decision_reference" | "unclear";
    voice: ReferenceVoice;
    span: AnchoredSpan;
  }>;
  attributed_passages: Array<{
    passage_id: string;
    reference_ids: string[];
    span: AnchoredSpan;
  }>;
  treatments: Array<{
    treatment_id: string;
    reference_ids: string[];
    opinion_id: string;
    signals: TreatmentSignal[];
    other_signal: string | null;
    cited_proposition: string;
    treatment_summary: string;
    evidence_spans: AnchoredSpan[];
    attributed_passage_ids: string[];
    partial_adopters: string[];
  }>;
  procedural_history: Array<{
    history_id: string;
    reference_ids: string[];
    opinion_id: string | null;
    stage_relation: ProceduralStageRelation;
    current_decision_action: ProceduralAction;
    other_action: string | null;
    summary: string;
    evidence_spans: AnchoredSpan[];
  }>;
  reference_uses: Array<{
    reference_id: string;
    treatment_ids: string[];
    procedural_history_ids: string[];
  }>;
};

export type AuthorityInventory = {
  authorities: Array<{
    authority_id: string;
    identifying_text: string;
    occurrences: AnchoredSpan[];
  }>;
};

export type AuthorityInventoryCompilation = {
  ok: boolean;
  errors: string[];
  value: AuthorityInventory | null;
  grounding: GroundingReceipt[];
};

export type CaseTreatmentSubmission = {
  structure: DecisionStructure;
  analysis: DecisionAnalysis;
};

export type GoldRecord = {
  document_id: number;
  citation: string;
  source_sha256: string;
  annotation: CaseTreatmentSubmission;
};

export type CaseMaterial = {
  document_id: number;
  citation: string;
  name: string | null;
  date: string | null;
  dataset: string;
  language: "en" | "fr";
  url: string | null;
  text: string;
  source_lines: ModelSourceLine[];
  citation_inventory: DecisionCitationInventory;
  deterministic_structure?: {
    status: "ready" | "unresolved" | "unavailable";
    panel: string[];
    nonparticipants: string[];
    opinions: Array<{
      id: string;
      authors: string[];
      joiners: string[];
      alignment: "lead" | "same_result_separate_reasons" | "different_result" | "mixed" | "unknown";
      start: number;
      end: number;
      start_quote: string;
      end_quote: string;
      substantive_words: number;
    }>;
    judges: Array<{
      name: string;
      result_side: "majority" | "minority" | "mixed" | "unknown";
      relationship: "authors" | "joins_reasons" | "concurs_in_result_only" | "mixed" | "unknown";
      opinion_ids: string[];
    }>;
    refusals: string[];
  };
  coverage: {
    status: "asserted" | "not_asserted";
    spans: Array<{ start: number; end: number; label: string }>;
  };
};

export type ResolvedSpan = AnchoredSpan & {
  start: number;
  end: number;
  exact_text: string;
  text_sha256: string;
};

type ResolvedOpinion = {
  opinion_id: string;
  boundary: ResolvedSpan;
  collective_author: string | null;
  result_position: ResultPosition;
  writers: string[];
  full_joiners: string[];
  partial_joiners: Array<{ name: string; scope: string }>;
};

export type CompiledStructure = {
  opinions: ResolvedOpinion[];
  participants: Array<{
    name: string;
    result_position: ResultPosition;
    result_only: boolean;
    links: Array<{ opinion_id: string; relation: "wrote" | "joined" | "joined_in_part"; scope: string | null }>;
  }>;
  nonparticipants: string[];
  disposition_spans: ResolvedSpan[];
};

export type CompiledAnalysis = {
  references: Array<{
    reference_id: string;
    detected_occurrence_id: string | null;
    reference_status: "decision_reference" | "not_decision_reference" | "unclear";
    voice: ReferenceVoice;
    span: ResolvedSpan;
  }>;
  attributed_passages: Array<{
    passage_id: string;
    reference_ids: string[];
    span: ResolvedSpan;
    deterministic_quote_ids: string[];
  }>;
  treatments: Array<{
    treatment_id: string;
    reference_ids: string[];
    opinion_id: string;
    signals: TreatmentSignal[];
    other_signal: string | null;
    cited_proposition: string;
    treatment_summary: string;
    evidence_spans: ResolvedSpan[];
    attributed_passage_ids: string[];
    partial_adopters: string[];
  }>;
  procedural_history: Array<{
    history_id: string;
    reference_ids: string[];
    opinion_id: string | null;
    stage_relation: ProceduralStageRelation;
    current_decision_action: ProceduralAction;
    other_action: string | null;
    summary: string;
    evidence_spans: ResolvedSpan[];
  }>;
  reference_uses: Array<{
    reference_id: string;
    treatment_ids: string[];
    procedural_history_ids: string[];
  }>;
};

export type GroundingReceipt = {
  path: string;
  start: number;
  end: number;
  exact_text: string;
  text_sha256: string;
};

export type BoundaryAdjustment = {
  opinion_id: string;
  rule: "trim_trailing_judicial_signature";
  original_start: number;
  original_end: number;
  canonical_start: number;
  canonical_end: number;
  removed_text: string;
  removed_sha256: string;
};

export type StructureCompilation = {
  ok: boolean;
  errors: string[];
  value: DecisionStructure | null;
  compiled: CompiledStructure | null;
  grounding: GroundingReceipt[];
  evidence_receipts: LegalEvidenceReceipt[];
  boundary_adjustments: BoundaryAdjustment[];
  coverage: { status: "asserted" | "not_asserted"; required: number; covered: number };
};

export type AnalysisCompilation = {
  ok: boolean;
  errors: string[];
  value: DecisionAnalysis | null;
  compiled: CompiledAnalysis | null;
  grounding: GroundingReceipt[];
  evidence_receipts: LegalEvidenceReceipt[];
  deterministic_quote_candidates: Array<{
    id: string;
    text: string;
    start: number;
    end: number;
    text_sha256: string;
  }>;
  citation_coverage: {
    detected: number;
    accounted_for: number;
    model_added: number;
    completeness: "not_asserted";
  };
};

export type SubmissionCompilation = {
  ok: boolean;
  errors: string[];
  value: CaseTreatmentSubmission | null;
  grounding: GroundingReceipt[];
  structure: StructureCompilation;
  analysis: AnalysisCompilation | null;
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const list = (value: unknown) => Array.isArray(value) ? value : [];
function requiredList(value: unknown, path: string, errors: string[]) {
  if (!Array.isArray(value)) errors.push(`${path}: expected an array`);
  return list(value);
}
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const personKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const anchoredSpanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    start_line: { type: "integer", minimum: 1 },
    end_line: { type: "integer", minimum: 1 },
    start_quote: { type: "string", minLength: 1, maxLength: 1_000 },
    end_quote: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  required: ["start_line", "end_line", "start_quote", "end_quote"],
} as const;

const nullableSpanSchema = { anyOf: [anchoredSpanSchema, { type: "null" }] } as const;
const personEvidenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 2, maxLength: 200 },
    evidence: anchoredSpanSchema,
  },
  required: ["name", "evidence"],
} as const;

export const CASE_STRUCTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    disposition_spans: { type: "array", maxItems: 20, items: anchoredSpanSchema },
    opinions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
          boundary: anchoredSpanSchema,
          collective_author: { anyOf: [personEvidenceSchema, { type: "null" }] },
          result_position: { enum: RESULT_POSITIONS },
          result_evidence: nullableSpanSchema,
        },
        required: ["opinion_id", "boundary", "collective_author", "result_position", "result_evidence"],
      },
    },
    participants: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2, maxLength: 200 },
          panel_evidence: anchoredSpanSchema,
          result_position: { enum: RESULT_POSITIONS },
          result_evidence: nullableSpanSchema,
          opinion_links: {
            type: "array",
            maxItems: 40,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                opinion_id: { type: "string", pattern: "^o[1-9][0-9]*$" },
                relation: { enum: ["wrote", "joined", "joined_in_part"] },
                scope: { type: ["string", "null"], maxLength: 1_000 },
                evidence: anchoredSpanSchema,
              },
              required: ["opinion_id", "relation", "scope", "evidence"],
            },
          },
        },
        required: ["name", "panel_evidence", "result_position", "result_evidence", "opinion_links"],
      },
    },
    nonparticipants: { type: "array", maxItems: 40, items: personEvidenceSchema },
  },
  required: ["disposition_spans", "opinions", "participants", "nonparticipants"],
} as const;

function bindLineMaximum(schema: unknown, lineCount: number) {
  const value = structuredClone(schema) as Record<string, unknown>;
  const visit = (node: unknown) => {
    const item = record(node);
    if (!item) return;
    const properties = record(item.properties);
    if (properties) for (const [name, child] of Object.entries(properties)) {
      const field = record(child);
      if (field && (name === "start_line" || name === "end_line")) field.maximum = lineCount;
      visit(child);
    }
    visit(item.items);
    for (const branch of list(item.anyOf)) visit(branch);
  };
  visit(value);
  return value;
}

export function structureOutputSchema(lineCount: number) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new Error("source requires at least one numbered line");
  return bindLineMaximum(CASE_STRUCTURE_SCHEMA, lineCount);
}

export function authorityInventoryOutputSchema(lineCount: number) {
  return bindLineMaximum({
    type: "object",
    additionalProperties: false,
    properties: {
      authorities: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            authority_id: { type: "string", pattern: "^a[1-9][0-9]*$" },
            identifying_text: { type: "string", minLength: 2, maxLength: 500 },
            occurrences: { type: "array", minItems: 1, maxItems: 100, items: anchoredSpanSchema },
          },
          required: ["authority_id", "identifying_text", "occurrences"],
        },
      },
    },
    required: ["authorities"],
  }, lineCount);
}

const referenceIdSchema = { type: "string", pattern: "^r[1-9][0-9]*$" } as const;
const passageIdSchema = { type: "string", pattern: "^q[1-9][0-9]*$" } as const;

export function analysisOutputSchema(
  inventory: DecisionCitationInventory,
  lineCount: number,
  opinionIds?: readonly string[],
) {
  const detectedIds = inventory.occurrences.map(({ id }) => id);
  const referenceCapacity = Math.max(500, detectedIds.length + 500);
  const analysisCapacity = Math.max(500, detectedIds.length * 4 + 100);
  const opinionId = opinionIds?.length
    ? { type: "string", enum: [...opinionIds] }
    : { type: "string", pattern: "^o[1-9][0-9]*$" };
  return bindLineMaximum({
    type: "object",
    additionalProperties: false,
    properties: {
      references: {
        type: "array",
        minItems: detectedIds.length,
        maxItems: referenceCapacity,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reference_id: referenceIdSchema,
            detected_occurrence_id: detectedIds.length
              ? { anyOf: [{ type: "string", enum: detectedIds }, { type: "null" }] }
              : { type: "null" },
            reference_status: { enum: ["decision_reference", "not_decision_reference", "unclear"] },
            voice: { enum: REFERENCE_VOICES },
            span: anchoredSpanSchema,
          },
          required: ["reference_id", "detected_occurrence_id", "reference_status", "voice", "span"],
        },
      },
      attributed_passages: {
        type: "array",
        maxItems: analysisCapacity,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            passage_id: passageIdSchema,
            reference_ids: { type: "array", minItems: 1, maxItems: 30, items: referenceIdSchema },
            span: anchoredSpanSchema,
          },
          required: ["passage_id", "reference_ids", "span"],
        },
      },
      treatments: {
        type: "array",
        maxItems: analysisCapacity,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            treatment_id: { type: "string", pattern: "^t[1-9][0-9]*$" },
            reference_ids: { type: "array", minItems: 1, maxItems: 30, items: referenceIdSchema },
            opinion_id: opinionId,
            signals: { type: "array", minItems: 1, maxItems: 5, items: { enum: TREATMENT_SIGNALS } },
            other_signal: { type: ["string", "null"], maxLength: 300 },
            cited_proposition: { type: "string", minLength: 1, maxLength: 4_000 },
            treatment_summary: { type: "string", minLength: 1, maxLength: 4_000 },
            evidence_spans: { type: "array", minItems: 1, maxItems: 20, items: anchoredSpanSchema },
            attributed_passage_ids: { type: "array", maxItems: 30, items: passageIdSchema },
            partial_adopters: { type: "array", maxItems: 40, items: { type: "string", minLength: 2, maxLength: 200 } },
          },
          required: [
            "treatment_id", "reference_ids", "opinion_id", "signals", "other_signal",
            "cited_proposition", "treatment_summary", "evidence_spans",
            "attributed_passage_ids", "partial_adopters",
          ],
        },
      },
      procedural_history: {
        type: "array",
        maxItems: referenceCapacity,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            history_id: { type: "string", pattern: "^h[1-9][0-9]*$" },
            reference_ids: { type: "array", minItems: 1, maxItems: 30, items: referenceIdSchema },
            opinion_id: { anyOf: [opinionId, { type: "null" }] },
            stage_relation: { enum: PROCEDURAL_STAGE_RELATIONS },
            current_decision_action: { enum: PROCEDURAL_ACTIONS },
            other_action: { type: ["string", "null"], maxLength: 300 },
            summary: { type: "string", minLength: 1, maxLength: 4_000 },
            evidence_spans: { type: "array", minItems: 1, maxItems: 20, items: anchoredSpanSchema },
          },
          required: [
            "history_id", "reference_ids", "opinion_id", "stage_relation",
            "current_decision_action", "other_action", "summary", "evidence_spans",
          ],
        },
      },
      reference_uses: {
        type: "array",
        minItems: detectedIds.length,
        maxItems: referenceCapacity,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            reference_id: referenceIdSchema,
            treatment_ids: {
              type: "array",
              maxItems: analysisCapacity,
              items: { type: "string", pattern: "^t[1-9][0-9]*$" },
            },
            procedural_history_ids: {
              type: "array",
              maxItems: referenceCapacity,
              items: { type: "string", pattern: "^h[1-9][0-9]*$" },
            },
          },
          required: ["reference_id", "treatment_ids", "procedural_history_ids"],
        },
      },
    },
    required: ["references", "attributed_passages", "treatments", "procedural_history", "reference_uses"],
  }, lineCount);
}

export function submissionOutputSchema(inventory: DecisionCitationInventory, lineCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      structure: structureOutputSchema(lineCount),
      analysis: analysisOutputSchema(inventory, lineCount),
    },
    required: ["structure", "analysis"],
  };
}

function anchoredSpan(value: unknown, path: string, material: CaseMaterial, errors: string[], maxChars = Number.MAX_SAFE_INTEGER) {
  const item = record(value);
  if (!item) {
    errors.push(`${path}: expected an exact source span`);
    return null;
  }
  const startLine = Number(item.start_line);
  const endLine = Number(item.end_line);
  const startQuote = typeof item.start_quote === "string" ? item.start_quote : "";
  const endQuote = typeof item.end_quote === "string" ? item.end_quote : "";
  if (
    !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 ||
    endLine < startLine || endLine > material.source_lines.length || !startQuote || !endQuote ||
    /[\r\n]/u.test(startQuote) || /[\r\n]/u.test(endQuote)
  ) {
    errors.push(`${path}: invalid line numbers or quote anchors`);
    return null;
  }
  const resolve = (lineNumber: number, quote: string, label: string) => {
    const line = material.source_lines[lineNumber - 1];
    const text = material.text.slice(line.start, line.end);
    const matches: number[] = [];
    let cursor = 0;
    while (cursor <= text.length - quote.length) {
      const index = text.indexOf(quote, cursor);
      if (index < 0) break;
      matches.push(line.start + index);
      cursor = index + Math.max(1, quote.length);
    }
    if (matches.length !== 1) {
      const suggestion = quoteRepairSuggestion(quote, [text]);
      errors.push(`${path}.${label}: quote must occur exactly once in source line ${lineNumber}${
        suggestion ? `; ${suggestion}` : `; line text: ${JSON.stringify(text)}`
      }`);
      return null;
    }
    return matches[0];
  };
  const start = resolve(startLine, startQuote, "start_quote");
  const endStart = resolve(endLine, endQuote, "end_quote");
  if (start === null || endStart === null) return null;
  const end = endStart + endQuote.length;
  if (end <= start) {
    errors.push(`${path}: end quote does not follow start quote`);
    return null;
  }
  if (end - start > maxChars) {
    errors.push(`${path}: source span is too broad (${end - start} characters; maximum ${maxChars})`);
    return null;
  }
  const exactText = material.text.slice(start, end);
  return {
    start_line: startLine,
    end_line: endLine,
    start_quote: startQuote,
    end_quote: endQuote,
    start,
    end,
    exact_text: exactText,
    text_sha256: sha256(exactText),
  } satisfies ResolvedSpan;
}

function stringValue(value: unknown, path: string, errors: string[], minimum = 1) {
  if (typeof value !== "string" || value.trim().length < minimum) {
    errors.push(`${path}: expected non-empty text`);
    return "";
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  errors: string[],
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    errors.push(`${path}: unexpected value ${JSON.stringify(value)}`);
    return values[0];
  }
  return value as T[number];
}

function idValue(value: unknown, pattern: RegExp, path: string, errors: string[]) {
  const text = stringValue(value, path, errors);
  if (text && !pattern.test(text)) errors.push(`${path}: invalid local identifier`);
  return text;
}

function evidenceReceipt(material: CaseMaterial, path: string, span: ResolvedSpan) {
  return createA2AJPassageEvidence({
    citation: material.citation,
    name: material.name,
    dataset: material.dataset,
    language: material.language,
    sourceText: material.text,
    spanText: span.exact_text,
    start: span.start,
    end: span.end,
    externalUrl: material.url,
    sourceClass: "case",
    blockId: `${CASE_TREATMENT_CONTRACT_VERSION}:${path}:${span.start}-${span.end}`,
  });
}

function collectSpan(
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
  grounding: GroundingReceipt[],
  evidence: Map<string, LegalEvidenceReceipt>,
  maxChars?: number,
  retainEvidenceReceipt = true,
) {
  const span = anchoredSpan(value, path, material, errors, maxChars);
  if (!span) return null;
  grounding.push({ path, start: span.start, end: span.end, exact_text: span.exact_text, text_sha256: span.text_sha256 });
  if (retainEvidenceReceipt) {
    const receipt = evidenceReceipt(material, path, span);
    evidence.set(receipt.evidence_id, receipt);
  }
  return span;
}

export function compileAuthorityInventory(raw: unknown, material: CaseMaterial): AuthorityInventoryCompilation {
  const item = record(raw);
  if (!item) return { ok: false, errors: ["authority inventory: expected an object"], value: null, grounding: [] };
  const errors: string[] = [];
  const grounding: GroundingReceipt[] = [];
  const evidence = new Map<string, LegalEvidenceReceipt>();
  const ids = new Set<string>();
  const spans = new Set<string>();
  const authorities: AuthorityInventory["authorities"] = [];
  for (const [index, rawAuthority] of requiredList(item.authorities, "authorities", errors).entries()) {
    const path = `authorities[${index}]`;
    const authority = record(rawAuthority);
    if (!authority) { errors.push(`${path}: expected an object`); continue; }
    const authorityId = idValue(authority.authority_id, /^a[1-9][0-9]*$/u, `${path}.authority_id`, errors);
    if (ids.has(authorityId)) errors.push(`${path}.authority_id: duplicate ${authorityId}`);
    ids.add(authorityId);
    const identifyingText = stringValue(authority.identifying_text, `${path}.identifying_text`, errors);
    const occurrences = requiredList(authority.occurrences, `${path}.occurrences`, errors).flatMap((value, occurrenceIndex) => {
      const span = collectSpan(value, `${path}.occurrences[${occurrenceIndex}]`, material, errors, grounding, evidence, 2_000, false);
      if (!span) return [];
      const key = `${span.start}:${span.end}`;
      if (spans.has(key)) errors.push(`${path}.occurrences[${occurrenceIndex}]: duplicate occurrence span`);
      spans.add(key);
      return [value as AnchoredSpan];
    });
    if (!occurrences.length) errors.push(`${path}.occurrences: at least one occurrence is required`);
    authorities.push({ authority_id: authorityId, identifying_text: identifyingText, occurrences });
  }
  return { ok: errors.length === 0, errors: unique(errors), value: errors.length ? null : { authorities }, grounding };
}

function evidenceNamesPerson(name: string, evidenceText: string) {
  const ignored = new Set([
    "a", "c", "chief", "cj", "cjc", "cja", "honorable", "honourable", "j", "ja", "judge", "justice", "the",
  ]);
  const tokens = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const identifying = tokens(name).filter((token) => token.length > 1 && !ignored.has(token));
  const evidence = new Set(tokens(evidenceText));
  // Court reasons identify judges by surname alone ("Matthews J."), so any
  // distinguishing name token in the evidence grounds the person.
  return identifying.length > 0 && identifying.some((token) => evidence.has(token));
}

const BOUNDARY_HEADING = /^(?:introduction|background|analysis|reasons?(?: for (?:judgment|decision|order)| of (?:the )?court)?|order|conclusion|disposition)\s*:?[.]?$/iu;

export function trailingJudicialSignature(text: string) {
  const lines = [...text.matchAll(/[^\r\n]+/gu)];
  const last = lines.at(-1);
  const line = last?.[0].trim() ?? "";
  if (wordCount(line) > 12) return false;
  return (/\b(?:justice|judge)\b/iu.test(line) ||
    /\b(?:c\.?\s*j|j)(?:\.?\s*a)?\.?['"”’]?[.]?$/iu.test(line)) && last
    ? { start: last.index!, text: line }
    : null;
}

export function paragraphCoverageEnd(text: string) {
  let end = trailingJudicialSignature(text)?.start ?? text.length;
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    if (line.index && BOUNDARY_HEADING.test(line[0].trim())) end = Math.min(end, line.index);
  }
  return text.slice(0, end).trimEnd().length;
}

function canonicalizeBoundary(
  boundary: ResolvedSpan,
  opinionId: string,
  material: CaseMaterial,
): { boundary: ResolvedSpan; adjustment: BoundaryAdjustment | null } {
  const signature = trailingJudicialSignature(boundary.exact_text);
  if (!signature) return { boundary, adjustment: null };
  const retained = boundary.exact_text.slice(0, signature.start).trimEnd();
  if (!retained) return { boundary, adjustment: null };
  const canonicalEnd = boundary.start + retained.length;
  const endLine = material.source_lines.find((line) => canonicalEnd > line.start && canonicalEnd <= line.end);
  if (!endLine) return { boundary, adjustment: null };
  const endText = material.text.slice(endLine.start, canonicalEnd).trim();
  const removedText = boundary.exact_text.slice(retained.length).trim();
  return {
    boundary: {
      ...boundary,
      end_line: endLine.line,
      end_quote: endText,
      end: canonicalEnd,
      exact_text: retained,
      text_sha256: sha256(retained),
    },
    adjustment: {
      opinion_id: opinionId,
      rule: "trim_trailing_judicial_signature",
      original_start: boundary.start,
      original_end: boundary.end,
      canonical_start: boundary.start,
      canonical_end: canonicalEnd,
      removed_text: removedText,
      removed_sha256: sha256(removedText),
    },
  };
}

function collectPersonEvidence(
  name: string,
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
  grounding: GroundingReceipt[],
  evidence: Map<string, LegalEvidenceReceipt>,
) {
  const span = collectSpan(value, path, material, errors, grounding, evidence, 3_000);
  if (span && !evidenceNamesPerson(name, span.exact_text)) {
    errors.push(`${path}: evidence does not identify ${name}`);
  }
  return span;
}

export function compileStructure(raw: unknown, material: CaseMaterial): StructureCompilation {
  const errors: string[] = [];
  const grounding: GroundingReceipt[] = [];
  const evidence = new Map<string, LegalEvidenceReceipt>();
  const boundaryAdjustments: BoundaryAdjustment[] = [];
  const item = record(raw);
  if (!item) {
    return {
      ok: false,
      errors: ["structure: expected an object"],
      value: null,
      compiled: null,
      grounding,
      evidence_receipts: [],
      boundary_adjustments: boundaryAdjustments,
      coverage: { status: material.coverage.status, required: material.coverage.spans.length, covered: 0 },
    };
  }
  const dispositionSpans = requiredList(item.disposition_spans, "structure.disposition_spans", errors).flatMap((value, index) => {
    const span = collectSpan(value, `structure.disposition_spans[${index}]`, material, errors, grounding, evidence, 12_000);
    return span ? [span] : [];
  });
  const opinions = requiredList(item.opinions, "structure.opinions", errors);
  if (!opinions.length) errors.push("structure.opinions: at least one opinion is required");
  const opinionIds = new Set<string>();
  const resolvedOpinions: ResolvedOpinion[] = [];
  for (const [index, value] of opinions.entries()) {
    const path = `structure.opinions[${index}]`;
    const opinion = record(value);
    if (!opinion) { errors.push(`${path}: expected an object`); continue; }
    const opinionId = idValue(opinion.opinion_id, /^o[1-9][0-9]*$/u, `${path}.opinion_id`, errors);
    if (opinionIds.has(opinionId)) errors.push(`${path}: duplicate opinion_id ${opinionId}`);
    opinionIds.add(opinionId);
    const rawBoundary = collectSpan(opinion.boundary, `${path}.boundary`, material, errors, grounding, evidence, undefined, false);
    const canonical = rawBoundary ? canonicalizeBoundary(rawBoundary, opinionId, material) : null;
    const boundary = canonical?.boundary ?? null;
    if (canonical?.adjustment) boundaryAdjustments.push(canonical.adjustment);
    if (boundary && wordCount(boundary.exact_text) < MIN_OPINION_WORDS) {
      errors.push(`${path}.boundary: fewer than ${MIN_OPINION_WORDS} substantive words`);
    }
    const resultPosition = enumValue(opinion.result_position, RESULT_POSITIONS, `${path}.result_position`, errors);
    const collective = opinion.collective_author === null ? null : record(opinion.collective_author);
    let collectiveName: string | null = null;
    if (opinion.collective_author !== null) {
      if (!collective) errors.push(`${path}.collective_author: expected a named collective author or null`);
      else {
        collectiveName = stringValue(collective.name, `${path}.collective_author.name`, errors, 2);
        collectPersonEvidence(collectiveName, collective.evidence, `${path}.collective_author.evidence`, material, errors, grounding, evidence);
      }
    }
    if (opinion.result_evidence !== null) collectSpan(opinion.result_evidence, `${path}.result_evidence`, material, errors, grounding, evidence, 12_000);
    if (boundary) resolvedOpinions.push({
      opinion_id: opinionId,
      boundary,
      collective_author: collectiveName,
      result_position: resultPosition,
      writers: [],
      full_joiners: [],
      partial_joiners: [],
    });
  }
  for (let index = 1; index < resolvedOpinions.length; index += 1) {
    const previous = resolvedOpinions[index - 1];
    const current = resolvedOpinions[index];
    if (previous.boundary.start >= current.boundary.start) errors.push(`structure.opinions[${index}]: opinions are not in source order`);
    if (previous.boundary.end > current.boundary.start) errors.push(`structure.opinions[${index}]: opinion boundaries overlap`);
  }

  const participantNames = new Set<string>();
  const resolvedParticipants: CompiledStructure["participants"] = [];
  for (const [index, value] of requiredList(item.participants, "structure.participants", errors).entries()) {
    const path = `structure.participants[${index}]`;
    const participant = record(value);
    if (!participant) { errors.push(`${path}: expected an object`); continue; }
    const name = stringValue(participant.name, `${path}.name`, errors, 2);
    const key = personKey(name);
    if (participantNames.has(key)) errors.push(`${path}: duplicate participant ${name}`);
    participantNames.add(key);
    collectPersonEvidence(name, participant.panel_evidence, `${path}.panel_evidence`, material, errors, grounding, evidence);
    const resultPosition = enumValue(participant.result_position, RESULT_POSITIONS, `${path}.result_position`, errors);
    const resultEvidence = participant.result_evidence === null
      ? null
      : collectSpan(participant.result_evidence, `${path}.result_evidence`, material, errors, grounding, evidence, 12_000);
    const links: CompiledStructure["participants"][number]["links"] = [];
    const linked = new Set<string>();
    for (const [linkIndex, linkValue] of requiredList(participant.opinion_links, `${path}.opinion_links`, errors).entries()) {
      const linkPath = `${path}.opinion_links[${linkIndex}]`;
      const link = record(linkValue);
      if (!link) { errors.push(`${linkPath}: expected an object`); continue; }
      const opinionId = idValue(link.opinion_id, /^o[1-9][0-9]*$/u, `${linkPath}.opinion_id`, errors);
      if (!opinionIds.has(opinionId)) errors.push(`${linkPath}: unknown opinion_id ${opinionId}`);
      const relation = enumValue(link.relation, ["wrote", "joined", "joined_in_part"] as const, `${linkPath}.relation`, errors);
      const scope = link.scope === null ? null : stringValue(link.scope, `${linkPath}.scope`, errors);
      if ((relation === "joined_in_part") !== Boolean(scope?.trim())) {
        errors.push(`${linkPath}: scope is required only for joined_in_part`);
      }
      const linkKey = `${opinionId}:${relation}`;
      if (linked.has(linkKey)) errors.push(`${linkPath}: duplicate opinion relationship`);
      linked.add(linkKey);
      collectPersonEvidence(name, link.evidence, `${linkPath}.evidence`, material, errors, grounding, evidence);
      links.push({ opinion_id: opinionId, relation, scope });
      const opinion = resolvedOpinions.find((candidate) => candidate.opinion_id === opinionId);
      if (opinion) {
        if (relation === "wrote") opinion.writers.push(name);
        else if (relation === "joined") opinion.full_joiners.push(name);
        else opinion.partial_joiners.push({ name, scope: scope ?? "" });
      }
    }
    const resultOnly = links.length === 0 && Boolean(resultEvidence &&
      /\b(?:result|disposition)\s+only\b|\bonly\s+(?:in|as\s+to)\s+the\s+(?:result|disposition)\b/iu.test(resultEvidence.exact_text));
    resolvedParticipants.push({ name, result_position: resultPosition, result_only: resultOnly, links });
  }

  for (const opinion of resolvedOpinions) {
    if (opinion.collective_author && opinion.writers.length) {
      errors.push(`structure.opinions[${opinion.opinion_id}]: use either a collective author or named writers, not both`);
    }
    for (const name of [...opinion.writers, ...opinion.full_joiners]) {
      const participant = resolvedParticipants.find((candidate) => personKey(candidate.name) === personKey(name));
      if (participant && participant.result_position !== "unclear" && opinion.result_position !== "unclear" &&
          participant.result_position !== opinion.result_position) {
        errors.push(`structure: ${name}'s complete relationship to ${opinion.opinion_id} conflicts with its result position`);
      }
    }
  }

  const nonparticipants: string[] = [];
  const nonparticipantNames = new Set<string>();
  for (const [index, value] of requiredList(item.nonparticipants, "structure.nonparticipants", errors).entries()) {
    const path = `structure.nonparticipants[${index}]`;
    const person = record(value);
    if (!person) { errors.push(`${path}: expected an object`); continue; }
    const name = stringValue(person.name, `${path}.name`, errors, 2);
    const key = personKey(name);
    if (participantNames.has(key)) errors.push(`${path}: ${name} is also listed as participating`);
    if (nonparticipantNames.has(key)) errors.push(`${path}: duplicate nonparticipant ${name}`);
    nonparticipantNames.add(key);
    nonparticipants.push(name);
    collectPersonEvidence(name, person.evidence, `${path}.evidence`, material, errors, grounding, evidence);
  }

  let covered = 0;
  if (material.coverage.status === "asserted") for (const required of material.coverage.spans) {
    const owners = resolvedOpinions.filter(({ boundary }) => required.start >= boundary.start && required.end <= boundary.end);
    if (owners.length === 1) covered += 1;
    else errors.push(`structure coverage: substantive ${required.label} is inside ${owners.length} opinion boundaries`);
  }
  const value = item as unknown as DecisionStructure;
  const compiled: CompiledStructure = {
    opinions: resolvedOpinions,
    participants: resolvedParticipants,
    nonparticipants,
    disposition_spans: dispositionSpans,
  };
  return {
    ok: errors.length === 0,
    errors: unique(errors),
    value,
    compiled: errors.length === 0 ? compiled : null,
    grounding,
    evidence_receipts: [...evidence.values()],
    boundary_adjustments: boundaryAdjustments,
    coverage: { status: material.coverage.status, required: material.coverage.spans.length, covered },
  };
}

function validateLocalIds(
  ids: unknown,
  pattern: RegExp,
  path: string,
  known: Map<string, unknown>,
  errors: string[],
  allowEmpty = false,
) {
  const values = requiredList(ids, path, errors)
    .map((value, index) => idValue(value, pattern, `${path}[${index}]`, errors));
  if ((!allowEmpty && !values.length) || unique(values).length !== values.length) {
    errors.push(`${path}: identifiers must be ${allowEmpty ? "unique" : "non-empty and unique"}`);
  }
  for (const id of values) if (!known.has(id)) errors.push(`${path}: unknown identifier ${id}`);
  return values;
}

export function compileAnalysis(
  raw: unknown,
  _structure: DecisionStructure,
  compiledStructure: CompiledStructure,
  material: CaseMaterial,
  requiredDetectedOccurrenceIds?: readonly string[],
): AnalysisCompilation {
  const errors: string[] = [];
  const grounding: GroundingReceipt[] = [];
  const evidence = new Map<string, LegalEvidenceReceipt>();
  const item = record(raw);
  if (!item) {
    return {
      ok: false,
      errors: ["analysis: expected an object"],
      value: null,
      compiled: null,
      grounding,
      evidence_receipts: [],
      deterministic_quote_candidates: [],
      citation_coverage: { detected: requiredDetectedOccurrenceIds?.length ?? material.citation_inventory.occurrences.length, accounted_for: 0, model_added: 0, completeness: "not_asserted" },
    };
  }
  const detected = new Map(material.citation_inventory.occurrences.map((value) => [value.id, value]));
  const requiredDetected = new Set(requiredDetectedOccurrenceIds ?? detected.keys());
  for (const id of requiredDetected) if (!detected.has(id)) errors.push(`analysis.references: unknown required detector occurrence ${id}`);
  const detectedUsed = new Set<string>();
  const references = new Map<string, CompiledAnalysis["references"][number]>();
  const referencePaths = new Map<string, string>();
  for (const [index, value] of requiredList(item.references, "analysis.references", errors).entries()) {
    const path = `analysis.references[${index}]`;
    const reference = record(value);
    if (!reference) { errors.push(`${path}: expected an object`); continue; }
    const id = idValue(reference.reference_id, /^r[1-9][0-9]*$/u, `${path}.reference_id`, errors);
    if (references.has(id)) errors.push(`${path}: duplicate reference_id ${id}`);
    else referencePaths.set(id, path);
    const detectedId = reference.detected_occurrence_id === null
      ? null
      : stringValue(reference.detected_occurrence_id, `${path}.detected_occurrence_id`, errors);
    const occurrence = detectedId === null ? null : detected.get(detectedId);
    if (detectedId !== null && !occurrence) errors.push(`${path}: unknown detected occurrence ${detectedId}`);
    if (detectedId !== null && !requiredDetected.has(detectedId)) errors.push(`${path}: detected occurrence ${detectedId} is outside this analysis target`);
    if (detectedId !== null && detectedUsed.has(detectedId)) errors.push(`${path}: duplicate detected occurrence ${detectedId}`);
    if (detectedId !== null) detectedUsed.add(detectedId);
    const status = enumValue(reference.reference_status, ["decision_reference", "not_decision_reference", "unclear"] as const, `${path}.reference_status`, errors);
    const voice = enumValue(reference.voice, REFERENCE_VOICES, `${path}.voice`, errors);
    const span = collectSpan(reference.span, `${path}.span`, material, errors, grounding, evidence, 2_000);
    if (span && occurrence) {
      if (occurrence.start < span.start || occurrence.end > span.end) errors.push(`${path}: detector occurrence is outside the reference span`);
      if (!span.exact_text.includes(occurrence.quote)) errors.push(`${path}: reference span must include ${JSON.stringify(occurrence.quote)}`);
    }
    if (span && !occurrence && material.citation_inventory.occurrences.some((candidate) =>
      candidate.start >= span.start && candidate.end <= span.end
    )) errors.push(`${path}: a supplied detector occurrence inside this span was not linked`);
    if (span) references.set(id, { reference_id: id, detected_occurrence_id: detectedId, reference_status: status, voice, span });
  }
  for (const id of requiredDetected) if (!detectedUsed.has(id)) errors.push(`analysis.references: missing detector occurrence ${id}`);

  const decisionReferences = new Map([...references].filter(([, value]) => value.reference_status === "decision_reference"));
  const deterministicQuotes = deterministicQuoteCandidates(material).map((quote) => ({
    ...quote,
    text_sha256: sha256(quote.text),
  }));
  const passages = new Map<string, CompiledAnalysis["attributed_passages"][number]>();
  for (const [index, value] of requiredList(item.attributed_passages, "analysis.attributed_passages", errors).entries()) {
    const path = `analysis.attributed_passages[${index}]`;
    const passage = record(value);
    if (!passage) { errors.push(`${path}: expected an object`); continue; }
    const id = idValue(passage.passage_id, /^q[1-9][0-9]*$/u, `${path}.passage_id`, errors);
    if (passages.has(id)) errors.push(`${path}: duplicate passage_id ${id}`);
    const referenceIds = validateLocalIds(passage.reference_ids, /^r[1-9][0-9]*$/u, `${path}.reference_ids`, decisionReferences, errors);
    const span = collectSpan(passage.span, `${path}.span`, material, errors, grounding, evidence, 12_000);
    if (span) passages.set(id, {
      passage_id: id,
      reference_ids: referenceIds,
      span,
      deterministic_quote_ids: deterministicQuotes
        .filter((quote) => quote.start >= span.start && quote.end <= span.end)
        .map(({ id: quoteId }) => quoteId),
    });
  }

  const opinions = new Map(compiledStructure.opinions.map((value) => [value.opinion_id, value]));
  const partialByOpinion = new Map(compiledStructure.opinions.map((opinion) => [
    opinion.opinion_id,
    new Set(opinion.partial_joiners.map(({ name }) => personKey(name))),
  ]));
  const treatments: CompiledAnalysis["treatments"] = [];
  const treatmentIds = new Set<string>();
  for (const [index, value] of requiredList(item.treatments, "analysis.treatments", errors).entries()) {
    const path = `analysis.treatments[${index}]`;
    const treatment = record(value);
    if (!treatment) { errors.push(`${path}: expected an object`); continue; }
    const id = idValue(treatment.treatment_id, /^t[1-9][0-9]*$/u, `${path}.treatment_id`, errors);
    if (treatmentIds.has(id)) errors.push(`${path}: duplicate treatment_id ${id}`);
    treatmentIds.add(id);
    const referenceIds = validateLocalIds(treatment.reference_ids, /^r[1-9][0-9]*$/u, `${path}.reference_ids`, decisionReferences, errors);
    const opinionId = idValue(treatment.opinion_id, /^o[1-9][0-9]*$/u, `${path}.opinion_id`, errors);
    const opinion = opinions.get(opinionId);
    if (!opinion) errors.push(`${path}: unknown opinion_id ${opinionId}`);
    const signals = requiredList(treatment.signals, `${path}.signals`, errors).map((signal, signalIndex) =>
      enumValue(signal, TREATMENT_SIGNALS, `${path}.signals[${signalIndex}]`, errors)
    );
    if (!signals.length || unique(signals).length !== signals.length) errors.push(`${path}.signals: signals must be non-empty and unique`);
    const otherSignal = treatment.other_signal === null ? null : stringValue(treatment.other_signal, `${path}.other_signal`, errors);
    if (signals.includes("other") !== Boolean(otherSignal?.trim())) errors.push(`${path}: other_signal is required only when signals includes other`);
    const citedProposition = stringValue(treatment.cited_proposition, `${path}.cited_proposition`, errors);
    const treatmentSummary = stringValue(treatment.treatment_summary, `${path}.treatment_summary`, errors);
    const evidenceSpans = requiredList(treatment.evidence_spans, `${path}.evidence_spans`, errors).flatMap((spanValue, spanIndex) => {
      const span = collectSpan(spanValue, `${path}.evidence_spans[${spanIndex}]`, material, errors, grounding, evidence, 12_000);
      if (span && opinion && (span.start < opinion.boundary.start || span.end > opinion.boundary.end)) {
        errors.push(`${path}.evidence_spans[${spanIndex}]: evidence is outside ${opinionId}`);
      }
      return span ? [span] : [];
    });
    if (!evidenceSpans.length) errors.push(`${path}.evidence_spans: at least one evidence span is required`);
    const passageIds = validateLocalIds(treatment.attributed_passage_ids, /^q[1-9][0-9]*$/u, `${path}.attributed_passage_ids`, passages, errors, true);
    for (const passageId of passageIds) {
      const passage = passages.get(passageId);
      if (passage && !passage.reference_ids.some((referenceId) => referenceIds.includes(referenceId))) {
        errors.push(`${path}: ${passageId} is attributed to a different reference`);
      }
    }
    const adopters = requiredList(treatment.partial_adopters, `${path}.partial_adopters`, errors).map((name, adopterIndex) =>
      stringValue(name, `${path}.partial_adopters[${adopterIndex}]`, errors, 2)
    );
    if (unique(adopters.map(personKey)).length !== adopters.length) errors.push(`${path}.partial_adopters: names must be unique`);
    const permittedAdopters = partialByOpinion.get(opinionId) ?? new Set<string>();
    for (const name of adopters) if (!permittedAdopters.has(personKey(name))) {
      errors.push(`${path}.partial_adopters: ${name} is not recorded as partially joining ${opinionId}`);
    }
    const visible = [
      ...evidenceSpans.map((span, spanIndex) => ({ evidenceId: `e${spanIndex + 1}`, text: span.exact_text })),
      ...passageIds.flatMap((passageId) => {
        const passage = passages.get(passageId);
        return passage ? [{ evidenceId: passageId, text: passage.span.exact_text }] : [];
      }),
    ];
    for (const [field, prose] of [["cited_proposition", citedProposition], ["treatment_summary", treatmentSummary]] as const) {
      errors.push(...groundedProseErrors(prose, visible.map(({ evidenceId }) => evidenceId), visible)
        .map((error) => `${path}.${field}: ${error}`));
    }
    treatments.push({
      treatment_id: id,
      reference_ids: referenceIds,
      opinion_id: opinionId,
      signals,
      other_signal: otherSignal,
      cited_proposition: citedProposition,
      treatment_summary: treatmentSummary,
      evidence_spans: evidenceSpans,
      attributed_passage_ids: passageIds,
      partial_adopters: adopters,
    });
  }

  const histories: CompiledAnalysis["procedural_history"] = [];
  const historyIds = new Set<string>();
  for (const [index, value] of requiredList(item.procedural_history, "analysis.procedural_history", errors).entries()) {
    const path = `analysis.procedural_history[${index}]`;
    const history = record(value);
    if (!history) { errors.push(`${path}: expected an object`); continue; }
    const id = idValue(history.history_id, /^h[1-9][0-9]*$/u, `${path}.history_id`, errors);
    if (historyIds.has(id)) errors.push(`${path}: duplicate history_id ${id}`);
    historyIds.add(id);
    const referenceIds = validateLocalIds(history.reference_ids, /^r[1-9][0-9]*$/u, `${path}.reference_ids`, decisionReferences, errors);
    const opinionId = history.opinion_id === null ? null : idValue(history.opinion_id, /^o[1-9][0-9]*$/u, `${path}.opinion_id`, errors);
    const opinion = opinionId === null ? null : opinions.get(opinionId);
    if (opinionId !== null && !opinion) errors.push(`${path}: unknown opinion_id ${opinionId}`);
    const stageRelation = enumValue(history.stage_relation, PROCEDURAL_STAGE_RELATIONS, `${path}.stage_relation`, errors);
    const action = enumValue(history.current_decision_action, PROCEDURAL_ACTIONS, `${path}.current_decision_action`, errors);
    const otherAction = history.other_action === null ? null : stringValue(history.other_action, `${path}.other_action`, errors);
    if ((action === "other") !== Boolean(otherAction?.trim())) errors.push(`${path}: other_action is required only for action=other`);
    const summary = stringValue(history.summary, `${path}.summary`, errors);
    const evidenceSpans = requiredList(history.evidence_spans, `${path}.evidence_spans`, errors).flatMap((spanValue, spanIndex) => {
      const span = collectSpan(spanValue, `${path}.evidence_spans[${spanIndex}]`, material, errors, grounding, evidence, 12_000);
      if (span && opinion && (span.start < opinion.boundary.start || span.end > opinion.boundary.end)) {
        errors.push(`${path}.evidence_spans[${spanIndex}]: evidence is outside ${opinionId}`);
      }
      return span ? [span] : [];
    });
    if (!evidenceSpans.length) errors.push(`${path}.evidence_spans: at least one evidence span is required`);
    const visible = evidenceSpans.map((span, spanIndex) => ({ evidenceId: `h${spanIndex + 1}`, text: span.exact_text }));
    errors.push(...groundedProseErrors(summary, visible.map(({ evidenceId }) => evidenceId), visible)
      .map((error) => `${path}.summary: ${error}`));
    histories.push({
      history_id: id,
      reference_ids: referenceIds,
      opinion_id: opinionId,
      stage_relation: stageRelation,
      current_decision_action: action,
      other_action: otherAction,
      summary,
      evidence_spans: evidenceSpans,
    });
  }

  const referenceUses: CompiledAnalysis["reference_uses"] = [];
  const usedReferences = new Set<string>();
  const knownTreatments = new Map(treatments.map((value) => [value.treatment_id, value]));
  const knownHistories = new Map(histories.map((value) => [value.history_id, value]));
  for (const [index, value] of requiredList(item.reference_uses, "analysis.reference_uses", errors).entries()) {
    const path = `analysis.reference_uses[${index}]`;
    const use = record(value);
    if (!use) { errors.push(`${path}: expected an object`); continue; }
    const referenceId = idValue(use.reference_id, /^r[1-9][0-9]*$/u, `${path}.reference_id`, errors);
    if (!references.has(referenceId)) errors.push(`${path}: unknown reference_id ${referenceId}`);
    if (usedReferences.has(referenceId)) errors.push(`${path}: duplicate reference_id ${referenceId}`);
    usedReferences.add(referenceId);
    const treatmentIds = validateLocalIds(use.treatment_ids, /^t[1-9][0-9]*$/u, `${path}.treatment_ids`, knownTreatments, errors, true);
    const historyIds = validateLocalIds(use.procedural_history_ids, /^h[1-9][0-9]*$/u, `${path}.procedural_history_ids`, knownHistories, errors, true);
    referenceUses.push({ reference_id: referenceId, treatment_ids: treatmentIds, procedural_history_ids: historyIds });
  }
  const usesByReference = new Map(referenceUses.map((value) => [value.reference_id, value]));
  for (const referenceId of references.keys()) {
    const sourcePath = referencePaths.get(referenceId) ?? "analysis.references";
    const use = usesByReference.get(referenceId);
    if (!use) {
      errors.push(`${sourcePath}: reference ${referenceId} is missing its reference_uses entry`);
      continue;
    }
    const expectedTreatments = treatments.filter((value) => value.reference_ids.includes(referenceId)).map((value) => value.treatment_id);
    const expectedHistories = histories.filter((value) => value.reference_ids.includes(referenceId)).map((value) => value.history_id);
    if (JSON.stringify([...use.treatment_ids].sort()) !== JSON.stringify(expectedTreatments.sort())) {
      errors.push(`${sourcePath}: reference ${referenceId} has incomplete treatment_ids in reference_uses`);
    }
    if (JSON.stringify([...use.procedural_history_ids].sort()) !== JSON.stringify(expectedHistories.sort())) {
      errors.push(`${sourcePath}: reference ${referenceId} has incomplete procedural_history_ids in reference_uses`);
    }
  }

  const compiled: CompiledAnalysis = {
    references: [...references.values()],
    attributed_passages: [...passages.values()],
    treatments,
    procedural_history: histories,
    reference_uses: referenceUses,
  };
  return {
    ok: errors.length === 0,
    errors: unique(errors),
    value: item as unknown as DecisionAnalysis,
    compiled: errors.length === 0 ? compiled : null,
    grounding,
    evidence_receipts: [...evidence.values()],
    deterministic_quote_candidates: deterministicQuotes,
    citation_coverage: {
      detected: requiredDetected.size,
      accounted_for: detectedUsed.size,
      model_added: [...references.values()].filter(({ detected_occurrence_id }) => detected_occurrence_id === null).length,
      completeness: "not_asserted",
    },
  };
}

export function compileSubmission(raw: unknown, material: CaseMaterial): SubmissionCompilation {
  const item = record(raw);
  if (!item) {
    const structure = compileStructure(null, material);
    return {
      ok: false,
      errors: ["submission: expected an object"],
      value: null,
      grounding: structure.grounding,
      structure,
      analysis: null,
    };
  }
  const structure = compileStructure(item.structure, material);
  if (!structure.ok || !structure.value || !structure.compiled) {
    return {
      ok: false,
      errors: structure.errors,
      value: null,
      grounding: structure.grounding,
      structure,
      analysis: null,
    };
  }
  const analysis = compileAnalysis(item.analysis, structure.value, structure.compiled, material);
  return {
    ok: structure.ok && analysis.ok,
    errors: unique([...structure.errors, ...analysis.errors]),
    value: structure.ok && analysis.ok ? item as unknown as CaseTreatmentSubmission : null,
    grounding: [...structure.grounding, ...analysis.grounding],
    structure,
    analysis,
  };
}

function numberedDecisionPacket(material: CaseMaterial) {
  return [
    "[DECISION]",
    JSON.stringify({ citation: material.citation, name: material.name, date: material.date, dataset: material.dataset }),
    "[COMPLETE NUMBERED DECISION]",
    material.source_lines.map((line) => `${line.line}: ${material.text.slice(line.start, line.end)}`).join("\n"),
  ].join("\n\n");
}

function referenceCandidatePacket(material: CaseMaterial, heading = "POSSIBLE DECISION REFERENCES — search hints, not a complete or authoritative list") {
  const lineRange = (start: number, end: number) => {
    const hits = material.source_lines.filter((line) => line.end > start && line.start < end);
    return hits.length ? [hits[0].line, hits.at(-1)!.line] : [null, null];
  };
  return [
    `[${heading}]`,
    JSON.stringify(material.citation_inventory.occurrences.map((occurrence) => [
      occurrence.id,
      ...lineRange(occurrence.start, occurrence.end),
      occurrence.quote,
    ])),
  ].join("\n\n");
}

const SPAN_INSTRUCTIONS = `Every source span uses four fields. start_quote must be copied exactly from start_line, and end_quote exactly from end_line. They delimit the first and last characters of the span. For a short span on one line, the same exact excerpt may be used for both anchors. Copy the decision's spelling and punctuation exactly; the line number before each colon is not part of the decision.`;

export const STRUCTURE_INSTRUCTIONS = `Read the complete decision and identify its judicial reasons and votes.

An opinion is an independently reasoned body of judicial reasons. A panel list, headnote, signature, order, correction, disposition-only line, or bare statement such as "I agree" is not a separate opinion. Bound each opinion from its first substantive heading or sentence through its last substantive sentence. Do not include editorial material, counsel lists, signatures, or a bare joinder in an opinion boundary.

List every participating decision-maker. Link a participant to an opinion as wrote, joined, or joined_in_part only when the decision establishes that relationship. For joined_in_part, state the expressly identified scope in plain language. Panel membership alone proves neither authorship nor joinder. Use collective_author only when the reasons identify an institutional writer such as "The Court"; otherwise leave it null when no writer is stated. List an expressly nonparticipating judge only in nonparticipants.

result_position describes whether an opinion or participant supports the decision's disposition, opposes it, reaches mixed results, or is genuinely unclear. Agreement by all judges is support for the disposition even if the word "majority" is absent. A judge agreeing only in the result has no opinion link unless the source also identifies reasons that judge adopts.

${SPAN_INSTRUCTIONS}

Return only JSON matching the supplied schema.`;

export const ANALYSIS_INSTRUCTIONS = `Read the complete decision and the supplied opinion structure. Describe how each judicial opinion treats decisions it cites.

REFERENCES
The supplied possible references are fallible search hints and are not exhaustive. Account for each supplied occurrence exactly once by placing its ID in detected_occurrence_id. Find additional references to legal decisions in the complete text and give those a null detected_occurrence_id. Do not guess a global database identity or resolve citation aliases. A reference span contains the exact identifying words in this decision.

voice identifies whose legal position the surrounding passage presents: the current judicial opinion, a party or counsel, the decision under review, a quoted decision, another quoted source, document metadata, or genuinely unclear. Court-written prose recounting counsel's argument has party_or_counsel voice. A quotation or a reported argument is not the current opinion's position unless the opinion adopts it.

ATTRIBUTED PASSAGES
Record a passage when the decision reproduces words that it attributes to a referenced decision and those words matter to the analysis. Delimit the exact passage as it appears here, including visible editorial alterations. This list is open-ended; quotation-mark detection is only a hint.

TREATMENTS
One treatment records one opinion's treatment of one proposition attributed to a cited decision. The cited proposition may contain several sentences or the connected components of a legal test when that is the meaningful unit. Create separate treatments when the same cited decision is used for materially different propositions or is treated differently by different opinions.

cited_proposition states what the current opinion presents the cited decision as standing for. treatment_summary states, succinctly but completely, what the current opinion does with that proposition and the material factual or legal scope of that action. Both must be supported by the listed evidence spans. If either field uses quotation marks, the quoted words must appear exactly in those spans or in a linked attributed passage.

signals may contain more than one independently supported operation:
- explained: interprets or clarifies the cited proposition;
- approved: expressly endorses it;
- followed: accepts it as governing authority;
- applied: uses it in deciding the present facts or question;
- extended: applies it beyond its previously stated setting;
- distinguished: declines to apply it because of a material difference;
- limited: narrows its scope;
- criticized: expresses disapproval without refusing to follow it;
- questioned: expresses doubt about its correctness or continuing force;
- not_followed: expressly refuses to follow it;
- overruled: expressly displaces its legal rule by a court able to do so;
- other: a substantive operation not described above, named in other_signal.

A bare citation, factual comparison, quotation, counsel submission, or description of another court does not itself establish treatment. Treatment evidence must include the current opinion's own words performing the operation. List in partial_adopters only judges whose recorded partial joinder expressly encompasses this proposition; do not repeat writers or full joiners.

PROCEDURAL HISTORY
Separately record cited decisions from the same proceeding. stage_relation describes how the cited decision fits in the litigation. current_decision_action describes what this decision does to the cited decision: for example, affirmed, reversed, varied, quashed, or remitted. Reversing a judgment under appeal is not overruling its legal rule. The summary explains the procedural relationship and result.

REFERENCE USES
For every reference, return one reference_uses row. List the treatment and procedural-history records that use that exact reference occurrence. Leave both ID arrays empty when the occurrence supports neither. The same occurrence may support both.

${SPAN_INSTRUCTIONS}

Return only JSON matching the supplied schema.`;

export const AUTHORITY_INVENTORY_INSTRUCTIONS = `Read the complete decision and list every judicial decision it cites or names.

Group multiple citations, short forms, or mentions only when the text makes clear that they refer to the same decision. Do not resolve the references to external database identifiers. Do not include legislation, secondary sources, party submissions that do not identify a decision, or the current decision's own title and citation in editorial metadata.

identifying_text should reproduce the clearest name or citation used in this decision. Record every occurrence that helped you identify the authority. The supplied possible references are fallible search hints, not an exhaustive list.

${SPAN_INSTRUCTIONS}

Return only JSON matching the supplied schema.`;

export function structurePrompt(material: CaseMaterial) {
  return [STRUCTURE_INSTRUCTIONS, numberedDecisionPacket(material)].join("\n\n");
}

function structureHintPacket(material: CaseMaterial) {
  const hints = material.deterministic_structure;
  if (!hints) return "";
  const resultPosition = (alignment: NonNullable<CaseMaterial["deterministic_structure"]>["opinions"][number]["alignment"]): ResultPosition =>
    alignment === "different_result"
      ? "opposes_disposition"
      : alignment === "mixed"
        ? "mixed"
        : alignment === "unknown"
          ? "unclear"
          : "supports_disposition";
  return [
    "[POSSIBLE STRUCTURE CUES \u2014 fallible search hints; verify every cue against the decision]",
    JSON.stringify({
      panel_names: hints.panel,
      nonparticipating_names: hints.nonparticipants,
      possible_opinions: hints.opinions.map((opinion) => ({
        possible_writers: opinion.authors,
        possible_full_joiners: opinion.joiners,
        possible_result_position: resultPosition(opinion.alignment),
        exact_start_text: opinion.start_quote,
        exact_end_text: opinion.end_quote,
      })),
    }),
  ].join("\n");
}

export function structurePromptWithHints(material: CaseMaterial) {
  return [STRUCTURE_INSTRUCTIONS, structureHintPacket(material), numberedDecisionPacket(material)]
    .filter(Boolean)
    .join("\n\n");
}

function compactStructure(structure: DecisionStructure) {
  return {
    opinions: structure.opinions,
    participants: structure.participants,
    nonparticipants: structure.nonparticipants,
  };
}

export function authorityInventoryPrompt(material: CaseMaterial) {
  return [
    AUTHORITY_INVENTORY_INSTRUCTIONS,
    referenceCandidatePacket(material),
    numberedDecisionPacket(material),
  ].join("\n\n");
}

export function analysisPrompt(material: CaseMaterial, structure: DecisionStructure, authorityInventory?: AuthorityInventory) {
  return [
    ANALYSIS_INSTRUCTIONS,
    "[JUDICIAL OPINION STRUCTURE]",
    JSON.stringify(compactStructure(structure)),
    authorityInventory ? "[REFERENCE INVENTORY FROM A COMPLETE FIRST READING]" : "",
    authorityInventory ? JSON.stringify(authorityInventory) : "",
    referenceCandidatePacket(material),
    numberedDecisionPacket(material),
  ].filter(Boolean).join("\n\n");
}

export function oneStagePrompt(material: CaseMaterial, includeStructureHints = false) {
  return [
    "Return one structured account of this complete court decision.",
    "[JUDICIAL OPINIONS AND VOTES]",
    STRUCTURE_INSTRUCTIONS.replace(/Return only JSON matching the supplied schema\.$/u, ""),
    "[CITED DECISIONS AND THEIR TREATMENT]",
    ANALYSIS_INSTRUCTIONS.replace(/Read the complete decision and the supplied opinion structure\. /u, "Read the complete decision. ")
      .replace(/Return only JSON matching the supplied schema\.$/u, ""),
    "Return only JSON matching the supplied schema.",
    includeStructureHints ? structureHintPacket(material) : "",
    referenceCandidatePacket(material),
    numberedDecisionPacket(material),
  ].filter(Boolean).join("\n\n");
}

export function propositionSupport(
  structure: CompiledStructure,
  treatment: CompiledAnalysis["treatments"][number],
) {
  const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id);
  const namedSupporters = unique([
    ...(opinion?.writers ?? []),
    ...(opinion?.full_joiners ?? []),
    ...treatment.partial_adopters,
  ].map(personKey));
  const panelSize = unique(structure.participants.map(({ name }) => personKey(name))).length;
  const collectiveSupporters = Boolean(opinion?.collective_author) && structure.opinions.length === 1
    ? structure.participants.filter((participant) =>
        !participant.result_only &&
        (participant.result_position === opinion?.result_position || participant.result_position === "unclear")
      ).map(({ name }) => personKey(name))
    : [];
  const supporterCount = unique([...namedSupporters, ...collectiveSupporters]).length;
  return {
    supporters: supporterCount,
    panel_size: panelSize,
    status: panelSize === 0
      ? "unknown" as const
      : supporterCount > panelSize / 2
        ? "majority" as const
        : "not_majority" as const,
  };
}

function opinionLabel(opinion: ResolvedOpinion) {
  if (opinion.writers.length) return opinion.writers.join(" and ");
  return opinion.collective_author ?? "writer not stated";
}

export function semanticView(compilation: SubmissionCompilation, idPrefix = "") {
  if (!compilation.ok || !compilation.structure.compiled || !compilation.analysis?.compiled) return null;
  const structure = compilation.structure.compiled;
  const analysis = compilation.analysis.compiled;
  const references = new Map(analysis.references.map((reference) => [reference.reference_id, reference]));
  const passages = new Map(analysis.attributed_passages.map((passage) => [passage.passage_id, passage]));
  return {
    treatments: analysis.treatments.map((treatment, index) => {
      const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id)!;
      return {
        treatment_id: `${idPrefix}t${index + 1}`,
        cited_references: treatment.reference_ids.map((id) => {
          const reference = references.get(id);
          return {
            reference: reference?.span.exact_text ?? id,
            voice: reference?.voice ?? "unclear",
          };
        }),
        treating_opinion: opinionLabel(opinion),
        signals: treatment.signals,
        other_signal: treatment.other_signal,
        cited_proposition: treatment.cited_proposition,
        treatment_summary: treatment.treatment_summary,
        evidence: treatment.evidence_spans.map(({ exact_text }) => exact_text),
        reproduced_passages: treatment.attributed_passage_ids.map((id) => passages.get(id)?.span.exact_text ?? id),
        judges_adopting_in_part: treatment.partial_adopters,
        majority_support: propositionSupport(structure, treatment).status,
      };
    }),
    procedural_history: analysis.procedural_history.map((history, index) => ({
      history_id: `${idPrefix}h${index + 1}`,
      cited_references: history.reference_ids.map((id) => references.get(id)?.span.exact_text ?? id),
      stage_relation: history.stage_relation,
      current_decision_action: history.current_decision_action,
      other_action: history.other_action,
      summary: history.summary,
      evidence: history.evidence_spans.map(({ exact_text }) => exact_text),
    })),
  };
}

export const SEMANTIC_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    treatment_grades: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reference_treatment_id: { type: "string", pattern: "^gt[1-9][0-9]*$" },
          candidate_treatment_ids: {
            type: "array",
            maxItems: 500,
            items: { type: "string", pattern: "^ct[1-9][0-9]*$" },
          },
          verdict: { enum: ["pass", "minor_error", "major_error"] },
          aspects: { type: "array", maxItems: 7, items: { enum: [
            "coverage",
            "attribution",
            "cited_proposition",
            "treatment",
            "scope",
            "support",
            "majority_support",
          ] } },
          explanation: { type: ["string", "null"], maxLength: 2_000 },
        },
        required: ["reference_treatment_id", "candidate_treatment_ids", "verdict", "aspects", "explanation"],
      },
    },
    extra_candidate_treatments: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_treatment_id: { type: "string", pattern: "^ct[1-9][0-9]*$" },
          severity: { enum: ["minor", "major"] },
          explanation: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["candidate_treatment_id", "severity", "explanation"],
      },
    },
    procedural_history_grades: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reference_history_id: { type: "string", pattern: "^gh[1-9][0-9]*$" },
          candidate_history_ids: {
            type: "array",
            maxItems: 500,
            items: { type: "string", pattern: "^ch[1-9][0-9]*$" },
          },
          verdict: { enum: ["pass", "minor_error", "major_error"] },
          explanation: { type: ["string", "null"], maxLength: 2_000 },
        },
        required: ["reference_history_id", "candidate_history_ids", "verdict", "explanation"],
      },
    },
    extra_candidate_history: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_history_id: { type: "string", pattern: "^ch[1-9][0-9]*$" },
          severity: { enum: ["minor", "major"] },
          explanation: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["candidate_history_id", "severity", "explanation"],
      },
    },
  },
  required: [
    "treatment_grades",
    "extra_candidate_treatments",
    "procedural_history_grades",
    "extra_candidate_history",
  ],
} as const;

export const SEMANTIC_PASS_THRESHOLD = 0.8;

export function semanticJudgeScore(value: unknown) {
  const result = record(value);
  const rows = (name: string) => Array.isArray(result?.[name]) ? result[name] as Array<Record<string, unknown>> : [];
  const gradePoints = (grade: unknown) => grade === "pass" ? 1 : grade === "minor_error" || grade === "minor" ? 0.5 : 0;
  const treatmentPoints = [
    ...rows("treatment_grades").map(({ verdict }) => gradePoints(verdict)),
    ...rows("extra_candidate_treatments").map(({ severity }) => gradePoints(severity)),
  ];
  const historyPoints = [
    ...rows("procedural_history_grades").map(({ verdict }) => gradePoints(verdict)),
    ...rows("extra_candidate_history").map(({ severity }) => gradePoints(severity)),
  ];
  const score = (points: number[]) => ({
    items: points.length,
    earned: points.reduce((total, point) => total + point, 0),
    score: points.length ? points.reduce((total, point) => total + point, 0) / points.length : 1,
  });
  const treatment = score(treatmentPoints);
  const procedural_history = score(historyPoints);
  const overall = score([...treatmentPoints, ...historyPoints]);
  return {
    treatment,
    procedural_history,
    overall,
    passed: overall.score >= SEMANTIC_PASS_THRESHOLD,
    passing_threshold: SEMANTIC_PASS_THRESHOLD,
  };
}

export function semanticJudgeResultErrors(
  gold: SubmissionCompilation,
  candidate: SubmissionCompilation,
  value: unknown,
) {
  const reference = semanticView(gold, "g");
  const answer = semanticView(candidate, "c");
  const result = record(value);
  if (!reference || !answer || !result) return ["semantic judge result is not an object"];
  const errors: string[] = [];
  const referenceTreatments = new Set(reference.treatments.map(({ treatment_id }) => treatment_id));
  const candidateTreatments = new Set(answer.treatments.map(({ treatment_id }) => treatment_id));
  const referenceHistory = new Set(reference.procedural_history.map(({ history_id }) => history_id));
  const candidateHistory = new Set(answer.procedural_history.map(({ history_id }) => history_id));
  const seenReferenceTreatments = new Set<string>();
  const seenCandidateTreatments = new Set<string>();
  const seenReferenceHistory = new Set<string>();
  const seenCandidateHistory = new Set<string>();
  const rows = (name: string) => Array.isArray(result[name]) ? result[name] as unknown[] : [];

  for (const [index, raw] of rows("treatment_grades").entries()) {
    const grade = record(raw);
    const id = typeof grade?.reference_treatment_id === "string" ? grade.reference_treatment_id : "";
    if (!referenceTreatments.has(id)) errors.push(`treatment_grades[${index}]: unknown reference treatment ${id}`);
    if (seenReferenceTreatments.has(id)) errors.push(`treatment_grades[${index}]: duplicate reference treatment ${id}`);
    seenReferenceTreatments.add(id);
    for (const candidateId of list(grade?.candidate_treatment_ids)) {
      if (typeof candidateId !== "string" || !candidateTreatments.has(candidateId)) {
        errors.push(`treatment_grades[${index}]: unknown candidate treatment ${String(candidateId)}`);
      } else seenCandidateTreatments.add(candidateId);
    }
    const verdict = grade?.verdict;
    const aspects = list(grade?.aspects);
    const explanation = grade?.explanation;
    if (verdict === "pass" && (aspects.length || explanation !== null)) {
      errors.push(`treatment_grades[${index}]: pass requires no aspects and a null explanation`);
    }
    if (verdict !== "pass" && (!aspects.length || typeof explanation !== "string" || !explanation.trim())) {
      errors.push(`treatment_grades[${index}]: an error requires aspects and an explanation`);
    }
  }
  for (const [index, raw] of rows("extra_candidate_treatments").entries()) {
    const grade = record(raw);
    const id = typeof grade?.candidate_treatment_id === "string" ? grade.candidate_treatment_id : "";
    if (!candidateTreatments.has(id)) errors.push(`extra_candidate_treatments[${index}]: unknown candidate treatment ${id}`);
    if (seenCandidateTreatments.has(id)) errors.push(`extra_candidate_treatments[${index}]: candidate treatment ${id} is already matched`);
    seenCandidateTreatments.add(id);
  }
  for (const [index, raw] of rows("procedural_history_grades").entries()) {
    const grade = record(raw);
    const id = typeof grade?.reference_history_id === "string" ? grade.reference_history_id : "";
    if (!referenceHistory.has(id)) errors.push(`procedural_history_grades[${index}]: unknown reference history ${id}`);
    if (seenReferenceHistory.has(id)) errors.push(`procedural_history_grades[${index}]: duplicate reference history ${id}`);
    seenReferenceHistory.add(id);
    for (const candidateId of list(grade?.candidate_history_ids)) {
      if (typeof candidateId !== "string" || !candidateHistory.has(candidateId)) {
        errors.push(`procedural_history_grades[${index}]: unknown candidate history ${String(candidateId)}`);
      } else seenCandidateHistory.add(candidateId);
    }
    const verdict = grade?.verdict;
    const explanation = grade?.explanation;
    if (verdict === "pass" && explanation !== null) {
      errors.push(`procedural_history_grades[${index}]: pass requires a null explanation`);
    }
    if (verdict !== "pass" && (typeof explanation !== "string" || !explanation.trim())) {
      errors.push(`procedural_history_grades[${index}]: an error requires an explanation`);
    }
  }
  for (const [index, raw] of rows("extra_candidate_history").entries()) {
    const grade = record(raw);
    const id = typeof grade?.candidate_history_id === "string" ? grade.candidate_history_id : "";
    if (!candidateHistory.has(id)) errors.push(`extra_candidate_history[${index}]: unknown candidate history ${id}`);
    if (seenCandidateHistory.has(id)) errors.push(`extra_candidate_history[${index}]: candidate history ${id} is already matched`);
    seenCandidateHistory.add(id);
  }

  for (const id of referenceTreatments) if (!seenReferenceTreatments.has(id)) errors.push(`missing grade for ${id}`);
  for (const id of candidateTreatments) if (!seenCandidateTreatments.has(id)) errors.push(`candidate treatment ${id} is neither matched nor extra`);
  for (const id of referenceHistory) if (!seenReferenceHistory.has(id)) errors.push(`missing grade for ${id}`);
  for (const id of candidateHistory) if (!seenCandidateHistory.has(id)) errors.push(`candidate history ${id} is neither matched nor extra`);
  return errors;
}

export function semanticJudgePrompt(gold: SubmissionCompilation, candidate: SubmissionCompilation) {
  const reference = semanticView(gold, "g");
  const answer = semanticView(candidate, "c");
  if (!reference || !answer) throw new Error("semantic judgment requires two valid compiled submissions");
  return `Assess the legal accuracy of the candidate's account of how the current decision treats cited decisions. Use the reference answer as the standard.

Compare the candidate and reference by legal meaning. Determine whether the candidate includes every substantive treatment and invents none; accurately states the proposition attributed to each cited decision; accurately describes what the treating opinion does with that proposition and its material scope; attributes the treatment to the correct judicial opinion and position; supplies evidence that supports the account; correctly identifies majority support; and accurately describes any procedural history from the same proceeding. Flag a treatment that presents a party's submission, a quotation, or another decision's reasoning as the current opinion's own position unless that opinion adopts it.

Equivalent wording, ordering, and grouping are acceptable when coverage and legal meaning are preserved.

Return one treatment grade for every reference treatment ID. List the candidate treatment IDs that collectively express that proposition; this may be empty when the proposition is missing, and one candidate treatment may correspond to more than one reference treatment. List every candidate treatment that corresponds to no reference proposition under extra_candidate_treatments. Grade procedural-history records the same way in their separate arrays.

pass means the proposition or history is substantively accurate. minor_error means a localized error or ambiguity unlikely to materially alter a legal researcher's understanding. major_error means an omission, invention, misattribution, or other error that could materially mislead legal research. For a pass, return no aspects and a null explanation; otherwise identify the affected aspects and explain the error concisely.

Return only schema JSON.

[REFERENCE ANSWER]
${JSON.stringify(reference)}

[CANDIDATE ANSWER]
${JSON.stringify(answer)}`;
}

function spanOverlap(
  left: Pick<ResolvedSpan, "start" | "end">,
  right: Pick<ResolvedSpan, "start" | "end">,
) {
  const intersection = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  const union = Math.max(left.end, right.end) - Math.min(left.start, right.start);
  return union ? intersection / union : 0;
}

const judicialNameKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .split(/\s+/u)
  .filter((token) => token && ![
    "the", "honourable", "honorable", "mr", "mrs", "ms", "madam", "chief",
    "associate", "justice", "judge", "j", "ja", "cj", "cja", "jj",
  ].includes(token) && !/^\p{L}$/u.test(token))
  .join(" ");

function categoryScore(categories: Record<string, boolean>) {
  const values = Object.values(categories);
  const passed = values.filter(Boolean).length;
  return { passed, total: values.length, score: values.length ? passed / values.length : 0 };
}

function recognizedBoundaryHeading(text: string) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => BOUNDARY_HEADING.test(line));
}

function safeGoldBoundaryDifference(
  start: number,
  end: number,
  material: CaseMaterial,
  dispositions: ResolvedSpan[],
) {
  const raw = material.text.slice(start, end);
  const content = raw.trim();
  if (!content) return true;
  const contentStart = start + raw.indexOf(content);
  const contentEnd = contentStart + content.length;
  const insideDisposition = (rangeStart: number, rangeEnd: number) => dispositions.some((span) => {
    if (rangeStart >= span.start && rangeEnd <= span.end) return true;
    if (span.start < rangeStart || span.end > rangeEnd) return false;
    return /^\s*(?:\[\d+\]\s*)?$/u.test(material.text.slice(rangeStart, span.start)) &&
      /^\s*$/u.test(material.text.slice(span.end, rangeEnd));
  });
  return insideDisposition(contentStart, contentEnd) || recognizedBoundaryHeading(content) ||
    [...raw.matchAll(/[^\r\n]+/gu)].every((line) => {
      const lineContent = line[0].trim();
      if (!lineContent || BOUNDARY_HEADING.test(lineContent)) return true;
      const lineStart = start + line.index! + line[0].indexOf(lineContent);
      return insideDisposition(lineStart, lineStart + lineContent.length);
    });
}

function boundaryComparison(
  expected: ResolvedSpan,
  actual: ResolvedSpan,
  overlap: number,
  material: CaseMaterial,
  dispositions: ResolvedSpan[],
) {
  const exact = expected.start === actual.start && expected.end === actual.end;
  const startRange = [Math.min(expected.start, actual.start), Math.max(expected.start, actual.start)] as const;
  const endRange = [Math.min(expected.end, actual.end), Math.max(expected.end, actual.end)] as const;
  const substantiveCoverageDifferences = material.coverage.spans.filter((span) =>
    (span.start >= expected.start && span.end <= expected.end) !==
    (span.start >= actual.start && span.end <= actual.end));
  const sameSubstantiveCoverage = !substantiveCoverageDifferences.length;
  const startDifferenceAcceptable = safeGoldBoundaryDifference(startRange[0], startRange[1], material, dispositions);
  const endDifferenceAcceptable = safeGoldBoundaryDifference(endRange[0], endRange[1], material, dispositions);
  const acceptable = exact || (sameSubstantiveCoverage && startDifferenceAcceptable && endDifferenceAcceptable);
  return {
    exact,
    acceptable,
    overlap,
    same_substantive_coverage: sameSubstantiveCoverage,
    substantive_coverage_differences: substantiveCoverageDifferences.map(({ label }) => label),
    start_difference_acceptable: startDifferenceAcceptable,
    end_difference_acceptable: endDifferenceAcceptable,
    start_difference: material.text.slice(startRange[0], startRange[1]),
    end_difference: material.text.slice(endRange[0], endRange[1]),
  };
}

export function compareStructureMechanics(gold: StructureCompilation, candidate: StructureCompilation, material: CaseMaterial) {
  if (!gold.compiled || !candidate.compiled) return null;
  const pairs = gold.compiled.opinions.flatMap((expected, expectedIndex) =>
    candidate.compiled!.opinions.map((actual, actualIndex) => ({ expected, actual, expectedIndex, actualIndex, overlap: spanOverlap(expected.boundary, actual.boundary) }))
  ).filter(({ overlap }) => overlap > 0).sort((left, right) => right.overlap - left.overlap);
  const goldUsed = new Set<number>();
  const candidateUsed = new Set<number>();
  const matches = pairs.filter(({ expectedIndex, actualIndex }) => {
    if (goldUsed.has(expectedIndex) || candidateUsed.has(actualIndex)) return false;
    goldUsed.add(expectedIndex);
    candidateUsed.add(actualIndex);
    return true;
  }).map((match) => ({
    ...match,
    boundary: boundaryComparison(
      match.expected.boundary,
      match.actual.boundary,
      match.overlap,
      material,
      gold.compiled!.disposition_spans,
    ),
  }));
  const normalizedNames = (values: string[]) => unique(values.map(judicialNameKey)).sort();
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const categories = {
    opinion_count_exact: gold.compiled.opinions.length === candidate.compiled.opinions.length,
    boundaries_acceptable: matches.length === gold.compiled.opinions.length && matches.length === candidate.compiled.opinions.length &&
      matches.every(({ boundary }) => boundary.acceptable),
    writers_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      same(normalizedNames(expected.writers), normalizedNames(actual.writers)) && expected.collective_author === actual.collective_author
    ),
    full_joiners_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      same(normalizedNames(expected.full_joiners), normalizedNames(actual.full_joiners))
    ),
    partial_joiners_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      same(normalizedNames(expected.partial_joiners.map(({ name }) => name)), normalizedNames(actual.partial_joiners.map(({ name }) => name)))
    ),
    opinion_results_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) => expected.result_position === actual.result_position),
    participant_votes_exact: same(
      gold.compiled.participants.map(({ name, result_position }) => [judicialNameKey(name), result_position]).sort(),
      candidate.compiled.participants.map(({ name, result_position }) => [judicialNameKey(name), result_position]).sort(),
    ),
    nonparticipants_exact: same(normalizedNames(gold.compiled.nonparticipants), normalizedNames(candidate.compiled.nonparticipants)),
  };
  return {
    accepted: Object.values(categories).every(Boolean),
    category_score: categoryScore(categories),
    categories,
    boundary_receipts: matches.map(({ expected, actual, boundary }) => ({
      gold_opinion_id: expected.opinion_id,
      candidate_opinion_id: actual.opinion_id,
      ...boundary,
    })),
    metrics: {
      gold_opinions: gold.compiled.opinions.length,
      candidate_opinions: candidate.compiled.opinions.length,
      matched_opinions: matches.length,
      exact_boundaries: matches.filter(({ boundary }) => boundary.exact).length,
      acceptable_boundaries: matches.filter(({ boundary }) => boundary.acceptable).length,
      mean_boundary_overlap: matches.length ? matches.reduce((sum, { overlap }) => sum + overlap, 0) / matches.length : 0,
    },
  };
}

export function compareDeterministicStructure(gold: StructureCompilation, material: CaseMaterial) {
  const hints = material.deterministic_structure;
  if (!gold.compiled || !hints) return null;
  const pairs = gold.compiled.opinions.flatMap((expected, expectedIndex) =>
    hints.opinions.map((actual, actualIndex) => ({
      expected,
      actual,
      expectedIndex,
      actualIndex,
      overlap: spanOverlap(expected.boundary, actual),
    }))
  ).filter(({ overlap }) => overlap > 0).sort((left, right) => right.overlap - left.overlap);
  const goldUsed = new Set<number>();
  const hintUsed = new Set<number>();
  const matches = pairs.filter(({ expectedIndex, actualIndex }) => {
    if (goldUsed.has(expectedIndex) || hintUsed.has(actualIndex)) return false;
    goldUsed.add(expectedIndex);
    hintUsed.add(actualIndex);
    return true;
  });
  const normalizedNames = (values: string[]) => unique(values.map(judicialNameKey)).sort();
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const alignmentPosition = (value: "lead" | "same_result_separate_reasons" | "different_result" | "mixed" | "unknown"): ResultPosition =>
    value === "different_result"
      ? "opposes_disposition"
      : value === "mixed"
        ? "mixed"
        : value === "unknown"
          ? "unclear"
          : "supports_disposition";
  const categories = {
    opinion_count_exact: gold.compiled.opinions.length === hints.opinions.length,
    boundaries_exact: matches.length === gold.compiled.opinions.length && matches.length === hints.opinions.length &&
      matches.every(({ expected, actual }) => expected.boundary.start === actual.start && expected.boundary.end === actual.end),
    writers_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      same(normalizedNames(expected.writers), normalizedNames(actual.authors))
    ),
    full_joiners_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      same(normalizedNames(expected.full_joiners), normalizedNames(actual.joiners))
    ),
    opinion_results_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      expected.result_position === alignmentPosition(actual.alignment)
    ),
    panel_names_exact: same(
      normalizedNames(gold.compiled.participants.map(({ name }) => name)),
      normalizedNames(hints.panel),
    ),
    nonparticipants_exact: same(normalizedNames(gold.compiled.nonparticipants), normalizedNames(hints.nonparticipants)),
  };
  return {
    status: hints.status,
    exact: Object.values(categories).every(Boolean),
    category_score: categoryScore(categories),
    categories,
    metrics: {
      gold_opinions: gold.compiled.opinions.length,
      detected_opinions: hints.opinions.length,
      matched_opinions: matches.length,
      mean_boundary_overlap: matches.length
        ? matches.reduce((sum, { overlap }) => sum + overlap, 0) / matches.length
        : 0,
    },
    refusals: hints.refusals,
  };
}

export function deterministicQuoteCandidates(material: CaseMaterial) {
  const seen = new Set<string>();
  return markedQuoteSpans(material.text)
    .filter(({ text }) => wordCount(text) >= 4 && text.trim().length >= 24)
    .filter(({ start, end }) => {
      const key = `${start}:${end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ text, start, end }, index) => ({ id: `dq${index + 1}`, text, start, end }));
}
