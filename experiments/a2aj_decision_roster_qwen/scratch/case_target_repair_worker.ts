import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  beaverCodexHome,
  shutdownCodexAppServers,
} from "../../../backend/src/lib/llm/codexAppServer";
import { streamChatWithTools } from "../../../backend/src/lib/llm";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  CASE_TARGET_MVP_PROMPTS,
  CASE_TARGET_MVP_VALIDATOR_VERSION,
  caseTargetMvpOutputSchema,
  caseTargetMvpPacket,
  candidatesFromPairFile,
  loadCase,
  validateCaseTargetSubmission,
  type CaseTargetPromptVariant,
} from "../runner";
import { setBelowNormalProcessPriority } from "../../../backend/src/lib/processPriority";

type JsonObject = Record<string, unknown>;
let interruptedBy: NodeJS.Signals | null = null;
const abort = new AbortController();
const interrupt = (signal: NodeJS.Signals) => {
  interruptedBy ??= signal;
  abort.abort();
};

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
    model: values.get("model")?.trim() || "gpt-5.6-luna",
    effort: values.get("effort")?.trim() || "max",
    maxCorrections: Math.min(5, Math.max(0, Number(values.get("max-corrections") ?? 2))),
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

function validateSubmission(record: NonNullable<Awaited<ReturnType<typeof loadCase>>>, parsed: unknown) {
  const validated = validateCaseTargetSubmission(record, parsed);
  const roster = { prediction: validated.prediction, validation: validated.validation };
  const target = validated.case_target_mvp;
  const errors = target?.errors.length
      ? target.errors
      : roster.validation.ok
        ? []
        : roster.validation.errors ?? [roster.validation.error ?? "opinion extraction rejected"];
  return {
    ok: roster.validation.ok && target?.ok === true,
    roster_validation: roster.validation,
    prediction: roster.prediction,
    target,
    errors,
  };
}

function parseAndValidate(record: NonNullable<Awaited<ReturnType<typeof loadCase>>>, text: string) {
  try {
    return validateSubmission(record, JSON.parse(text));
  } catch (error) {
    return {
      ...validateSubmission(record, null),
      ok: false,
      errors: [`JSON parse: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function correctionMessages(draft: string, errors: string[]) {
  return [
    { role: "assistant" as const, content: draft },
    {
      role: "user" as const,
      content: [
        "The JSON failed deterministic validation. Return a complete corrected JSON object, not a patch or explanation.",
        "Keep content that is already correct and fix every listed error:",
        ...errors.map((error) => `- ${error}`),
      ].join("\n"),
    },
  ];
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
  setBelowNormalProcessPriority();
  const cli = args();
  if (!Number.isSafeInteger(cli.documentId) || cli.documentId <= 0) throw new Error("--document must be a positive integer");
  if (!Number.isSafeInteger(cli.maxCorrections)) throw new Error("--max-corrections must be an integer");
  if (!(cli.variant in CASE_TARGET_MVP_PROMPTS)) throw new Error(`unknown prompt variant ${cli.variant}`);
  await mkdir(path.dirname(cli.receiptFile), { recursive: true });
  await appendFile(cli.rawFile, "", "utf8");
  const preflight = await subscriptionPreflight();
  const candidates = await candidatesFromPairFile(cli.pairFile);
  const candidate = candidates.find(({ documentId }) => documentId === cli.documentId);
  if (!candidate) throw new Error(`document ${cli.documentId} is not in the pair file`);
  const record = await loadCase(candidate);
  if (!record) throw new Error(`document ${cli.documentId} could not be loaded`);
  const prompt = caseTargetMvpPacket(record, cli.variant);
  const schema = caseTargetMvpOutputSchema(
    record.candidate.target?.sameLitigationEligible === true,
    record.targetOccurrences.map(({ id }) => id),
    record.sourceLines.length,
  );
  const call = async (
    callStage: string,
    messages: Array<{ role: "assistant" | "user"; content: string }>,
    continuationId?: string,
  ) => {
    const callId = randomUUID();
    await appendJsonl(cli.ledger, {
      kind: "model_call_started",
      call_id: callId,
      run_id: cli.runId,
      purpose: "validator_repair",
      stage: callStage,
      document: cli.documentId,
      provider: "codex_app_server_subscription",
      model: cli.model,
      effort: cli.effort,
      prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
      prompt_sha256: sha256(JSON.stringify(messages)),
      prompt_chars: messages.reduce((sum, message) => sum + message.content.length, 0),
    });
    const started = Date.now();
    let rawQueue = Promise.resolve();
    let rawBuffer = "";
    const flushRaw = () => {
      if (!rawBuffer) return;
      const text = rawBuffer;
      rawBuffer = "";
      rawQueue = rawQueue.then(() => appendJsonl(cli.rawFile, {
        kind: "model_output_delta",
        run_id: cli.runId,
        document: cli.documentId,
        stage: callStage,
        text,
      }));
    };
    try {
      const result = await streamChatWithTools({
        model: cli.model.startsWith("codex:") ? cli.model : `codex:${cli.model}`,
        reasoningEffort: cli.effort,
        systemPrompt: "Extract the legal structure requested by the user. Use only the supplied decision. Return exactly the host-enforced JSON object without commentary.",
        messages,
        outputSchema: schema,
        abortSignal: abort.signal,
        callbacks: {
          onContentDelta(text) {
            rawBuffer += text;
            if (rawBuffer.length >= 4_096) flushRaw();
          },
        },
        providerSession: {
          persist: true,
          ...(continuationId ? { continuationId } : {}),
        },
      });
      flushRaw();
      await rawQueue;
      await appendJsonl(cli.rawFile, {
        kind: "model_output",
        run_id: cli.runId,
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
      flushRaw();
      await rawQueue;
      await appendJsonl(cli.ledger, {
        kind: "model_call_finished",
        call_id: callId,
        run_id: cli.runId,
        purpose: "validator_repair",
        stage: callStage,
        document: cli.documentId,
        status: interruptedBy ? "interrupted" : "failed",
        elapsed_seconds: Math.round((Date.now() - started) / 10) / 100,
        error: errorMessage(error),
      });
      throw error;
    }
  };

  const attempts: Array<ReturnType<typeof parseAndValidate> & {
    stage: string;
    output_sha256: string;
    continuation_id: string | null;
  }> = [];
  let result = await call("initial", [{ role: "user", content: prompt }]);
  for (let correction = 0; ; correction += 1) {
    const validation = parseAndValidate(record, result.fullText);
    const attemptStage = correction === 0 ? "initial" : `correction_${correction}`;
    attempts.push({
      ...validation,
      stage: attemptStage,
      output_sha256: sha256(result.fullText),
      continuation_id: result.continuationId ?? null,
    });
    console.log(`[repair ${cli.documentId}] ${attemptStage} ok=${validation.ok}`);
    await writeAtomic(cli.receiptFile, {
      run_id: cli.runId,
      document_id: cli.documentId,
      citation: candidate.citation,
      status: "running",
      attempts,
      raw_event_file: cli.rawFile,
    });
    if (validation.ok || correction >= cli.maxCorrections) break;
    if (!result.continuationId) throw new Error(`${attemptStage} returned no continuation ID`);
    result = await call(
      `correction_${correction + 1}`,
      correctionMessages(result.fullText, validation.errors),
      result.continuationId,
    );
  }
  const accepted = attempts.at(-1)?.ok === true;
  await writeAtomic(cli.receiptFile, {
    run_id: cli.runId,
    document_id: cli.documentId,
    citation: candidate.citation,
    target: candidate.target,
    source_sha256: record.sourceSha256,
    prompt_variant: cli.variant,
    prompt_version: CASE_TARGET_MVP_PROMPTS[cli.variant].version,
    validator_version: CASE_TARGET_MVP_VALIDATOR_VERSION,
    transport: {
      kind: "beaver_llm",
      ...preflight,
      isolated_process: true,
      model: cli.model,
      effort: cli.effort,
    },
    max_corrections: cli.maxCorrections,
    raw_event_file: cli.rawFile,
    status: accepted ? "successful" : "failed",
    attempts,
    accepted_attempt: accepted ? attempts.length : null,
  });
}

function selfTest() {
  const ineligible = caseTargetMvpOutputSchema(false, ["tm1", "tm2", "tn1"], 3);
  assert.equal(ineligible.properties.case_history.maxItems, 0);
  assert.equal(ineligible.properties.target_mentions.minItems, 3);
  assert.equal(ineligible.properties.target_mentions.maxItems, 3);
  assert.deepEqual(ineligible.properties.target_mentions.items.properties.occurrence_id.enum, ["tm1", "tm2", "tn1"]);
  assert.equal(ineligible.properties.opinions.items.properties.start_line.maximum, 3);
  const messages = correctionMessages("prior draft", ["bad quote"]);
  assert.deepEqual(messages.map(({ role }) => role), ["assistant", "user"]);
  assert.equal(messages[0]?.content, "prior draft");
  assert.doesNotMatch(messages[1]?.content ?? "", /source text/iu);
  console.log("case_target_repair_worker self-test passed");
}

const selfTesting = process.argv.includes("--self-test");
if (!selfTesting) {
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
}
const running = selfTesting ? Promise.resolve(selfTest()) : main();
running
  .catch(async (error) => {
    const cli = (() => { try { return args(); } catch { return null; } })();
    if (cli) {
      const previous = await readFile(cli.receiptFile, "utf8")
        .then((value) => JSON.parse(value) as JsonObject)
        .catch(() => ({}));
      await writeAtomic(cli.receiptFile, {
        ...previous,
        run_id: cli.runId,
        document_id: cli.documentId,
        status: interruptedBy ? "interrupted" : "worker_error",
        ...(interruptedBy ? { signal: interruptedBy } : {}),
        error: errorMessage(error),
        raw_event_file: cli.rawFile,
      }).catch(() => undefined);
    }
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await shutdownCodexAppServers();
    await shutdownSourceStructureEngine();
  });
