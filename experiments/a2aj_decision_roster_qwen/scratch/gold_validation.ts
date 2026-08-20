import { createHash } from "node:crypto";

import { resolveUniqueGroundedQuote } from "../../../backend/experiments/a2aj-decision-roster/caseSemanticMvp";
import {
  ATTRIBUTIONS,
  DIRECT_HISTORY_LABELS,
  SUBSTANTIVE_LABELS,
  TREATMENT_SCOPES,
} from "../../../backend/experiments/a2aj-decision-roster/caseTreatment";

const RESULT_POSITIONS = ["supports_disposition", "opposes_disposition", "mixed", "unclear"] as const;
const OPINION_LINK_RELATIONS = ["authors", "joins", "joins_in_part"] as const;
const ISSUE_RELATIONS = ["dispositive", "independent_alternative", "non_dispositive", "unclear"] as const;
export const GOLD_SCHEMA_VERSION = "a2aj-case-target-gold-v14";
const AUDITED_STATUSES = new Set(["audited_no_change", "audited_corrected"]);

export function goldAuditState(row: Record<string, any>) {
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
  if (status === "audited_corrected") {
    if (typeof audit.correction_summary !== "string" || !audit.correction_summary.trim()) errors.push("semantic_audit.correction_summary: required when corrected");
  } else if (audit.correction_summary !== null) {
    errors.push("semantic_audit.correction_summary: must be null unless corrected");
  }
  return { state: complete ? "audited" as const : "authored" as const, errors, complete: complete && !errors.length };
}

export function groundedEvidence(source: string, value: unknown, pathLabel: string, errors: string[]) {
  if (typeof value !== "string" || value.length < 4) {
    errors.push(`${pathLabel}: expected an exact quote of at least four characters`);
    return null;
  }
  const resolved = resolveUniqueGroundedQuote(source, 0, value);
  if (typeof resolved === "string") {
    errors.push(`${pathLabel}: ${resolved}`);
    return null;
  }
  return resolved;
}

export function validateGold(source: string, gold: Record<string, any>, expectedOccurrences: string[] = []) {
  const errors: string[] = [];
  const requiredArrays = ["opinions", "participants", "issues", "target_mentions", "target_treatments", "target_direct_history"];
  for (const key of requiredArrays) if (!Array.isArray(gold[key])) errors.push(`${key}: expected an array`);
  if (Array.isArray(gold.opinions) && !gold.opinions.length) errors.push("opinions: expected at least one substantive opinion");
  if (Array.isArray(gold.participants) && !gold.participants.length) errors.push("participants: expected at least one decision-maker");
  if (gold.disposition_quote !== null) groundedEvidence(source, gold.disposition_quote, "disposition_quote", errors);

  const opinions = new Set<string>();
  for (const [index, opinion] of (gold.opinions ?? []).entries()) {
    const label = `opinions[${index}]`;
    if (typeof opinion.opinion_key !== "string" || !/^o[1-9][0-9]*$/u.test(opinion.opinion_key) || opinions.has(opinion.opinion_key)) {
      errors.push(`${label}: invalid or duplicate opinion_key`);
    } else opinions.add(opinion.opinion_key);
    if (!Array.isArray(opinion.writer_names) || opinion.writer_names.some((name: unknown) => typeof name !== "string" || !name.trim())) {
      errors.push(`${label}.writer_names: expected names`);
    }
    if (opinion.collective_writer !== null && (typeof opinion.collective_writer !== "string" || !opinion.collective_writer.trim())) {
      errors.push(`${label}.collective_writer: expected a string or null`);
    }
    const hasWriter = (opinion.writer_names?.length ?? 0) > 0 || opinion.collective_writer !== null;
    if (hasWriter) groundedEvidence(source, opinion.writer_evidence_quote, `${label}.writer_evidence_quote`, errors);
    else if (opinion.writer_evidence_quote !== null) errors.push(`${label}.writer_evidence_quote: must be null when the writer is unknown`);
    if (!RESULT_POSITIONS.includes(opinion.result_position)) errors.push(`${label}.result_position: invalid value`);
    if (opinion.result_position !== "unclear") groundedEvidence(source, opinion.position_evidence_quote, `${label}.position_evidence_quote`, errors);
    const start = groundedEvidence(source, opinion.start_quote, `${label}.start_quote`, errors);
    const end = groundedEvidence(source, opinion.end_quote, `${label}.end_quote`, errors);
    if (start && end && start.start > end.start) errors.push(`${label}: opinion ends before it starts`);
  }

  const participantNames = new Set<string>();
  const participantLinks: Array<{ label: string; link: Record<string, any> }> = [];
  for (const [index, participant] of (gold.participants ?? []).entries()) {
    const label = `participants[${index}]`;
    const name = typeof participant.name === "string" ? participant.name.trim().toLocaleLowerCase() : "";
    if (!name || participantNames.has(name)) errors.push(`${label}.name: missing or duplicate participant`);
    else participantNames.add(name);
    groundedEvidence(source, participant.panel_evidence_quote, `${label}.panel_evidence_quote`, errors);
    if (!RESULT_POSITIONS.includes(participant.result_position)) errors.push(`${label}.result_position: invalid value`);
    if (participant.result_position !== "unclear") groundedEvidence(source, participant.result_evidence_quote, `${label}.result_evidence_quote`, errors);
    if (typeof participant.result_only !== "boolean") errors.push(`${label}.result_only: expected boolean`);
    if (!Array.isArray(participant.opinion_links)) errors.push(`${label}.opinion_links: expected an array`);
    const links = participant.opinion_links ?? [];
    if (participant.result_only && links.length) errors.push(`${label}: result-only participant cannot link to reasons`);
    if (participant.result_only === false && !links.length) errors.push(`${label}: participant needs an authorship or joinder link`);
    for (const [linkIndex, link] of links.entries()) {
      const linkLabel = `${label}.opinion_links[${linkIndex}]`;
      participantLinks.push({ label: linkLabel, link });
      if (!opinions.has(link.opinion_key)) errors.push(`${linkLabel}: unknown opinion ${String(link.opinion_key)}`);
      if (!OPINION_LINK_RELATIONS.includes(link.relation)) errors.push(`${linkLabel}.relation: invalid value`);
      if (!Array.isArray(link.issue_keys)) errors.push(`${linkLabel}.issue_keys: expected an array`);
      if (link.relation === "joins_in_part" && !link.issue_keys?.length) errors.push(`${linkLabel}: joins_in_part needs issue_keys`);
      if (link.relation !== "joins_in_part" && link.issue_keys?.length) errors.push(`${linkLabel}: only joins_in_part may specify issue_keys`);
      groundedEvidence(source, link.evidence_quote, `${linkLabel}.evidence_quote`, errors);
    }
  }

  const issues = new Set<string>();
  for (const [index, issue] of (gold.issues ?? []).entries()) {
    const label = `issues[${index}]`;
    if (typeof issue.issue_key !== "string" || !/^s[1-9][0-9]*$/u.test(issue.issue_key) || issues.has(issue.issue_key)) {
      errors.push(`${label}: invalid or duplicate issue_key`);
    } else issues.add(issue.issue_key);
    if (typeof issue.question !== "string" || issue.question.trim().length < 4) errors.push(`${label}.question: expected a legal question`);
    if (!Array.isArray(issue.answer_groups) || !issue.answer_groups.length) errors.push(`${label}.answer_groups: expected at least one answer group`);
    const positionedOpinions = new Set<string>();
    const answerGroups = new Set<string>();
    for (const [groupIndex, group] of (issue.answer_groups ?? []).entries()) {
      const groupLabel = `${label}.answer_groups[${groupIndex}]`;
      if (typeof group.answer_group_key !== "string" || !group.answer_group_key.trim() || answerGroups.has(group.answer_group_key)) {
        errors.push(`${groupLabel}: invalid or duplicate answer_group_key`);
      } else answerGroups.add(group.answer_group_key);
      if (typeof group.answer !== "string" || !group.answer.trim()) errors.push(`${groupLabel}.answer: expected an answer`);
      if (!Array.isArray(group.positions) || !group.positions.length) errors.push(`${groupLabel}.positions: expected at least one opinion position`);
      for (const [positionIndex, position] of (group.positions ?? []).entries()) {
        const positionLabel = `${groupLabel}.positions[${positionIndex}]`;
        if (!opinions.has(position.opinion_key)) errors.push(`${positionLabel}: unknown opinion ${String(position.opinion_key)}`);
        if (positionedOpinions.has(position.opinion_key)) errors.push(`${positionLabel}: opinion already belongs to an answer group on this issue`);
        else positionedOpinions.add(position.opinion_key);
        if (!ISSUE_RELATIONS.includes(position.relation_to_disposition)) errors.push(`${positionLabel}.relation_to_disposition: invalid value`);
        if (!Array.isArray(position.answer_evidence_quotes) || !position.answer_evidence_quotes.length) {
          errors.push(`${positionLabel}.answer_evidence_quotes: expected at least one quote`);
        }
        for (const [quoteIndex, quote] of (position.answer_evidence_quotes ?? []).entries()) {
          groundedEvidence(source, quote, `${positionLabel}.answer_evidence_quotes[${quoteIndex}]`, errors);
        }
      }
    }
  }
  for (const { label, link } of participantLinks) {
    for (const issue of link.issue_keys ?? []) if (!issues.has(issue)) errors.push(`${label}: unknown issue ${issue}`);
  }

  const mentions = new Set<string>();
  const occurrenceCounts = new Map<string, number>();
  for (const [index, item] of (gold.target_mentions ?? []).entries()) {
    const label = `target_mentions[${index}]`;
    groundedEvidence(source, item.evidence_quote, `${label}.evidence_quote`, errors);
    if (typeof item.mention_key !== "string" || !/^m[1-9][0-9]*$/u.test(item.mention_key) || mentions.has(item.mention_key)) errors.push(`${label}: invalid or duplicate mention_key`);
    else mentions.add(item.mention_key);
    const hasOccurrence = typeof item.occurrence_id === "string";
    const hasMentionQuote = typeof item.mention_quote === "string";
    if (hasOccurrence === hasMentionQuote) errors.push(`${label}: provide exactly one of occurrence_id or mention_quote`);
    if (hasOccurrence) occurrenceCounts.set(item.occurrence_id, (occurrenceCounts.get(item.occurrence_id) ?? 0) + 1);
    if (hasMentionQuote) groundedEvidence(source, item.mention_quote, `${label}.mention_quote`, errors);
    if (!ATTRIBUTIONS.includes(item.voice)) errors.push(`${label}.voice: invalid value`);
    if (!Array.isArray(item.issue_keys)) errors.push(`${label}.issue_keys: expected an array`);
    for (const issue of item.issue_keys ?? []) if (!issues.has(issue)) errors.push(`${label}: unknown issue ${issue}`);
  }
  for (const occurrence of expectedOccurrences) {
    if (occurrenceCounts.get(occurrence) !== 1) errors.push(`target_mentions: expected occurrence ${occurrence} exactly once`);
  }
  for (const [index, item] of (gold.target_treatments ?? []).entries()) {
    const label = `target_treatments[${index}]`;
    groundedEvidence(source, item.evidence_quote, `${label}.evidence_quote`, errors);
    if (!Array.isArray(item.mention_keys) || !item.mention_keys.length) errors.push(`${label}.mention_keys: expected at least one mention`);
    for (const mention of item.mention_keys ?? []) if (!mentions.has(mention)) errors.push(`${label}: unknown mention ${mention}`);
    if (!Array.isArray(item.issue_keys)) errors.push(`${label}.issue_keys: expected an array`);
    for (const issue of item.issue_keys ?? []) if (!issues.has(issue)) errors.push(`${label}: unknown issue ${issue}`);
    if (!ATTRIBUTIONS.includes(item.attribution)) errors.push(`${label}.attribution: invalid value`);
    if (!SUBSTANTIVE_LABELS.includes(item.label)) errors.push(`${label}.label: invalid value`);
    if (!TREATMENT_SCOPES.includes(item.scope)) errors.push(`${label}.scope: invalid value`);
    if (item.target_proposition_as_characterized !== null && (typeof item.target_proposition_as_characterized !== "string" || !item.target_proposition_as_characterized.trim())) {
      errors.push(`${label}.target_proposition_as_characterized: expected a string or null`);
    }
  }
  for (const [index, item] of (gold.target_direct_history ?? []).entries()) {
    const label = `target_direct_history[${index}]`;
    groundedEvidence(source, item.evidence_quote, `${label}.evidence_quote`, errors);
    if (!Array.isArray(item.mention_keys) || !item.mention_keys.length) errors.push(`${label}.mention_keys: expected at least one mention`);
    for (const mention of item.mention_keys ?? []) if (!mentions.has(mention)) errors.push(`${label}: unknown mention ${mention}`);
    if (!DIRECT_HISTORY_LABELS.includes(item.label)) errors.push(`${label}.label: invalid value`);
  }
  return errors;
}

export function validateFrozenSourceReceipt(source: string, pair: Record<string, any>) {
  const errors: string[] = [];
  const receipt = pair.selection_receipt ?? {};
  if (Number(receipt.source_chars) !== source.length) errors.push("frozen source length mismatch");
  if (receipt.source_text_sha256 !== createHash("sha256").update(source, "utf8").digest("hex")) errors.push("frozen source hash mismatch");
  const occurrences = Array.isArray(receipt.target_occurrences) ? receipt.target_occurrences as Array<Record<string, any>> : [];
  const occurrenceIds = new Set<string>();
  if (!occurrences.length) errors.push("missing frozen target occurrences");
  for (const [index, occurrence] of occurrences.entries()) {
    const label = `selection_receipt.target_occurrences[${index}]`;
    const id = typeof occurrence.id === "string" ? occurrence.id : "";
    if (!id || occurrenceIds.has(id)) errors.push(`${label}: missing or duplicate id`);
    else occurrenceIds.add(id);
    const start = Number(occurrence.start);
    const end = Number(occurrence.end_exclusive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || source.slice(start, end) !== occurrence.quote) {
      errors.push(`${label}: frozen quote does not match local source`);
    }
    const context = occurrence.context;
    if (context) {
      const contextStart = Number(context.start);
      const contextEnd = Number(context.end_exclusive);
      if (!Number.isSafeInteger(contextStart) || !Number.isSafeInteger(contextEnd) || contextStart < 0 || contextEnd <= contextStart || source.slice(contextStart, contextEnd) !== context.quote) {
        errors.push(`${label}.context: frozen quote does not match local source`);
      } else if (context.sha256 && context.sha256 !== createHash("sha256").update(context.quote, "utf8").digest("hex")) {
        errors.push(`${label}.context: hash mismatch`);
      }
    }
  }
  return { errors, occurrenceIds: [...occurrenceIds] };
}

export function validateFrozenGoldCase(source: string, pair: Record<string, any>, annotation: Record<string, any>) {
  const receipt = validateFrozenSourceReceipt(source, pair);
  return [...receipt.errors, ...validateGold(source, annotation, receipt.occurrenceIds)];
}
