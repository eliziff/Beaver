import { schemaValidator } from "../llm/structured";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedToolCall, NormalizedToolResult, Tool } from "../llm";
import { safeErrorLog } from "../safeError";
import { jsonRecord } from "../value";
import type { AskInputsEvent, AssistantEvent } from "./assistantEvents";
import type { LegalEvidenceReceipt, PendingLegalResearchQueryReceipt,
  RegisteredEvidence } from "./legalEvidence";
import type { ReadSubagentRegion } from "./readSubagents";

export const LOAD_TOOLS_NAME = "load_tools";
const MAX_PARALLEL_TOOL_CALLS = 4;
export const MAX_MODEL_TOOL_RESULT_CHARS = 64_000;

export type BeaverOutcome = {
  result: CallToolResult;
  metadata?: Omit<NormalizedToolResult, "tool_use_id" | "content" | "terminal">;
  events?: AssistantEvent[];
  evidence?: LegalEvidenceReceipt[];
  queryReceipts?: PendingLegalResearchQueryReceipt[];
  evidenceSources?: Map<string, Omit<RegisteredEvidence, "receipt">>;
  activityCitations?: Record<string, unknown>[];
  pause?: AskInputsEvent;
  mutated?: boolean;
  terminal?: boolean;
};
export type BeaverToolPolicy = {
  specialist?: boolean;
  research?: boolean;
  reader?: readonly ReadSubagentRegion[];
  sequential?: boolean | ((input: Record<string, unknown>) => boolean);
  activity?: (input: Record<string, unknown>) => string | null;
  activityCitations?: (input: Record<string, unknown>) => Record<string, unknown>[];
};
export type BeaverTool<Context> = Tool & BeaverToolPolicy & {
  execute(
    input: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
    call: Readonly<NormalizedToolCall>,
  ): Promise<BeaverOutcome>;
};

const schema = (tool: Tool): Tool => ({
  name: tool.name,
  ...(tool.title && { title: tool.title }),
  ...(tool.description && { description: tool.description }),
  inputSchema: tool.inputSchema,
  ...(tool.strict !== undefined && { strict: tool.strict }),
  ...(tool.outputSchema && { outputSchema: tool.outputSchema }),
  ...(tool.annotations && { annotations: tool.annotations }),
  ...(tool.execution && { execution: tool.execution }),
  ...(tool.icons && { icons: tool.icons }),
  ...(tool._meta && { _meta: tool._meta }),
});
/** A tool input schema: named properties, nothing else accepted. */
export const objectSchema = (properties: Record<string, object>,
  required: string[] = []): Tool["inputSchema"] => ({
  type: "object", properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const loader = (names: string[]): Tool => ({
  name: LOAD_TOOLS_NAME,
  description: "Load the specialist tools needed for this task by exact name.",
  inputSchema: objectSchema({ names: {
    type: "array", minItems: 1, maxItems: names.length, uniqueItems: true,
    items: names.length ? { type: "string", enum: names } : { type: "string" },
  } }, ["names"]),
});

export const toolText = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError && { isError: true }),
});
export const toolOutcome = (value: unknown): BeaverOutcome => ({ result: toolText(value, jsonRecord(value)?.ok === false) });
export const failedOutcome = (error: string, detail?: string): BeaverOutcome => toolOutcome({ ok: false, error, ...(detail && { detail }) });
export const withoutUrls = (value: unknown): unknown => Array.isArray(value)
  ? value.map(withoutUrls)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .flatMap(([key, item]) => /(?:^|_)(?:url|uri|href)$/iu.test(key)
          ? [] : [[key, withoutUrls(item)]]))
    : value;
const visibleText = (result: CallToolResult) => {
  const text = result.content.map((block) => {
    if (block.type !== "text") return JSON.stringify(block);
    try { return JSON.stringify(withoutUrls(JSON.parse(block.text))); }
    catch { return block.text; }
  }).join("\n");
  if (text.length <= MAX_MODEL_TOOL_RESULT_CHARS) return { text, truncated: false };
  const marker = "\n… tool result truncated; retry with narrower inputs …\n";
  const tail = Math.floor(MAX_MODEL_TOOL_RESULT_CHARS / 4);
  return {
    text: text.slice(0, MAX_MODEL_TOOL_RESULT_CHARS - tail - marker.length) +
      marker + text.slice(-tail),
    truncated: true,
  };
};
const normalize = (id: string, outcome: BeaverOutcome): NormalizedToolResult => {
  const visible = visibleText(outcome.result);
  // A failed tool result is otherwise invisible outside the model's context; name it in the server log.
  if (outcome.result.isError) console.warn("[assistant-tool] failed", { id, detail: visible.text.slice(0, 600) });
  return {
    tool_use_id: id,
    content: visible.text,
    ...outcome.metadata,
    status: outcome.metadata?.status ??
      (visible.truncated ? "truncated" : outcome.result.isError ? "error" : "ok"),
    ...(outcome.terminal && { terminal: true }),
  };
};

type Check = ReturnType<typeof schemaValidator>;
type Execution = { call: NormalizedToolCall; outcome: BeaverOutcome };
type OnResult = (call: NormalizedToolCall, outcome: BeaverOutcome) => void;

export class TurnToolRegistry<Context> {
  readonly #tools = new Map<string, BeaverTool<Context>>();
  readonly #active = new Set<string>();
  #visible?: Tool[];
  #loadInput?: Check;

  constructor(tools: BeaverTool<Context>[]) {
    for (const candidate of tools) {
      const parsed = ToolSchema.safeParse(schema(candidate));
      if (!parsed.success) throw new Error(
        `Invalid tool ${candidate.name || "<empty>"}: ${parsed.error.message}`);
      const name = candidate.name.trim();
      if (!name || name === LOAD_TOOLS_NAME) {
        throw new Error(`Reserved or empty tool name: ${name || "<empty>"}`);
      }
      if (this.#tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
      this.#tools.set(name, { ...candidate, name });
      if (!candidate.specialist) this.#active.add(name);
    }
  }

  specialists() {
    return [...this.#tools.values()].flatMap((tool) => this.#active.has(tool.name) ? [] : [tool.name]);
  }
  visible() {
    if (this.#visible) return this.#visible;
    const specialists = this.specialists();
    return this.#visible = [
      ...(specialists.length ? [loader(specialists)] : []),
      ...[...this.#tools.values()].flatMap((tool) => this.#active.has(tool.name) ? [schema(tool)] : []),
    ];
  }
  all() {
    const specialists = this.specialists();
    return [
      ...(specialists.length ? [loader(specialists)] : []),
      ...[...this.#tools.values()].map(schema),
    ];
  }
  activity(call: NormalizedToolCall) {
    // Reaching for a tool is machinery, not an act the reader follows, and a call whose
    // arguments the schema rejects never runs: neither is work to show as a step.
    const tool = this.#tools.get(call.name);
    return tool && schemaValidator(tool.inputSchema)(call.input).valid
      ? tool.activity?.(call.input) ?? null : null;
  }
  activityCitations(call: NormalizedToolCall) {
    return this.#tools.get(call.name)?.activityCitations?.(call.input) ?? [];
  }

  async run(
    calls: NormalizedToolCall[],
    context: Context,
    signal: AbortSignal = new AbortController().signal,
    onResult?: OnResult,
  ): Promise<NormalizedToolResult[]> {
    const serial = calls.some((call) => {
      const setting = this.#tools.get(call.name)?.sequential;
      return typeof setting === "function" ? setting(call.input) : setting === true;
    });
    const executions = serial
      ? await this.#serial(calls, context, signal, onResult)
      : await this.#parallel(calls, context, signal, onResult);
    const terminal = executions.length > 0 && executions.every(({ outcome }) => outcome.terminal);
    return executions.map(({ call, outcome }) => normalize(call.id, { ...outcome, terminal }));
  }

  async #parallel(
    calls: NormalizedToolCall[], context: Context, signal: AbortSignal, onResult?: OnResult,
  ) {
    const results = new Array<Execution>(calls.length);
    let next = 0, failed = false;
    const workers = await Promise.allSettled(Array.from(
      { length: Math.min(MAX_PARALLEL_TOOL_CALLS, calls.length) },
      async () => {
        try {
          while (!failed && next < calls.length) {
            const index = next++;
            results[index] = await this.#execute(calls[index], context, signal);
            onResult?.(results[index].call, results[index].outcome);
          }
        } catch (error) { failed = true; throw error; }
      },
    ));
    const rejected = workers.find((worker) => worker.status === "rejected");
    if (rejected) throw rejected.reason;
    return results;
  }

  async #serial(
    calls: NormalizedToolCall[], context: Context, signal: AbortSignal, onResult?: OnResult,
  ) {
    const results: Execution[] = [];
    for (const call of calls) {
      const executed = results.some(({ outcome }) => outcome.pause)
        ? { call, outcome: failedOutcome("waiting_for_user") }
        : await this.#execute(call, context, signal);
      results.push(executed);
      onResult?.(call, executed.outcome);
    }
    return results;
  }

  async #execute(
    call: NormalizedToolCall,
    context: Context,
    signal: AbortSignal,
  ): Promise<Execution> {
    if (call.name === LOAD_TOOLS_NAME) {
      const checked = (this.#loadInput ??= schemaValidator(
        loader([...this.#tools.keys()]).inputSchema))(call.input);
      return { call, outcome: checked.valid
        ? { result: this.#load(call.input.names as string[]) }
        : failedOutcome("invalid_arguments", checked.errorMessage) };
    }
    const tool = this.#tools.get(call.name);
    if (!tool || !this.#active.has(call.name)) return {
      call,
      outcome: failedOutcome(tool ? "tool_not_loaded" : "unknown_tool",
        tool ? `Load ${call.name} before calling it.` : `Unknown tool: ${call.name}`),
    };
    const checked = schemaValidator(tool.inputSchema)(call.input);
    if (!checked.valid) {
      // Rejected arguments never reach the tool, so log them here or the failure is invisible.
      console.error("[assistant-tool] rejected arguments",
        { tool: call.name, detail: checked.errorMessage?.slice(0, 500) });
      return { call, outcome: failedOutcome("invalid_arguments", checked.errorMessage) };
    }
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Tool call cancelled");
      const outcome = await tool.execute(call.input, context, signal, call);
      const parsed = CallToolResultSchema.safeParse(outcome?.result);
      if (!parsed.success) throw new Error(`Malformed tool result: ${parsed.error.message}`);
      if (tool.outputSchema && !parsed.data.isError) {
        if (!parsed.data.structuredContent) throw new Error(
          "Tool declared outputSchema but returned no structuredContent");
        const output = schemaValidator(tool.outputSchema)(parsed.data.structuredContent);
        if (!output.valid) throw new Error(`Invalid structuredContent: ${output.errorMessage}`);
      }
      return { call, outcome: { ...outcome, result: parsed.data } };
    } catch (error) {
      console.error("[assistant-tool] execution failed", { tool: call.name, ...safeErrorLog(error) });
      return { call, outcome: {
        ...failedOutcome("tool_error", "Tool execution failed"),
        metadata: { status: "error" },
      } };
    }
  }

  #load(names: string[]) {
    const added = names.filter((name) => !this.#active.has(name));
    added.forEach((name) => this.#active.add(name));
    if (added.length) this.#visible = undefined;
    return toolText({ ok: true, loaded: added });
  }
}
