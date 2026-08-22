import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { fetchLocalA2AJDocumentById } from "../../../backend/src/lib/a2ajLocalBulk";
import { modelSourceLines } from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  candidatesFromPairFile,
  codexSubscriptionPreflight,
  deterministicPrediction,
  loadCase,
  modelCallLedgerUsage,
  nameKey,
  runStructuredLuna,
  validateCaseTargetSubmission,
} from "../runner";
import {
  goldAuditState,
  groundedEvidence,
  validateFrozenGoldCase,
  validateGold,
} from "./gold_validation";

const GRADER_MODEL = "gpt-5.6-sol";
const GRADER_EFFORT = "low";
const GRADER_PROMPT_VERSION = "a2aj-case-target-treatment-by-issue-grader-v1";
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
    prompt_version: args.purpose === "gold_adjudication"
      ? GRADER_PROMPT_VERSION
      : COMPARISON_PROMPT_VERSION,
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
  "opinion_or_authorship_wrong",
  "vote_or_join_wrong",
  "issue_or_answer_wrong",
  "source_attribution_wrong",
  "target_treatment_wrong",
  "case_history_wrong",
  "other",
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

const GRADE_VERDICTS = ["pass", "minor_error", "major_error"] as const;
const TREATMENT_ERROR_ASPECTS = ["issue", "target_proposition", "treatment"] as const;

const GRADE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "errors"],
  properties: {
    verdict: { type: "string", enum: GRADE_VERDICTS },
    errors: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "aspect", "explanation"],
        properties: {
          severity: { type: "string", enum: ["minor", "major"] },
          aspect: { type: "string", enum: TREATMENT_ERROR_ASPECTS },
          explanation: { type: "string", minLength: 4 },
        },
      },
    },
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

function hasSemanticExtraction(output: CandidateOutput | undefined) {
  if (!output) return false;
  if (output.raw && typeof output.raw === "object" && !Array.isArray(output.raw)) return true;
  const canonical = output.canonical;
  return !!canonical && typeof canonical === "object" && !Array.isArray(canonical) &&
    (((canonical as Record<string, unknown>).prediction != null) ||
      ((canonical as Record<string, unknown>).case_target_mvp != null));
}

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
        byDocument.set(documentId, { ...current, raw: parsedOutput(event.raw_model_output) ?? event.raw_model_output ?? null });
      } else if (event.kind === "canonical_model_output") {
        const explicit = parsedOutput(event.canonical_model_output ?? event.canonical_output ?? event.model_output);
        const canonical = explicit ?? {
          compiler_version: event.compiler_version,
          validator_version: event.validator_version,
          source_sha256: event.source_sha256,
          raw_output_sha256: event.raw_output_sha256,
          target_occurrence_version: event.target_occurrence_version,
          target_occurrence_set_sha256: event.target_occurrence_set_sha256,
          prediction: event.prediction ?? null,
          case_target_mvp: event.case_target_mvp ?? null,
          compiler_errors: event.compiler_errors ?? [],
          opinion_validation: event.opinion_validation ?? null,
          recompile_receipt: event.recompile_receipt ?? null,
        };
        byDocument.set(documentId, {
          raw: parsedOutput(event.raw_model_output) ?? current.raw,
          canonical,
        });
      } else if (event.kind === "case_receipt" && event.receipt?.status === "successful") {
        const receipt = event.receipt as Record<string, any>;
        const attempt = Array.isArray(receipt.attempts)
          ? receipt.attempts[Number(receipt.accepted_attempt) - 1]
          : null;
        if (attempt?.ok) {
          byDocument.set(documentId, {
            raw: null,
            canonical: { prediction: attempt.prediction, case_target_mvp: attempt.target },
          });
        }
      }
    }
  }
  return byDocument;
}

function semanticView(value: unknown) {
  const canonical = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
  const prediction = canonical.prediction ?? {};
  const target = canonical.case_target_mvp ?? {};
  const legalActor = (voice: string) => ({
    current_court: "current_court",
    party_submission: "party_or_counsel",
    reported_decision: "decision_under_review",
    quoted_authority: "other_source",
    document_metadata: "metadata",
    unclear: "unclear",
  })[voice] ?? "unclear";
  return {
    disposition: prediction.disposition_quote ?? null,
    opinions: (prediction.opinions ?? []).map((opinion: Record<string, any>) => ({
      id: opinion.id,
      authors: opinion.author_names,
      collective_author: opinion.collective_author,
      result_position: opinion.result_position,
      authority_position: opinion.authority_position,
      result_evidence: opinion.position_evidence_quote,
      start_offset: opinion.start,
      end_offset: opinion.end_exclusive,
      start: opinion.start_quote,
      end: opinion.end_quote,
    })),
    decision_makers: (prediction.participants ?? []).map((participant: Record<string, any>) => ({
      name: participant.name,
      panel_evidence: participant.panel_evidence_quote,
      result_position: participant.result_position,
      result_side: participant.result_side,
      relationship: participant.relationship,
      opinion_links: participant.opinion_links,
      result_only: participant.result_only,
      result_only_evidence: participant.result_only_evidence_quote,
    })),
    nonparticipants: prediction.nonparticipants ?? [],
    issues: target.case_issues ?? [],
    opinion_issue_positions: (target.opinion_issue_positions ?? []).map((position: Record<string, any>) => ({
      id: position.id,
      issue_id: position.case_issue_id,
      opinion_id: position.opinion_id,
      answer_group_id: position.answer_group_id,
      answer: position.answer,
      relation_to_disposition: position.relation_to_disposition,
      answer_evidence_ids: position.answer_evidence_ids,
      evidence: position.evidence,
    })),
    issue_only_joins: target.partial_issue_joins ?? [],
    occurrence_assessments: (target.target_mentions ?? []).map((mention: Record<string, any>) => ({
      id: mention.id,
      occurrence_id: mention.occurrence_id,
      opinion_id: mention.opinion_id,
      target_identity: mention.target_identity,
      source_origin: mention.source_origin,
      legal_actor: legalActor(mention.voice),
      issue_ids: mention.case_issue_ids,
    })),
    target_treatments: (target.target_treatments ?? []).map((treatment: Record<string, any>) => ({
      id: treatment.id,
      occurrence_assessment_ids: treatment.mention_ids,
      opinion_id: treatment.opinion_id,
      issue_ids: treatment.case_issue_ids,
      treated_by: legalActor(treatment.attribution),
      label: treatment.label,
      scope: treatment.scope === "specific_proposition" ? "rule_or_proposition" : treatment.scope,
      evidence: treatment.evidence_quote,
      target_proposition_as_characterized: treatment.target_proposition_as_characterized,
    })),
    case_history: target.target_direct_history ?? [],
  };
}

function boundaryReceipt(candidate: ReturnType<typeof semanticView>, reference: ReturnType<typeof semanticView>) {
  const count = Math.max(candidate.opinions.length, reference.opinions.length);
  const comparisons = Array.from({ length: count }, (_, index) => {
    const candidateOpinion = candidate.opinions[index] ?? null;
    const referenceOpinion = reference.opinions[index] ?? null;
    return {
      opinion_number: index + 1,
      start_exact: candidateOpinion?.start === referenceOpinion?.start,
      end_exact: candidateOpinion?.end === referenceOpinion?.end,
      candidate: candidateOpinion ? { start: candidateOpinion.start, end: candidateOpinion.end } : null,
      reference: referenceOpinion ? { start: referenceOpinion.start, end: referenceOpinion.end } : null,
    };
  });
  return {
    candidate_opinions: candidate.opinions.length,
    reference_opinions: reference.opinions.length,
    exact: candidate.opinions.length === reference.opinions.length
      && comparisons.every(({ start_exact, end_exact }) => start_exact && end_exact),
    comparisons,
  };
}

function votingClaims(view: ReturnType<typeof semanticView>) {
  const claims = new Map<string, string>();
  const opinionNumber = new Map(view.opinions.map((opinion: Record<string, any>, index: number) => [opinion.id, index + 1]));
  view.opinions.forEach((opinion: Record<string, any>, index: number) => {
    const prefix = `opinion:${index + 1}`;
    if (opinion.result_position && opinion.result_position !== "unclear") claims.set(`${prefix}:result`, opinion.result_position);
    if (opinion.authority_position && opinion.authority_position !== "unknown") claims.set(`${prefix}:authority`, opinion.authority_position);
    const authors = (opinion.authors ?? []).map((name: string) => nameKey(name)).filter(Boolean).sort();
    for (const author of authors) claims.set(`${prefix}:author:${author}`, "true");
    if (opinion.collective_author) claims.set(`${prefix}:collective_author`, String(opinion.collective_author).trim().toLocaleLowerCase());
  });
  for (const judge of view.decision_makers as Array<Record<string, any>>) {
    const name = nameKey(String(judge.name ?? ""));
    if (!name) continue;
    const prefix = `judge:${name}`;
    if (judge.result_position && judge.result_position !== "unclear") claims.set(`${prefix}:result`, judge.result_position);
    if (judge.result_side && judge.result_side !== "unknown") claims.set(`${prefix}:side`, judge.result_side);
    if (judge.relationship && judge.relationship !== "unknown") claims.set(`${prefix}:relationship`, judge.relationship);
    for (const link of judge.opinion_links ?? []) {
      claims.set(`${prefix}:link:${opinionNumber.get(link.opinion_id) ?? "unmatched"}`, link.relation);
    }
  }
  return claims;
}

function compareVotingClaims(
  candidate: Map<string, string>,
  reference: Map<string, string>,
  keys = new Set(reference.keys()),
  includeExtra: (key: string) => boolean = () => true,
) {
  let correct = 0;
  let missing = 0;
  let wrong = 0;
  const differences: Array<{ claim: string; expected: string | null; actual: string | null }> = [];
  const expectedKeys = [...keys].filter((key) => reference.has(key));
  for (const key of expectedKeys) {
    if (!candidate.has(key)) {
      missing += 1;
      differences.push({ claim: key, expected: reference.get(key) ?? null, actual: null });
    }
    else if (candidate.get(key) === reference.get(key)) correct += 1;
    else {
      wrong += 1;
      differences.push({ claim: key, expected: reference.get(key) ?? null, actual: candidate.get(key) ?? null });
    }
  }
  const extras = [...candidate.keys()].filter((key) => !reference.has(key) && includeExtra(key));
  differences.push(...extras.map((claim) => ({ claim, expected: null, actual: candidate.get(claim) ?? null })));
  return { expected: expectedKeys.length, correct, missing, wrong, extra: extras.length, exact: correct === expectedKeys.length && wrong === 0 && extras.length === 0, differences };
}

function votingReceipt(
  luna: ReturnType<typeof semanticView>,
  reference: ReturnType<typeof semanticView>,
  deterministic: ReturnType<typeof semanticView> | null,
) {
  const goldClaims = votingClaims(reference);
  const lunaClaims = votingClaims(luna);
  const deterministicClaims = deterministic ? votingClaims(deterministic) : new Map<string, string>();
  const deterministicScore = compareVotingClaims(deterministicClaims, goldClaims, new Set(deterministicClaims.keys()));
  const uncovered = new Set([...goldClaims.keys()].filter((key) => !deterministicClaims.has(key)));
  const lunaGapScore = compareVotingClaims(lunaClaims, goldClaims, uncovered);
  const combined = new Map(lunaClaims);
  for (const [key, value] of deterministicClaims) combined.set(key, value);
  const lunaScore = compareVotingClaims(lunaClaims, goldClaims);
  const combinedScore = compareVotingClaims(combined, goldClaims);
  const majorityMinority = (key: string) => key.endsWith(":result") || key.endsWith(":authority") || key.endsWith(":side");
  const writer = (key: string) => key.includes(":author:") || key.endsWith(":collective_author");
  const join = (key: string) => key.includes(":link:") || key.endsWith(":relationship");
  const majorityMinorityKeys = new Set([...goldClaims.keys()].filter(majorityMinority));
  const writerKeys = new Set([...goldClaims.keys()].filter(writer));
  const joinKeys = new Set([...goldClaims.keys()].filter(join));
  const nontrivial = reference.opinions.length > 1 || reference.opinions.some((opinion: Record<string, any>) =>
    !["unanimous", "majority"].includes(opinion.authority_position)
  );
  return {
    nontrivial,
    luna: lunaScore,
    majority_minority: compareVotingClaims(lunaClaims, goldClaims, majorityMinorityKeys, majorityMinority),
    writers: compareVotingClaims(lunaClaims, goldClaims, writerKeys, writer),
    joins: compareVotingClaims(lunaClaims, goldClaims, joinKeys, join),
    deterministic: deterministic ? {
      ...deterministicScore,
      asserted: deterministicClaims.size,
      precision: deterministicClaims.size ? deterministicScore.correct / deterministicClaims.size : null,
      gold_coverage: goldClaims.size ? deterministicScore.correct / goldClaims.size : null,
      zero_known_false_positives: deterministicScore.wrong === 0 && deterministicScore.extra === 0,
    } : null,
    luna_on_deterministic_gaps: lunaGapScore,
    combined: combinedScore,
  };
}

function treatmentByIssueView(view: ReturnType<typeof semanticView>) {
  const opinionNumber = new Map(view.opinions.map((opinion: Record<string, any>, index: number) => [opinion.id, index + 1]));
  const treatmentSummary = (treatment: Record<string, any>, issueId: string | null = null) => {
    const position = view.opinion_issue_positions.find((item: Record<string, any>) =>
      item.opinion_id === treatment.opinion_id && item.issue_id === issueId
    );
    return {
      opinion_number: opinionNumber.get(treatment.opinion_id) ?? null,
      opinion_answer: position?.answer ?? null,
      relation_to_disposition: position?.relation_to_disposition ?? null,
      treatment: treatment.label,
      scope: treatment.scope,
      target_proposition: treatment.target_proposition_as_characterized,
      evidence: treatment.evidence,
    };
  };
  return {
    treatments: [
      ...view.issues.flatMap((issue: Record<string, any>) => {
        const treatments = view.target_treatments.filter((treatment: Record<string, any>) => treatment.issue_ids.includes(issue.id));
        return treatments.map((treatment: Record<string, any>) => ({
          issue: issue.question,
          ...treatmentSummary(treatment, issue.id),
        }));
      }),
      ...view.target_treatments
        .filter((treatment: Record<string, any>) => treatment.issue_ids.length === 0)
        .map((treatment: Record<string, any>) => ({ issue: null, ...treatmentSummary(treatment) })),
    ],
  };
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
    "[POSSIBLE REFERENCES TO THE TARGET]",
    JSON.stringify(record.targetOccurrences.map(({ id, kind, quote, linkedContext }) => ({ id, kind, text: quote, context: linkedContext?.quote ?? null })), null, 2),
    "[COMPLETE CITING DECISION — the line number before each colon is not decision text]",
    modelSourceLines(record.source.text).map((line) => `${line.line}: ${record.source.text.slice(line.start, line.end)}`).join("\n"),
  ].join("\n\n");
}

function gradePrompt(candidate: unknown, reference: unknown) {
  return `Compare the candidate treatment-by-issue summary with the verified reference.

Judge only whether the candidate preserves:
- the material legal issue on which the target case is discussed;
- the proposition the decision attributes to the target case; and
- what the decision does with that proposition.

Different wording or organization is acceptable when the legal meaning is the same.
pass: no semantic error.
minor_error: a localized imprecision that would not materially mislead legal research.
major_error: an omission or mistake that could materially mislead legal research.

List only actual errors in the candidate. Return only schema JSON.

[CANDIDATE]
${JSON.stringify(candidate, null, 2)}

[VERIFIED REFERENCE]
${JSON.stringify(reference, null, 2)}`;
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

function validateGrade(grade: Record<string, any>) {
  const errors: string[] = [];
  const severities = (grade.errors ?? []).map((item: Record<string, unknown>) => item.severity);
  const expectedVerdict = severities.includes("major")
    ? "major_error"
    : severities.includes("minor")
      ? "minor_error"
      : "pass";
  if (grade.verdict !== expectedVerdict) errors.push(`verdict must be ${expectedVerdict} for the reported errors`);
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
    const opinionValidation = canonical.opinion_validation;
    const opinionOk = typeof opinionValidation?.ok === "boolean"
      ? opinionValidation.ok
      : canonical.prediction != null;
    return {
      opinion_ok: opinionOk,
      opinion_error: opinionOk ? null : opinionValidation?.error ?? opinionValidation?.errors?.join("; ") ?? "opinion extraction rejected",
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
    const valid = validateGrade({ verdict: "minor_error", errors: [{ severity: "minor", aspect: "treatment", explanation: "Slightly too broad." }] });
    const invalid = validateGrade({ verdict: "pass", errors: [{ severity: "major", aspect: "issue", explanation: "A material issue is missing." }] });
    const candidateIds = ["candidate_00000001", "candidate_00000002"];
    const comparison = validateComparison(source, {
      candidate_grades: candidateIds.map((candidate_id) => ({ candidate_id, critical_errors: [] })),
      ranking: candidateIds,
      preferred_candidate_id: "candidate_00000001",
      material_ties: [],
    }, candidateIds);
    const boundary = boundaryReceipt(
      semanticView({ prediction: { opinions: [{ start_quote: "A", end_quote: "B" }] } }),
      semanticView({ prediction: { opinions: [{ start_quote: "A", end_quote: "B" }] } }),
    );
    const voting = votingReceipt(
      semanticView({ prediction: { opinions: [{ id: "o1", result_position: "supports_disposition", authority_position: "unanimous" }] } }),
      semanticView({ prediction: { opinions: [{ id: "o1", result_position: "supports_disposition", authority_position: "unanimous" }] } }),
      null,
    );
    if (valid.length || invalid.length !== 1 || !boundary.exact || !voting.luna.exact || comparison.length || "raw" in modelReceipt({ raw: "x", parsed: {}, error: null } as any)) {
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
    const allowPartial = process.argv.includes("--allow-partial-gold");
    if (unknown.length || (!allowPartial && missing.length)) throw new Error(`human-gold cohort mismatch; unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"}`);
    const byDocument = new Map(rows.map((row) => [Number(row.document_id), row]));
    for (const pair of pairs.filter((item) => byDocument.has(Number(item.document_id)))) {
      const documentId = Number(pair.document_id);
      const source = fetchLocalA2AJDocumentById({
        id: documentId,
        language: String(pair.source?.language ?? "en"),
        maxChars: Number.MAX_SAFE_INTEGER,
      })?.text;
      const gold = byDocument.get(documentId);
      if (!source || !gold?.annotation) throw new Error(`missing source or human gold for ${documentId}`);
      const errors = [
        ...goldAuditState(gold).errors,
        ...validateFrozenGoldCase(source, pair, gold.annotation),
      ];
      if (errors.length) throw new Error(`invalid human gold for ${documentId}: ${errors.join("; ")}`);
    }
    console.log(JSON.stringify({ cases: pairs.length, valid_human_gold: rows.length, partial: allowPartial, gold_files: files }, null, 2));
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
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  const { files: goldFiles, rows: goldRows } = await readGoldFiles(goldArg);
  const goldByDocument = new Map(goldRows.map((row) => [Number(row.document_id), row]));
  const outputsByDocument = await rawCandidates(candidateFiles.map((file) => path.resolve(file)));
  const missingCandidateOutputs = candidates
    .filter((candidate) => !hasSemanticExtraction(outputsByDocument.get(candidate.documentId)))
    .map((candidate) => ({ document_id: candidate.documentId, citation: candidate.citation }));
  const loaded = await Promise.all(candidates.filter((candidate) => hasSemanticExtraction(outputsByDocument.get(candidate.documentId))).map(async (candidate) => {
    const record = await loadCase(candidate);
    const output = outputsByDocument.get(candidate.documentId);
    const gold = goldByDocument.get(candidate.documentId);
    if (!record || !output || !gold?.annotation) throw new Error(`missing case or human gold for ${candidate.documentId}`);
    const goldValidationErrors = [
      ...goldAuditState(gold).errors,
      ...validateGold(record.source.text, gold.annotation, record.targetOccurrences),
    ];
    if (goldValidationErrors.length) {
      throw new Error(`invalid human gold for ${candidate.documentId}: ${goldValidationErrors.join("; ")}`);
    }
    const canonical = output.canonical ?? output.raw;
    const candidateValidation = validateCandidate(record, canonical);
    const compiledGold = validateCaseTargetSubmission(record, gold.annotation);
    if (!compiledGold.validation.ok || compiledGold.case_target_mvp?.ok !== true) {
      throw new Error(`Gold compilation failed for ${candidate.documentId}`);
    }
    return {
      candidate,
      record,
      candidateView: semanticView(canonical),
      goldView: semanticView({ prediction: compiledGold.prediction, case_target_mvp: compiledGold.case_target_mvp }),
      deterministicView: (() => {
        const prediction = deterministicPrediction(record);
        return prediction ? semanticView({ prediction }) : null;
      })(),
      goldAnnotator: gold.annotator,
      candidateValidation,
    };
  }));
  const invalidCandidateOutputs = loaded.filter(({ candidateValidation }) =>
    !candidateValidation.opinion_ok || !candidateValidation.target_ok
  ).map(({ candidate, candidateValidation }) => ({
    document_id: candidate.documentId,
    citation: candidate.citation,
    validation: candidateValidation,
  }));
  const work = loaded.filter(({ candidateValidation }) =>
    candidateValidation.opinion_ok && candidateValidation.target_ok
  ).map((item) => {
    const boundaries = boundaryReceipt(item.candidateView, item.goldView);
    const candidateTreatment = treatmentByIssueView(item.candidateView);
    const goldTreatment = treatmentByIssueView(item.goldView);
    return {
      ...item,
      boundaries,
      voting: votingReceipt(item.candidateView, item.goldView, item.deterministicView),
      candidateTreatment,
      goldTreatment,
      treatmentExact: JSON.stringify(candidateTreatment) === JSON.stringify(goldTreatment),
    };
  });
  await shutdownSourceStructureEngine();
  if (process.argv.includes("--validate-only")) {
    console.log(JSON.stringify({
      cases: candidates.length,
      candidate_outputs: work.length,
      valid_human_gold_for_candidate_outputs: work.length,
      missing_candidate_outputs: missingCandidateOutputs,
      invalid_candidate_outputs: invalidCandidateOutputs,
    }, null, 2));
    return;
  }
  await Promise.all([
    mkdir(path.dirname(path.resolve(outStem)), { recursive: true }),
    mkdir(path.dirname(path.resolve(ledger)), { recursive: true }),
  ]);
  const gradeFile = `${path.resolve(outStem)}.grades.jsonl`;
  const rawEventFile = `${path.resolve(outStem)}.raw-events.jsonl`;
  const existingGrades = new Map((await readJsonl(gradeFile))
    .filter((row) => row.grader_prompt_version === GRADER_PROMPT_VERSION)
    .map((row) => [Number(row.document_id), row]));
  for (const { candidate, boundaries, treatmentExact } of work) {
    if (!treatmentExact || existingGrades.has(candidate.documentId)) continue;
    const row = {
      kind: "gold_grade",
      document_id: candidate.documentId,
      citation: candidate.citation,
      grader_prompt_version: GRADER_PROMPT_VERSION,
      boundary_receipt: boundaries,
      treatment_exact: true,
      judge_required: false,
      parsed: { verdict: "pass", errors: [] },
      validation_errors: [],
    };
    await appendJsonl(gradeFile, row);
    existingGrades.set(candidate.documentId, row);
  }
  const pending = work.filter(({ candidate, treatmentExact }) => !treatmentExact && !existingGrades.has(candidate.documentId));
  const codexSubscription = pending.length ? codexSubscriptionPreflight() : null;
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

  await mapPool(pending, workers, async ({ candidate, boundaries, candidateTreatment, goldTreatment }, index) => {
    process.stderr.write(`[grade ${index + 1}] ${candidate.citation}\n`);
    const result = await runLedgeredCall({
      ledger: path.resolve(ledger), runId, purpose: "gold_adjudication", documentId: candidate.documentId, citation: candidate.citation,
      call: {
        prompt: gradePrompt(candidateTreatment, goldTreatment), schema: GRADE_SCHEMA, schemaName: "a2aj_case_target_treatment_by_issue_grade_v1",
        responseFormat: { type: "json_schema", name: "a2aj_case_target_treatment_by_issue_grade_v1", strict: true, schema: GRADE_SCHEMA },
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
    const validation_errors = parsed ? validateGrade(parsed) : [result.error ?? "missing parsed output"];
    const row = {
      kind: "gold_grade",
      document_id: candidate.documentId,
      citation: candidate.citation,
      grader_prompt_version: GRADER_PROMPT_VERSION,
      boundary_receipt: boundaries,
      treatment_exact: false,
      judge_required: true,
      parsed,
      validation_errors,
      raw_model_output: result.raw,
      model_receipt: modelReceipt(result),
    };
    await appendJsonl(gradeFile, row);
    existingGrades.set(candidate.documentId, row);
    return row;
  });

  const judgeOutputs = [...existingGrades.values()].filter((row) => row.parsed && !row.validation_errors?.length);
  const grades = judgeOutputs;
  const verdicts = Object.fromEntries(GRADE_VERDICTS.map((verdict) => [verdict,
    grades.filter((row) => row.parsed.verdict === verdict).length,
  ]));
  const boundaryComparisons = work.flatMap(({ boundaries }) => boundaries.comparisons);
  const votingCases = work.map(({ candidate, voting }) => ({ document_id: candidate.documentId, citation: candidate.citation, ...voting }));
  const deterministicVoting = votingCases.flatMap(({ deterministic }) => deterministic ? [deterministic] : []);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const summary = {
    cases: candidates.length,
    candidate_outputs: work.length,
    missing_candidate_outputs: missingCandidateOutputs,
    invalid_candidate_outputs: invalidCandidateOutputs,
    valid_human_gold: work.length,
    valid_judge_outputs: judgeOutputs.length,
    valid_grades: grades.length,
    verdicts,
    opinion_boundaries: {
      exact_cases: work.filter(({ boundaries }) => boundaries.exact).length,
      cases_compared: work.length,
      exact_starts: boundaryComparisons.filter(({ start_exact }) => start_exact).length,
      exact_ends: boundaryComparisons.filter(({ end_exact }) => end_exact).length,
      boundaries_compared: boundaryComparisons.length,
    },
    opinion_voting: {
      cases_compared: votingCases.length,
      nontrivial_cases: votingCases.filter(({ nontrivial }) => nontrivial).length,
      luna_full_voting_graph_exact_cases: votingCases.filter(({ luna }) => luna.exact).length,
      luna_majority_minority_exact_cases: votingCases.filter(({ majority_minority }) => majority_minority.exact).length,
      luna_majority_minority_exact_nontrivial_cases: votingCases.filter(({ majority_minority, nontrivial }) => nontrivial && majority_minority.exact).length,
      luna_writers_exact_cases: votingCases.filter(({ writers }) => writers.exact).length,
      luna_joins_exact_cases: votingCases.filter(({ joins }) => joins.exact).length,
      deterministic_available_cases: deterministicVoting.length,
      deterministic_asserted_claims: sum(deterministicVoting.map(({ asserted }) => asserted)),
      deterministic_correct_claims: sum(deterministicVoting.map(({ correct }) => correct)),
      deterministic_wrong_claims: sum(deterministicVoting.map(({ wrong, extra }) => wrong + extra)),
      deterministic_zero_known_false_positives: deterministicVoting.every(({ zero_known_false_positives }) => zero_known_false_positives),
      luna_gap_expected_claims: sum(votingCases.map(({ luna_on_deterministic_gaps }) => luna_on_deterministic_gaps.expected)),
      luna_gap_correct_claims: sum(votingCases.map(({ luna_on_deterministic_gaps }) => luna_on_deterministic_gaps.correct)),
      combined_exact_cases: votingCases.filter(({ combined }) => combined.exact).length,
      cases: votingCases,
    },
    treatment_by_issue: {
      exact_cases_without_judge: work.filter(({ treatmentExact }) => treatmentExact).length,
      judge_required: work.filter(({ treatmentExact }) => !treatmentExact).length,
    },
    grader_model: GRADER_MODEL,
    grader_effort: GRADER_EFFORT,
    grader_prompt_version: GRADER_PROMPT_VERSION,
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
