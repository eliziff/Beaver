import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  candidatesFromPairFile,
  CASE_TARGET_MVP_COMPILER_VERSION,
  CASE_TARGET_MVP_VALIDATOR_VERSION,
  loadCase,
  validateCaseTargetSubmission,
} from "../runner";

async function outputs(files: string[]) {
  const byDocument = new Map<number, unknown>();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.kind !== "model_output" || typeof event.raw_model_output !== "string") continue;
      try {
        byDocument.set(Number(event.document), JSON.parse(event.raw_model_output));
      } catch {
        // Empty or malformed final answers are model failures, not corrupt
        // receipt streams. Keep them as fail-closed rejections.
        byDocument.set(Number(event.document), null);
      }
    }
  }
  return byDocument;
}

async function main() {
  const pairFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!pairFile || !outputFile) {
    throw new Error("usage: revalidate_case_target_run.ts <pairs.json> <outputs.jsonl[,outputs.jsonl]>");
  }
  const rawByDocument = await outputs(outputFile.split(",").map((file) => path.resolve(file)));
  const candidates = await candidatesFromPairFile(path.resolve(pairFile));
  const results = await Promise.all(candidates.map(async (candidate) => {
    const record = await loadCase(candidate);
    const raw = rawByDocument.get(candidate.documentId);
    if (!record || !rawByDocument.has(candidate.documentId)) throw new Error(`missing frozen input for ${candidate.documentId}`);
    const validated = validateCaseTargetSubmission(record, raw);
    const roster = { prediction: validated.prediction, validation: validated.validation };
    const target = validated.case_target_mvp;
    return {
      document_id: candidate.documentId,
      citation: candidate.citation,
      opinion_ok: roster.validation.ok,
      target_ok: target?.ok ?? false,
      errors: target?.errors ?? roster.validation.errors ?? [roster.validation.error ?? "unknown rejection"],
      counts: target?.counts ?? null,
      flat_treatment: target?.flat_treatment ?? null,
      rejections: target?.rejections ?? null,
    };
  }));
  const report = {
    compiler_version: CASE_TARGET_MVP_COMPILER_VERSION,
    validator_version: CASE_TARGET_MVP_VALIDATOR_VERSION,
    cases: results.length,
    opinion_ok: results.filter(({ opinion_ok }) => opinion_ok).length,
    target_ok: results.filter(({ target_ok }) => target_ok).length,
    results,
  };
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0) {
    const destination = process.argv[outIndex + 1];
    if (!destination) throw new Error("--out requires a path");
    await writeFile(path.resolve(destination), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(process.argv.includes("--summary") ? {
    validator_version: report.validator_version,
    compiler_version: report.compiler_version,
    cases: report.cases,
    opinion_ok: report.opinion_ok,
    target_ok: report.target_ok,
    results: results.map(({ document_id, citation, opinion_ok, target_ok, errors, counts, flat_treatment }) => ({
      document_id,
      citation,
      opinion_ok,
      target_ok,
      errors,
      accepted_positions: counts?.accepted_opinion_positions ?? 0,
      accepted_mentions: counts?.accepted_target_mentions ?? 0,
      accepted_treatments: counts?.accepted_target_treatments ?? 0,
      accepted_direct_history: counts?.accepted_target_direct_history ?? 0,
      controlling_labels: flat_treatment?.controlling_labels ?? [],
      other_judicial_labels: flat_treatment?.other_judicial_labels ?? [],
      attributed_labels: flat_treatment?.attributed_labels ?? [],
    })),
  } : report, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(shutdownSourceStructureEngine);
