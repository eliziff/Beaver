import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { streamCodex } from "../../../backend/src/lib/llm/codex";
import {
  acquireCodexAppServer,
  beaverCodexHome,
  shutdownCodexAppServers,
} from "../../../backend/src/lib/llm/codexAppServer";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  CASE_TARGET_MVP_PROMPTS,
  CASE_TARGET_MVP_JSON_SCHEMA,
  caseTargetMvpPacket,
  candidatesFromPairFile,
  loadCase,
  validateCaseTargetSubmission,
  type CaseTargetPromptVariant,
} from "../runner";

type JsonObject = Record<string, unknown>;

function args() {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (!key?.startsWith("--")) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const required = (key: string) => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  return {
    documentId: Number(required("document")),
    pairFile: path.resolve(required("pair-file")),
    variant: required("variant") as CaseTargetPromptVariant,
    receiptFile: path.resolve(required("receipt-file")),
    rawFile: path.resolve(required("raw-file")),
    ledger: path.resolve(required("call-ledger")),
    runId: required("run-id"),
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function appendJsonl(file: string, row: JsonObject) {
  await appendFile(file, `${JSON.stringify({ utc: new Date().toISOString(), ...row })}\n`, "utf8");
}

async function writeAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function parseAndValidate(record: NonNullable<Awaited<ReturnType<typeof loadCase>>>, text: string) {
  let parsed: JsonObject | null = null;
  let parseError: string | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response is not an object");
    parsed = value as JsonObject;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const validated = validateCaseTargetSubmission(record, parsed);
  const roster = { prediction: validated.prediction, validation: validated.validation };
  const target = validated.case_target_mvp;
  const errors = parseError
    ? [`JSON parse: ${parseError}`]
    : target?.errors.length
      ? target.errors
      : roster.validation.ok
        ? []
        : roster.validation.errors ?? [roster.validation.error ?? "opinion extraction rejected"];
  return {
    ok: roster.validation.ok && target?.ok === true,
    parse_error: parseError,
    roster_validation: roster.validation,
    prediction: roster.prediction,
    target,
    errors,
  };
}

async function subscriptionPreflight() {
  const authFile = path.join(beaverCodexHome(), "auth.json");
  const auth = JSON.parse(await readFile(authFile, "utf8")) as JsonObject;
  if (auth.auth_mode !== "chatgpt" || !auth.tokens || auth.OPENAI_API_KEY) {
    throw new Error("Codex app-server must use ChatGPT subscription auth without an API key");
  }
  return { auth_mode: "chatgpt", api_key_present: false };
}

async function main() {
  const cli = args();
  if (!Number.isSafeInteger(cli.documentId) || cli.documentId <= 0) throw new Error("--document must be a positive integer");
  if (!(cli.variant in CASE_TARGET_MVP_PROMPTS)) throw new Error(`unknown prompt variant ${cli.variant}`);
  await mkdir(path.dirname(cli.receiptFile), { recursive: true });
  await writeFile(cli.rawFile, "", "utf8");
  const preflight = await subscriptionPreflight();
  const candidates = await candidatesFromPairFile(cli.pairFile);
  const candidate = candidates.find(({ documentId }) => documentId === cli.documentId);
  if (!candidate) throw new Error(`document ${cli.documentId} is not in the pair file`);
  const record = await loadCase(candidate);
  if (!record) throw new Error(`document ${cli.documentId} could not be loaded`);
  const prompt = caseTargetMvpPacket(record, cli.variant);
  const server = await acquireCodexAppServer("");
  let stage = "preflight";
  let eventQueue = Promise.resolve();
  const unsubscribe = server.subscribe((event) => {
    eventQueue = eventQueue.then(() => appendJsonl(cli.rawFile, {
      kind: "app_server_event",
      document: cli.documentId,
      stage,
      event,
    }));
  });

  const call = async (callStage: string, message: string, continuationId?: string) => {
    stage = callStage;
    const callId = randomUUID();
    await appendJsonl(cli.ledger, {
      kind: "model_call_started",
      call_id: callId,
      run_id: cli.runId,
      purpose: "validator_repair",
      stage: callStage,
      document: cli.documentId,
      provider: "codex_app_server_subscription",
      model: "gpt-5.6-luna",
      effort: "max",
      prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
      prompt_sha256: sha256(message),
      prompt_chars: message.length,
    });
    const started = Date.now();
    try {
      const result = await streamCodex({
        model: "codex:gpt-5.6-luna",
        reasoningEffort: "max",
        systemPrompt: "Extract the legal structure requested by the user. Use only the supplied decision. Return exactly the host-enforced JSON object without commentary.",
        messages: [{ role: "user", content: message }],
        outputSchema: CASE_TARGET_MVP_JSON_SCHEMA,
        providerSession: {
          persist: true,
          ...(continuationId ? { continuationId } : {}),
        },
      });
      await eventQueue;
      await appendJsonl(cli.rawFile, {
        kind: "model_output",
        document: cli.documentId,
        stage: callStage,
        raw_model_output: result.fullText,
        output_sha256: sha256(result.fullText),
        continuation_id: result.continuationId ?? null,
        usage: result.usage ?? null,
      });
      await appendJsonl(cli.ledger, {
        kind: "model_call_finished",
        call_id: callId,
        run_id: cli.runId,
        purpose: "validator_repair",
        stage: callStage,
        document: cli.documentId,
        status: "completed",
        elapsed_seconds: Math.round((Date.now() - started) / 10) / 100,
        output_sha256: sha256(result.fullText),
        usage: result.usage ?? null,
      });
      return result;
    } catch (error) {
      await eventQueue;
      await appendJsonl(cli.ledger, {
        kind: "model_call_finished",
        call_id: callId,
        run_id: cli.runId,
        purpose: "validator_repair",
        stage: callStage,
        document: cli.documentId,
        status: "failed",
        elapsed_seconds: Math.round((Date.now() - started) / 10) / 100,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  try {
    const initial = await call("initial", prompt);
    const initialValidation = parseAndValidate(record, initial.fullText);
    console.log(`[repair ${cli.documentId}] initial ok=${initialValidation.ok}`);
    let persistent: ReturnType<typeof parseAndValidate> | null = null;
    let fresh: ReturnType<typeof parseAndValidate> | null = null;
    if (!initialValidation.ok) {
      if (!initial.continuationId) throw new Error("persistent initial turn returned no continuation ID");
      const feedback = [
        "Your prior extraction failed deterministic validation.",
        "Return a complete replacement object, not a patch.",
        "Correct every listed error without changing grounded facts that were already valid.",
        "Validator errors:",
        ...initialValidation.errors.map((error) => `- ${error}`),
      ].join("\n");
      const persistentResult = await call("persistent_repair", feedback, initial.continuationId);
      persistent = parseAndValidate(record, persistentResult.fullText);
      console.log(`[repair ${cli.documentId}] persistent ok=${persistent.ok}`);

      const freshMessage = [
        prompt,
        "[REJECTED PRIOR OUTPUT]",
        initial.fullText,
        "[DETERMINISTIC VALIDATOR FEEDBACK]",
        ...initialValidation.errors.map((error) => `- ${error}`),
        "Return a complete corrected replacement object, not a patch or explanation.",
      ].join("\n\n");
      const freshResult = await call("fresh_repair", freshMessage);
      fresh = parseAndValidate(record, freshResult.fullText);
      console.log(`[repair ${cli.documentId}] fresh ok=${fresh.ok}`);
    }
    await eventQueue;
    await writeAtomic(cli.receiptFile, {
      run_id: cli.runId,
      document_id: cli.documentId,
      citation: candidate.citation,
      target: candidate.target,
      source_sha256: record.sourceSha256,
      prompt_variant: cli.variant,
      prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
      transport: { kind: "codex_app_server", ...preflight, isolated_process: true },
      raw_event_file: cli.rawFile,
      initial: initialValidation,
      persistent_repair: persistent,
      fresh_repair: fresh,
    });
  } finally {
    unsubscribe();
  }
}

main()
  .catch(async (error) => {
    const cli = (() => { try { return args(); } catch { return null; } })();
    if (cli) {
      await writeAtomic(cli.receiptFile, {
        run_id: cli.runId,
        document_id: cli.documentId,
        status: "worker_error",
        error: errorMessage(error),
        raw_event_file: cli.rawFile,
      }).catch(() => undefined);
    }
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownCodexAppServers();
    await shutdownSourceStructureEngine();
  });
