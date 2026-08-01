/**
 * docx-edit-bench runner: one model, one tool surface, one task, one replicate.
 *
 * Runs the model against the REAL local-assistant tool handlers on a private,
 * throwaway document store, so an edit is executed by the same code the
 * product runs and the scored document is a real DOCX round trip. What the
 * model is shown is the surface's tool schema list and one instruction; the
 * system prompt is deliberately neutral and IDENTICAL across surfaces, and
 * names no tool and no parameter, so the only thing that differs between two
 * surfaces is the schema list itself.
 *
 *   npx tsx ../benchmarks/docx_edit/src/run.ts \
 *     --surface beaver-address --task lease-cure-period \
 *     --model claude-p:claude-sonnet-4-6 --effort medium --rep 1 --out <dir>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractDocxBodyText,
  extractTrackedChangeIds,
  resolveTrackedChange,
  type OpenAIToolSchema,
} from "../../../backend/scripts/docx-edit-bench-bridge";
import { scoreTask } from "./checks";
import { fixtureBytes, fixtureSpec, fixtureText } from "./fixtures";
import { applySurface, surfaceById } from "./surface";
import { taskById } from "./tasks";
import { BENCH_VERSION, RECEIPT_SCHEMA } from "./types";

const argOf = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
};

/**
 * Neutral by construction. Any prose that names a tool or a parameter would
 * override the schema list in practice and silently un-do the comparison, so
 * this says only what the job is.
 */
const SYSTEM_PROMPT = [
  "You are assisting a lawyer with the documents in their local document library.",
  "",
  "The library is connected to you through your tools. Use them to find, read and change documents.",
  "",
  "When the user asks for a change to a document, make the change in the document itself and confirm briefly what you changed. Do not reply with a list of proposed changes instead of making them.",
  "",
  "Make exactly the change that was asked for. Leave everything else in the document as it is.",
  "",
  "If the request cannot be carried out as given — the thing described is not there, or the instruction could mean two different things — say so plainly and do not change anything.",
].join("\n");

type CapturedCall = {
  iteration: number;
  name: string;
  input: Record<string, unknown>;
  ok: boolean | null;
  error: string | null;
  result_chars: number;
};

async function child() {
  const surface = surfaceById(argOf("surface"));
  const task = taskById(argOf("task"));
  const model = argOf("model");
  const effort = argOf("effort");
  const rep = Number(argOf("rep", "1"));
  const outDir = argOf("out");

  const {
    LOCAL_ASSISTANT_TOOLS,
    runLocalAssistantTools,
    partitionTools,
    toolsForDomains,
  } = await import("../../../backend/src/lib/chat/localAssistantTools");
  const { createLocalDocument, getLocalVersionFile } = await import(
    "../../../backend/src/lib/localDocumentStore"
  );
  const { streamChatWithTools } = await import("../../../backend/src/lib/llm");

  const userId = "docx-edit-bench";
  const documentIdByFixture = new Map<string, string>();
  for (const fixtureId of task.fixtures) {
    const spec = fixtureSpec(fixtureId);
    const created = await createLocalDocument({
      userId,
      kind: "file",
      filename: spec.filename,
      bytes: await fixtureBytes(fixtureId),
    });
    documentIdByFixture.set(fixtureId, (created as { id: string }).id);
  }

  const allTools = applySurface(LOCAL_ASSISTANT_TOOLS, surface);

  /**
   * Progressive disclosure. A surface may ship only part of its schema in the
   * request and reveal the rest when the model asks. The conversation loop
   * belongs to the caller, so it is driven here; a surface with no deferral
   * reports everything resident, and the same code path serves both.
   *
   * Two things make the condition real rather than cosmetic:
   *  - `served` starts at the resident set and only grows when the model
   *    opens a domain, so the request genuinely carries fewer schemas;
   *  - a call to a tool that is not currently served is REFUSED here instead
   *    of executed. The handlers dispatch on name alone, so without this a
   *    model that guessed a deferred tool's name would silently get it, and
   *    the deferral would be measured as free.
   */
  const partition = surface.tools?.no_disclosure
    ? { resident: allTools, deferred: [] as OpenAIToolSchema[] }
    : partitionTools(allTools);
  let served: OpenAIToolSchema[] = [...partition.resident];
  const servedNames = new Set(served.map((entry) => entry.function.name));
  const residentSchemaBytes = Buffer.byteLength(JSON.stringify(partition.resident));
  const fullSchemaBytes = Buffer.byteLength(JSON.stringify(allTools));
  const schemaBytesPerRequest: number[] = [];
  const schemaHashesPerRequest: string[] = [];
  const disclosure: { phase: number; batch: number; domains: string[]; opened: string[] }[] = [];
  const refusedUnserved: { batch: number; name: string }[] = [];
  const refusedHeadless: { batch: number; name: string }[] = [];

  const calls: CapturedCall[] = [];
  const turnEditState: import("../../../backend/src/lib/chat/localAssistantTools").LocalAssistantEditTurnState =
    new Map();
  let iteration = 0;
  const started = Date.now();
  let answer = "";
  let runError: string | null = null;

  try {
    await streamChatWithTools({
      model,
      systemPrompt: `${SYSTEM_PROMPT}\n\nDocuments in the library: ${task.fixtures
        .map((id) => fixtureSpec(id).filename)
        .join("; ")}.`,
      messages: [{ role: "user", content: task.instruction }],
      tools: served,
      resolveTools: () => {
        schemaBytesPerRequest.push(Buffer.byteLength(JSON.stringify(served)));
        schemaHashesPerRequest.push(
          createHash("sha256").update(JSON.stringify(served)).digest("hex"),
        );
        return served;
      },
      maxIterations: 14,
      reasoningEffort: effort,
      enableThinking: true,
      callbacks: {
        onContentDelta: (text: string) => {
          answer += text;
        },
      },
      runTools: async (batch) => {
        iteration += 1;
        // Snapshot first: a describe_tools call may open a domain only for
        // the next model turn, never for another call in this same batch.
        const callable = new Set(servedNames);
        const executable = batch.filter(
          (call) => callable.has(call.name) && call.name !== "ask_inputs",
        );
        for (const call of batch) {
          if (call.name === "ask_inputs") {
            refusedHeadless.push({ batch: iteration, name: call.name });
          } else if (!callable.has(call.name)) {
            refusedUnserved.push({ batch: iteration, name: call.name });
          }
        }
        const executed = executable.length
          ? await runLocalAssistantTools(
              userId,
              executable,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              turnEditState,
            )
          : [];
        const byId = new Map(executed.map((entry) => [entry.tool_use_id, entry.content]));
        const results = batch.map((call) => ({
          tool_use_id: call.id,
          content:
            call.name === "ask_inputs"
              ? JSON.stringify({
                  ok: false,
                  error: "ask_inputs is unavailable in this headless benchmark.",
                })
              : byId.get(call.id) ??
                JSON.stringify({
                  ok: false,
                  error: `Tool '${call.name}' is not loaded. Call describe_tools, then retry it on the next turn.`,
                }),
        }));

        const domains = new Set<string>();
        for (const entry of results) {
          const call = batch.find((item) => item.id === entry.tool_use_id)!;
          const content = entry.content;
          let ok: boolean | null = null;
          let error: string | null = null;
          try {
            const parsed = JSON.parse(content) as {
              ok?: boolean;
              error?: string;
              domains?: string[];
            };
            if (typeof parsed.ok === "boolean") ok = parsed.ok;
            if (typeof parsed.error === "string") error = parsed.error;
            if (call.name === "describe_tools" && parsed.ok === true) {
              for (const domain of parsed.domains ?? []) {
                if (typeof domain === "string") domains.add(domain);
              }
            }
          } catch {
            if (/^No such tool|not found|does not exist/iu.test(content)) {
              ok = false;
              error = content.slice(0, 300);
            }
          }
          calls.push({
            iteration,
            name: call.name,
            input: call.input,
            ok,
            error,
            result_chars: content.length,
          });
        }

        if (domains.size) {
          const opened = toolsForDomains(partition.deferred, [...domains]).filter(
            (entry) => !servedNames.has(entry.function.name),
          );
          if (opened.length) {
            served = [...served, ...opened];
            for (const entry of opened) servedNames.add(entry.function.name);
          }
          disclosure.push({
            phase: 1,
            batch: iteration,
            domains: [...domains],
            opened: opened.map((entry) => entry.function.name),
          });
        }
        return results;
      },
    });
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }
  const wallClockSeconds = (Date.now() - started) / 1000;

  // Score the accepted projection: every edit lands as a tracked change, so
  // the document a human would see after Accept All is the one that counts.
  const originals = new Map<string, string>();
  const results = new Map<string, string>();
  for (const fixtureId of task.fixtures) {
    originals.set(fixtureId, await fixtureText(fixtureId));
    const documentId = documentIdByFixture.get(fixtureId)!;
    const file = await getLocalVersionFile(userId, documentId);
    if (!file) {
      results.set(fixtureId, originals.get(fixtureId)!);
      continue;
    }
    let bytes: Buffer = readFileSync(file.path);
    const ids = (await extractTrackedChangeIds(bytes)).map((entry) => entry.w_id);
    if (ids.length) bytes = (await resolveTrackedChange(bytes, ids, "accept")).bytes;
    results.set(fixtureId, await extractDocxBodyText(bytes));
  }

  const score = scoreTask({ task, originals, results, answer });

  // What the run leaned on, measured from the captured arguments rather than
  // inferred from the answer.
  const documentTexts = [...originals.values()];
  const RETYPE_MIN = 12;
  const stringArgs: { path: string; value: string }[] = [];
  const walk = (node: unknown, at: string) => {
    if (typeof node === "string") {
      if (node.length >= RETYPE_MIN) stringArgs.push({ path: at, value: node });
      return;
    }
    if (Array.isArray(node)) node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
    else if (node && typeof node === "object") {
      for (const [key, entry] of Object.entries(node)) walk(entry, `${at}.${key}`);
    }
  };
  for (const call of calls) walk(call.input, call.name);
  const quoted = stringArgs.filter((entry) =>
    documentTexts.some((text) => text.includes(entry.value)),
  );
  // A long string in a locating argument that is NOT in any document is a
  // misquote: the arm retyped document text and got it wrong.
  const LOCATING = /\.(find|text|from_text|to_text|old_string|context_before|context_after)$/u;
  const misquoted = stringArgs.filter(
    (entry) =>
      LOCATING.test(entry.path) &&
      !documentTexts.some((text) => text.includes(entry.value)),
  );
  const scopeKinds: Record<string, number> = {};
  const addressArgs: string[] = [];
  for (const call of calls) {
    const ops = (call.input as { ops?: { scope?: { kind?: string; at?: string } }[] }).ops;
    for (const op of ops ?? []) {
      const kind = op?.scope?.kind ?? "(none)";
      scopeKinds[kind] = (scopeKinds[kind] ?? 0) + 1;
      if (op?.scope?.at) addressArgs.push(`${call.name}.scope.at=${op.scope.at}`);
    }
    for (const key of ["at", "section", "offset", "page", "pages", "from", "follow", "depth"]) {
      const value = (call.input as Record<string, unknown>)[key];
      if (value !== undefined) addressArgs.push(`${call.name}.${key}=${String(value)}`);
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let providerTurns = 0;
  const manifestPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH ?? "";
  if (manifestPath && existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      providerTurns += 1;
      const entry = JSON.parse(line) as {
        usage?: {
          inputTokens?: number | null;
          outputTokens?: number | null;
          cacheReadInputTokens?: number | null;
          cacheWriteInputTokens?: number | null;
        } | null;
        inputEstimate?: { tokens?: number };
      };
      if (entry.usage?.inputTokens != null) {
        inputTokens +=
          entry.usage.inputTokens +
          (entry.usage.cacheReadInputTokens ?? 0) +
          (entry.usage.cacheWriteInputTokens ?? 0);
        outputTokens += entry.usage.outputTokens ?? 0;
      } else {
        inputTokens += entry.inputEstimate?.tokens ?? 0;
      }
    }
  }

  const receipt = {
    schema: RECEIPT_SCHEMA,
    benchmark_version: BENCH_VERSION,
    run_at: new Date().toISOString(),
    surface: surface.id,
    surface_env: surface.env,
    surface_tool_filter: surface.tools ?? {},
    tools_shown: partition.resident.map((entry) => entry.function.name),
    tools_deferred: partition.deferred.map((entry) => entry.function.name),
    tool_schema_bytes: fullSchemaBytes,
    // The saving is only real if the model does not open everything at once:
    // first-request bytes against the mean across the run's requests.
    resident_schema_bytes: residentSchemaBytes,
    schema_bytes_first_request: schemaBytesPerRequest[0] ?? residentSchemaBytes,
    schema_bytes_per_request: schemaBytesPerRequest,
    schema_sha256_per_request: schemaHashesPerRequest,
    schema_bytes_mean_request:
      schemaBytesPerRequest.reduce((a, b) => a + b, 0) /
      Math.max(1, schemaBytesPerRequest.length),
    disclosure_events: disclosure,
    disclosure_domains: [...new Set(disclosure.flatMap((entry) => entry.domains))],
    disclosure_first_batch: disclosure.length ? disclosure[0].batch : null,
    disclosure_restarts: 0,
    refused_unserved_calls: refusedUnserved,
    refused_headless_calls: refusedHeadless,
    // A domain is useful when any of its schemas is called. Opening one
    // member out of a small domain is not disclosure waste.
    opened_domains_never_called: [
      ...new Set(disclosure.flatMap((entry) => entry.domains)),
    ].filter((domain) => {
      const names = new Set(
        toolsForDomains(partition.deferred, [domain]).map(
          (entry) => entry.function.name,
        ),
      );
      return !calls.some((call) => names.has(call.name));
    }),
    // Tool-level detail remains diagnostic, but is not the waste verdict.
    opened_tools_never_called: [...new Set(disclosure.flatMap((entry) => entry.opened))].filter(
      (name) => !calls.some((call) => call.name === name),
    ),
    // Pins the served surface: a product change that reintroduces a dropped
    // parameter shows up as a different hash rather than as a silent result.
    tool_schema_sha256: createHash("sha256")
      .update(JSON.stringify(allTools))
      .digest("hex"),
    resident_schema_sha256: createHash("sha256")
      .update(JSON.stringify(partition.resident))
      .digest("hex"),
    repo_head: (() => {
      try {
        return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })
          .stdout?.trim() ?? null;
      } catch {
        return null;
      }
    })(),
    model,
    reasoning_effort: effort,
    task: task.id,
    task_version: task.version,
    difficulty: task.difficulty,
    floor_task: task.floor_task === true,
    expected: task.expected,
    replicate: rep,
    run_error: runError,
    wall_clock_seconds: Math.round(wallClockSeconds * 100) / 100,
    provider_turns: providerTurns,
    tool_call_batches: iteration,
    tool_calls: calls.length,
    tools_used: calls.reduce<Record<string, number>>((acc, call) => {
      acc[call.name] = (acc[call.name] ?? 0) + 1;
      return acc;
    }, {}),
    tool_failures: calls.filter((call) => call.ok === false).length,
    tool_errors: calls
      .filter((call) => call.error)
      .map((call) => ({ name: call.name, error: call.error!.slice(0, 240) })),
    scope_kinds: scopeKinds,
    address_args: addressArgs,
    retyped_arg_count: quoted.length,
    retyped_chars: quoted.reduce((total, entry) => total + entry.value.length, 0),
    misquoted_arg_count: misquoted.length,
    misquoted_args: misquoted.map((entry) => ({
      path: entry.path,
      value: entry.value.slice(0, 160),
    })),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    answer_chars: answer.length,
    answer,
    score,
    calls,
  };

  mkdirSync(outDir, { recursive: true });
  appendFileSync(
    path.join(outDir, "receipts.jsonl"),
    `${JSON.stringify(receipt)}\n`,
    "utf8",
  );
  console.log(
    `${surface.id} ${task.id} rep${rep}: ${score.pass ? "PASS" : "FAIL"} ` +
      `sites ${score.sites_correct}/${score.targets_total} correct, ${score.sites_wrong} damaged, ` +
      `${calls.length} tool calls, ${inputTokens + outputTokens} tokens, ${wallClockSeconds.toFixed(1)}s`,
  );
  process.exit(0);
}

async function parent() {
  const surface = surfaceById(argOf("surface"));
  const dataHome = mkdtempSync(path.join(os.tmpdir(), "docx-edit-bench-"));
  const manifestPath = path.join(dataHome, "llm-manifest.jsonl");
  // tsx lives in the backend workspace, not beside this file.
  const tsxCli = require.resolve("tsx/cli", {
    paths: [path.join(__dirname, "..", "..", "..", "backend")],
  });
  const result = spawnSync(
    process.execPath,
    [tsxCli, __filename, ...process.argv.slice(2)],
    {
      env: {
        ...process.env,
        ...surface.env,
        DOCX_EDIT_BENCH_CHILD: "1",
        NODE_ENV: "",
        AUTH_MODE: "anonymous",
        OPEN_LEGAL_DATA_HOME: dataHome,
        MIKE_LOCAL_DATA_DIR: path.join(dataHome, "apps", "mike", "library"),
        SUPABASE_URL: "",
        SUPABASE_SECRET_KEY: "",
        MIKE_LLM_CONTEXT_MANIFEST_PATH: manifestPath,
      },
      stdio: "inherit",
      timeout: 40 * 60_000,
    },
  );
  try {
    rmSync(dataHome, { recursive: true, force: true });
  } catch {}
  process.exit(result.status ?? 1);
}

(process.env.DOCX_EDIT_BENCH_CHILD ? child() : parent()).catch((error) => {
  console.error("[docx-edit-bench run]", error);
  process.exit(1);
});
