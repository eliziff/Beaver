import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { resolveUniqueGroundedQuote } from "../../../backend/experiments/a2aj-decision-roster/caseSemanticMvp";
import {
  ATTRIBUTIONS,
  DIRECT_HISTORY_LABELS,
  SUBSTANTIVE_LABELS,
  TREATMENT_SCOPES,
} from "../../../backend/experiments/a2aj-decision-roster/caseTreatment";
import { fetchLocalA2AJDocumentById } from "../../../backend/src/lib/a2ajLocalBulk";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  candidatesFromPairFile,
  codexSubscriptionPreflight,
  loadCase,
  modelCallLedgerUsage,
  runStructuredLuna,
  validateCaseTargetSubmission,
} from "../runner";

const RESULT_POSITIONS = ["supports_disposition", "opposes_disposition", "mixed", "unclear"] as const;
const OPINION_LINK_RELATIONS = ["authors", "joins", "joins_in_part"] as const;
const ISSUE_RELATIONS = ["dispositive", "independent_alternative", "non_dispositive", "unclear"] as const;
const GRADER_MODEL = "gpt-5.6-sol";
// Ultra is a Codex orchestration preset. Keep each adjudication to one isolated
// model response by using the strongest flat-subscription inference effort.
const GRADER_EFFORT = "max";
const GRADER_PROMPT_VERSION = "a2aj-case-target-gold-grader-v3";
const COMPARISON_PROMPT_VERSION = "a2aj-case-target-blind-comparison-v2";
const appendQueues = new Map<string, Promise<void>>();

async function appendJsonl(file: string, row: unknown) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const next = previous.then(() => appendFile(file, `${JSON.stringify(row)}\n`, "utf8"));
  appendQueues.set(file, next);
  try { await next; } finally { if (appendQueues.get(file) === next) appendQueues.delete(file); }
}

function modelReceipt(result: Awaited<ReturnType<typeof runStructuredLuna>>) {
  const { raw: _raw, parsed: _parsed, ...receipt } = result;
  return receipt;
}

async function runLedgeredCall(args: {
  ledger: string;
  runId: string;
  purpose: string;
  documentId: number;
  citation: string;
  call: Parameters<typeof runStructuredLuna>[0];
}) {
  const callId = randomUUID();
  await appendJsonl(args.ledger, {
    kind: "model_call_started",
    call_id: callId,
    run_id: args.runId,
    purpose: args.purpose,
    document: args.documentId,
    citation: args.citation,
    provider: "codex_subscription",
    model: args.call.model,
    effort: args.call.effort,
    prompt_version: args.purpose === "gold_adjudication" ? GRADER_PROMPT_VERSION : COMPARISON_PROMPT_VERSION,
    prompt_sha256: createHash("sha256").update(args.call.prompt, "utf8").digest("hex"),
    prompt_chars: args.call.prompt.length,
  });
  try {
    const originalEventSink = args.call.onEvent;
    const seenProviderAttempts = new Set([1]);
    const result = await runStructuredLuna({
      ...args.call,
      onEvent: async (event, rawLine) => {
        const providerAttempt = typeof event.attempt === "number" ? event.attempt : null;
        if (providerAttempt && providerAttempt > 1 && !seenProviderAttempts.has(providerAttempt)) {
          seenProviderAttempts.add(providerAttempt);
          await appendJsonl(args.ledger, {
            kind: "model_call_retry_started",
            call_id: callId,
            run_id: args.runId,
            purpose: args.purpose,
            document: args.documentId,
            citation: args.citation,
            provider: "codex_subscription",
            model: args.call.model,
            effort: args.call.effort,
            attempt: providerAttempt,
          });
        }
        await originalEventSink?.(event, rawLine);
      },
    });
    await appendJsonl(args.ledger, {
      kind: "model_call_finished",
      call_id: callId,
      run_id: args.runId,
      purpose: args.purpose,
      document: args.documentId,
      status: result.returnCode === 0 && !result.error ? "completed" : "failed",
      return_code: result.returnCode,
      error: result.error,
      output_sha256: result.outputSha256,
      elapsed_seconds: result.elapsedSeconds,
      usage: result.usage,
      transport_retries: result.transport_retries,
    });
    return result;
  } catch (error) {
    await appendJsonl(args.ledger, {
      kind: "model_call_finished",
      call_id: callId,
      run_id: args.runId,
      purpose: args.purpose,
      document: args.documentId,
      status: "runner_error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const ERROR_KINDS = [
  "opinion_omitted", "opinion_invented", "opinion_boundary_wrong", "writer_wrong",
  "participant_omitted", "participant_invented", "vote_or_join_wrong",
  "issue_omitted", "issue_invented", "issue_misframed", "answer_wrong", "answer_group_wrong",
  "disposition_relation_wrong", "mention_omitted", "mention_invented", "occurrence_voice_wrong",
  "treatment_omitted", "treatment_invented", "treatment_label_wrong", "treatment_scope_wrong",
  "treatment_proposition_wrong", "direct_history_wrong", "grounding_or_linkage_wrong", "other",
] as const;

const FINAL_SCORE_NAMES = [
  "opinion_structure",
  "opinion_writers",
  "participant_votes_and_joins",
  "issues_and_answers",
  "occurrence_voice",
  "treatment",
  "direct_history",
  "evidence_and_linkage",
] as const;

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidate_usable", "scores", "critical_errors", "acceptable_variations"],
  properties: {
    candidate_usable: { type: "boolean" },
    scores: {
      type: "object",
      additionalProperties: false,
      required: FINAL_SCORE_NAMES,
      properties: Object.fromEntries(FINAL_SCORE_NAMES.map((name) => [name, { type: "integer", minimum: 0, maximum: 4 }])),
    },
    critical_errors: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "candidate_path", "explanation", "evidence_quote"],
        properties: {
          kind: { type: "string", enum: ERROR_KINDS },
          candidate_path: { type: ["string", "null"] },
          explanation: { type: "string", minLength: 4 },
          evidence_quote: { type: ["string", "null"], minLength: 4 },
        },
      },
    },
    acceptable_variations: { type: "array", maxItems: 20, items: { type: "string" } },
  },
} as const;

const COMPARISON_SCORE_NAMES = FINAL_SCORE_NAMES;

const COMPARISON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidate_grades", "ranking", "preferred_candidate_id", "material_ties", "comparison_rationale"],
  properties: {
    candidate_grades: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidate_id", "semantically_usable", "scores", "critical_errors"],
        properties: {
          candidate_id: { type: "string", pattern: "^candidate_[a-f0-9]{8}$" },
          semantically_usable: { type: "boolean" },
          scores: {
            type: "object",
            additionalProperties: false,
            required: COMPARISON_SCORE_NAMES,
            properties: Object.fromEntries(COMPARISON_SCORE_NAMES.map((name) => [name, { type: "integer", minimum: 0, maximum: 4 }])),
          },
          critical_errors: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "explanation", "source_quote"],
              properties: {
                kind: { type: "string", enum: ERROR_KINDS },
                explanation: { type: "string", minLength: 4 },
                source_quote: { type: ["string", "null"], minLength: 4 },
              },
            },
          },
        },
      },
    },
    ranking: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", pattern: "^candidate_[a-f0-9]{8}$" } },
    preferred_candidate_id: { type: ["string", "null"], pattern: "^candidate_[a-f0-9]{8}$" },
    material_ties: {
      type: "array",
      maxItems: 4,
      items: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", pattern: "^candidate_[a-f0-9]{8}$" } },
    },
    comparison_rationale: { type: "string", minLength: 4 },
  },
} as const;

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function readJsonl(file: string) {
  const rows: Array<Record<string, any>> = [];
  if (!existsSync(file)) return rows;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a truncated last line is retried */ }
  }
  return rows;
}

type CandidateOutput = { raw: unknown; canonical: unknown };

function parsedOutput(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function rawCandidates(files: string[]) {
  const byDocument = new Map<number, CandidateOutput>();
  for (const file of files) {
    for (const event of await readJsonl(file)) {
      const documentId = Number(event.document ?? event.document_id);
      if (!Number.isSafeInteger(documentId)) continue;
      const current = byDocument.get(documentId) ?? { raw: null, canonical: null };
      if (event.kind === "model_output") {
        byDocument.set(documentId, { ...current, raw: parsedOutput(event.raw_model_output) });
      } else if (event.kind === "canonical_model_output") {
        const explicit = parsedOutput(event.canonical_model_output ?? event.canonical_output ?? event.model_output);
        const canonical = explicit ?? {
          compiler_version: event.compiler_version,
          validator_version: event.validator_version,
          source_sha256: event.source_sha256,
          raw_output_sha256: event.raw_output_sha256,
          prediction: event.prediction ?? null,
          case_target_mvp: event.case_target_mvp ?? null,
          compiler_errors: event.compiler_errors ?? [],
        };
        byDocument.set(documentId, {
          raw: parsedOutput(event.raw_model_output) ?? current.raw,
          canonical,
        });
      }
    }
  }
  return byDocument;
}

function armSpecs(value: string) {
  const specs = value.split(",").filter(Boolean).map((item) => {
    const separator = item.indexOf("=");
    if (separator < 1 || separator === item.length - 1) throw new Error(`invalid --arms item ${item}; expected label=outputs.jsonl`);
    return { label: item.slice(0, separator), file: path.resolve(item.slice(separator + 1)) };
  });
  if (specs.length < 2 || specs.length > 4 || new Set(specs.map(({ label }) => label)).size !== specs.length) {
    throw new Error("--arms requires two to four unique label=outputs.jsonl items");
  }
  return specs;
}

async function rawCandidatesByArm(specs: ReturnType<typeof armSpecs>) {
  return new Map(await Promise.all(specs.map(async ({ label, file }) => [label, await rawCandidates([file])] as const)));
}

async function readGoldFiles(value: string) {
  const files = value.split(",").filter(Boolean).map((file) => path.resolve(file));
  const rows = (await Promise.all(files.map(async (file) => {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`human gold must be a JSON array: ${file}`);
    return parsed as Array<Record<string, any>>;
  }))).flat();
  return { files, rows };
}

function blindCandidateId(documentId: number, label: string) {
  return `candidate_${createHash("sha256").update(`${documentId}:${label}`, "utf8").digest("hex").slice(0, 8)}`;
}

async function mapPool<T, R>(items: T[], workers: number, fn: (item: T, index: number) => Promise<R>) {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

function packet(record: Awaited<ReturnType<typeof loadCase>>) {
  if (!record) throw new Error("record is unavailable");
  return [
    "[TARGET]",
    JSON.stringify(record.candidate.target, null, 2),
    "[DETERMINISTIC TARGET OCCURRENCES]",
    JSON.stringify(record.targetOccurrences, null, 2),
    "[COMPLETE CITING DECISION TEXT]",
    record.source.text,
  ].join("\n\n");
}

function gradePrompt(
  record: NonNullable<Awaited<ReturnType<typeof loadCase>>>,
  candidate: unknown,
  rawCandidate: unknown,
  deterministic: unknown,
  gold: unknown,
) {
  return `Act as a strict evidence adjudicator for a legal extraction evaluation. Use only the complete citing decision below.
The HUMAN GOLD was written after direct review, but it may contain an annotator error. Resolve every disagreement against the source text. Grade the FINAL CANONICAL EXTRACTION as one legal representation: opinion boundaries and writers; participants, votes, and joins; shared issues with each opinion's answer and answer group; target-occurrence voice; treatment and direct history; and the evidence/linkage supporting them. Deterministic validation may expose grounding or linkage defects, but is not a semantic oracle. The RAW MODEL EXTRACTION is included only to reveal whether deterministic normalization changed the answer; grade the final canonical extraction.
The issue map contains only legal questions actually answered by at least one opinion. Opinions need not address or frame every issue identically. A question expressly left undecided is omitted. "I agree" joins reasons unless explicitly limited. A result-only concurrence does not adopt another opinion's reasons. Authority is derived from votes and answer groups; do not reward or penalize redundant authority labels. A treatment is "applied" when the current court uses the target proposition to resolve an issue or remedy; "referred_to" is citation without substantive adoption or use. Keep counsel, quotations, reported decisions, procedural recounting, and document metadata out of the current court's voice. Direct history exists only between successive decisions in the same litigation.
Scores are 0=wholly wrong/missing, 1=major errors, 2=mixed, 3=minor errors, 4=fully acceptable. Do not score pipeline stages. Do not penalize harmless paraphrase, reasonable issue grouping/splitting, or IDs. Give each critical error its candidate JSON path and a contiguous exact source quote; use null only when an omission or internal linkage error has no honest source quote. Return only schema JSON.

[FINAL CANONICAL EXTRACTION]
${JSON.stringify(candidate, null, 2)}

[RAW MODEL EXTRACTION]
${JSON.stringify(rawCandidate, null, 2)}

[DETERMINISTIC VALIDATION/DERIVATION]
${JSON.stringify(deterministic, null, 2)}

[HUMAN GOLD]
${JSON.stringify(gold, null, 2)}

${packet(record)}`;
}

function comparisonPrompt(
  record: NonNullable<Awaited<ReturnType<typeof loadCase>>>,
  candidates: Array<{ candidate_id: string; canonical_extraction: unknown; raw_model_extraction: unknown; deterministic_validation: unknown }>,
) {
  return `Independently adjudicate ${candidates.length} anonymized final extractions of one closed-record citing decision and one named target case. Use only the complete citing decision. Determine the legally correct opinion boundaries and writers; participants, votes, and joins; shared issues and each opinion's answer group; occurrence voice; treatment; and direct history before comparing candidates. Agreement among candidates is not evidence of correctness. Grade each canonical extraction; its raw model extraction is included only to show what deterministic normalization changed.

The issue map contains only material legal questions actually answered by at least one opinion. Different opinions need not address the same issues or frame them identically. A question expressly left undecided is omitted. "I agree" joins reasons unless explicitly limited; a result-only concurrence does not adopt reasons. Authority is derived from votes and answer groups. A treatment describes what this source does to the named target on the linked issue: "applied" means the current court used the target proposition to resolve an issue or remedy; "referred_to" is citation without substantive adoption or use. Keep the current court's voice separate from counsel, quoted authorities, reported decisions, procedural recounting, and document metadata. Direct appellate history is separate from substantive treatment and exists only between successive decisions in the same litigation.

Score each final candidate 0=wholly wrong/missing, 1=major errors, 2=mixed, 3=minor errors, 4=fully acceptable. Do not score pipeline stages. A candidate is usable only if it would not materially mislead downstream research about the decision or target treatment. Structural validation is evidence, not a semantic oracle. Do not penalize harmless paraphrase, IDs, or reasonable issue grouping. Every source_quote must be a contiguous exact substring of the decision; use null only for a purely internal linkage error. Rank every candidate, using material_ties when differences are immaterial. Return only schema JSON.

[ANONYMIZED CANDIDATES]
${JSON.stringify(candidates, null, 2)}

${packet(record)}`;
}

function groundedEvidence(source: string, value: unknown, pathLabel: string, errors: string[]) {
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

function validateGold(source: string, gold: Record<string, any>, expectedOccurrences: string[] = []) {
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

function validateGrade(source: string, grade: Record<string, any>) {
  const errors: string[] = [];
  for (const [index, item] of (grade.critical_errors ?? []).entries()) groundedEvidence(source, item.evidence_quote, `critical_errors[${index}]`, errors);
  return errors;
}

function validateComparison(source: string, comparison: Record<string, any>, expectedIds: string[]) {
  const errors: string[] = [];
  const expected = new Set(expectedIds);
  const grades = Array.isArray(comparison.candidate_grades) ? comparison.candidate_grades : [];
  const gradedIds = grades.map((item) => String(item?.candidate_id ?? ""));
  if (grades.length !== expected.size || new Set(gradedIds).size !== expected.size || gradedIds.some((id) => !expected.has(id))) {
    errors.push("candidate_grades must contain each blinded candidate exactly once");
  }
  for (const [gradeIndex, grade] of grades.entries()) {
    for (const [errorIndex, item] of (grade?.critical_errors ?? []).entries()) {
      if (typeof item?.source_quote === "string") groundedEvidence(source, item.source_quote, `candidate_grades[${gradeIndex}].critical_errors[${errorIndex}]`, errors);
    }
  }
  const ranking = Array.isArray(comparison.ranking) ? comparison.ranking.map(String) : [];
  if (ranking.length !== expected.size || new Set(ranking).size !== expected.size || ranking.some((id) => !expected.has(id))) {
    errors.push("ranking must contain each blinded candidate exactly once");
  }
  if (comparison.preferred_candidate_id !== null && !expected.has(String(comparison.preferred_candidate_id))) {
    errors.push("preferred_candidate_id is unknown");
  }
  for (const [index, tie] of (comparison.material_ties ?? []).entries()) {
    if (!Array.isArray(tie) || new Set(tie.map(String)).size !== tie.length || tie.some((id) => !expected.has(String(id)))) {
      errors.push(`material_ties[${index}] contains unknown or duplicate candidates`);
    }
  }
  return errors;
}

function validateCandidate(record: NonNullable<Awaited<ReturnType<typeof loadCase>>>, candidate: unknown) {
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && "case_target_mvp" in candidate) {
    const canonical = candidate as Record<string, any>;
    const target = canonical.case_target_mvp;
    return {
      opinion_ok: canonical.prediction !== null,
      opinion_error: canonical.prediction === null ? "opinion extraction rejected" : null,
      target_ok: target?.ok ?? false,
      target_errors: target?.errors ?? (canonical.compiler_errors?.length ? canonical.compiler_errors : ["case-target extraction missing"]),
    };
  }
  const result = validateCaseTargetSubmission(record, candidate);
  return {
    opinion_ok: result.validation.ok,
    opinion_error: result.validation.ok ? null : result.validation.error,
    target_ok: result.case_target_mvp?.ok ?? false,
    target_errors: result.case_target_mvp?.errors ?? (result.compiler_errors.length ? result.compiler_errors : [candidate ? "case-target extraction rejected" : "model output missing"]),
  };
}

async function runComparison() {
  const pairFile = process.argv[2];
  const specs = armSpecs(flag("--arms"));
  const outStem = flag("--out");
  const ledger = flag("--call-ledger");
  const runId = flag("--run-id", path.basename(outStem || "case-target-comparison"));
  const workers = Math.min(5, Math.max(1, Number(flag("--workers", "5"))));
  const timeoutSeconds = Math.max(1, Number(flag("--timeout-seconds", "1800")));
  const callBudget = Math.max(1, Number(flag("--call-budget", "15000")));
  if (!pairFile || !outStem || !ledger) {
    throw new Error("usage: silver_case_target_eval.ts <pairs.json> --compare --arms current=a.outputs.jsonl,reduced=b.outputs.jsonl --out <stem> --call-ledger <ledger.jsonl> [--workers 5]");
  }
  const codexSubscription = codexSubscriptionPreflight();
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  const outputs = await rawCandidatesByArm(specs);
  const work = await Promise.all(candidates.map(async (candidate) => {
    const record = await loadCase(candidate);
    if (!record) throw new Error(`missing case ${candidate.documentId}`);
    const arms = specs.map(({ label }) => {
      const output = outputs.get(label)?.get(candidate.documentId) ?? { raw: null, canonical: null };
      const canonical = output.canonical ?? output.raw;
      return {
        label,
        candidate_id: blindCandidateId(candidate.documentId, label),
        raw: output.raw,
        canonical,
        deterministic: validateCandidate(record, canonical),
      };
    }).sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));
    return { candidate, record, arms };
  }));
  await shutdownSourceStructureEngine();
  await Promise.all([
    mkdir(path.dirname(path.resolve(outStem)), { recursive: true }),
    mkdir(path.dirname(path.resolve(ledger)), { recursive: true }),
  ]);
  const gradeFile = `${path.resolve(outStem)}.comparisons.jsonl`;
  const rawEventFile = `${path.resolve(outStem)}.raw-events.jsonl`;
  const existing = new Map((await readJsonl(gradeFile)).map((row) => [Number(row.document_id), row]));
  const pending = work.filter(({ candidate }) => !existing.has(candidate.documentId));
  const usedBeforeRun = await modelCallLedgerUsage(path.resolve(ledger));
  const plannedAttemptCeiling = pending.length * 2;
  if (usedBeforeRun + plannedAttemptCeiling > callBudget) {
    throw new Error(`call budget exceeded: ${usedBeforeRun} used + ${plannedAttemptCeiling} maximum attempts planned > ${callBudget}`);
  }
  await appendJsonl(path.resolve(ledger), {
    kind: "call_budget_checked", run_id: runId, budget: callBudget, attempted_before_run: usedBeforeRun,
    planned_calls: pending.length, planned_attempt_ceiling: plannedAttemptCeiling,
    remaining_after_attempt_ceiling: callBudget - usedBeforeRun - plannedAttemptCeiling,
  });

  await mapPool(pending, workers, async ({ candidate, record, arms }, index) => {
    process.stderr.write(`[compare ${index + 1}] ${candidate.citation}\n`);
    const promptCandidates = arms.map(({ candidate_id, raw, canonical, deterministic }) => ({
      candidate_id,
      canonical_extraction: canonical,
      raw_model_extraction: raw,
      deterministic_validation: deterministic,
    }));
    const result = await runLedgeredCall({
      ledger: path.resolve(ledger),
      runId,
      purpose: "blind_prompt_comparison",
      documentId: candidate.documentId,
      citation: candidate.citation,
      call: {
        prompt: comparisonPrompt(record, promptCandidates),
        schema: COMPARISON_SCHEMA,
        schemaName: "a2aj_case_target_blind_comparison_v2",
        responseFormat: { type: "json_schema", name: "a2aj_case_target_blind_comparison_v2", strict: true, schema: COMPARISON_SCHEMA },
        model: GRADER_MODEL,
        effort: GRADER_EFFORT,
        timeoutSeconds,
        onEvent: async (_event, rawLine) => appendJsonl(rawEventFile, {
          kind: "codex_event_raw",
          document_id: candidate.documentId,
          citation: candidate.citation,
          raw_event_line: rawLine,
        }),
      },
    });
    const parsed = result.parsed as Record<string, any> | null;
    const expectedIds = arms.map(({ candidate_id }) => candidate_id);
    const validation_errors = parsed ? validateComparison(record.source.text, parsed, expectedIds) : [result.error ?? "missing parsed output"];
    const row = {
      kind: "blind_prompt_comparison",
      document_id: candidate.documentId,
      citation: candidate.citation,
      comparison_prompt_version: COMPARISON_PROMPT_VERSION,
      candidate_map: Object.fromEntries(arms.map(({ candidate_id, label }) => [candidate_id, label])),
      deterministic_validation: Object.fromEntries(arms.map(({ label, deterministic }) => [label, deterministic])),
      parsed,
      validation_errors,
      raw_model_output: result.raw,
      model_receipt: modelReceipt(result),
    };
    await appendJsonl(gradeFile, row);
    existing.set(candidate.documentId, row);
    return row;
  });

  const rows = [...existing.values()].filter((row) => row.parsed && !row.validation_errors?.length);
  const arms = Object.fromEntries(specs.map(({ label }) => {
    const grades = rows.flatMap((row) => {
      const candidateId = Object.entries(row.candidate_map as Record<string, string>).find(([, arm]) => arm === label)?.[0];
      return candidateId ? (row.parsed.candidate_grades ?? []).filter((grade: Record<string, unknown>) => grade.candidate_id === candidateId) : [];
    });
    const preferred = rows.filter((row) => {
      const preferredId = row.parsed.preferred_candidate_id;
      return preferredId && row.candidate_map[preferredId] === label;
    }).length;
    return [label, {
      cases: grades.length,
      semantically_usable: grades.filter((grade: Record<string, unknown>) => grade.semantically_usable).length,
      preferred,
      mean_scores: Object.fromEntries(COMPARISON_SCORE_NAMES.map((dimension) => [
        dimension,
        grades.reduce((sum: number, grade: Record<string, any>) => sum + Number(grade.scores?.[dimension] ?? 0), 0) / Math.max(1, grades.length),
      ])),
      deterministic_opinion_ok: work.filter((item) => item.arms.find((arm) => arm.label === label)?.deterministic.opinion_ok).length,
      deterministic_target_ok: work.filter((item) => item.arms.find((arm) => arm.label === label)?.deterministic.target_ok).length,
    }];
  }));
  const summary = {
    cases: work.length,
    valid_comparisons: rows.length,
    grader_model: GRADER_MODEL,
    grader_effort: GRADER_EFFORT,
    comparison_prompt_version: COMPARISON_PROMPT_VERSION,
    arms,
    arm_files: Object.fromEntries(specs.map(({ label, file }) => [label, file])),
    comparison_file: gradeFile,
    raw_event_file: rawEventFile,
    call_ledger: path.resolve(ledger),
    call_budget: callBudget,
    call_budget_attempted_before_run: usedBeforeRun,
    codex_subscription: codexSubscription,
  };
  await writeFile(`${path.resolve(outStem)}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const source = "Smith J.A.\nThe court applied 2010 SCC 1 on notice and dismissed the appeal.";
    const valid = validateGold(source, {
      disposition_quote: "dismissed the appeal",
      opinions: [{
        opinion_key: "o1", writer_names: ["Smith"], collective_writer: null,
        writer_evidence_quote: "Smith J.A.", result_position: "supports_disposition",
        position_evidence_quote: "dismissed the appeal", start_quote: "The court applied 2010 SCC 1",
        end_quote: "dismissed the appeal",
      }],
      participants: [{
        name: "Smith", panel_evidence_quote: "Smith J.A.", result_position: "supports_disposition",
        result_evidence_quote: "dismissed the appeal", result_only: false,
        opinion_links: [{ opinion_key: "o1", relation: "authors", issue_keys: [], evidence_quote: "Smith J.A." }],
      }],
      issues: [{
        issue_key: "s1", question: "Should the appeal be dismissed?",
        answer_groups: [{ answer_group_key: "g1", answer: "Yes.", positions: [{ opinion_key: "o1", relation_to_disposition: "dispositive", answer_evidence_quotes: ["dismissed the appeal"] }] }],
      }],
      target_mentions: [{ mention_key: "m1", occurrence_id: "tm1", mention_quote: null, voice: "current_court", issue_keys: ["s1"], evidence_quote: "applied 2010 SCC 1" }],
      target_treatments: [{ mention_keys: ["m1"], issue_keys: ["s1"], attribution: "current_court", label: "applied", scope: "specific_proposition", evidence_quote: "The court applied 2010 SCC 1 on notice", target_proposition_as_characterized: "Notice governed." }],
      target_direct_history: [],
    }, ["tm1"]);
    const invalid = validateGrade(source, { critical_errors: [{ evidence_quote: "allowed the appeal" }] });
    const candidateIds = ["candidate_00000001", "candidate_00000002"];
    const comparison = validateComparison(source, {
      candidate_grades: candidateIds.map((candidate_id) => ({ candidate_id, critical_errors: [] })),
      ranking: candidateIds,
      preferred_candidate_id: "candidate_00000001",
      material_ties: [],
    }, candidateIds);
    if (valid.length || invalid.length !== 1 || comparison.length || "raw" in modelReceipt({ raw: "x", parsed: {}, error: null } as any)) {
      throw new Error("gold evaluator self-test failed");
    }
    console.log("PASS gold evaluator self-test");
    return;
  }
  if (process.argv.includes("--compare")) {
    await runComparison();
    return;
  }
  const pairFile = process.argv[2];
  const goldArg = flag("--gold");
  if (process.argv.includes("--validate-gold-only")) {
    if (!pairFile || !goldArg) throw new Error("usage: silver_case_target_eval.ts <pairs.json> --gold <gold-a.json[,gold-b.json]> --validate-gold-only");
    const manifest = JSON.parse(await readFile(path.resolve(pairFile), "utf8")) as Record<string, any>;
    const pairs = Array.isArray(manifest.pairs) ? manifest.pairs as Array<Record<string, any>> : [];
    if (!pairs.length) throw new Error("offline gold validation requires a pair manifest with frozen occurrences");
    const { files, rows } = await readGoldFiles(goldArg);
    const documentIds = rows.map((row) => Number(row.document_id));
    const duplicates = documentIds.filter((id, index) => documentIds.indexOf(id) !== index);
    if (duplicates.length) throw new Error(`duplicate human-gold document IDs: ${[...new Set(duplicates)].join(", ")}`);
    const expected = new Set(pairs.map((pair) => Number(pair.document_id)));
    const unknown = documentIds.filter((id) => !expected.has(id));
    const missing = [...expected].filter((id) => !documentIds.includes(id));
    if (unknown.length || missing.length) throw new Error(`human-gold cohort mismatch; unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"}`);
    const byDocument = new Map(rows.map((row) => [Number(row.document_id), row]));
    for (const pair of pairs) {
      const documentId = Number(pair.document_id);
      const source = fetchLocalA2AJDocumentById({
        id: documentId,
        language: String(pair.source?.language ?? "en"),
        maxChars: Number.MAX_SAFE_INTEGER,
      })?.text;
      const gold = byDocument.get(documentId);
      if (!source || !gold?.annotation) throw new Error(`missing source or human gold for ${documentId}`);
      const receipt = pair.selection_receipt ?? {};
      if (Number(receipt.source_chars) !== source.length || receipt.source_text_sha256 !== createHash("sha256").update(source, "utf8").digest("hex")) {
        throw new Error(`frozen source identity mismatch for ${documentId}`);
      }
      const occurrences = Array.isArray(receipt.target_occurrences)
        ? receipt.target_occurrences.map((item: Record<string, unknown>) => String(item.id))
        : [];
      if (!occurrences.length) throw new Error(`missing frozen target occurrences for ${documentId}`);
      const errors = validateGold(source, gold.annotation, occurrences);
      if (errors.length) throw new Error(`invalid human gold for ${documentId}: ${errors.join("; ")}`);
    }
    console.log(JSON.stringify({ cases: pairs.length, valid_human_gold: pairs.length, gold_files: files }, null, 2));
    return;
  }
  const candidateFiles = flag("--candidate-outputs").split(",").filter(Boolean);
  const outStem = flag("--out");
  const ledger = flag("--call-ledger");
  const runId = flag("--run-id", path.basename(outStem || "case-target-gold-eval"));
  const workers = Math.min(5, Math.max(1, Number(flag("--workers", "5"))));
  const timeoutSeconds = Math.max(1, Number(flag("--timeout-seconds", "1800")));
  const callBudget = Math.max(1, Number(flag("--call-budget", "15000")));
  if (!pairFile || !candidateFiles.length || !goldArg || !outStem || !ledger) {
    throw new Error("usage: silver_case_target_eval.ts <pairs.json> --candidate-outputs <a.jsonl,b.jsonl> --gold <gold-a.json[,gold-b.json]> --out <stem> --call-ledger <ledger.jsonl> [--workers 5]");
  }
  const codexSubscription = codexSubscriptionPreflight();
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  const { files: goldFiles, rows: goldRows } = await readGoldFiles(goldArg);
  const goldByDocument = new Map(goldRows.map((row) => [Number(row.document_id), row]));
  const outputsByDocument = await rawCandidates(candidateFiles.map((file) => path.resolve(file)));
  const work = await Promise.all(candidates.map(async (candidate) => {
    const record = await loadCase(candidate);
    const output = outputsByDocument.get(candidate.documentId);
    const gold = goldByDocument.get(candidate.documentId);
    if (!record || !output || !gold?.annotation) throw new Error(`missing case, candidate output, or human gold for ${candidate.documentId}`);
    const goldValidationErrors = validateGold(record.source.text, gold.annotation, record.targetOccurrences.map((item) => item.id));
    if (goldValidationErrors.length) {
      throw new Error(`invalid human gold for ${candidate.documentId}: ${goldValidationErrors.join("; ")}`);
    }
    const canonical = output.canonical ?? output.raw;
    return { candidate, record, raw: output.raw, canonical, gold, deterministic: validateCandidate(record, canonical) };
  }));
  await shutdownSourceStructureEngine();
  if (process.argv.includes("--validate-only")) {
    console.log(JSON.stringify({ cases: work.length, valid_human_gold: work.length }, null, 2));
    return;
  }
  await Promise.all([
    mkdir(path.dirname(path.resolve(outStem)), { recursive: true }),
    mkdir(path.dirname(path.resolve(ledger)), { recursive: true }),
  ]);
  const gradeFile = `${path.resolve(outStem)}.grades.jsonl`;
  const rawEventFile = `${path.resolve(outStem)}.raw-events.jsonl`;
  const existingGrades = new Map((await readJsonl(gradeFile)).map((row) => [Number(row.document_id), row]));
  const pending = work.filter(({ candidate }) => !existingGrades.has(candidate.documentId));
  const usedBeforeRun = await modelCallLedgerUsage(path.resolve(ledger));
  const plannedAttemptCeiling = pending.length * 2;
  if (usedBeforeRun + plannedAttemptCeiling > callBudget) {
    throw new Error(`call budget exceeded: ${usedBeforeRun} used + ${plannedAttemptCeiling} maximum attempts planned > ${callBudget}`);
  }
  await appendJsonl(path.resolve(ledger), {
    kind: "call_budget_checked", run_id: runId, budget: callBudget, attempted_before_run: usedBeforeRun,
    planned_calls: pending.length, planned_attempt_ceiling: plannedAttemptCeiling,
    remaining_after_attempt_ceiling: callBudget - usedBeforeRun - plannedAttemptCeiling,
  });

  await mapPool(pending, workers, async ({ candidate, record, raw, canonical, gold, deterministic }, index) => {
    process.stderr.write(`[grade ${index + 1}] ${candidate.citation}\n`);
    const result = await runLedgeredCall({
      ledger: path.resolve(ledger), runId, purpose: "gold_adjudication", documentId: candidate.documentId, citation: candidate.citation,
      call: {
        prompt: gradePrompt(record, canonical, raw, deterministic, gold.annotation), schema: GRADE_SCHEMA, schemaName: "a2aj_case_target_gold_grade_v3",
        responseFormat: { type: "json_schema", name: "a2aj_case_target_gold_grade_v3", strict: true, schema: GRADE_SCHEMA },
        model: GRADER_MODEL, effort: GRADER_EFFORT, timeoutSeconds,
        onEvent: async (_event, rawLine) => appendJsonl(rawEventFile, {
          kind: "codex_event_raw",
          document_id: candidate.documentId,
          citation: candidate.citation,
          raw_event_line: rawLine,
        }),
      },
    });
    const parsed = result.parsed as Record<string, any> | null;
    const validation_errors = parsed ? validateGrade(record.source.text, parsed) : [result.error ?? "missing parsed output"];
    const row = { kind: "gold_grade", document_id: candidate.documentId, citation: candidate.citation, gold_annotator: gold.annotator, grader_prompt_version: GRADER_PROMPT_VERSION, parsed, validation_errors, raw_model_output: result.raw, model_receipt: modelReceipt(result) };
    await appendJsonl(gradeFile, row);
    existingGrades.set(candidate.documentId, row);
    return row;
  });

  const grades = [...existingGrades.values()].filter((row) => row.parsed && !row.validation_errors?.length);
  const dimensions = Object.keys(GRADE_SCHEMA.properties.scores.properties);
  const means = Object.fromEntries(dimensions.map((dimension) => [dimension,
    grades.reduce((sum, row) => sum + Number(row.parsed.scores[dimension]), 0) / Math.max(1, grades.length),
  ]));
  const summary = {
    cases: work.length,
    valid_human_gold: work.length,
    valid_grades: grades.length,
    candidate_usable: grades.filter((row) => row.parsed.candidate_usable).length,
    grader_model: GRADER_MODEL,
    grader_effort: GRADER_EFFORT,
    grader_prompt_version: GRADER_PROMPT_VERSION,
    mean_scores: means,
    gold_files: goldFiles,
    candidate_output_files: candidateFiles.map((file) => path.resolve(file)),
    grade_file: gradeFile,
    raw_event_file: rawEventFile,
    call_ledger: path.resolve(ledger),
    call_budget: callBudget,
    call_budget_attempted_before_run: usedBeforeRun,
    codex_subscription: codexSubscription,
  };
  await writeFile(`${path.resolve(outStem)}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(shutdownSourceStructureEngine);
