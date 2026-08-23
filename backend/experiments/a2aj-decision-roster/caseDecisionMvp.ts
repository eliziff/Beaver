import { citationLookupKey, citationsInText } from "../../src/lib/citationKey";
import { groundedProseIntegrityErrors, markedQuoteSpans, quoteRepairSuggestion } from "../../src/lib/chat/quoteRepair";
import { footnoteReferenceContext, type CaseTargetOccurrence } from "./caseTargetMvp";
import type { ModelSourceLine } from "./caseTargetMvpReduced";

export const CASE_DECISION_MVP_VERSION = "a2aj-case-decision-extraction-v3";

export type SourceLineRef = { start_line: number; end_line: number };
export type PersonEvidence = { name: string; evidence_lines: SourceLineRef };
export type ResultPosition = "supports_disposition" | "opposes_disposition" | "mixed" | "unclear";

export type DecisionCitationOccurrence = CaseTargetOccurrence & { authority_id: string; citation_key: string };
export type DecisionCitationAuthority = { id: string; citation_key: string; display_citations: string[]; occurrence_ids: string[]; document_id: number | null };
export type DecisionCitationInventory = { authorities: DecisionCitationAuthority[]; occurrences: DecisionCitationOccurrence[] };

export type DecisionStructure = {
  disposition_evidence: SourceLineRef[];
  opinions: Array<{
    boundary: SourceLineRef;
    authorship:
      | { kind: "named"; writers: PersonEvidence[] }
      | { kind: "collective"; name: string; evidence_lines: SourceLineRef }
      | { kind: "unstated" };
    result_position: ResultPosition;
    result_evidence: SourceLineRef | null;
    full_joiners: PersonEvidence[];
  }>;
  other_panel_members: Array<{
    name: string;
    panel_evidence: SourceLineRef;
    relationship: "agrees_in_result_only" | "participation_only";
    result_position: ResultPosition;
    relationship_evidence: SourceLineRef | null;
  }>;
  nonparticipants: PersonEvidence[];
};

export type TreatmentOperation = "explained" | "followed" | "approved" | "applied" | "distinguished" | "limited" | "criticized" | "not_followed" | "questioned" | "overruled" | "other";
export type DecisionReference = {
  reference_id: string;
  detected_occurrence_id: string | null;
  reference_status: "decision_reference" | "not_decision_reference" | "unclear";
  exact_reference: string;
  evidence: SourceLineRef;
  text_source: "current_decision_words" | "quoted_source" | "document_metadata" | "unclear";
  proposition_attributed_to: "current_opinion" | "party_or_counsel" | "decision_under_review" | "cited_or_quoted_source" | "none" | "unclear";
};
export type DecisionQuotedPassage = {
  quote_id: string;
  reference_ids: string[];
  exact_quote: string;
  evidence: SourceLineRef;
};

export type DecisionAnalysis = {
  issues: Array<{
    question: string;
    answers: Array<{
      answer: string;
      positions: Array<{ opinion_number: number; answer_evidence: SourceLineRef[]; issue_only_joiners: PersonEvidence[] }>;
    }>;
  }>;
  references: DecisionReference[];
  quoted_passages: DecisionQuotedPassage[];
  treatments: Array<{
    reference_ids: string[];
    quoted_passage_ids: string[];
    issue_number: number;
    containing_opinion_number: number;
    operation: TreatmentOperation;
    proposition: string;
    explanation: string;
    evidence: SourceLineRef;
    other_operation: string | null;
  }>;
  procedural_history: Array<{
    reference_ids: string[];
    containing_opinion_number: number | null;
    relationship: "affirmed" | "reversed" | "varied" | "quashed" | "remanded" | "leave_granted" | "leave_refused";
    evidence: SourceLineRef;
  }>;
};

export type CaseDecisionSubmission = { structure: DecisionStructure; analysis: DecisionAnalysis };
export type CaseDecisionStructureSubmission = DecisionStructure;
export type CaseDecisionTreatmentSubmission = DecisionAnalysis;

const lineRefSchema = {
  type: "object", additionalProperties: false,
  properties: { start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
  required: ["start_line", "end_line"],
} as const;
const personSchema = {
  type: "object", additionalProperties: false,
  properties: { name: { type: "string", minLength: 2 }, evidence_lines: lineRefSchema },
  required: ["name", "evidence_lines"],
} as const;
const resultPositionSchema = { type: "string", enum: ["supports_disposition", "opposes_disposition", "mixed", "unclear"] } as const;

export const CASE_DECISION_STRUCTURE_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    disposition_evidence: { type: "array", minItems: 0, maxItems: 20, items: lineRefSchema },
    opinions: {
      type: "array", minItems: 1, maxItems: 20,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          boundary: lineRefSchema,
          authorship: { anyOf: [
            { type: "object", additionalProperties: false, properties: { kind: { const: "named" }, writers: { type: "array", minItems: 1, maxItems: 30, items: personSchema } }, required: ["kind", "writers"] },
            { type: "object", additionalProperties: false, properties: { kind: { const: "collective" }, name: { type: "string", minLength: 2 }, evidence_lines: lineRefSchema }, required: ["kind", "name", "evidence_lines"] },
            { type: "object", additionalProperties: false, properties: { kind: { const: "unstated" } }, required: ["kind"] },
          ] },
          result_position: resultPositionSchema,
          result_evidence: { anyOf: [lineRefSchema, { type: "null" }] },
          full_joiners: { type: "array", minItems: 0, maxItems: 30, items: personSchema },
        },
        required: ["boundary", "authorship", "result_position", "result_evidence", "full_joiners"],
      },
    },
    other_panel_members: {
      type: "array", minItems: 0, maxItems: 30,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 2 }, panel_evidence: lineRefSchema,
          relationship: { enum: ["agrees_in_result_only", "participation_only"] },
          result_position: resultPositionSchema,
          relationship_evidence: { anyOf: [lineRefSchema, { type: "null" }] },
        },
        required: ["name", "panel_evidence", "relationship", "result_position", "relationship_evidence"],
      },
    },
    nonparticipants: { type: "array", minItems: 0, maxItems: 30, items: personSchema },
  },
  required: ["disposition_evidence", "opinions", "other_panel_members", "nonparticipants"],
} as const;

const localReferenceId = { type: "string", pattern: "^r[1-9][0-9]*$" } as const;
const localQuoteId = { type: "string", pattern: "^q[1-9][0-9]*$" } as const;

function treatmentSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      reference_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: localReferenceId },
      quoted_passage_ids: { type: "array", minItems: 0, maxItems: 20, uniqueItems: true, items: localQuoteId },
      issue_number: { type: "integer", minimum: 1 }, containing_opinion_number: { type: "integer", minimum: 1 },
      operation: { enum: ["explained", "followed", "approved", "applied", "distinguished", "limited", "criticized", "not_followed", "questioned", "overruled", "other"] },
      proposition: { type: "string", minLength: 1 },
      explanation: { type: "string", minLength: 1 },
      evidence: lineRefSchema,
      other_operation: { type: ["string", "null"] },
    },
    required: ["reference_ids", "quoted_passage_ids", "issue_number", "containing_opinion_number", "operation", "proposition", "explanation", "evidence", "other_operation"],
  };
}

function detectedOccurrenceIdSchema(ids: string[]) {
  return ids.length
    ? { anyOf: [{ type: "string", enum: ids }, { type: "null" }] }
    : { type: "null" };
}

function bindLineMaximum(schema: any, sourceLineCount: number) {
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node.properties ?? {}) as Array<[string, any]>) {
      if (name === "start_line" || name === "end_line") child.maximum = sourceLineCount;
      visit(child);
    }
    if (node.items) visit(node.items);
    for (const branch of node.anyOf ?? []) visit(branch);
  };
  visit(schema);
  return schema;
}

export function caseDecisionStructureOutputSchema(sourceLineCount: number) {
  if (!Number.isSafeInteger(sourceLineCount) || sourceLineCount < 1) throw new Error("structure schema requires a positive source line count");
  return bindLineMaximum(structuredClone(CASE_DECISION_STRUCTURE_JSON_SCHEMA), sourceLineCount);
}

export function caseDecisionTreatmentOutputSchema(structure: DecisionStructure, inventory: DecisionCitationInventory, sourceLineCount: number) {
  if (!structure.opinions.length) throw new Error("analysis schema requires at least one opinion");
  const detectedIds = inventory.occurrences.map(({ id }) => id);
  const schema: any = {
    type: "object", additionalProperties: false,
    properties: {
      issues: {
        type: "array", minItems: 0, maxItems: 40,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            question: { type: "string", minLength: 8 },
            answers: {
              type: "array", minItems: 1, maxItems: 20,
              items: {
                type: "object", additionalProperties: false,
                properties: {
                  answer: { type: "string", minLength: 1 },
                  positions: {
                    type: "array", minItems: 1, maxItems: 20,
                    items: {
                      type: "object", additionalProperties: false,
                      properties: {
                        opinion_number: { type: "integer", minimum: 1, maximum: structure.opinions.length },
                        answer_evidence: { type: "array", minItems: 1, maxItems: 20, items: lineRefSchema },
                        issue_only_joiners: { type: "array", minItems: 0, maxItems: 30, items: personSchema },
                      },
                      required: ["opinion_number", "answer_evidence", "issue_only_joiners"],
                    },
                  },
                },
                required: ["answer", "positions"],
              },
            },
          },
          required: ["question", "answers"],
        },
      },
      references: {
        type: "array", minItems: detectedIds.length, maxItems: 500,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            reference_id: localReferenceId,
            detected_occurrence_id: detectedOccurrenceIdSchema(detectedIds),
            reference_status: { enum: ["decision_reference", "not_decision_reference", "unclear"] },
            exact_reference: { type: "string", minLength: 1, maxLength: 500 },
            evidence: lineRefSchema,
            text_source: { enum: ["current_decision_words", "quoted_source", "document_metadata", "unclear"] },
            proposition_attributed_to: { enum: ["current_opinion", "party_or_counsel", "decision_under_review", "cited_or_quoted_source", "none", "unclear"] },
          },
          required: ["reference_id", "detected_occurrence_id", "reference_status", "exact_reference", "evidence", "text_source", "proposition_attributed_to"],
        },
      },
      quoted_passages: {
        type: "array", minItems: 0, maxItems: 200,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            quote_id: localQuoteId,
            reference_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: localReferenceId },
            exact_quote: { type: "string", minLength: 1, maxLength: 8_000 },
            evidence: lineRefSchema,
          },
          required: ["quote_id", "reference_ids", "exact_quote", "evidence"],
        },
      },
      treatments: { type: "array", minItems: 0, maxItems: 500, items: treatmentSchema() },
      procedural_history: {
        type: "array", minItems: 0, maxItems: 100,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            reference_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: localReferenceId },
            containing_opinion_number: { anyOf: [{ type: "integer", minimum: 1, maximum: structure.opinions.length }, { type: "null" }] },
            relationship: { enum: ["affirmed", "reversed", "varied", "quashed", "remanded", "leave_granted", "leave_refused"] },
            evidence: lineRefSchema,
          },
          required: ["reference_ids", "containing_opinion_number", "relationship", "evidence"],
        },
      },
    },
    required: ["issues", "references", "quoted_passages", "treatments", "procedural_history"],
  };
  return bindLineMaximum(schema, sourceLineCount);
}

export function caseDecisionOutputSchema(inventory: DecisionCitationInventory, sourceLineCount: number) {
  const analysis = caseDecisionTreatmentOutputSchema({
    disposition_evidence: [],
    opinions: Array.from({ length: 20 }, () => ({ boundary: { start_line: 1, end_line: 1 }, authorship: { kind: "unstated" as const }, result_position: "unclear" as const, result_evidence: null, full_joiners: [] })),
    other_panel_members: [], nonparticipants: [],
  }, inventory, sourceLineCount);
  return bindLineMaximum({
    type: "object", additionalProperties: false,
    properties: { structure: structuredClone(CASE_DECISION_STRUCTURE_JSON_SCHEMA), analysis },
    required: ["structure", "analysis"],
  }, sourceLineCount);
}

export function mergeCaseDecisionStages(structure: DecisionStructure, analysis: DecisionAnalysis) {
  return { submission: { structure, analysis } satisfies CaseDecisionSubmission, errors: [] as string[] };
}

function isDecisionCitationSurface(value: string) {
  if (!value || /[\r\n]/u.test(value)) return false;
  return !/^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/iu.test(value.trim());
}

/** Detect every explicit citation once and group exact parallel surfaces conservatively. */
export function decisionCitationInventory(
  sourceText: string,
  currentCitation: string,
  substantiveBodyEnd = sourceText.length,
  options: { extendedUsFallback?: boolean } = {},
): DecisionCitationInventory {
  const currentKey = citationLookupKey(currentCitation);
  const groups = new Map<string, { id: string; displays: string[]; occurrences: DecisionCitationOccurrence[] }>();
  const occurrences: DecisionCitationOccurrence[] = [];
  let previousMatch: ReturnType<typeof citationsInText>[number] | null = null;
  let previousGroup: { id: string; displays: string[]; occurrences: DecisionCitationOccurrence[] } | null = null;
  for (const match of citationsInText(sourceText, options)) {
    if (!isDecisionCitationSurface(match.text)) { previousMatch = null; previousGroup = null; continue; }
    const surfaceKey = citationLookupKey(match.text);
    if (!surfaceKey || surfaceKey === currentKey) { previousMatch = null; previousGroup = null; continue; }
    const parallel = previousMatch !== null && /^\s*,\s*$/u.test(sourceText.slice(previousMatch.end, match.start));
    const citationKey: string = parallel && previousGroup ? previousGroup.occurrences[0].citation_key : surfaceKey;
    let group: { id: string; displays: string[]; occurrences: DecisionCitationOccurrence[] } | null =
      parallel ? previousGroup : groups.get(citationKey) ?? null;
    if (!group) { group = { id: `a${groups.size + 1}`, displays: [], occurrences: [] }; groups.set(citationKey, group); }
    const occurrence: DecisionCitationOccurrence = {
      id: `c${occurrences.length + 1}`, kind: "citation", quote: match.text, start: match.start, end: match.end,
      linkedContext: footnoteReferenceContext(sourceText, match.start, substantiveBodyEnd) ?? (parallel ? previousGroup?.occurrences.at(-1)?.linkedContext ?? null : null),
      citationKey, authority_id: group.id, citation_key: citationKey,
    };
    if (!group.displays.includes(match.text)) group.displays.push(match.text);
    group.occurrences.push(occurrence); occurrences.push(occurrence); previousMatch = match; previousGroup = group;
  }
  return { occurrences, authorities: [...groups.entries()].map(([citationKey, group]) => ({ id: group.id, citation_key: citationKey, display_citations: group.displays, occurrence_ids: group.occurrences.map(({ id }) => id), document_id: null })) };
}

function resolveLineRange(ref: SourceLineRef, sourceLines: ModelSourceLine[], path: string, errors: string[]) {
  if (!Number.isInteger(ref?.start_line) || !Number.isInteger(ref?.end_line) || ref.start_line < 1 || ref.end_line < ref.start_line || ref.end_line > sourceLines.length) {
    errors.push(`${path}: invalid source-line range`); return null;
  }
  return { start: sourceLines[ref.start_line - 1].start, end: sourceLines[ref.end_line - 1].end };
}

function exactSpans(text: string, exact: string, range: { start: number; end: number }) {
  const matches: Array<{ start: number; end: number }> = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const start = text.indexOf(exact, cursor);
    if (start < 0 || start + exact.length > range.end) break;
    matches.push({ start, end: start + exact.length });
    cursor = start + Math.max(1, exact.length);
  }
  return matches;
}

export function compileCaseDecisionSubmission(args: {
  submission: CaseDecisionSubmission;
  sourceText: string;
  sourceLines: ModelSourceLine[];
  inventory: DecisionCitationInventory;
  coverageLineNumbers?: readonly number[];
}) {
  const errors: string[] = [];
  const { structure, analysis } = args.submission;
  if (!structure || !analysis) return { ok: false, errors: ["submission requires structure and analysis"] };
  structure.disposition_evidence.forEach((ref, index) => resolveLineRange(ref, args.sourceLines, `structure.disposition_evidence[${index}]`, errors));
  const opinionSpans = structure.opinions.map((opinion, index) => resolveLineRange(opinion.boundary, args.sourceLines, `structure.opinions[${index}].boundary`, errors));
  for (let index = 1; index < structure.opinions.length; index += 1) if (structure.opinions[index - 1].boundary.end_line >= structure.opinions[index].boundary.start_line) errors.push(`structure.opinions[${index}] overlaps or is out of source order`);
  for (const line of args.coverageLineNumbers ?? []) if (!structure.opinions.some(({ boundary }) => line >= boundary.start_line && line <= boundary.end_line)) errors.push(`substantive source line ${line} is outside every opinion`);

  const participantNames = new Set<string>();
  const personKey = (name: string) => name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  structure.opinions.forEach((opinion, index) => {
    const authors = opinion.authorship.kind === "named" ? opinion.authorship.writers : [];
    const authorKeys = new Set(authors.map(({ name }) => personKey(name)));
    for (const person of [...authors, ...opinion.full_joiners]) {
      const key = personKey(person.name); if (!key) errors.push(`structure.opinions[${index}]: empty judicial name`);
      participantNames.add(key); resolveLineRange(person.evidence_lines, args.sourceLines, `structure.opinions[${index}] evidence`, errors);
    }
    for (const joiner of opinion.full_joiners) if (authorKeys.has(personKey(joiner.name))) errors.push(`structure.opinions[${index}] lists ${joiner.name} as both writer and joiner`);
    if (opinion.authorship.kind === "collective") resolveLineRange(opinion.authorship.evidence_lines, args.sourceLines, `structure.opinions[${index}].authorship`, errors);
    if (opinion.result_evidence) resolveLineRange(opinion.result_evidence, args.sourceLines, `structure.opinions[${index}].result_evidence`, errors);
  });
  for (const [index, person] of structure.other_panel_members.entries()) {
    const key = personKey(person.name);
    if (participantNames.has(key)) errors.push(`structure.other_panel_members[${index}] duplicates an opinion writer or joiner`);
    participantNames.add(key); resolveLineRange(person.panel_evidence, args.sourceLines, `structure.other_panel_members[${index}].panel_evidence`, errors);
    if (person.relationship_evidence) resolveLineRange(person.relationship_evidence, args.sourceLines, `structure.other_panel_members[${index}].relationship_evidence`, errors);
  }
  const nonparticipantNames = new Set<string>();
  for (const [index, person] of structure.nonparticipants.entries()) {
    const key = personKey(person.name);
    if (participantNames.has(key)) errors.push(`structure.nonparticipants[${index}] duplicates a participating judge`);
    if (nonparticipantNames.has(key)) errors.push(`structure.nonparticipants duplicates ${person.name}`);
    nonparticipantNames.add(key);
    resolveLineRange(person.evidence_lines, args.sourceLines, `structure.nonparticipants[${index}].evidence_lines`, errors);
  }

  const detectedById = new Map(args.inventory.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const usedDetectedIds = new Set<string>();
  const referenceById = new Map<string, DecisionReference>();
  const referenceReceipts: Array<Record<string, unknown>> = [];
  for (const [index, reference] of (analysis.references ?? []).entries()) {
    const path = `analysis.references[${index}]`;
    if (referenceById.has(reference.reference_id)) errors.push(`${path}: duplicate reference_id ${reference.reference_id}`);
    referenceById.set(reference.reference_id, reference);
    const evidence = resolveLineRange(reference.evidence, args.sourceLines, `${path}.evidence`, errors);
    const evidenceText = evidence ? args.sourceText.slice(evidence.start, evidence.end) : "";
    const matches = evidence ? exactSpans(args.sourceText, reference.exact_reference, evidence) : [];
    if (!matches.length) errors.push(`${path}: exact_reference does not occur verbatim inside its evidence lines${
      quoteRepairSuggestion(reference.exact_reference, [evidenceText]) ? `; ${quoteRepairSuggestion(reference.exact_reference, [evidenceText])}` : ""
    }`);
    const detected = reference.detected_occurrence_id === null ? null : detectedById.get(reference.detected_occurrence_id);
    if (reference.detected_occurrence_id !== null && !detected) errors.push(`${path}: unknown detected_occurrence_id ${reference.detected_occurrence_id}`);
    if (detected) {
      if (usedDetectedIds.has(detected.id)) errors.push(`${path}: duplicate detected_occurrence_id ${detected.id}`);
      usedDetectedIds.add(detected.id);
      if (evidence && (detected.start < evidence.start || detected.end > evidence.end)) errors.push(`${path}: detected occurrence is outside its evidence lines`);
      if (!reference.exact_reference.includes(detected.quote)) errors.push(`${path}: exact_reference must include the detected citation text ${JSON.stringify(detected.quote)}`);
    } else if (evidence && args.inventory.occurrences.some((occurrence) =>
      occurrence.start >= evidence.start && occurrence.end <= evidence.end && reference.exact_reference.includes(occurrence.quote)
    )) errors.push(`${path}: reference overlaps a supplied detector candidate but detected_occurrence_id is null`);
    referenceReceipts.push({
      reference_id: reference.reference_id,
      detected_occurrence_id: reference.detected_occurrence_id,
      exact_reference: reference.exact_reference,
      evidence: evidence ? { ...evidence, exact_text: evidenceText } : null,
      source_matches: matches,
    });
  }
  for (const id of detectedById.keys()) if (!usedDetectedIds.has(id)) errors.push(`analysis.references is missing detector candidate ${id}`);

  const deterministicQuotes = markedQuoteSpans(args.sourceText).map((quote, index) => ({
    quote_id: `dq${index + 1}`,
    exact_quote: quote.text,
    start: quote.start,
    end: quote.end,
  }));
  const quoteById = new Map<string, DecisionQuotedPassage>();
  const quoteReceipts: Array<Record<string, unknown>> = [];
  const validateReferenceIds = (ids: string[], path: string) => {
    if (!ids.length || new Set(ids).size !== ids.length) errors.push(`${path}: reference_ids must be non-empty and unique`);
    for (const id of ids) {
      const reference = referenceById.get(id);
      if (!reference) errors.push(`${path}: unknown reference_id ${id}`);
      else if (reference.reference_status !== "decision_reference") errors.push(`${path}: ${id} is not established as a decision reference`);
    }
  };
  for (const [index, quote] of (analysis.quoted_passages ?? []).entries()) {
    const path = `analysis.quoted_passages[${index}]`;
    if (quoteById.has(quote.quote_id)) errors.push(`${path}: duplicate quote_id ${quote.quote_id}`);
    quoteById.set(quote.quote_id, quote);
    validateReferenceIds(quote.reference_ids, path);
    const evidence = resolveLineRange(quote.evidence, args.sourceLines, `${path}.evidence`, errors);
    const evidenceText = evidence ? args.sourceText.slice(evidence.start, evidence.end) : "";
    const matches = evidence ? exactSpans(args.sourceText, quote.exact_quote, evidence) : [];
    if (!matches.length) errors.push(`${path}: exact_quote does not occur verbatim inside its evidence lines${
      quoteRepairSuggestion(quote.exact_quote, [evidenceText]) ? `; ${quoteRepairSuggestion(quote.exact_quote, [evidenceText])}` : ""
    }`);
    quoteReceipts.push({
      quote_id: quote.quote_id,
      reference_ids: quote.reference_ids,
      exact_quote: quote.exact_quote,
      evidence: evidence ? { ...evidence, exact_text: evidenceText } : null,
      source_matches: matches,
      detector_quote_ids: deterministicQuotes.filter((candidate) => matches.some((match) =>
        match.start >= candidate.start && match.end <= candidate.end
      )).map(({ quote_id }) => quote_id),
    });
  }

  const treatmentReceipts: Array<Record<string, unknown>> = [];
  for (const [index, treatment] of (analysis.treatments ?? []).entries()) {
    const path = `analysis.treatments[${index}]`;
    validateReferenceIds(treatment.reference_ids, path);
    if (!treatment.quoted_passage_ids || new Set(treatment.quoted_passage_ids).size !== treatment.quoted_passage_ids.length) errors.push(`${path}: quoted_passage_ids must be unique`);
    const citedQuotes = (treatment.quoted_passage_ids ?? []).flatMap((id) => {
      const quote = quoteById.get(id);
      if (!quote) { errors.push(`${path}: unknown quote_id ${id}`); return []; }
      if (!quote.reference_ids.some((referenceId) => treatment.reference_ids.includes(referenceId))) errors.push(`${path}: ${id} is attributed to a different reference`);
      return [{ evidenceId: id, text: quote.exact_quote }];
    });
    if (treatment.issue_number < 1 || treatment.issue_number > analysis.issues.length) errors.push(`${path}: unknown issue number`);
    if (treatment.containing_opinion_number < 1 || treatment.containing_opinion_number > structure.opinions.length) errors.push(`${path}: unknown opinion number`);
    if ((treatment.operation === "other") !== Boolean(treatment.other_operation?.trim())) errors.push(`${path}: other_operation must be supplied only for operation=other`);
    const evidence = resolveLineRange(treatment.evidence, args.sourceLines, `${path}.evidence`, errors);
    const opinion = opinionSpans[treatment.containing_opinion_number - 1];
    if (evidence && opinion && (evidence.start < opinion.start || evidence.end > opinion.end)) errors.push(`${path}: evidence is outside the containing opinion`);
    const ownWords = evidence ? args.sourceText.slice(evidence.start, evidence.end) : "";
    const visible = [{ evidenceId: "treatment_evidence", text: ownWords }, ...citedQuotes];
    for (const [field, prose] of [["proposition", treatment.proposition], ["explanation", treatment.explanation]] as const) {
      errors.push(...groundedProseIntegrityErrors(prose, visible.map(({ evidenceId }) => evidenceId), visible).map((error) => `${path}.${field}: ${error}`));
    }
    treatmentReceipts.push({
      treatment_index: index,
      reference_ids: treatment.reference_ids,
      quoted_passage_ids: treatment.quoted_passage_ids,
      evidence: evidence ? { ...evidence, exact_text: ownWords } : null,
    });
  }
  for (const [index, history] of (analysis.procedural_history ?? []).entries()) {
    const path = `analysis.procedural_history[${index}]`;
    validateReferenceIds(history.reference_ids, path);
    if (history.containing_opinion_number !== null && (history.containing_opinion_number < 1 || history.containing_opinion_number > structure.opinions.length)) errors.push(`${path}: unknown opinion number`);
    const evidence = resolveLineRange(history.evidence, args.sourceLines, `${path}.evidence`, errors);
    const opinion = history.containing_opinion_number === null ? null : opinionSpans[history.containing_opinion_number - 1];
    if (evidence && opinion && (evidence.start < opinion.start || evidence.end > opinion.end)) errors.push(`${path}: evidence is outside the containing opinion`);
  }
  analysis.issues.forEach((issue, issueIndex) => issue.answers.forEach((answer, answerIndex) => answer.positions.forEach((position, positionIndex) => {
    const path = `analysis.issues[${issueIndex}].answers[${answerIndex}].positions[${positionIndex}]`;
    if (position.opinion_number < 1 || position.opinion_number > structure.opinions.length) errors.push(`${path}: unknown opinion number`);
    const opinion = opinionSpans[position.opinion_number - 1];
    for (const [index, ref] of position.answer_evidence.entries()) {
      const evidence = resolveLineRange(ref, args.sourceLines, `${path}.answer_evidence[${index}]`, errors);
      if (evidence && opinion && (evidence.start < opinion.start || evidence.end > opinion.end)) errors.push(`${path}: answer evidence is outside its opinion`);
    }
    for (const joiner of position.issue_only_joiners) resolveLineRange(joiner.evidence_lines, args.sourceLines, `${path}.issue_only_joiners`, errors);
  })));
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    coverage: {
      detected_occurrences: args.inventory.occurrences.length,
      detector_candidates_accounted_for: [...detectedById.keys()].every((id) => usedDetectedIds.has(id)),
      model_added_references: (analysis.references ?? []).filter(({ detected_occurrence_id }) => detected_occurrence_id === null).length,
      completeness: "not_asserted" as const,
    },
    grounding: {
      deterministic_quote_candidates: deterministicQuotes,
      references: referenceReceipts,
      quoted_passages: quoteReceipts,
      treatments: treatmentReceipts,
    },
  };
}
