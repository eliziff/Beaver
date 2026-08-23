import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

import {
  caseDecisionStructureOutputSchema,
  caseDecisionTreatmentOutputSchema,
  decisionCitationInventory,
  mergeCaseDecisionStages,
  type CaseDecisionStructureSubmission,
  type CaseDecisionTreatmentSubmission,
} from "../../../backend/experiments/a2aj-decision-roster/caseDecisionMvp";
import {
  candidatesByDocumentIds,
  codexSubscriptionPreflight,
  decisionStructurePacket,
  decisionTreatmentPacket,
  loadCase,
  modelCallLedgerUsage,
  validateDecisionMvp,
  validateDecisionStructure,
} from "../runner";
import { streamChatWithTools } from "../../../backend/src/lib/llm";
import { shutdownCodexAppServers } from "../../../backend/src/lib/llm/codexAppServer";
import { setBelowNormalProcessPriority } from "../../../backend/src/lib/processPriority";
import { createA2AJPassageEvidence } from "../../../backend/src/lib/chat/legalEvidence";

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const now = () => new Date().toISOString();
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function appendJsonl(file: string, value: Record<string, unknown>) {
  await appendFile(file, `${JSON.stringify({ utc: now(), ...value })}\n`, "utf8");
}

function outputFile(base: string, suffix: string) {
  return base.endsWith(".json") ? base.replace(/\.json$/u, suffix) : `${base}${suffix}`;
}

function parseIds() {
  const ids = flag("--document-ids").split(/[\s,]+/u).filter(Boolean).map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("--document-ids must contain positive integers");
  }
  return [...new Set(ids)];
}

function parseJson(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}

function repairReceipts(errors: string[], grounding: any) {
  if (!grounding) return [];
  const selected: unknown[] = [];
  const take = (name: "references" | "quoted_passages" | "treatments") => {
    const indexes = new Set(errors.flatMap((error) => {
      const match = new RegExp(`analysis\\.${name}\\[(\\d+)\\]`, "u").exec(error);
      return match ? [Number(match[1])] : [];
    }));
    for (const index of indexes) if (grounding[name]?.[index]) selected.push(grounding[name][index]);
  };
  take("references"); take("quoted_passages"); take("treatments");
  return selected;
}

function correctionMessages(draft: string, errors: string[], grounding: unknown) {
  return [
    { role: "assistant" as const, content: draft },
    {
      role: "user" as const,
      content: [
        "Correct the JSON and return the complete object, without explanation.",
        "The host found these errors:",
        ...errors.map((error) => `- ${error}`),
        "Exact source receipts for affected fields:",
        JSON.stringify(repairReceipts(errors, grounding)),
      ].join("\n"),
    },
  ];
}

function evidenceReceipts(record: NonNullable<Awaited<ReturnType<typeof loadCase>>>, grounding: any) {
  const receipts = new Map<string, ReturnType<typeof createA2AJPassageEvidence>>();
  const add = (start: number, end: number, blockId: string) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > record.source.text.length) return;
    const receipt = createA2AJPassageEvidence({
      citation: record.candidate.citation,
      name: record.candidate.name,
      dataset: record.candidate.dataset,
      language: record.document.language,
      sourceText: record.source.text,
      spanText: record.source.text.slice(start, end),
      start, end,
      externalUrl: record.document.url,
      sourceClass: "case",
      blockId,
    });
    receipts.set(receipt.evidence_id, receipt);
  };
  for (const reference of grounding?.references ?? []) {
    for (const [index, span] of (reference.source_matches ?? []).entries()) add(span.start, span.end, `case-decision:reference:${reference.reference_id}:${index}`);
  }
  for (const quote of grounding?.quoted_passages ?? []) {
    for (const [index, span] of (quote.source_matches ?? []).entries()) add(span.start, span.end, `case-decision:quote:${quote.quote_id}:${index}`);
  }
  for (const treatment of grounding?.treatments ?? []) {
    if (treatment.evidence) add(treatment.evidence.start, treatment.evidence.end, `case-decision:treatment:${treatment.treatment_index}`);
  }
  return [...receipts.values()];
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

async function main() {
  setBelowNormalProcessPriority();
  const ids = parseIds();
  const model = flag("--model", "gpt-5.6-luna");
  const effort = flag("--effort", "max");
  const out = path.resolve(flag("--out"));
  const ledger = path.resolve(flag("--call-ledger"));
  if (!flag("--out") || !flag("--call-ledger")) throw new Error("requires --out and --call-ledger");
  const outputs = outputFile(out, ".outputs.jsonl");
  const progress = outputFile(out, ".progress.jsonl");
  const receipts = outputFile(out, ".receipts.jsonl");
  const workers = Math.min(10, Math.max(1, Number(flag("--workers", "5"))));
  const timeoutSeconds = Math.max(1, Number(flag("--timeout-seconds", "1800")));
  const maxCorrections = Math.min(5, Math.max(0, Number(flag("--max-corrections", "2"))));
  const budget = Number(flag("--call-budget", "0"));
  const used = await modelCallLedgerUsage(ledger);
  const attemptCeiling = ids.length * 2 * (1 + maxCorrections);
  if (!Number.isSafeInteger(budget) || budget < used + attemptCeiling) {
    throw new Error(`call budget must cover ${used + attemptCeiling} total attempts`);
  }
  codexSubscriptionPreflight();
  await mkdir(path.dirname(out), { recursive: true });
  await Promise.all([out, outputs, progress, receipts].map((file) => writeFile(file, "", "utf8")));
  await appendJsonl(ledger, { kind: "call_budget_checked", purpose: "two_stage_decision_extraction", budget, attempted_before_run: used, planned_calls: ids.length * 2, planned_attempt_ceiling: attemptCeiling });

  const candidates = candidatesByDocumentIds(ids);
  const byId = new Map(candidates.map((candidate) => [candidate.documentId, candidate]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`decisions unavailable: ${missing.join(", ")}`);
  const results: Record<string, unknown>[] = [];

  async function call(
    record: Awaited<ReturnType<typeof loadCase>> & {},
    stage: string,
    messages: Array<{ role: "assistant" | "user"; content: string }>,
    schema: any,
    continuationId?: string,
  ) {
    const callId = randomUUID();
    const prompt = JSON.stringify(messages);
    await appendJsonl(ledger, { kind: "model_call_started", call_id: callId, purpose: `case_decision_${stage}`, document: record.candidate.documentId, model, effort, prompt_sha256: sha256(prompt), prompt_chars: messages.reduce((sum, message) => sum + message.content.length, 0) });
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
    let rawQueue = Promise.resolve();
    let rawBuffer = "";
    const flushRaw = () => {
      if (!rawBuffer) return;
      const text = rawBuffer; rawBuffer = "";
      rawQueue = rawQueue.then(() => appendJsonl(outputs, { kind: "model_output_delta", phase: `case_decision_${stage}`, document: record.candidate.documentId, text }));
    };
    try {
      const result = await streamChatWithTools({
        model: model.startsWith("codex:") ? model : `codex:${model}`,
        reasoningEffort: effort,
        systemPrompt: "Analyze only the supplied court decision. Return exactly the host-enforced JSON object without commentary.",
        messages,
        outputSchema: schema,
        abortSignal: controller.signal,
        callbacks: { onContentDelta(text) { rawBuffer += text; if (rawBuffer.length >= 4_096) flushRaw(); } },
        providerSession: { persist: true, ...(continuationId ? { continuationId } : {}) },
      });
      flushRaw(); await rawQueue;
      const outputSha256 = sha256(result.fullText);
      await appendJsonl(ledger, { kind: "model_call_finished", call_id: callId, purpose: `case_decision_${stage}`, document: record.candidate.documentId, status: "completed", elapsed_seconds: Math.round((Date.now() - started) / 10) / 100, usage: result.usage ?? null, output_sha256: outputSha256 });
      await appendJsonl(outputs, { kind: "model_output", phase: `case_decision_${stage}`, document: record.candidate.documentId, raw_model_output: result.fullText, output_sha256: outputSha256, continuation_id: result.continuationId ?? null });
      return { raw: result.fullText, parsed: parseJson(result.fullText), error: null, outputSha256, continuationId: result.continuationId ?? null, usage: result.usage ?? null };
    } catch (error) {
      flushRaw(); await rawQueue;
      const message = error instanceof Error ? error.message : String(error);
      await appendJsonl(ledger, { kind: "model_call_finished", call_id: callId, purpose: `case_decision_${stage}`, document: record.candidate.documentId, status: "failed", elapsed_seconds: Math.round((Date.now() - started) / 10) / 100, error: message });
      return { raw: "", parsed: null, error: message, outputSha256: sha256(""), continuationId: null, usage: null };
    } finally {
      clearTimeout(timer);
    }
  }

  await mapPool(ids, workers, async (documentId, index) => {
    const candidate = byId.get(documentId)!;
    process.stderr.write(`[${index + 1}/${ids.length}] ${candidate.citation}\n`);
    await appendJsonl(progress, { kind: "case_started", document: documentId, citation: candidate.citation });
    try {
      const record = await loadCase(candidate);
      if (!record) throw new Error("decision unavailable");
      const inventory = decisionCitationInventory(record.source.text, record.candidate.citation, record.paragraphs.at(-1)?.end ?? record.source.text.length);
      const structureSchema = caseDecisionStructureOutputSchema(record.sourceLines.length);
      let structureResult = await call(record, "structure_initial", [{ role: "user", content: decisionStructurePacket(record) }], structureSchema);
      const structureAttempts: Array<Record<string, unknown>> = [];
      let structure: CaseDecisionStructureSubmission | null = null;
      for (let correction = 0; correction <= maxCorrections; correction += 1) {
        structure = structureResult.parsed as CaseDecisionStructureSubmission | null;
        const structuralValidation = structure ? validateDecisionStructure(record, structure) : null;
        const structureErrors = structureResult.error
          ? [structureResult.error]
          : !structure
            ? ["response was not parseable JSON"]
            : structuralValidation?.validation.ok === true
              ? []
              : structuralValidation?.validation.errors ?? ["structure validation failed"];
        structureAttempts.push({ attempt: correction + 1, output_sha256: structureResult.outputSha256, errors: structureErrors });
        if (!structureErrors.length) break;
        if (correction >= maxCorrections) throw new Error(structureErrors.join("; "));
        if (!structureResult.continuationId) throw new Error("structure correction requires a continuation ID");
        structureResult = await call(record, `structure_correction_${correction + 1}`, correctionMessages(structureResult.raw, structureErrors, structuralValidation?.case_decision_mvp?.grounding), structureSchema, structureResult.continuationId);
      }
      if (!structure) throw new Error("structure response was not parseable");
      await appendJsonl(progress, { kind: "structure_accepted", document: documentId, output_sha256: structureResult.outputSha256 });

      const treatmentSchema = caseDecisionTreatmentOutputSchema(structure, inventory, record.sourceLines.length);
      let treatmentResult = await call(record, "treatment_initial", [{ role: "user", content: decisionTreatmentPacket(record, structure) }], treatmentSchema);
      const treatmentAttempts: Array<Record<string, unknown>> = [];
      let merged = mergeCaseDecisionStages(structure, treatmentResult.parsed as CaseDecisionTreatmentSubmission);
      let validation = treatmentResult.parsed && !merged.errors.length ? validateDecisionMvp(record, merged.submission) : null;
      let errors: string[] = [];
      let accepted = false;
      for (let correction = 0; correction <= maxCorrections; correction += 1) {
        errors = treatmentResult.error
          ? [treatmentResult.error]
          : !treatmentResult.parsed
            ? ["response was not parseable JSON"]
            : [...merged.errors, ...(validation?.validation.errors ?? []), ...(validation?.case_decision_mvp?.errors ?? [])];
        accepted = errors.length === 0 && validation?.validation.ok === true && validation.case_decision_mvp?.ok === true;
        treatmentAttempts.push({ attempt: correction + 1, output_sha256: treatmentResult.outputSha256, errors });
        if (accepted || correction >= maxCorrections) break;
        if (!treatmentResult.continuationId) throw new Error("treatment correction requires a continuation ID");
        treatmentResult = await call(record, `treatment_correction_${correction + 1}`, correctionMessages(treatmentResult.raw, errors, validation?.case_decision_mvp?.grounding), treatmentSchema, treatmentResult.continuationId);
        merged = mergeCaseDecisionStages(structure, treatmentResult.parsed as CaseDecisionTreatmentSubmission);
        validation = treatmentResult.parsed && !merged.errors.length ? validateDecisionMvp(record, merged.submission) : null;
      }
      const canonical = JSON.stringify(merged.submission);
      await appendJsonl(outputs, { kind: "model_output", phase: "case_decision_two_stage", document: documentId, citation: candidate.citation, raw_model_output: canonical, output_sha256: sha256(canonical) });
      const receipt = {
        document_id: documentId, citation: candidate.citation, status: accepted ? "accepted" : "rejected", errors,
        structure_output_sha256: structureResult.outputSha256, treatment_output_sha256: treatmentResult.outputSha256,
        canonical_output_sha256: sha256(canonical), detected_citations: inventory.occurrences.length,
        structure_attempts: structureAttempts, treatment_attempts: treatmentAttempts,
        coverage: validation?.case_decision_mvp?.coverage ?? null,
        grounding: validation?.case_decision_mvp?.grounding ?? null,
        evidence_receipts: evidenceReceipts(record, validation?.case_decision_mvp?.grounding),
        source_sha256: record.sourceSha256,
      };
      results[index] = receipt;
      await appendJsonl(receipts, { kind: "case_receipt", receipt });
      await appendJsonl(progress, { kind: "case_finished", ...receipt });
    } catch (error) {
      const receipt = { document_id: documentId, citation: candidate.citation, status: "failed", error: error instanceof Error ? error.message : String(error) };
      results[index] = receipt;
      await appendJsonl(receipts, { kind: "case_receipt", receipt });
      await appendJsonl(progress, { kind: "case_finished", ...receipt });
    }
  });
  const summary = { mode: "two_stage", model, effort, cases: results };
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (results.some((result) => result.status !== "accepted")) process.exitCode = 1;
}

function selfTest() {
  const grounding = {
    references: [{ reference_id: "r1", evidence: { exact_text: "2020 SCC 1" } }],
    quoted_passages: [{ quote_id: "q1", evidence: { exact_text: "exact words" } }],
    treatments: [{ treatment_index: 0, evidence: { exact_text: "We apply it." } }],
  };
  const errors = ["analysis.references[0]: bad reference", "analysis.treatments[0].explanation: bad quote"];
  assert.deepEqual(repairReceipts(errors, grounding), [grounding.references[0], grounding.treatments[0]]);
  const messages = correctionMessages("draft", errors, grounding);
  assert.deepEqual(messages.map(({ role }) => role), ["assistant", "user"]);
  assert.match(messages[1].content, /2020 SCC 1/u);
  assert.match(messages[1].content, /We apply it\./u);
  console.log("decision_two_stage self-test passed");
}

const selfTesting = process.argv.includes("--self-test");
const running = selfTesting ? Promise.resolve(selfTest()) : main();
void running
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!selfTesting) {
      await shutdownCodexAppServers();
    }
  });
