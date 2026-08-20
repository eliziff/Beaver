import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CASE_TARGET_MVP_PROMPTS,
  candidatesFromPairFile,
  modelCallLedgerUsage,
  type CaseTargetPromptVariant,
} from "../runner";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "case_target_repair_worker.ts");

function args() {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key?.startsWith("--")) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) switches.add(key.slice(2));
    else {
      values.set(key.slice(2), value);
      index += 1;
    }
  }
  const required = (key: string) => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  return {
    pairFile: path.resolve(required("pair-file")),
    variant: (values.get("variant") ?? "nested") as CaseTargetPromptVariant,
    documents: (values.get("documents") ?? "").split(",").map(Number).filter(Number.isSafeInteger),
    out: path.resolve(required("out")),
    ledger: path.resolve(required("call-ledger")),
    budget: Number(values.get("call-budget") ?? 15_000),
    workers: Math.min(10, Math.max(1, Number(values.get("workers") ?? 5))),
    runId: values.get("run-id") ?? path.basename(required("out")),
    resume: switches.has("resume"),
  };
}

async function appendJsonl(file: string, row: unknown) {
  await appendFile(file, `${JSON.stringify({ utc: new Date().toISOString(), ...(row as object) })}\n`, "utf8");
}

async function main() {
  const cli = args();
  if (!(cli.variant in CASE_TARGET_MVP_PROMPTS)) throw new Error(`unknown prompt variant ${cli.variant}`);
  const candidates = await candidatesFromPairFile(cli.pairFile);
  const wanted = new Set(cli.documents.length ? cli.documents : candidates.map(({ documentId }) => documentId));
  const selected = candidates.filter(({ documentId }) => wanted.has(documentId));
  if (!selected.length || selected.length !== wanted.size) throw new Error("--documents must select cases in the pair file");
  const caseDir = `${cli.out}.cases`;
  const progressFile = `${cli.out}.progress.jsonl`;
  const receiptStream = `${cli.out}.receipts.jsonl`;
  await mkdir(caseDir, { recursive: true });
  if (!cli.resume) {
    await writeFile(progressFile, "", "utf8");
    await writeFile(receiptStream, "", "utf8");
  }
  const pending: Array<{
    candidate: (typeof selected)[number];
    receiptFile: string;
    rawFile: string;
  }> = [];
  for (const candidate of selected) {
    const receiptFile = path.join(caseDir, `${candidate.documentId}.receipt.json`);
    if (cli.resume) {
      try { await readFile(receiptFile); continue; } catch { /* run missing case */ }
    }
    pending.push({ candidate, receiptFile, rawFile: path.join(caseDir, `${candidate.documentId}.raw-events.jsonl`) });
  }
  const used = await modelCallLedgerUsage(cli.ledger);
  const plannedCeiling = pending.length * 3;
  if (used + plannedCeiling > cli.budget) {
    throw new Error(`call budget exceeded: ${used} used + ${plannedCeiling} planned > ${cli.budget}`);
  }
  await appendJsonl(cli.ledger, {
    kind: "call_budget_checked",
    run_id: cli.runId,
    budget: cli.budget,
    attempted_before_run: used,
    planned_calls: pending.length,
    planned_attempt_ceiling: plannedCeiling,
  });
  await appendJsonl(progressFile, {
    kind: "run_started",
    run_id: cli.runId,
    prompt_variant: cli.variant,
    prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
    workers: cli.workers,
    cases: selected.map(({ documentId, citation }) => ({ document_id: documentId, citation })),
    call_budget_attempted_before_run: used,
    planned_attempt_ceiling: plannedCeiling,
  });

  let cursor = 0;
  let completed = 0;
  const failedDocuments = new Set<number>();
  const runOne = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const item = pending[index];
      if (!item) return;
      await appendJsonl(progressFile, { kind: "case_started", document: item.candidate.documentId });
      const child = spawn(process.execPath, [
        ...process.execArgv,
        WORKER,
        "--document", String(item.candidate.documentId),
        "--pair-file", cli.pairFile,
        "--variant", cli.variant,
        "--receipt-file", item.receiptFile,
        "--raw-file", item.rawFile,
        "--call-ledger", cli.ledger,
        "--run-id", cli.runId,
      ], { stdio: "inherit", windowsHide: true });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) failedDocuments.add(item.candidate.documentId);
      const receipt = JSON.parse(await readFile(item.receiptFile, "utf8")) as Record<string, unknown>;
      await appendJsonl(receiptStream, { kind: "case_receipt", document: item.candidate.documentId, receipt });
      completed += 1;
      await appendJsonl(progressFile, { kind: "case_finished", document: item.candidate.documentId, exit_code: exitCode, completed, total: pending.length });
      console.log(`[repair ${completed}/${pending.length}] ${item.candidate.citation}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cli.workers, pending.length) }, runOne));

  const receipts = [];
  for (const candidate of selected) {
    const receiptFile = path.join(caseDir, `${candidate.documentId}.receipt.json`);
    receipts.push(JSON.parse(await readFile(receiptFile, "utf8")) as Record<string, unknown>);
  }
  const valid = (stage: unknown) => Boolean(stage && typeof stage === "object" && (stage as { ok?: unknown }).ok === true);
  const comparable = receipts.filter((receipt) => receipt.persistent_repair && receipt.fresh_repair);
  for (const receipt of receipts) {
    if (receipt.status === "worker_error" && typeof receipt.document_id === "number" && Number.isSafeInteger(receipt.document_id)) {
      failedDocuments.add(receipt.document_id);
    }
  }
  const summary = {
    run_id: cli.runId,
    prompt_variant: cli.variant,
    prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
    transport: "codex_app_server_chatgpt_subscription",
    workers: cli.workers,
    cases: receipts.length,
    worker_errors: failedDocuments.size,
    initial_valid: receipts.filter((receipt) => valid(receipt.initial)).length,
    comparable_repairs: comparable.length,
    persistent_valid: comparable.filter((receipt) => valid(receipt.persistent_repair)).length,
    fresh_valid: comparable.filter((receipt) => valid(receipt.fresh_repair)).length,
    receipt_stream: receiptStream,
    case_directory: caseDir,
    receipts,
  };
  await writeFile(`${cli.out}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await appendJsonl(progressFile, { kind: "run_finished", ...summary, receipts: undefined });
  console.log(JSON.stringify({ ...summary, receipts: undefined }, null, 2));
  if (summary.worker_errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
