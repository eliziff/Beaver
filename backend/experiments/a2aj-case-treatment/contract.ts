import { createHash } from "node:crypto";

import { createA2AJPassageEvidence, type LegalEvidenceReceipt } from "../../src/lib/chat/legalEvidence";
import { structureNative } from "../../src/lib/structureNative";

const { groundedProseErrors, markedQuoteSpans, quoteRepairSuggestion } = structureNative();
const wordCount = (value: string) => value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
import type {
  DecisionCitationInventory,
} from "../a2aj-decision-roster/caseDecisionMvp";
import type { ModelSourceLine } from "../a2aj-decision-roster/caseTargetMvpReduced";

export const CASE_TREATMENT_CONTRACT_VERSION = "a2aj-proposition-treatment-v6";

export const RESULT_POSITIONS = [
  "supports_disposition",
  "opposes_disposition",
  "mixed",
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

export const PROCEDURAL_ACTIONS = [
  "affirmed",
  "reversed",
  "varied",
  "quashed",
  "remitted",
  "leave_granted",
  "leave_refused",
  "other",
] as const;

export const ANALYSIS_CONTRACTS = ["simple", "self-check"] as const;

export type ResultPosition = (typeof RESULT_POSITIONS)[number];
export type TreatmentSignal = (typeof TREATMENT_SIGNALS)[number];
export type ProceduralAction = (typeof PROCEDURAL_ACTIONS)[number];
export type AnalysisContract = (typeof ANALYSIS_CONTRACTS)[number];

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

export type SourceBlockId = `p${number}`;

export type BlockQuotation = {
  block_ids: SourceBlockId[];
  text: string;
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
      evidence: AnchoredSpan;
    }>;
  }>;
  nonparticipants: PersonEvidence[];
};

export type DecisionAnalysis = {
  decision_mentions: Array<{
    cited_decision: string;
    identifying_block: SourceBlockId;
  }>;
  procedural_relationships: Array<{
    cited_decision: string;
    identifying_block: SourceBlockId;
    description: string;
    evidence_blocks: SourceBlockId[];
    actions: Array<{
      action: ProceduralAction;
      affected_part: string | null;
      evidence_blocks: SourceBlockId[];
    }>;
  }>;
  treatments: Array<{
    cited_decision: string;
    identifying_block: SourceBlockId;
    opinion_id?: string;
    signals: TreatmentSignal[];
    other_signal: string | null;
    proposition: string;
    treatment: string;
    evidence_blocks: SourceBlockId[];
    supporting_passages?: BlockQuotation[];
    quoted_passages: BlockQuotation[];
  }>;
};

export type CaseTreatmentSubmission = {
  structure: DecisionStructure;
  analysis: DecisionAnalysis;
};

export type GoldRecord = {
  contract_version: typeof CASE_TREATMENT_CONTRACT_VERSION;
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
  qualified_joiners: Array<{ name: string; evidence: ResolvedSpan }>;
};

export type CompiledStructure = {
  opinions: ResolvedOpinion[];
  participants: Array<{
    name: string;
    result_position: ResultPosition;
    result_only: boolean;
    links: Array<{ opinion_id: string; relation: "wrote" | "joined" | "joined_in_part"; evidence: ResolvedSpan }>;
  }>;
  nonparticipants: string[];
  disposition_spans: ResolvedSpan[];
};

export type CompiledAnalysis = {
  decision_mentions: Array<{
    decision_id: string;
    cited_decision: string;
    identifying_block: ResolvedSpan;
  }>;
  procedural_relationships: Array<{
    relationship_id: string;
    decision_id: string;
    cited_decision: string;
    identifying_block: ResolvedSpan;
    description: string;
    evidence_blocks: ResolvedSpan[];
    actions: Array<{
      action: ProceduralAction;
      affected_part: string | null;
      evidence_blocks: ResolvedSpan[];
    }>;
  }>;
  treatments: Array<{
    treatment_id: string;
    decision_id: string;
    cited_decision: string;
    identifying_block: ResolvedSpan;
    opinion_id: string;
    model_opinion_id: string | null;
    signals: TreatmentSignal[];
    other_signal: string | null;
    proposition: string;
    treatment: string;
    evidence_blocks: ResolvedSpan[];
    supporting_passages: Array<ResolvedSpan & {
      block_ids: SourceBlockId[];
      model_text: string;
      alignment: "exact" | "normalized";
      deterministic_quote_ids: string[];
    }>;
    quoted_passages: Array<ResolvedSpan & {
      block_ids: SourceBlockId[];
      model_text: string;
      alignment: "exact" | "normalized";
      deterministic_quote_ids: string[];
    }>;
  }>;
};

export type GroundingReceipt = {
  path: string;
  start: number;
  end: number;
  exact_text: string;
  text_sha256: string;
};

export type ProseCopyReceipt = {
  path: string;
  exact_text: string;
  text_sha256: string;
  source: {
    evidence_id: string;
    start: number;
    end: number;
    text_sha256: string;
  };
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
  prose_copy_receipts: ProseCopyReceipt[];
  deterministic_quote_candidates: Array<{
    id: string;
    text: string;
    start: number;
    end: number;
    text_sha256: string;
  }>;
  no_oracle_citation_check: {
    checked: number;
    covered: number;
    omissions: Array<{
      occurrence_id: string;
      line: number;
      exact_text: string;
      start: number;
      end: number;
      text_sha256: string;
    }>;
    unresolved: Array<{
      occurrence_id: string;
      line: number;
      exact_text: string;
      start: number;
      end: number;
      text_sha256: string;
    }>;
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
                evidence: anchoredSpanSchema,
              },
              required: ["opinion_id", "relation", "evidence"],
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

export function analysisOutputSchema(
  lineCount: number,
  opinionIds?: readonly string[],
  contract: AnalysisContract = "self-check",
) {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new Error("source requires at least one block");
  if (!ANALYSIS_CONTRACTS.includes(contract)) throw new Error(`unknown analysis contract ${contract}`);
  const blockId = { type: "string", pattern: "^p[1-9][0-9]*$" };
  const blockList = { type: "array", minItems: 1, maxItems: 50, items: blockId };
  const blockQuotation = {
    type: "object",
    additionalProperties: false,
    properties: {
      block_ids: blockList,
      text: { type: "string", minLength: 1, maxLength: 12_000 },
    },
    required: ["block_ids", "text"],
  };
  const opinionId = opinionIds?.length
    ? { type: "string", enum: [...opinionIds] }
    : { type: "string", pattern: "^o[1-9][0-9]*$" };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decision_mentions: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            cited_decision: { type: "string", minLength: 1, maxLength: 500 },
            identifying_block: blockId,
          },
          required: ["cited_decision", "identifying_block"],
        },
      },
      procedural_relationships: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            cited_decision: { type: "string", minLength: 1, maxLength: 500 },
            identifying_block: blockId,
            description: { type: "string", minLength: 1, maxLength: 4_000 },
            evidence_blocks: blockList,
            actions: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  action: { enum: PROCEDURAL_ACTIONS },
                  affected_part: { type: ["string", "null"], maxLength: 2_000 },
                  evidence_blocks: blockList,
                },
                required: ["action", "affected_part", "evidence_blocks"],
              },
            },
          },
          required: ["cited_decision", "identifying_block", "description", "evidence_blocks", "actions"],
        },
      },
      treatments: {
        type: "array",
        maxItems: 2_000,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            cited_decision: { type: "string", minLength: 1, maxLength: 500 },
            identifying_block: blockId,
            ...(contract === "self-check" ? { opinion_id: opinionId } : {}),
            signals: { type: "array", minItems: 1, maxItems: 5, items: { enum: TREATMENT_SIGNALS } },
            other_signal: { type: ["string", "null"], maxLength: 300 },
            proposition: { type: "string", minLength: 1, maxLength: 4_000 },
            treatment: { type: "string", minLength: 1, maxLength: 4_000 },
            evidence_blocks: blockList,
            ...(contract === "self-check" ? {
              supporting_passages: { type: "array", minItems: 1, maxItems: 20, items: blockQuotation },
            } : {}),
            quoted_passages: {
              type: "array",
              maxItems: 20,
              items: blockQuotation,
            },
          },
          required: [
            "cited_decision", "identifying_block",
            ...(contract === "self-check" ? ["opinion_id", "supporting_passages"] : []),
            "signals", "other_signal", "proposition", "treatment", "evidence_blocks", "quoted_passages",
          ],
        },
      },
    },
    required: ["decision_mentions", "procedural_relationships", "treatments"],
  };
}

export function submissionOutputSchema(lineCount: number, contract: AnalysisContract = "self-check") {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      structure: structureOutputSchema(lineCount),
      analysis: analysisOutputSchema(lineCount, undefined, contract),
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

function sourceBlock(
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
) {
  if (typeof value !== "string" || !/^p[1-9][0-9]*$/u.test(value)) {
    errors.push(`${path}: expected a source block such as p12`);
    return null;
  }
  const number = Number(value.slice(1));
  const line = material.source_lines[number - 1];
  if (!line || line.line !== number) {
    errors.push(`${path}: unknown source block ${value}`);
    return null;
  }
  const exactText = material.text.slice(line.start, line.end);
  return {
    start_line: number,
    end_line: number,
    start_quote: exactText,
    end_quote: exactText,
    start: line.start,
    end: line.end,
    exact_text: exactText,
    text_sha256: sha256(exactText),
  } satisfies ResolvedSpan;
}

function collectBlock(
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
  grounding: GroundingReceipt[],
  evidence: Map<string, LegalEvidenceReceipt>,
  retainEvidenceReceipt = true,
) {
  const span = sourceBlock(value, path, material, errors);
  if (!span) return null;
  grounding.push({ path, start: span.start, end: span.end, exact_text: span.exact_text, text_sha256: span.text_sha256 });
  if (retainEvidenceReceipt) {
    const receipt = evidenceReceipt(material, path, span);
    evidence.set(receipt.evidence_id, receipt);
  }
  return span;
}

function collectBlocks(
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
  grounding: GroundingReceipt[],
  evidence: Map<string, LegalEvidenceReceipt>,
  opinion?: ResolvedOpinion,
) {
  const values = requiredList(value, path, errors);
  if (!values.length) {
    errors.push(`${path}: at least one source block is required`);
    return [];
  }
  const seen = new Set<string>();
  return values.flatMap((blockId, index) => {
    if (typeof blockId === "string" && seen.has(blockId)) {
      errors.push(`${path}[${index}]: duplicate source block ${blockId}`);
      return [];
    }
    if (typeof blockId === "string") seen.add(blockId);
    const span = collectBlock(blockId, `${path}[${index}]`, material, errors, grounding, evidence);
    if (!span) return [];
    if (opinion && (span.end <= opinion.boundary.start || span.start >= opinion.boundary.end)) {
      errors.push(`${path}[${index}]: block ${String(blockId)} is outside ${opinion.opinion_id}`);
    }
    return [span];
  });
}

function normalizedText(value: string, withOffsets = false) {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespace = false;
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    const width = character.length;
    if (/\s/u.test(character)) {
      if (text && !whitespace) {
        text += " ";
        starts.push(index);
        ends.push(index + width);
      } else if (whitespace && ends.length) {
        ends[ends.length - 1] = index + width;
      }
      whitespace = true;
      index += width;
      continue;
    }
    whitespace = false;
    const mapped = /[\u201c\u201d\u201e\u201f]/u.test(character)
      ? '"'
      : /[\u2018\u2019\u201a\u201b]/u.test(character)
        ? "'"
        : /[\u2010-\u2015\u2212]/u.test(character)
          ? "-"
          : character;
    text += mapped;
    if (withOffsets) for (let offset = 0; offset < mapped.length; offset += 1) {
      starts.push(index);
      ends.push(index + width);
    }
    index += width;
  }
  return { text: withOffsets ? text : text.trim(), starts, ends };
}

function stringMatches(haystack: string, needle: string) {
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(1, needle.length);
  }
  return matches;
}

function collectBlockQuotation(
  value: unknown,
  path: string,
  material: CaseMaterial,
  errors: string[],
  grounding: GroundingReceipt[],
  evidence: Map<string, LegalEvidenceReceipt>,
  opinion: ResolvedOpinion | undefined,
  deterministicQuotes: Array<{ id: string; start: number; end: number }>,
) {
  const item = record(value);
  if (!item) {
    errors.push(`${path}: expected quoted text and its source blocks`);
    return null;
  }
  const modelText = stringValue(item.text, `${path}.text`, errors);
  const rawBlockIds = requiredList(item.block_ids, `${path}.block_ids`, errors);
  if (!rawBlockIds.length) {
    errors.push(`${path}.block_ids: at least one source block is required`);
    return null;
  }
  const blockIds = unique(rawBlockIds.filter((blockId): blockId is SourceBlockId =>
    typeof blockId === "string" && /^p[1-9][0-9]*$/u.test(blockId)
  ));
  if (blockIds.length !== rawBlockIds.length) {
    errors.push(`${path}.block_ids: source blocks must be valid and unique`);
    return null;
  }
  const blockNumbers = blockIds.map((blockId) => Number(blockId.slice(1))).sort((left, right) => left - right);
  if (blockNumbers.some((number, index) => index > 0 && number !== blockNumbers[index - 1] + 1)) {
    errors.push(`${path}.block_ids: a copied passage must use consecutive source blocks`);
    return null;
  }
  const blocks = blockIds.flatMap((blockId, index) => {
    const span = sourceBlock(blockId, `${path}.block_ids[${index}]`, material, errors);
    return span ? [span] : [];
  });
  if (blocks.length !== blockIds.length || !modelText) return null;
  const envelopeStart = Math.min(...blocks.map(({ start }) => start));
  const envelopeEnd = Math.max(...blocks.map(({ end }) => end));
  const envelope = material.text.slice(envelopeStart, envelopeEnd);
  let start = -1;
  let end = -1;
  let alignment: "exact" | "normalized" = "exact";
  const exactMatches = stringMatches(envelope, modelText);
  if (exactMatches.length === 1) {
    start = envelopeStart + exactMatches[0];
    end = start + modelText.length;
  } else {
    const normalizedEnvelope = normalizedText(envelope, true);
    const normalizedNeedle = normalizedText(modelText).text;
    const matches = normalizedNeedle ? stringMatches(normalizedEnvelope.text, normalizedNeedle) : [];
    if (matches.length === 1) {
      const normalizedStart = matches[0];
      const normalizedEnd = normalizedStart + normalizedNeedle.length - 1;
      start = envelopeStart + normalizedEnvelope.starts[normalizedStart];
      end = envelopeStart + normalizedEnvelope.ends[normalizedEnd];
      alignment = "normalized";
    } else {
      const suggestion = quoteRepairSuggestion(modelText, [envelope]);
      errors.push(`${path}.text: quoted text ${matches.length > 1 || exactMatches.length > 1 ? "is ambiguous" : "was not found"} within ${blockIds.join(", ")}${suggestion ? `; ${suggestion}` : ""}`);
      return null;
    }
  }
  if (opinion && (start < opinion.boundary.start || end > opinion.boundary.end)) {
    errors.push(`${path}: quoted passage is outside ${opinion.opinion_id}`);
  }
  const exactText = material.text.slice(start, end);
  const startLine = sourceLineAt(material, start)!;
  const endLine = sourceLineAt(material, Math.max(start, end - 1))!;
  const span = {
    start_line: startLine.line,
    end_line: endLine.line,
    start_quote: material.text.slice(start, Math.min(end, startLine.end)),
    end_quote: material.text.slice(Math.max(start, endLine.start), end),
    start,
    end,
    exact_text: exactText,
    text_sha256: sha256(exactText),
    block_ids: blockIds,
    model_text: modelText,
    alignment,
    deterministic_quote_ids: deterministicQuotes
      .filter((quote) => quote.start >= start && quote.end <= end)
      .map(({ id }) => id),
  } satisfies CompiledAnalysis["treatments"][number]["quoted_passages"][number];
  grounding.push({ path, start, end, exact_text: exactText, text_sha256: span.text_sha256 });
  const receipt = evidenceReceipt(material, path, span);
  evidence.set(receipt.evidence_id, receipt);
  return span;
}

function evidenceNamesPerson(name: string, evidenceText: string) {
  const ignored = new Set([
    "a", "c", "chief", "cj", "cjc", "cja", "dr", "honorable", "honourable", "j", "ja",
    "judge", "justice", "madam", "mr", "mrs", "ms", "the",
  ]);
  const tokens = (value: string) => (value.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((token) => token.replace(/([\p{L}\p{N}])\1{2,}/gu, "$1$1"));
  const identifying = tokens(name).filter((token) => token.length > 1 && !ignored.has(token));
  const evidence = new Set(tokens(evidenceText));
  // Court reasons identify judges by surname alone ("Matthews J."), so any
  // distinguishing name token in the evidence grounds the person.
  return identifying.length > 0 && identifying.some((token) => evidence.has(token));
}

const BOUNDARY_HEADING = /^(?:(?:summary of )?(?:orders?|dispositions?)|decision|introduction|background|analysis|reasons?(?: for (?:judgment|decision|order)| of (?:the )?court)?|conclusion)\s*:?[.]?$/iu;
const SIGNED_JUDGMENT_TAIL = /^(?:signed|dated)\s+at\s+.+,\s+(?:this\s+)?\d{1,2}(?:st|nd|rd|th)?\s+day\s+of\b/iu;
const OPINION_BYLINE = /(?:\((?:concurring|dissenting|separate)\s+reasons?\)|^(?:concurring|dissenting|separate)\s+reasons?\b|^the following (?:are|is) the reasons (?:delivered|given) by\s*:?$)/iu;
const JUDICIAL_SIGNATURE_LINE = /^(?:[“"][\p{L}\p{M}.'’ -]{2,80}[”"]|(?:c\.?\s*j|j)(?:\.?\s*a)?\.?)$/iu;
const JUDICIAL_SIGNATURE_SEPARATOR = /^[_\p{Pd}]{3,}$/u;

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
  const signature = trailingJudicialSignature(text);
  let end = signature?.start ?? text.length;
  const lines = [...text.matchAll(/[^\r\n]+/gu)];
  if (signature) {
    const signatureLine = lines.findIndex(({ index }) => index === signature.start);
    for (let prior = signatureLine - 1; prior >= 0; prior -= 1) {
      const line = lines[prior][0].trim();
      if (!JUDICIAL_SIGNATURE_LINE.test(line) && !JUDICIAL_SIGNATURE_SEPARATOR.test(line)) break;
      end = Math.min(end, lines[prior].index!);
    }
  }
  for (const [index, line] of lines.entries()) {
    if (line.index && (BOUNDARY_HEADING.test(line[0].trim()) || SIGNED_JUDGMENT_TAIL.test(line[0].trim()))) {
      end = Math.min(end, line.index);
    }
    if (line.index && OPINION_BYLINE.test(line[0].trim())) {
      let tailStart = line.index;
      for (let prior = index - 1; prior >= 0 && JUDICIAL_SIGNATURE_LINE.test(lines[prior][0].trim()); prior -= 1) {
        tailStart = lines[prior].index!;
      }
      end = Math.min(end, tailStart);
    }
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
      qualified_joiners: [],
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
      if (linked.has(opinionId)) errors.push(`${linkPath}: participant has more than one relationship to ${opinionId}`);
      linked.add(opinionId);
      const linkEvidence = collectPersonEvidence(name, link.evidence, `${linkPath}.evidence`, material, errors, grounding, evidence);
      if (!linkEvidence) continue;
      links.push({ opinion_id: opinionId, relation, evidence: linkEvidence });
      const opinion = resolvedOpinions.find((candidate) => candidate.opinion_id === opinionId);
      if (opinion) {
        if (relation === "wrote") opinion.writers.push(name);
        else if (relation === "joined") opinion.full_joiners.push(name);
        else opinion.qualified_joiners.push({ name, evidence: linkEvidence });
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
    const requiredText = material.text.slice(required.start, required.end);
    const requiredEnd = required.start + paragraphCoverageEnd(requiredText);
    const owners = resolvedOpinions.filter(({ boundary }) => required.start >= boundary.start && requiredEnd <= boundary.end);
    if (owners.length === 1) covered += 1;
    else {
      const lines = material.source_lines
        .filter((line) => line.end > required.start && line.start < required.end)
        .map((line) => line.line);
      const where = lines.length ? ` (line${lines.length === 1 ? "" : "s"} ${lines.join("-")})` : "";
      errors.push(`structure coverage: substantive ${required.label}${where} is inside ${owners.length} opinion boundaries`);
    }
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

const STRICT_DECISION_CITATION = /^(?:19|20)\d{2}\s+(?:[A-Z][A-Z0-9.-]{1,15}|CanLII)\s+\d+(?:\s*\([A-Z][A-Z0-9. -]*\))?$/u;

function sourceLineAt(material: CaseMaterial, offset: number) {
  return material.source_lines.find((line) => offset >= line.start && offset < line.end) ?? null;
}

/**
 * Production-safe citation check. It uses only the decision text, the
 * deterministic detector, the accepted opinion boundaries, and this draft.
 * Gold annotations are intentionally neither accepted nor consulted.
 */
export function noOracleCitationCheck(
  material: CaseMaterial,
  structure: CompiledStructure,
  analysis: CompiledAnalysis,
): AnalysisCompilation["no_oracle_citation_check"] {
  const insideOpinion = (start: number, end: number) => structure.opinions.some((opinion) =>
    start >= opinion.boundary.start && end <= opinion.boundary.end
  );
  const strictOccurrences = material.citation_inventory.occurrences.filter((occurrence) =>
    (insideOpinion(occurrence.start, occurrence.end) || Boolean(
      occurrence.linkedContext && insideOpinion(occurrence.linkedContext.start, occurrence.linkedContext.end)
    )) &&
    STRICT_DECISION_CITATION.test(occurrence.quote.replace(/\s+/gu, " ").trim())
  );
  const strictByAuthority = new Map<string, typeof strictOccurrences>();
  for (const occurrence of strictOccurrences) {
    const values = strictByAuthority.get(occurrence.authority_id) ?? [];
    values.push(occurrence);
    strictByAuthority.set(occurrence.authority_id, values);
  }

  const representedSpans: ResolvedSpan[] = [
    ...analysis.decision_mentions.map(({ identifying_block }) => identifying_block),
    ...analysis.procedural_relationships.flatMap((relationship) => [
      relationship.identifying_block,
      ...relationship.evidence_blocks,
      ...relationship.actions.flatMap(({ evidence_blocks }) => evidence_blocks),
    ]),
    ...analysis.treatments.flatMap((treatment) => [
      treatment.identifying_block,
      ...treatment.evidence_blocks,
      ...treatment.quoted_passages,
    ]),
  ];
  const identifyingSpans = analysis.decision_mentions.map(({ identifying_block }) => identifying_block);
  const overlaps = (start: number, end: number, span: ResolvedSpan) => start < span.end && end > span.start;
  const nearbyIdentification = (start: number, end: number) => {
    const occurrenceLine = sourceLineAt(material, start);
    if (!occurrenceLine) return false;
    return identifyingSpans.some((span) => {
      const spanLine = sourceLineAt(material, span.start);
      return spanLine?.line === occurrenceLine.line &&
        Math.max(0, Math.max(start, span.start) - Math.min(end, span.end)) <= 240;
    });
  };

  const unmatched: AnalysisCompilation["no_oracle_citation_check"]["omissions"] = [];
  let covered = 0;
  for (const [authorityId, candidates] of strictByAuthority) {
    const allOccurrences = material.citation_inventory.occurrences.filter((occurrence) => occurrence.authority_id === authorityId);
    const represented = allOccurrences.some((occurrence) => {
      const context = occurrence.linkedContext;
      return representedSpans.some((span) => overlaps(occurrence.start, occurrence.end, span)) ||
        nearbyIdentification(occurrence.start, occurrence.end) ||
        Boolean(context && (
          representedSpans.some((span) => overlaps(context.start, context.end, span)) ||
          nearbyIdentification(context.start, context.end)
        ));
    });
    if (represented) { covered += 1; continue; }
    const occurrence = candidates[0];
    const line = sourceLineAt(material, occurrence.start);
    if (!line) continue;
    unmatched.push({
      occurrence_id: occurrence.id,
      line: line.line,
      exact_text: occurrence.quote,
      start: occurrence.start,
      end: occurrence.end,
      text_sha256: sha256(occurrence.quote),
    });
  }
  // Distinct citation forms can name one decision. Without an alias oracle,
  // an unmatched form proves an omission only when the draft names no cited
  // decision at all. Otherwise retain it for review without rejecting the draft.
  const omissions = analysis.decision_mentions.length === 0 ? unmatched : [];
  const unresolved = analysis.decision_mentions.length === 0 ? [] : unmatched;
  return { checked: strictByAuthority.size, covered, omissions, unresolved };
}

type VisibleGroundingSpan = {
  evidenceId: string;
  text: string;
  span: ResolvedSpan;
};

function collectProseGrounding(
  path: string,
  prose: string,
  visible: VisibleGroundingSpan[],
  errors: string[],
  copyReceipts: ProseCopyReceipt[],
) {
  for (const error of groundedProseErrors(prose, visible.map(({ evidenceId }) => evidenceId), visible)) {
    const match = /^unmarked copied passage (.+) matches visible evidence ([^;]+);/u.exec(error);
    if (!match) {
      errors.push(`${path}: ${error}`);
      continue;
    }
    const source = visible.find(({ evidenceId }) => evidenceId === match[2]);
    let exactText: unknown;
    try {
      exactText = JSON.parse(match[1]);
    } catch {
      errors.push(`${path}: ${error}`);
      continue;
    }
    if (!source || typeof exactText !== "string") {
      errors.push(`${path}: ${error}`);
      continue;
    }
    copyReceipts.push({
      path,
      exact_text: exactText,
      text_sha256: sha256(exactText),
      source: {
        evidence_id: source.evidenceId,
        start: source.span.start,
        end: source.span.end,
        text_sha256: source.span.text_sha256,
      },
    });
  }
}

export function compileAnalysis(
  raw: unknown,
  _structure: DecisionStructure,
  compiledStructure: CompiledStructure,
  material: CaseMaterial,
  contract: AnalysisContract = "self-check",
): AnalysisCompilation {
  const errors: string[] = [];
  const grounding: GroundingReceipt[] = [];
  const evidence = new Map<string, LegalEvidenceReceipt>();
  const proseCopyReceipts: ProseCopyReceipt[] = [];
  const deterministicQuotes = deterministicQuoteCandidates(material).map((quote) => ({
    ...quote,
    text_sha256: sha256(quote.text),
  }));
  const item = record(raw);
  if (!item) {
    return {
      ok: false,
      errors: ["analysis: expected an object"],
      value: null,
      compiled: null,
      grounding,
      evidence_receipts: [],
      prose_copy_receipts: proseCopyReceipts,
      deterministic_quote_candidates: deterministicQuotes,
      no_oracle_citation_check: { checked: 0, covered: 0, omissions: [], unresolved: [] },
    };
  }
  const opinions = new Map(compiledStructure.opinions.map((value) => [value.opinion_id, value]));
  const deriveOpinion = (blocks: ResolvedSpan[], path: string) => {
    const blockOpinions = blocks.map((block) => {
      const overlaps = compiledStructure.opinions
        .map((opinion) => ({
          opinion,
          characters: Math.max(0, Math.min(block.end, opinion.boundary.end) - Math.max(block.start, opinion.boundary.start)),
        }))
        .filter(({ characters }) => characters > 0)
        .sort((left, right) => right.characters - left.characters);
      if (!overlaps.length || (overlaps[1] && overlaps[0].characters === overlaps[1].characters)) return null;
      return overlaps[0].opinion.opinion_id;
    });
    const ids = unique(blockOpinions.filter((id): id is string => id !== null));
    if (ids.length !== 1 || blockOpinions.some((id) => id === null) || blocks.length === 0) {
      errors.push(`${path}: evidence blocks must identify exactly one judicial opinion`);
      return null;
    }
    return opinions.get(ids[0]) ?? null;
  };
  const mentions: CompiledAnalysis["decision_mentions"] = [];
  const relationships: CompiledAnalysis["procedural_relationships"] = [];
  const treatments: CompiledAnalysis["treatments"] = [];
  const identities = new Map<string, CompiledAnalysis["decision_mentions"][number]>();
  const identityKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const identify = (value: Record<string, unknown>, path: string) => {
    const citedDecision = stringValue(value.cited_decision, `${path}.cited_decision`, errors);
    const identifyingBlock = collectBlock(
      value.identifying_block,
      `${path}.identifying_block`,
      material,
      errors,
      grounding,
      evidence,
    );
    if (!citedDecision || !identifyingBlock) return null;
    const key = identityKey(citedDecision);
    let identity = identities.get(key);
    if (!identity) {
      identity = {
        decision_id: `d${identities.size + 1}`,
        cited_decision: citedDecision,
        identifying_block: identifyingBlock,
      };
      identities.set(key, identity);
      mentions.push(identity);
    }
    return { ...identity, cited_decision: citedDecision, identifying_block: identifyingBlock };
  };

  for (const [index, value] of requiredList(item.decision_mentions, "analysis.decision_mentions", errors).entries()) {
    const path = `analysis.decision_mentions[${index}]`;
    const mention = record(value);
    if (!mention) errors.push(`${path}: expected an object`);
    else identify(mention, path);
  }

  for (const [index, value] of requiredList(item.procedural_relationships, "analysis.procedural_relationships", errors).entries()) {
    const path = `analysis.procedural_relationships[${index}]`;
    const relationship = record(value);
    if (!relationship) { errors.push(`${path}: expected an object`); continue; }
    const identity = identify(relationship, path);
    const description = stringValue(relationship.description, `${path}.description`, errors);
    const evidenceBlocks = collectBlocks(
      relationship.evidence_blocks,
      `${path}.evidence_blocks`,
      material,
      errors,
      grounding,
      evidence,
    );
    const visible = evidenceBlocks.map((span, blockIndex) => ({
      evidenceId: `e${blockIndex + 1}`,
      text: span.exact_text,
      span,
    }));
    collectProseGrounding(`${path}.description`, description, visible, errors, proseCopyReceipts);
    const actions = requiredList(relationship.actions, `${path}.actions`, errors).flatMap((value, actionIndex) => {
      const actionPath = `${path}.actions[${actionIndex}]`;
      const action = record(value);
      if (!action) { errors.push(`${actionPath}: expected an object`); return []; }
      return [{
        action: enumValue(action.action, PROCEDURAL_ACTIONS, `${actionPath}.action`, errors),
        affected_part: action.affected_part === null
          ? null
          : stringValue(action.affected_part, `${actionPath}.affected_part`, errors),
        evidence_blocks: collectBlocks(
          action.evidence_blocks,
          `${actionPath}.evidence_blocks`,
          material,
          errors,
          grounding,
          evidence,
        ),
      }];
    });
    if (identity) relationships.push({
      relationship_id: `r${relationships.length + 1}`,
      ...identity,
      description,
      evidence_blocks: evidenceBlocks,
      actions,
    });
  }

  for (const [index, value] of requiredList(item.treatments, "analysis.treatments", errors).entries()) {
    const path = `analysis.treatments[${index}]`;
    const treatment = record(value);
    if (!treatment) { errors.push(`${path}: expected an object`); continue; }
    const identity = identify(treatment, path);
    const modelOpinionId = contract === "self-check"
      ? idValue(treatment.opinion_id, /^o[1-9][0-9]*$/u, `${path}.opinion_id`, errors)
      : null;
    if (modelOpinionId && !opinions.has(modelOpinionId)) errors.push(`${path}: unknown opinion_id ${modelOpinionId}`);
    const signals = requiredList(treatment.signals, `${path}.signals`, errors).map((signal, signalIndex) =>
      enumValue(signal, TREATMENT_SIGNALS, `${path}.signals[${signalIndex}]`, errors)
    );
    if (!signals.length || unique(signals).length !== signals.length) {
      errors.push(`${path}.signals: signals must be non-empty and unique`);
    }
    const otherSignal = treatment.other_signal === null
      ? null
      : stringValue(treatment.other_signal, `${path}.other_signal`, errors);
    if (signals.includes("other") !== Boolean(otherSignal?.trim())) {
      errors.push(`${path}: other_signal is required only when signals includes other`);
    }
    const proposition = stringValue(treatment.proposition, `${path}.proposition`, errors);
    const treatmentText = stringValue(treatment.treatment, `${path}.treatment`, errors);
    const evidenceBlocks = collectBlocks(
      treatment.evidence_blocks,
      `${path}.evidence_blocks`,
      material,
      errors,
      grounding,
      evidence,
    );
    const opinion = deriveOpinion(evidenceBlocks, `${path}.evidence_blocks`);
    const opinionId = opinion?.opinion_id ?? modelOpinionId ?? "";
    if (contract === "self-check" && opinion && modelOpinionId && opinion.opinion_id !== modelOpinionId) {
      errors.push(`${path}.opinion_id: ${modelOpinionId} conflicts with evidence in ${opinion.opinion_id}`);
    }
    const supportingValues = contract === "self-check"
      ? requiredList(treatment.supporting_passages, `${path}.supporting_passages`, errors)
      : [];
    if (contract === "self-check" && !supportingValues.length) {
      errors.push(`${path}.supporting_passages: at least one supporting passage is required`);
    }
    const supportingPassages = contract === "self-check"
      ? supportingValues
        .flatMap((passage, passageIndex) => {
          const resolved = collectBlockQuotation(
            passage,
            `${path}.supporting_passages[${passageIndex}]`,
            material,
            errors,
            grounding,
            evidence,
            opinion ?? undefined,
            deterministicQuotes,
          );
          return resolved ? [resolved] : [];
        })
      : [];
    const quotedPassages = requiredList(treatment.quoted_passages, `${path}.quoted_passages`, errors)
      .flatMap((passage, passageIndex) => {
        const resolved = collectBlockQuotation(
          passage,
          `${path}.quoted_passages[${passageIndex}]`,
          material,
          errors,
          grounding,
          evidence,
          opinion,
          deterministicQuotes,
        );
        return resolved ? [resolved] : [];
      });
    const visible = [
      ...evidenceBlocks.map((span, blockIndex) => ({ evidenceId: `e${blockIndex + 1}`, text: span.exact_text, span })),
      ...supportingPassages.map((span, passageIndex) => ({ evidenceId: `s${passageIndex + 1}`, text: span.exact_text, span })),
      ...quotedPassages.map((span, passageIndex) => ({ evidenceId: `q${passageIndex + 1}`, text: span.exact_text, span })),
    ];
    for (const [field, prose] of [["proposition", proposition], ["treatment", treatmentText]] as const) {
      collectProseGrounding(`${path}.${field}`, prose, visible, errors, proseCopyReceipts);
    }
    if (identity) treatments.push({
      treatment_id: `t${treatments.length + 1}`,
      ...identity,
      opinion_id: opinionId,
      model_opinion_id: modelOpinionId,
      signals,
      other_signal: otherSignal,
      proposition,
      treatment: treatmentText,
      evidence_blocks: evidenceBlocks,
      supporting_passages: supportingPassages,
      quoted_passages: quotedPassages,
    });
  }

  const compiled: CompiledAnalysis = {
    decision_mentions: mentions,
    procedural_relationships: relationships,
    treatments,
  };
  const citationCheck = noOracleCitationCheck(material, compiledStructure, compiled);
  for (const omission of citationCheck.omissions) {
    errors.push(`analysis.decision_mentions: source block p${omission.line} contains an unmistakable decision citation ${JSON.stringify(omission.exact_text)} that is not represented`);
  }
  return {
    ok: errors.length === 0,
    errors: unique(errors),
    value: item as unknown as DecisionAnalysis,
    compiled,
    grounding,
    evidence_receipts: [...evidence.values()],
    prose_copy_receipts: proseCopyReceipts,
    deterministic_quote_candidates: deterministicQuotes,
    no_oracle_citation_check: citationCheck,
  };
}

export function compileSubmission(
  raw: unknown,
  material: CaseMaterial,
  contract: AnalysisContract = "self-check",
): SubmissionCompilation {
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
  const analysis = compileAnalysis(item.analysis, structure.value, structure.compiled, material, contract);
  return {
    ok: structure.ok && analysis.ok,
    errors: unique([...structure.errors, ...analysis.errors]),
    value: structure.ok && analysis.ok ? item as unknown as CaseTreatmentSubmission : null,
    grounding: [...structure.grounding, ...analysis.grounding],
    structure,
    analysis,
  };
}

/** Compile human-authored reference truth without requiring model self-check fields. */
export function compileReferenceSubmission(raw: unknown, material: CaseMaterial): SubmissionCompilation {
  const compilation = compileSubmission(raw, material, "simple");
  if (!compilation.ok || !compilation.analysis?.compiled) return compilation;
  const analysis = record(record(raw)?.analysis);
  const treatments = list(analysis?.treatments);
  const errors: string[] = [];
  for (const [index, value] of treatments.entries()) {
    const treatment = record(value);
    const opinionId = treatment?.opinion_id;
    const derived = compilation.analysis.compiled.treatments[index]?.opinion_id;
    if (typeof opinionId !== "string" || !/^o[1-9][0-9]*$/u.test(opinionId)) {
      errors.push(`analysis.treatments[${index}].opinion_id: reference opinion_id is required`);
    } else if (opinionId !== derived) {
      errors.push(`analysis.treatments[${index}].opinion_id: ${opinionId} conflicts with evidence in ${derived || "no opinion"}`);
    }
  }
  return errors.length
    ? { ...compilation, ok: false, errors, value: null }
    : compilation;
}

function numberedDecisionPacket(material: CaseMaterial) {
  return [
    "[DECISION]",
    JSON.stringify({ citation: material.citation, name: material.name, date: material.date, dataset: material.dataset }),
    "[COMPLETE DECISION]",
    material.source_lines.map((line) => `[p${line.line}] ${material.text.slice(line.start, line.end)}`).join("\n"),
  ].join("\n\n");
}

const SPAN_INSTRUCTIONS = `Each source block is labelled pN. For structure spans, start_line and end_line are the numeric N values. start_quote must be copied exactly from the start block and end_quote exactly from the end block. They delimit the first and last characters of the span. For a short span in one block, the same exact excerpt may be used for both anchors. Copy spelling and punctuation exactly; block labels are not part of the decision.`;

export const STRUCTURE_INSTRUCTIONS = `Read the complete decision and identify its judicial reasons and votes.

An opinion is an independently reasoned body of judicial reasons. A panel list, headnote, signature, order, correction, disposition-only line, or bare statement such as "I agree" is not a separate opinion. Bound each opinion from its first substantive heading or sentence through its last substantive sentence. Do not include editorial material, counsel lists, signatures, or a bare joinder in an opinion boundary.

List every participating decision-maker. Link a participant to an opinion as wrote, joined, or joined_in_part only when the decision establishes that relationship. For joined_in_part, use the exact passage in which the judge qualifies the agreement; do not summarize its legal scope. Ground every link in a passage that identifies the participant, because a heading such as "Reasons for Judgment" does not by itself identify its writer. Panel membership alone proves neither authorship nor joinder. Use collective_author only when the reasons identify an institutional writer such as "The Court"; otherwise leave it null when no writer is stated. List an expressly nonparticipating judge only in nonparticipants.

result_position describes whether an opinion or participant supports the decision's disposition, opposes it, reaches mixed results, or is genuinely unclear. Agreement by all judges is support for the disposition even if the word "majority" is absent. A judge agreeing only in the result has no opinion link unless the source also identifies reasons that judge adopts.

${SPAN_INSTRUCTIONS}

Return only JSON matching the supplied schema.`;

export const ANALYSIS_INSTRUCTIONS = `Read the complete decision and the supplied judicial-opinion structure. Describe what its judicial opinions say about other adjudicative decisions.

In decision_mentions, list one clear mention of every other decision found anywhere in the document, including quotations, parties' arguments, and procedural descriptions. cited_decision is a short name or citation as printed in the document. identifying_block is the pN block containing that mention. Do not include legislation, secondary sources, or the present decision.

In procedural_relationships, record only decisions from the same litigation. description explains how the earlier decision fits into the litigation. actions records what the present court directly does to it; actions may be empty. Use separate actions when different parts receive different results, and set affected_part to null when an action applies to the whole decision. Reversing a judgment is a procedural action, not precedential overruling.

In treatments, record each legal proposition that a judicial opinion adopts, applies, explains, extends, distinguishes, limits, criticizes, questions, rejects, or otherwise evaluates. proposition states the proposition as the opinion presents it. treatment states succinctly what the opinion does with that proposition and any material limit on its scope. Use separate observations for different opinions, propositions, operations, or material scopes.

A mention alone is not treatment. A party's submission, an unadopted quotation, or another decision's reasoning is not the current opinion's position. evidence_blocks must identify the current judicial opinion's own words adopting or evaluating the proposition.

Each evidence_blocks value is a list of pN block IDs. quoted_passages contains exact words attributed to the cited decision that matter to the treatment. For each quoted passage, give the pN blocks containing it and copy its text verbatim, including visible editorial alterations. It may be empty.

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

Return only JSON matching the supplied schema.`;

export const ANALYSIS_EXAMPLES = `EXAMPLE
{"decision_mentions":[{"cited_decision":"Smith v. Jones, 2023 ABKB 100","identifying_block":"p4"},{"cited_decision":"Brown v. Canada, 2019 SCC 5","identifying_block":"p8"}],"procedural_relationships":[{"cited_decision":"Smith v. Jones, 2023 ABKB 100","identifying_block":"p4","description":"This is the trial judgment under appeal.","evidence_blocks":["p4"],"actions":[{"action":"reversed","affected_part":"the limitation finding","evidence_blocks":["p5"]}]}],"treatments":[{"cited_decision":"Smith v. Jones, 2023 ABKB 100","identifying_block":"p4","opinion_id":"o1","signals":["not_followed"],"other_signal":null,"proposition":"The limitation period began when the plaintiff first suspected an injury.","treatment":"The opinion rejects that proposition because the period begins only with knowledge of the material facts.","evidence_blocks":["p6"],"supporting_passages":[{"block_ids":["p6"],"text":"I respectfully disagree"}],"quoted_passages":[]},{"cited_decision":"Brown v. Canada, 2019 SCC 5","identifying_block":"p8","opinion_id":"o1","signals":["approved","applied"],"other_signal":null,"proposition":"A waiver of statutory rights must be unequivocal.","treatment":"The opinion adopts that requirement and finds no waiver.","evidence_blocks":["p8","p9"],"supporting_passages":[{"block_ids":["p8","p9"],"text":"Brown states that a waiver must be unequivocal. I apply that rule here"}],"quoted_passages":[{"block_ids":["p8"],"text":"A waiver must be unequivocal"}]}]}`;

const SELF_CHECK_ANALYSIS_INSTRUCTIONS = `For each treatment, state which supplied opinion made it. In supporting_passages, copy one or more short verbatim passages containing that opinion's own words that directly support the characterization. These passages are distinct from quoted_passages, which reproduce words attributed to the cited decision.`;

export function analysisExampleText(contract: AnalysisContract) {
  if (contract === "self-check") return ANALYSIS_EXAMPLES;
  const value = JSON.parse(ANALYSIS_EXAMPLES.slice(ANALYSIS_EXAMPLES.indexOf("{") )) as DecisionAnalysis;
  for (const treatment of value.treatments) {
    delete treatment.opinion_id;
    delete treatment.supporting_passages;
  }
  return `EXAMPLE\n${JSON.stringify(value)}`;
}

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
    opinions: structure.opinions.map((opinion) => ({
      opinion_id: opinion.opinion_id,
      start_block: `p${opinion.boundary.start_line}`,
      end_block: `p${opinion.boundary.end_line}`,
      collective_author: opinion.collective_author?.name ?? null,
      result_position: opinion.result_position,
    })),
    participants: structure.participants.map((participant) => ({
      name: participant.name,
      result_position: participant.result_position,
      opinion_links: participant.opinion_links.map(({ opinion_id, relation }) => ({ opinion_id, relation })),
    })),
    nonparticipants: structure.nonparticipants.map(({ name }) => name),
  };
}

export function analysisPrompt(
  material: CaseMaterial,
  structure: DecisionStructure,
  includeExamples = false,
  contract: AnalysisContract = "self-check",
) {
  return [
    ANALYSIS_INSTRUCTIONS,
    contract === "self-check" ? SELF_CHECK_ANALYSIS_INSTRUCTIONS : "",
    includeExamples ? analysisExampleText(contract) : "",
    "[JUDICIAL OPINION STRUCTURE]",
    JSON.stringify(compactStructure(structure)),
    numberedDecisionPacket(material),
  ].filter(Boolean).join("\n\n");
}

export function oneStagePrompt(
  material: CaseMaterial,
  includeStructureHints = false,
  includeAnalysisExamples = false,
  contract: AnalysisContract = "self-check",
) {
  return [
    "Return one structured account of this complete court decision.",
    "[JUDICIAL OPINIONS AND VOTES]",
    STRUCTURE_INSTRUCTIONS.replace(/Return only JSON matching the supplied schema\.$/u, ""),
    "[CITED DECISIONS AND THEIR TREATMENT]",
    ANALYSIS_INSTRUCTIONS.replace(/^Read the complete decision and the supplied judicial-opinion structure\. /u, "Read the complete decision. ")
      .replace(/Return only JSON matching the supplied schema\.$/u, ""),
    contract === "self-check" ? SELF_CHECK_ANALYSIS_INSTRUCTIONS : "",
    includeAnalysisExamples ? analysisExampleText(contract) : "",
    "Return only JSON matching the supplied schema.",
    includeStructureHints ? structureHintPacket(material) : "",
    numberedDecisionPacket(material),
  ].filter(Boolean).join("\n\n");
}

export function opinionSupportBounds(
  structure: CompiledStructure,
  treatment: Pick<CompiledAnalysis["treatments"][number], "opinion_id">,
) {
  const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id);
  const confirmed = unique([
    ...(opinion?.writers ?? []),
    ...(opinion?.full_joiners ?? []),
  ].map(personKey));
  const panelSize = unique(structure.participants.map(({ name }) => personKey(name))).length;
  const collectiveSupporters = Boolean(opinion?.collective_author) && structure.opinions.length === 1
    ? structure.participants.filter((participant) =>
        !participant.result_only &&
        (participant.result_position === opinion?.result_position || participant.result_position === "unclear")
      ).map(({ name }) => personKey(name))
    : [];
  const confirmedCount = unique([...confirmed, ...collectiveSupporters]).length;
  const possibleCount = unique([
    ...confirmed,
    ...collectiveSupporters,
    ...(opinion?.qualified_joiners ?? []).map(({ name }) => personKey(name)),
  ]).length;
  return {
    confirmed_supporters: confirmedCount,
    possible_supporters: possibleCount,
    panel_size: panelSize,
    status: panelSize === 0
      ? "unknown" as const
      : confirmedCount > panelSize / 2
        ? "majority" as const
        : possibleCount <= panelSize / 2
          ? "not_majority" as const
          : "unresolved" as const,
  };
}

export function submissionReviewFlags(compilation: SubmissionCompilation) {
  const groups = new Map<string, Array<{
    decision_id: string;
    treatment_id: string;
    opinion_id: string;
    proposition: string;
    treatment: string;
  }>>();
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
  for (const treatment of compilation.analysis?.compiled?.treatments ?? []) {
    const key = JSON.stringify([
      treatment.opinion_id,
      normalize(treatment.proposition),
      normalize(treatment.treatment),
    ]);
    const group = groups.get(key) ?? [];
    group.push({
      decision_id: treatment.decision_id,
      treatment_id: treatment.treatment_id,
      opinion_id: treatment.opinion_id,
      proposition: treatment.proposition,
      treatment: treatment.treatment,
    });
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const decisionIds = unique(group.map(({ decision_id }) => decision_id));
    if (decisionIds.length < 2) return [];
    return [{
      kind: "shared_treatment_wording" as const,
      opinion_id: group[0].opinion_id,
      decision_ids: decisionIds,
      treatment_ids: group.map(({ treatment_id }) => treatment_id),
      proposition: group[0].proposition,
      treatment: group[0].treatment,
    }];
  });
}

function opinionLabel(opinion: ResolvedOpinion) {
  if (opinion.writers.length) return opinion.writers.join(" and ");
  return opinion.collective_author ?? "writer not stated";
}

export function semanticView(compilation: SubmissionCompilation, idPrefix = "") {
  if (!compilation.ok || !compilation.structure.compiled || !compilation.analysis?.compiled) return null;
  const structure = compilation.structure.compiled;
  const analysis = compilation.analysis.compiled;
  return {
    procedural_relationships: analysis.procedural_relationships.map((relationship, index) => ({
      relationship_id: `${idPrefix}r${index + 1}`,
      cited_decision: relationship.cited_decision,
      description: relationship.description,
      evidence: relationship.evidence_blocks.map(({ exact_text }) => exact_text),
      actions: relationship.actions.map((action) => ({
        action: action.action,
        affected_part: action.affected_part,
        evidence: action.evidence_blocks.map(({ exact_text }) => exact_text),
      })),
    })),
    treatments: analysis.treatments.map((treatment, index) => {
      const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id)!;
      return {
        treatment_id: `${idPrefix}t${index + 1}`,
        cited_decision: treatment.cited_decision,
        treating_opinion: opinionLabel(opinion),
        signals: treatment.signals,
        other_signal: treatment.other_signal,
        proposition: treatment.proposition,
        treatment: treatment.treatment,
        evidence: treatment.evidence_blocks.map(({ exact_text }) => exact_text),
        quoted_passages: treatment.quoted_passages.map(({ exact_text }) => exact_text),
      };
    }),
  };
}

function anchoredSpanExcerpt(span: AnchoredSpan) {
  return span.start_quote === span.end_quote
    ? span.start_quote
    : `${span.start_quote} … ${span.end_quote}`;
}

/**
 * Semantic-only view of a parsed draft. This deliberately ignores failed
 * locator grounding and redundant reverse-link bookkeeping so those failures
 * do not prevent an independent legal-meaning review.
 */
export function semanticDraftView(compilation: SubmissionCompilation, idPrefix = "") {
  const valid = semanticView(compilation, idPrefix);
  if (valid) return valid;
  if (!compilation.structure.compiled || !compilation.analysis?.compiled) return null;
  const structure = compilation.structure.compiled;
  const analysis = compilation.analysis.compiled;
  return {
    procedural_relationships: analysis.procedural_relationships.map((relationship, index) => ({
      relationship_id: `${idPrefix}r${index + 1}`,
      cited_decision: relationship.cited_decision,
      description: relationship.description,
      evidence: relationship.evidence_blocks.map(({ exact_text }) => exact_text),
      actions: relationship.actions.map((action) => ({
        action: action.action,
        affected_part: action.affected_part,
        evidence: action.evidence_blocks.map(({ exact_text }) => exact_text),
      })),
    })),
    treatments: analysis.treatments.map((treatment, index) => {
      const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id);
      return {
        treatment_id: `${idPrefix}t${index + 1}`,
        cited_decision: treatment.cited_decision,
        treating_opinion: opinion ? opinionLabel(opinion) : "not identified",
        signals: treatment.signals,
        other_signal: treatment.other_signal,
        proposition: treatment.proposition,
        treatment: treatment.treatment,
        evidence: treatment.evidence_blocks.map(({ exact_text }) => exact_text),
        quoted_passages: treatment.quoted_passages.map(({ exact_text }) => exact_text),
      };
    }),
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
          aspects: { type: "array", maxItems: 6, items: { enum: [
            "coverage",
            "attribution",
            "proposition",
            "treatment",
            "scope",
            "evidence",
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
    procedural_relationship_grades: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          reference_relationship_id: { type: "string", pattern: "^gr[1-9][0-9]*$" },
          candidate_relationship_ids: {
            type: "array",
            maxItems: 500,
            items: { type: "string", pattern: "^cr[1-9][0-9]*$" },
          },
          verdict: { enum: ["pass", "minor_error", "major_error"] },
          aspects: { type: "array", maxItems: 6, items: { enum: [
            "coverage", "cited_decision", "description", "actions", "affected_part", "evidence",
          ] } },
          explanation: { type: ["string", "null"], maxLength: 2_000 },
        },
        required: ["reference_relationship_id", "candidate_relationship_ids", "verdict", "aspects", "explanation"],
      },
    },
    extra_candidate_relationships: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_relationship_id: { type: "string", pattern: "^cr[1-9][0-9]*$" },
          severity: { enum: ["minor", "major"] },
          explanation: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        required: ["candidate_relationship_id", "severity", "explanation"],
      },
    },
  },
  required: [
    "treatment_grades",
    "extra_candidate_treatments",
    "procedural_relationship_grades",
    "extra_candidate_relationships",
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
  const relationshipPoints = [
    ...rows("procedural_relationship_grades").map(({ verdict }) => gradePoints(verdict)),
    ...rows("extra_candidate_relationships").map(({ severity }) => gradePoints(severity)),
  ];
  const score = (points: number[]) => ({
    items: points.length,
    earned: points.reduce((total, point) => total + point, 0),
    score: points.length ? points.reduce((total, point) => total + point, 0) / points.length : 1,
  });
  const treatment = score(treatmentPoints);
  const procedural_relationship = score(relationshipPoints);
  const overall = score([...treatmentPoints, ...relationshipPoints]);
  const majorErrors = [
    ...rows("treatment_grades").map(({ verdict }) => verdict),
    ...rows("extra_candidate_treatments").map(({ severity }) => severity),
    ...rows("procedural_relationship_grades").map(({ verdict }) => verdict),
    ...rows("extra_candidate_relationships").map(({ severity }) => severity),
  ].filter((grade) => grade === "major_error" || grade === "major").length;
  return {
    treatment,
    procedural_relationship,
    overall,
    major_errors: majorErrors,
    passed: overall.score >= SEMANTIC_PASS_THRESHOLD && majorErrors === 0,
    passing_threshold: SEMANTIC_PASS_THRESHOLD,
  };
}

export function semanticJudgeResultErrors(
  gold: SubmissionCompilation,
  candidate: SubmissionCompilation,
  value: unknown,
  includeInvalidCandidate = false,
) {
  const reference = semanticView(gold, "g");
  const answer = includeInvalidCandidate
    ? semanticDraftView(candidate, "c")
    : semanticView(candidate, "c");
  const result = record(value);
  if (!reference || !answer || !result) return ["semantic judge result is not an object"];
  const errors: string[] = [];
  const referenceTreatments = new Set(reference.treatments.map(({ treatment_id }) => treatment_id));
  const candidateTreatments = new Set(answer.treatments.map(({ treatment_id }) => treatment_id));
  const referenceRelationships = new Set(reference.procedural_relationships.map(({ relationship_id }) => relationship_id));
  const candidateRelationships = new Set(answer.procedural_relationships.map(({ relationship_id }) => relationship_id));
  const seenReferenceTreatments = new Set<string>();
  const seenCandidateTreatments = new Set<string>();
  const seenReferenceRelationships = new Set<string>();
  const seenCandidateRelationships = new Set<string>();
  const rows = (name: string) => Array.isArray(result[name]) ? result[name] as unknown[] : [];
  for (const name of ["treatment_grades", "extra_candidate_treatments", "procedural_relationship_grades", "extra_candidate_relationships"]) {
    if (!Array.isArray(result[name])) errors.push(`${name}: expected an array`);
  }

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
    if (!["pass", "minor_error", "major_error"].includes(String(verdict))) {
      errors.push(`treatment_grades[${index}]: invalid verdict ${String(verdict)}`);
    }
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
    if (!["minor", "major"].includes(String(grade?.severity))) errors.push(`extra_candidate_treatments[${index}]: invalid severity ${String(grade?.severity)}`);
    if (typeof grade?.explanation !== "string" || !grade.explanation.trim()) errors.push(`extra_candidate_treatments[${index}]: explanation is required`);
  }
  for (const [index, raw] of rows("procedural_relationship_grades").entries()) {
    const grade = record(raw);
    const id = typeof grade?.reference_relationship_id === "string" ? grade.reference_relationship_id : "";
    if (!referenceRelationships.has(id)) errors.push(`procedural_relationship_grades[${index}]: unknown reference relationship ${id}`);
    if (seenReferenceRelationships.has(id)) errors.push(`procedural_relationship_grades[${index}]: duplicate reference relationship ${id}`);
    seenReferenceRelationships.add(id);
    for (const candidateId of list(grade?.candidate_relationship_ids)) {
      if (typeof candidateId !== "string" || !candidateRelationships.has(candidateId)) {
        errors.push(`procedural_relationship_grades[${index}]: unknown candidate relationship ${String(candidateId)}`);
      } else seenCandidateRelationships.add(candidateId);
    }
    const verdict = grade?.verdict;
    const aspects = list(grade?.aspects);
    const explanation = grade?.explanation;
    if (!["pass", "minor_error", "major_error"].includes(String(verdict))) {
      errors.push(`procedural_relationship_grades[${index}]: invalid verdict ${String(verdict)}`);
    }
    if (verdict === "pass" && (aspects.length || explanation !== null)) {
      errors.push(`procedural_relationship_grades[${index}]: pass requires no aspects and a null explanation`);
    }
    if (verdict !== "pass" && (!aspects.length || typeof explanation !== "string" || !explanation.trim())) {
      errors.push(`procedural_relationship_grades[${index}]: an error requires aspects and an explanation`);
    }
  }
  for (const [index, raw] of rows("extra_candidate_relationships").entries()) {
    const grade = record(raw);
    const id = typeof grade?.candidate_relationship_id === "string" ? grade.candidate_relationship_id : "";
    if (!candidateRelationships.has(id)) errors.push(`extra_candidate_relationships[${index}]: unknown candidate relationship ${id}`);
    if (seenCandidateRelationships.has(id)) errors.push(`extra_candidate_relationships[${index}]: candidate relationship ${id} is already matched`);
    seenCandidateRelationships.add(id);
    if (!["minor", "major"].includes(String(grade?.severity))) errors.push(`extra_candidate_relationships[${index}]: invalid severity ${String(grade?.severity)}`);
    if (typeof grade?.explanation !== "string" || !grade.explanation.trim()) errors.push(`extra_candidate_relationships[${index}]: explanation is required`);
  }

  for (const id of referenceTreatments) if (!seenReferenceTreatments.has(id)) errors.push(`missing grade for ${id}`);
  for (const id of candidateTreatments) if (!seenCandidateTreatments.has(id)) errors.push(`candidate treatment ${id} is neither matched nor extra`);
  for (const id of referenceRelationships) if (!seenReferenceRelationships.has(id)) errors.push(`missing grade for ${id}`);
  for (const id of candidateRelationships) if (!seenCandidateRelationships.has(id)) errors.push(`candidate relationship ${id} is neither matched nor extra`);
  return errors;
}

export function semanticJudgePrompt(
  gold: SubmissionCompilation,
  candidate: SubmissionCompilation,
  includeInvalidCandidate = false,
) {
  const reference = semanticView(gold, "g");
  const answer = includeInvalidCandidate
    ? semanticDraftView(candidate, "c")
    : semanticView(candidate, "c");
  if (!reference || !answer) throw new Error("semantic judgment requires two valid compiled submissions");
  return `Assess the legal accuracy of the candidate's account of how the current decision treats cited decisions. Use the reference answer as the standard.

For each treatment, assess whether the candidate identifies the cited decision, treating opinion, proposition, treatment, material scope, and supporting evidence accurately. Flag a candidate that presents a party's submission, a quotation, or another decision's reasoning as the current opinion's position unless the opinion adopts it. For each procedural relationship, assess how the cited decision fits into the litigation, what the present court did to it, and which parts were affected.

Equivalent wording and different divisions of the explanation are acceptable when every legal point is preserved.

Return one grade for every reference treatment and procedural relationship. List the candidate IDs that collectively express the same legal point; use an empty array when it is missing. List every unmatched candidate item in the corresponding extra-candidate array.

pass means the item is substantively accurate. minor_error means a localized imprecision that does not change the legal operation, proposition, material scope, opinion attribution, procedural action, or affected part. major_error means an omission or invention of a substantive item, attribution to the wrong opinion or speaker, a wrong proposition or treatment direction, a materially wrong scope, a wrong procedural action or affected part, or evidence that does not support the characterization. A signal mismatch is major when it changes the legal operation and minor when the prose remains accurate and the difference is only a less precise compatible label. For a pass, return no aspects and a null explanation; otherwise identify the affected aspects and explain the error concisely.

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
    "associate", "justice", "judge", "prothonotary", "master", "registrar",
    "j", "ja", "cj", "cja", "jj",
  ].includes(token) && !/^\p{L}$/u.test(token))
  .join(" ");

function sameJudicialName(left: string, right: string) {
  const leftTokens = judicialNameKey(left).split(" ").filter(Boolean);
  const rightTokens = judicialNameKey(right).split(" ").filter(Boolean);
  if (leftTokens.join(" ") === rightTokens.join(" ")) return true;
  return (leftTokens.length === 1 && rightTokens.includes(leftTokens[0])) ||
    (rightTokens.length === 1 && leftTokens.includes(rightTokens[0]));
}

function sameJudicialNames(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  return left.every((name) => {
    const index = remaining.findIndex((candidate) => sameJudicialName(name, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function sameJudicialVotes(
  left: Array<{ name: string; result_position: string }>,
  right: Array<{ name: string; result_position: string }>,
) {
  if (left.length !== right.length) return false;
  const remaining = [...right];
  return left.every((vote) => {
    const index = remaining.findIndex((candidate) =>
      vote.result_position === candidate.result_position && sameJudicialName(vote.name, candidate.name));
    if (index < 0) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function categoryScore(categories: Record<string, boolean>) {
  const values = Object.values(categories);
  const passed = values.filter(Boolean).length;
  return { passed, total: values.length, score: values.length ? passed / values.length : 0 };
}

function boundaryDecorationLine(text: string) {
  const content = text.trim();
  if (!content || /^[\p{P}\p{S}]+$/u.test(content) || /^\[\d+\]$/u.test(content)) return true;
  const unwrapped = content
    .replace(/^(?:\/{2}|\*{1,3}|_+)\s*/u, "")
    .replace(/\s*(?:\/{2}|\*{1,3}|_+)$/u, "")
    .trim();
  return BOUNDARY_HEADING.test(unwrapped) || OPINION_BYLINE.test(unwrapped) ||
    /^(?:[a-z]|\d+)[.)]\s*(?:introduction|background|analysis|reasons?|order|conclusion|disposition)\b/iu.test(unwrapped) ||
    /^the (?:judgment|reasons?) of .{1,180} (?:was|were) delivered by\s*:?$/iu.test(unwrapped) ||
    /^[\p{L}\p{M}.,'\u2019 -]{2,80}\s+(?:c\.?\s*j\.?|j\.?\s*a?\.?|prothonotary|master|registrar)(?:\s*\((?:concurring|dissenting|separate)(?:\s+reasons?)?\))?\s*(?::|--?)?$/iu.test(unwrapped);
}

function recognizedBoundaryHeading(text: string) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  const signature = trailingJudicialSignature(text);
  if (signature) lines.pop();
  return lines.length === 0 || lines.every(boundaryDecorationLine);
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
    return /^\s*(?:(?:summary of )?(?:orders?|dispositions?)\s*:?[.]?\s*)?(?:\[\d+\]\s*)?$/iu.test(material.text.slice(rangeStart, span.start)) &&
      /^\s*$/u.test(material.text.slice(span.end, rangeEnd));
  });
  return insideDisposition(contentStart, contentEnd) || recognizedBoundaryHeading(content) ||
    [...raw.matchAll(/[^\r\n]+/gu)].every((line) => {
      const lineContent = line[0].trim();
      if (boundaryDecorationLine(lineContent)) return true;
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
      sameJudicialNames(expected.writers, actual.writers) &&
      (expected.collective_author === actual.collective_author ||
        !!expected.collective_author && !!actual.collective_author && sameJudicialName(expected.collective_author, actual.collective_author))
    ),
    full_joiners_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      sameJudicialNames(expected.full_joiners, actual.full_joiners)
    ),
    qualified_agreements_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) =>
      sameJudicialNames(expected.qualified_joiners.map(({ name }) => name), actual.qualified_joiners.map(({ name }) => name))
    ),
    opinion_results_exact: matches.length === gold.compiled.opinions.length && matches.every(({ expected, actual }) => expected.result_position === actual.result_position),
    participant_votes_exact: sameJudicialVotes(gold.compiled.participants, candidate.compiled.participants),
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
