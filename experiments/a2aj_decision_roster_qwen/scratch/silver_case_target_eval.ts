import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

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
import { groundedEvidence, validateFrozenGoldCase, validateGold } from "./gold_validation";

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
      const errors = validateFrozenGoldCase(source, pair, gold.annotation);
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
