import { createHash } from "node:crypto";
import type { NormalizedToolCall } from "../../src/lib/llm";
import {
  toolResultText,
  type BeaverOutcome,
  type BeaverTool,
} from "../../src/lib/chat/toolRegistry";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function chatToolTraceEvent(
  call: NormalizedToolCall,
  outcome: BeaverOutcome,
) {
  const content = toolResultText(outcome.result);
  return {
    type: "tool_call_result",
    id: call.id,
    name: call.name,
    phase: "research",
    ok: outcome.result.isError !== true,
    content_chars: content.length,
    content_sha256: hash(content),
    content_preview: content.length <= 2_000
      ? content
      : `${content.slice(0, 1_600)}\n…\n${content.slice(-400)}`,
    ...(outcome.metadata?.evidenceRefs?.length
      ? {
          evidence_refs: outcome.metadata.evidenceRefs.map((reference) => ({
            handle: reference.handle,
            filename: reference.filename ?? reference.handle,
            ...(reference.locator ? { locator: reference.locator } : {}),
            chars: reference.text.length,
            exact_sha256: reference.exactSha256 || hash(reference.text),
            ...(reference.kind ? { kind: reference.kind } : {}),
          })),
        }
      : {}),
  };
}

export function traceChatTools<Context>(
  tools: BeaverTool<Context>[],
  emit: (event: ReturnType<typeof chatToolTraceEvent>) => void,
) {
  if (process.env.MIKE_BENCHMARK_TRACE_TOOLS !== "1") return tools;
  return tools.map((tool): BeaverTool<Context> => ({
    ...tool,
    async execute(input, context, signal, call) {
      const outcome = await tool.execute(input, context, signal, call);
      emit(chatToolTraceEvent(call, outcome));
      return outcome;
    },
  }));
}
