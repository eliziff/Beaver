import { runChatTurn } from "../chat/turnEngine";
import type { UserApiKeys } from "../llm";
import type { TabularColumn } from "../tabularStore";
import type { TabularMeasurement } from "./extraction";
import { classifyJevColumns, jevConfig, JEV_ROUTING_SCHEMA, type JevRouting } from "./jev";

export async function prepareTabularRouting(input: {
  columns: TabularColumn[]; previous?: JevRouting; model: string; apiKeys: UserApiKeys;
  signal?: AbortSignal; runTurn?: typeof runChatTurn;
  onMeasurement?: (event: TabularMeasurement) => void;
}): Promise<JevRouting | undefined> {
  if (!jevConfig()) return input.previous;
  return classifyJevColumns({ columns: input.columns, previous: input.previous, signal: input.signal,
    ask: async (systemPrompt, user, signal) => {
      const started = performance.now();
      try { return JSON.stringify((await (input.runTurn ?? runChatTurn)({ model: input.model, apiKeys: input.apiKeys,
        systemPrompt, outputSchema: JEV_ROUTING_SCHEMA, messages: [{ role: "user", content: user }], createTools: () => [], emit() {},
        onProviderResult: result => input.onMeasurement?.({ phase: "routing", elapsedMs: performance.now() - started,
          usage: result.usage, contextRounds: result.contextRounds }),
        signal, reasoningEffort: "low", subagents: false, grounded: false, separateContentBlocks: false })).output); }
      catch (error) {
        input.onMeasurement?.({ phase: "routing", elapsedMs: performance.now() - started, error: "routing_failed" });
        throw error;
      }
    } });
}
