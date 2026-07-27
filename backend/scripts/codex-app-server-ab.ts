/**
 * Live A/B harness for the two Codex transports.
 *
 *   npx tsx scripts/codex-app-server-ab.ts [--model codex:gpt-5.3-codex-spark]
 *
 * Costs real tokens. Reports spawn -> first-content-delta latency and delta
 * counts for `codex exec` vs `codex app-server`, then exercises the tool
 * bridge, thread continuation, and abort recovery on the app-server path.
 */
import { performance } from "node:perf_hooks";
import { streamCodex } from "../src/lib/llm/codex";
import {
  shutdownCodexAppServers,
  streamCodexAppServer,
} from "../src/lib/llm/codexAppServer";
import type {
  NormalizedToolCall,
  StreamChatParams,
  StreamChatResult,
} from "../src/lib/llm/types";

const model =
  process.argv[process.argv.indexOf("--model") + 1]?.startsWith("codex:")
    ? process.argv[process.argv.indexOf("--model") + 1]
    : "codex:gpt-5.3-codex-spark";

const PROMPT =
  "In about 250 words, explain what a promissory note is, how it differs from an IOU, and when a lawyer would use one.";

type Run = {
  label: string;
  deltas: number;
  firstDeltaMs: number | null;
  totalMs: number;
  chars: number;
  result?: StreamChatResult;
};

function baseParams(content: string): StreamChatParams {
  return {
    model,
    systemPrompt: "You are terse and precise.",
    messages: [{ role: "user", content }],
    reasoningEffort: "low",
  };
}

async function measure(
  label: string,
  stream: (params: StreamChatParams) => Promise<StreamChatResult>,
  params: StreamChatParams,
): Promise<Run> {
  const startedAt = performance.now();
  let deltas = 0;
  let firstDeltaMs: number | null = null;
  const result = await stream({
    ...params,
    callbacks: {
      ...params.callbacks,
      onContentDelta(text) {
        if (!text) return;
        deltas += 1;
        if (firstDeltaMs === null) firstDeltaMs = performance.now() - startedAt;
        params.callbacks?.onContentDelta?.(text);
      },
    },
  });
  return {
    label,
    deltas,
    firstDeltaMs,
    totalMs: performance.now() - startedAt,
    chars: result.fullText.length,
    result,
  };
}

function report(run: Run) {
  console.log(
    `  ${run.label.padEnd(26)} deltas=${String(run.deltas).padStart(3)}  ` +
      `firstContent=${run.firstDeltaMs === null ? "n/a" : `${Math.round(run.firstDeltaMs)}ms`}  ` +
      `total=${Math.round(run.totalMs)}ms  chars=${run.chars}`,
  );
}

async function gateAb() {
  console.log("\n[a] A/B latency (identical prompt, effort=low)");
  const exec = await measure("codex exec", streamCodex, baseParams(PROMPT));
  report(exec);
  const cold = await measure(
    "app-server (cold spawn)",
    streamCodexAppServer,
    baseParams(PROMPT),
  );
  report(cold);
  const warm = await measure(
    "app-server (warm reuse)",
    streamCodexAppServer,
    baseParams(PROMPT),
  );
  report(warm);
  const exec2 = await measure("codex exec (2nd)", streamCodex, baseParams(PROMPT));
  report(exec2);
  const warm2 = await measure(
    "app-server (warm 2nd)",
    streamCodexAppServer,
    baseParams(PROMPT),
  );
  report(warm2);
  const pass = warm.deltas > 1 && (warm.firstDeltaMs ?? Infinity) < (exec.firstDeltaMs ?? 0);
  console.log(`  => ${pass ? "PASS" : "FAIL"} (>1 delta and earlier first content)`);
  return pass;
}

async function gateTools() {
  console.log("\n[b] Tool round-trip through the mike_runtime bridge");
  const calls: NormalizedToolCall[] = [];
  const run = await measure(
    "app-server + tools",
    streamCodexAppServer,
    {
      ...baseParams(
        "Call the beaver_case_codeword tool with matter set to 'Halifax' and then reply with only the codeword it returns.",
      ),
      tools: [
        {
          type: "function",
          function: {
            name: "beaver_case_codeword",
            description:
              "Returns the internal Beaver codeword for a matter. The codeword cannot be guessed.",
            parameters: {
              type: "object",
              properties: { matter: { type: "string" } },
              required: ["matter"],
            },
          },
        },
      ],
      runTools: async (toolCalls) => {
        calls.push(...toolCalls);
        return toolCalls.map((call) => ({
          tool_use_id: call.id,
          content: "ORCA-77193",
        }));
      },
      callbacks: {
        onToolCallStart: (call) =>
          console.log(`  onToolCallStart -> ${call.name} ${JSON.stringify(call.input)}`),
      },
    } as StreamChatParams,
  );
  report(run);
  const pass = calls.length > 0 && run.result!.fullText.includes("ORCA-77193");
  console.log(`  tool calls dispatched: ${calls.length}`);
  console.log(`  => ${pass ? "PASS" : "FAIL"} (tool ran and its result reached the answer)`);
  return pass;
}

async function gateContinuation() {
  console.log("\n[c] Thread continuation");
  const first = await measure("turn 1", streamCodexAppServer, {
    ...baseParams(
      "Remember this case reference: BEAVER-4417. Reply with only 'noted'.",
    ),
    providerSession: { persist: true },
  });
  report(first);
  const continuationId = first.result?.continuationId;
  console.log(`  continuationId: ${continuationId ?? "(none)"}`);
  if (!continuationId) {
    console.log("  => FAIL (no continuationId returned)");
    return false;
  }
  const second = await measure("turn 2 (resumed)", streamCodexAppServer, {
    ...baseParams("What case reference did I ask you to remember? Reply with only it."),
    providerSession: { persist: true, continuationId },
  });
  report(second);
  console.log(`  turn 2 answer: ${second.result!.fullText.trim().slice(0, 120)}`);
  const pass =
    second.result!.fullText.includes("BEAVER-4417") &&
    second.result!.continuationId === continuationId;
  console.log(`  => ${pass ? "PASS" : "FAIL"} (turn 2 recalled turn 1 on the same thread)`);
  return pass;
}

async function gateAbort() {
  console.log("\n[e] Abort mid-generation, then reuse the singleton");
  const controller = new AbortController();
  let aborted = false;
  try {
    await streamCodexAppServer({
      ...baseParams("Write a 700 word essay about the history of contract law."),
      abortSignal: controller.signal,
      callbacks: {
        onContentDelta: () => controller.abort(),
      },
    });
  } catch (error) {
    aborted = (error as Error).name === "AbortError";
    console.log(`  aborted with: ${(error as Error).name}: ${(error as Error).message}`);
  }
  const after = await measure(
    "next turn after abort",
    streamCodexAppServer,
    baseParams("Reply with only the word: alive"),
  );
  report(after);
  const pass = aborted && after.chars > 0;
  console.log(`  => ${pass ? "PASS" : "FAIL"} (abort raised AbortError and the server still serves turns)`);
  return pass;
}

async function main() {
  console.log(`Codex transport A/B — model ${model}`);
  const gates = {
    a: await gateAb(),
    b: await gateTools(),
    c: await gateContinuation(),
    e: await gateAbort(),
  };
  console.log("\nSummary");
  for (const [gate, pass] of Object.entries(gates)) {
    console.log(`  gate ${gate}: ${pass ? "PASS" : "FAIL"}`);
  }
  await shutdownCodexAppServers();
  process.exit(Object.values(gates).every(Boolean) ? 0 : 1);
}

void main().catch(async (error) => {
  console.error(error);
  await shutdownCodexAppServers();
  process.exit(1);
});
