import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CaseDecisionSubmission, DecisionStructure } from "../../../backend/experiments/a2aj-decision-roster/caseDecisionMvp";
import {
  compareDecisionMechanics,
  compareDecisionStructure,
  DECISION_SEMANTIC_JUDGE_SCHEMA,
  decisionSemanticJudgePrompt,
  decisionSemanticView,
} from "../../../backend/experiments/a2aj-decision-roster/caseDecisionBenchmark";
import {
  candidatesByDocumentIds,
  codexSubscriptionPreflight,
  loadCase,
  modelCallLedgerUsage,
  runStructuredLuna,
  validateDecisionMvp,
} from "../runner";

type GoldRow = { document_id: number; citation: string; annotation: CaseDecisionSubmission };

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function jsonl(file: string) {
  const text = await readFile(path.resolve(file), "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as Record<string, any>; }
    catch { throw new Error(`${file}:${index + 1}: invalid JSON`); }
  });
}

async function appendJsonl(file: string, value: unknown) {
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function rawSubmissions(rows: Record<string, any>[]) {
  const output = new Map<number, CaseDecisionSubmission>();
  for (const row of rows) {
    if (row.kind !== "model_output" || !["case_decision_mvp", "case_decision_two_stage"].includes(row.phase) || typeof row.raw_model_output !== "string") continue;
    try { output.set(Number(row.document), JSON.parse(row.raw_model_output) as CaseDecisionSubmission); }
    catch { /* validator reports the missing parseable submission */ }
  }
  return output;
}

function rawStructures(rows: Record<string, any>[]) {
  const output = new Map<number, DecisionStructure>();
  for (const row of rows) {
    if (row.kind !== "model_output" || row.phase !== "case_decision_structure" || typeof row.raw_model_output !== "string") continue;
    try { output.set(Number(row.document), JSON.parse(row.raw_model_output) as DecisionStructure); }
    catch { /* reported as a missing parseable structure */ }
  }
  return output;
}

const semanticExact = (left: CaseDecisionSubmission, right: CaseDecisionSubmission) =>
  JSON.stringify(decisionSemanticView(left)) === JSON.stringify(decisionSemanticView(right));

async function cases() {
  const goldFile = flag("--gold");
  const candidateFiles = flag("--candidates").split(",").map((value) => value.trim()).filter(Boolean);
  if (!goldFile || !candidateFiles.length) throw new Error("requires --gold and --candidates");
  const allGold = JSON.parse(await readFile(path.resolve(goldFile), "utf8")) as GoldRow[];
  const candidateRows = (await Promise.all(candidateFiles.map(jsonl))).flat();
  const attemptedIds = new Set(candidateRows
    .filter((row) => row.kind === "model_output" && [
      "case_decision_mvp",
      "case_decision_structure",
      "case_decision_treatment",
      "case_decision_two_stage",
    ].includes(row.phase))
    .map((row) => Number(row.document)));
  const gold = allGold.filter(({ document_id }) => attemptedIds.has(document_id));
  if (!gold.length) throw new Error("candidate file contains no decision outputs matching the gold set");
  const submissions = rawSubmissions(candidateRows);
  const structures = rawStructures(candidateRows);
  const records = new Map((await Promise.all(candidatesByDocumentIds(gold.map(({ document_id }) => document_id)).map(async (candidate) => {
    const record = await loadCase(candidate);
    return record ? [[candidate.documentId, record] as const] : [];
  }))).flat());
  return gold.map((reference) => {
    const candidate = submissions.get(reference.document_id) ?? null;
    const candidateStructure = candidate?.structure ?? structures.get(reference.document_id) ?? null;
    const record = records.get(reference.document_id);
    const validation = candidate && record ? validateDecisionMvp(record, candidate) : null;
    const valid = validation?.validation.ok === true && validation.case_decision_mvp?.ok === true;
    return {
      reference,
      candidate,
      valid,
      validation_errors: validation
        ? [...(validation.validation.errors ?? []), ...(validation.case_decision_mvp?.errors ?? [])]
        : [candidate ? "decision unavailable" : "parseable candidate missing"],
      structure_mechanics: candidateStructure ? compareDecisionStructure(reference.annotation.structure, candidateStructure) : null,
      mechanics: candidate ? compareDecisionMechanics(reference.annotation, candidate) : null,
      semantic_exact: candidate ? semanticExact(reference.annotation, candidate) : false,
    };
  });
}

async function validate() {
  const values = await cases();
  const out = flag("--out");
  const rows = values.map(({ reference, candidate: _candidate, ...value }) => ({
    document_id: reference.document_id,
    citation: reference.citation,
    ...value,
    judge_required: value.valid && !value.semantic_exact,
  }));
  const summary = {
    cases: rows.length,
    valid_candidates: rows.filter(({ valid }) => valid).length,
    parseable_structures: rows.filter(({ structure_mechanics }) => structure_mechanics !== null).length,
    structurally_exact: rows.filter(({ structure_mechanics }) => structure_mechanics?.exact).length,
    mechanically_exact: rows.filter(({ mechanics }) => mechanics?.exact).length,
    semantically_exact: rows.filter(({ semantic_exact }) => semantic_exact).length,
    judge_required: rows.filter(({ judge_required }) => judge_required).length,
    rows,
  };
  if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(path.resolve(out), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function mapPool<T>(items: T[], size: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  }));
}

async function judge() {
  const values = (await cases()).filter((value) => value.valid && value.candidate && !value.semantic_exact);
  const out = path.resolve(flag("--out"));
  const ledger = path.resolve(flag("--call-ledger"));
  if (!flag("--out") || !flag("--call-ledger")) throw new Error("judge requires --out and --call-ledger");
  const budget = Number(flag("--call-budget", "0"));
  const used = await modelCallLedgerUsage(ledger);
  if (!Number.isSafeInteger(budget) || budget < used + values.length) throw new Error(`call budget must cover ${used + values.length} total attempts`);
  codexSubscriptionPreflight();
  await mkdir(path.dirname(out), { recursive: true });
  await appendJsonl(ledger, { kind: "call_budget_checked", purpose: "case_decision_semantic_judge", budget, attempted_before_run: used, planned_calls: values.length });
  await mapPool(values, Math.min(10, Math.max(1, Number(flag("--workers", "5")))), async (value, index) => {
    const result = await runStructuredLuna({
      prompt: decisionSemanticJudgePrompt(value.reference.annotation, value.candidate!),
      schema: DECISION_SEMANTIC_JUDGE_SCHEMA,
      schemaName: "a2aj_case_decision_semantic_grade_v1",
      responseFormat: { type: "json_schema", name: "a2aj_case_decision_semantic_grade_v1", strict: true, schema: DECISION_SEMANTIC_JUDGE_SCHEMA },
      model: "gpt-5.6-sol",
      effort: "low",
      timeoutSeconds: Number(flag("--timeout-seconds", "1800")),
    });
    await appendJsonl(out, {
      document_id: value.reference.document_id,
      citation: value.reference.citation,
      parsed: result.parsed,
      raw_model_output: result.raw,
      error: result.error,
      usage: result.usage,
      elapsed_seconds: result.elapsedSeconds,
    });
    await appendJsonl(ledger, {
      kind: "model_call_finished",
      purpose: "case_decision_semantic_judge",
      document: value.reference.document_id,
      model: "gpt-5.6-sol",
      effort: "low",
      status: result.returnCode === 0 && !result.error ? "completed" : "failed",
      usage: result.usage,
    });
    process.stderr.write(`[judge ${index + 1}/${values.length}] ${value.reference.citation}\n`);
  });
}

async function showPrompt() {
  const documentId = Number(flag("--document-id"));
  const value = (await cases()).find(({ reference }) => reference.document_id === documentId);
  if (!value?.candidate) throw new Error("document has no candidate submission");
  console.log(decisionSemanticJudgePrompt(value.reference.annotation, value.candidate));
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") await validate();
  else if (command === "judge") await judge();
  else if (command === "show-prompt") await showPrompt();
  else throw new Error("commands: validate | judge | show-prompt");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
