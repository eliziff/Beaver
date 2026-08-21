import { createHash } from "node:crypto";

import {
  CASE_TARGET_MVP_REDUCED_JSON_SCHEMA,
  modelSourceLines,
  type SourceLineRef,
} from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced";

export const GOLD_SCHEMA_VERSION = "a2aj-case-target-extraction-v1";
const AUDITED_STATUSES = new Set(["audited"]);

type Json = Record<string, any>;
type FrozenOccurrence = { id: string; start: number; end: number; quote?: string };
type ResolvedLines = SourceLineRef & { start: number; end: number; quote: string };

export function goldAuditState(row: Json) {
  const audit = row.semantic_audit;
  if (!audit) return { state: "missing" as const, errors: [] as string[], complete: false };
  const errors: string[] = [];
  const status = audit.status;
  const annotator = typeof row.annotator === "string" ? row.annotator.trim() : "";
  if (!annotator) errors.push("annotator: required");
  if (row.gold_schema_version !== GOLD_SCHEMA_VERSION) errors.push(`gold_schema_version: expected ${GOLD_SCHEMA_VERSION}`);
  if (!["authored", ...AUDITED_STATUSES].includes(status)) errors.push("semantic_audit.status: invalid value");
  const complete = AUDITED_STATUSES.has(status);
  if (complete) {
    const reviewer = typeof audit.reviewer_identity === "string" ? audit.reviewer_identity.trim() : "";
    if (!reviewer) errors.push("semantic_audit.reviewer_identity: required for independent audit");
    if (reviewer.toLocaleLowerCase() === annotator.toLocaleLowerCase()) errors.push("semantic_audit.reviewer_identity: must differ from annotator");
    if (typeof audit.reviewer_version !== "string" || !audit.reviewer_version.trim()) errors.push("semantic_audit.reviewer_version: required for independent audit");
    if (typeof audit.reviewed_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(audit.reviewed_on) || Number.isNaN(Date.parse(`${audit.reviewed_on}T00:00:00Z`))) errors.push("semantic_audit.reviewed_on: expected YYYY-MM-DD");
  } else if ([audit.reviewer_identity, audit.reviewer_version, audit.reviewed_on].some((value) => value !== null)) {
    errors.push("semantic_audit: authored records must not claim an independent reviewer");
  }
  return { state: complete ? "audited" as const : "authored" as const, errors, complete: complete && !errors.length };
}

function schemaErrors(schema: any, value: unknown, path: string): string[] {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch: unknown) => schemaErrors(branch, value, path));
    return branches.filter((branchErrors: string[]) => !branchErrors.length).length === 1
      ? [] : [`${path}: expected exactly one schema alternative`];
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type !== undefined && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    return [`${path}: expected ${types.join(" or ")}`];
  }
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${String(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid value`);
  if (actual === "object") {
    const row = value as Json;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(row, key)) errors.push(`${path}.${key}: required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(row)) if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: unexpected field`);
    }
    for (const [key, child] of Object.entries(row)) if (Object.hasOwn(properties, key)) {
      errors.push(...schemaErrors(properties[key], child, `${path}.${key}`));
    }
  } else if (actual === "array") {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems) errors.push(`${path}: expected at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems) errors.push(`${path}: expected at most ${schema.maxItems} items`);
    items.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
  } else if (actual === "string" && schema.minLength !== undefined && (value as string).length < schema.minLength) {
    errors.push(`${path}: expected at least ${schema.minLength} characters`);
  } else if (actual === "integer" && schema.minimum !== undefined && (value as number) < schema.minimum) {
    errors.push(`${path}: expected at least ${schema.minimum}`);
  }
  return errors;
}

function lineResolver(source: string, errors: string[]) {
  const lines = modelSourceLines(source);
  const byNumber = new Map(lines.map((line, index) => [line.line, { line, index }]));
  return {
    lines,
    resolve(value: unknown, path: string): ResolvedLines | null {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected a line range`);
        return null;
      }
      const reference = value as Partial<SourceLineRef>;
      if (!Number.isSafeInteger(reference.start_line) || !Number.isSafeInteger(reference.end_line)
        || reference.start_line! < 1 || reference.end_line! < 1) {
        errors.push(`${path}: line numbers must be positive integers`);
        return null;
      }
      const start = byNumber.get(reference.start_line!);
      const end = byNumber.get(reference.end_line!);
      if (!start || !end) {
        errors.push(`${path}: source line does not exist`);
        return null;
      }
      if (start.index > end.index) {
        errors.push(`${path}: source lines are out of order`);
        return null;
      }
      return {
        start_line: reference.start_line!, end_line: reference.end_line!,
        start: start.line.start, end: end.line.end,
        quote: source.slice(start.line.start, end.line.end),
      };
    },
  };
}

export function groundedEvidence(source: string, value: unknown, path: string, errors: string[]) {
  return lineResolver(source, errors).resolve(value, path);
}

function contains(container: { start: number; end: number }, evidence: { start: number; end: number }) {
  return evidence.start >= container.start && evidence.end <= container.end;
}

export function validateGold(source: string, gold: Json, expectedOccurrences: FrozenOccurrence[] = []) {
  const errors = schemaErrors(CASE_TARGET_MVP_REDUCED_JSON_SCHEMA, gold, "annotation");
  if (errors.length) return errors;
  const sourceLine = lineResolver(source, errors);
  gold.disposition_lines.forEach((value: unknown, index: number) => sourceLine.resolve(value, `disposition_lines[${index}]`));

  const opinions: Array<{ start: number; end: number }> = [];
  const decisionMakers = new Set<string>();
  for (const [index, opinion] of gold.opinions.entries()) {
    const path = `opinions[${index}]`;
    const boundary = sourceLine.resolve(opinion, path);
    if (!boundary) continue;
    opinions.push(boundary);
    if (index > 0 && opinions[index - 1].end > boundary.start) errors.push(`${path}: opinions overlap or are out of source order`);
    if (opinion.authorship.kind === "named") opinion.authorship.authors.forEach((author: Json, authorIndex: number) => {
      decisionMakers.add(author.name.trim().toLocaleLowerCase());
      sourceLine.resolve(author.evidence_lines, `${path}.authorship.authors[${authorIndex}].evidence_lines`);
    });
    else if (opinion.authorship.kind === "collective") sourceLine.resolve(opinion.authorship.evidence_lines, `${path}.authorship.evidence_lines`);
    opinion.full_joiners.forEach((joiner: Json, joinerIndex: number) => {
      decisionMakers.add(joiner.name.trim().toLocaleLowerCase());
      sourceLine.resolve(joiner.evidence_lines, `${path}.full_joiners[${joinerIndex}].evidence_lines`);
    });
    if (opinion.position_evidence_lines) {
      const evidence = sourceLine.resolve(opinion.position_evidence_lines, `${path}.position_evidence_lines`);
      if (evidence && !contains(boundary, evidence)) errors.push(`${path}.position_evidence_lines: outside opinion`);
    }
  }
  for (const [index, participant] of gold.other_decision_makers.entries()) {
    const name = participant.name.trim().toLocaleLowerCase();
    if (decisionMakers.has(name)) errors.push(`other_decision_makers[${index}]: decision-maker is already an author or full joiner`);
    decisionMakers.add(name);
    sourceLine.resolve(participant.panel_evidence_lines, `other_decision_makers[${index}].panel_evidence_lines`);
    if (participant.result_only_evidence_lines) sourceLine.resolve(participant.result_only_evidence_lines, `other_decision_makers[${index}].result_only_evidence_lines`);
  }
  gold.nonparticipants.forEach((participant: Json, index: number) =>
    sourceLine.resolve(participant.evidence_lines, `nonparticipants[${index}].evidence_lines`));

  const expectedById = new Map(expectedOccurrences.map((occurrence) => [occurrence.id, occurrence]));
  const declaredOccurrences = new Set<string>();
  const identityByOccurrence = new Map<string, string>();
  for (const [index, mention] of gold.occurrence_assessments.entries()) {
    if (declaredOccurrences.has(mention.occurrence_id)) errors.push(`occurrence_assessments[${index}]: duplicate occurrence ${mention.occurrence_id}`);
    declaredOccurrences.add(mention.occurrence_id);
    identityByOccurrence.set(mention.occurrence_id, mention.target_identity);
    if (expectedOccurrences.length && !expectedById.has(mention.occurrence_id)) errors.push(`occurrence_assessments[${index}]: unknown frozen occurrence ${mention.occurrence_id}`);
  }
  for (const occurrence of expectedOccurrences) if (!declaredOccurrences.has(occurrence.id)) errors.push(`occurrence_assessments: missing frozen occurrence ${occurrence.id}`);

  const validateTreatment = (item: Json, path: string, opinion: { start: number; end: number } | null) => {
    const evidence = sourceLine.resolve(item.evidence_lines, `${path}.evidence_lines`);
    if (opinion && evidence && !contains(opinion, evidence)) errors.push(`${path}.evidence_lines: outside position opinion`);
    item.target_mentions.forEach((reference: Json, index: number) => {
      if (!declaredOccurrences.has(reference.occurrence_id)) errors.push(`${path}.target_mentions[${index}]: undeclared occurrence`);
      else if (identityByOccurrence.get(reference.occurrence_id) !== "target") errors.push(`${path}.target_mentions[${index}]: occurrence is not assessed as target`);
      const occurrence = expectedById.get(reference.occurrence_id);
      if (opinion && occurrence && !contains(opinion, occurrence)) errors.push(`${path}.target_mentions[${index}]: occurrence is outside position opinion`);
    });
  };
  for (const [issueIndex, issue] of gold.issues.entries()) {
    const positionedOpinions = new Set<number>();
    for (const [answerIndex, answer] of issue.answers.entries()) for (const [positionIndex, position] of answer.positions.entries()) {
      const path = `issues[${issueIndex}].answers[${answerIndex}].positions[${positionIndex}]`;
      const evidence = position.answer_evidence.map((item: Json, index: number) =>
        sourceLine.resolve(item, `${path}.answer_evidence[${index}]`)).filter(Boolean) as ResolvedLines[];
      const owners = opinions.map((opinion, index) => evidence.every((item) => contains(opinion, item)) ? index : -1).filter((index) => index >= 0);
      if (owners.length !== 1) {
        errors.push(`${path}: answer evidence must belong to exactly one opinion`);
        continue;
      }
      const ownerIndex = owners[0];
      const owner = opinions[ownerIndex];
      if (positionedOpinions.has(ownerIndex)) errors.push(`${path}: opinion already has a position on this issue`);
      positionedOpinions.add(ownerIndex);
      if (!position.answer_evidence.some((item: Json) => item.origin === "court_words")) errors.push(`${path}: answer lacks court-words evidence`);
      position.issue_only_joiners.forEach((joiner: Json, joinerIndex: number) => {
        if (!decisionMakers.has(joiner.participant_name.trim().toLocaleLowerCase())) errors.push(`${path}.issue_only_joiners[${joinerIndex}]: unknown decision-maker`);
        sourceLine.resolve(joiner.evidence_lines, `${path}.issue_only_joiners[${joinerIndex}].evidence_lines`);
      });
      position.target_treatments.forEach((item: Json, treatmentIndex: number) =>
        validateTreatment(item, `${path}.target_treatments[${treatmentIndex}]`, owner));
    }
  }
  gold.unscoped_target_treatments.forEach((item: Json, index: number) =>
    validateTreatment(item, `unscoped_target_treatments[${index}]`, null));
  gold.case_history.forEach((item: Json, index: number) => {
    sourceLine.resolve(item.evidence_lines, `case_history[${index}].evidence_lines`);
    item.target_mentions.forEach((reference: Json, referenceIndex: number) => {
      if (!declaredOccurrences.has(reference.occurrence_id)) errors.push(`case_history[${index}].target_mentions[${referenceIndex}]: undeclared occurrence`);
      else if (identityByOccurrence.get(reference.occurrence_id) !== "target") errors.push(`case_history[${index}].target_mentions[${referenceIndex}]: occurrence is not assessed as target`);
    });
  });
  return [...new Set(errors)];
}

export function validateFrozenSourceReceipt(source: string, pair: Json) {
  const errors: string[] = [];
  const receipt = pair.selection_receipt ?? {};
  if (Number(receipt.source_chars) !== source.length) errors.push("frozen source length mismatch");
  if (receipt.source_text_sha256 !== createHash("sha256").update(source, "utf8").digest("hex")) errors.push("frozen source hash mismatch");
  const occurrences = Array.isArray(receipt.target_occurrences) ? receipt.target_occurrences as Json[] : [];
  const occurrenceIds = new Set<string>();
  if (!occurrences.length) errors.push("missing frozen target occurrences");
  for (const [index, occurrence] of occurrences.entries()) {
    const path = `selection_receipt.target_occurrences[${index}]`;
    const id = typeof occurrence.id === "string" ? occurrence.id : "";
    if (!id || occurrenceIds.has(id)) errors.push(`${path}: missing or duplicate id`);
    else occurrenceIds.add(id);
    const start = Number(occurrence.start);
    const end = Number(occurrence.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || source.slice(start, end) !== occurrence.quote) errors.push(`${path}: frozen quote does not match local source`);
    const context = occurrence.context;
    if (context) {
      const contextStart = Number(context.start);
      const contextEnd = Number(context.end_exclusive);
      if (!Number.isSafeInteger(contextStart) || !Number.isSafeInteger(contextEnd) || contextStart < 0 || contextEnd <= contextStart || source.slice(contextStart, contextEnd) !== context.quote) errors.push(`${path}.context: frozen quote does not match local source`);
      else if (context.sha256 && context.sha256 !== createHash("sha256").update(context.quote, "utf8").digest("hex")) errors.push(`${path}.context: hash mismatch`);
    }
  }
  return {
    errors,
    occurrenceIds: [...occurrenceIds],
    occurrences: occurrences.map(({ id, start, end, quote }) => ({ id, start: Number(start), end: Number(end), quote })),
  };
}

export function validateFrozenGoldCase(source: string, pair: Json, annotation: Json) {
  const receipt = validateFrozenSourceReceipt(source, pair);
  return [...receipt.errors, ...validateGold(source, annotation, receipt.occurrences)];
}
