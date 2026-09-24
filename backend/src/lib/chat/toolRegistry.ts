import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { LlmMessage, NormalizedToolCall, NormalizedToolResult } from "../llm";
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
  /** Application-owned submissions may defer a malformed item for isolated repair. */
  onInvalidInput?: (input: Record<string, unknown>, detail: string) => BeaverOutcome;
  execute(
    input: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
    call: Readonly<NormalizedToolCall>,
  ): Promise<BeaverOutcome>;
};

const validator = new AjvJsonSchemaValidator();
const schema = (tool: Tool): Tool => ({
  name: tool.name,
  ...(tool.title && { title: tool.title }),
  ...(tool.description && { description: tool.description }),
  inputSchema: tool.inputSchema,
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
  description: "Load specialist tools by exact name. Returns their callable definitions and parameter schemas.",
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
/** Strip host audit fields, not source text or actionable versions/cursors. */
export const modelToolData = (value: unknown): unknown => Array.isArray(value)
  ? value.map(modelToolData)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      /(?:^|_)(?:url|uri|href)$/iu.test(key) || /(?:sha256|Sha256)$/u.test(key) ||
      ["sourceFingerprints", "executor_version", "resolver_version", "text_sha256"].includes(key) ||
      item === "not_run" && /(?:status|verification)$/u.test(key)
        ? [] : [[key, modelToolData(item)]]))
    : value;
const visibleText = (result: CallToolResult, definitions = false) => {
  const text = result.content.map((block) => {
    if (block.type !== "text") return JSON.stringify(block);
    if (definitions) return block.text;
    try { return JSON.stringify(modelToolData(JSON.parse(block.text))); }
    catch { return block.text; }
  }).join("\n");
  if (text.length <= MAX_MODEL_TOOL_RESULT_CHARS) return { text, truncated: false };
  try {
    JSON.parse(text);
    return { text: JSON.stringify({ ok: false, error: "tool_result_too_large",
      truncated: true, next: "Use narrower read inputs or a smaller page. No partial JSON was returned; the operation was not undone. Do not repeat completed writes." }), truncated: true };
  } catch { /* Plain text keeps the existing explicit truncation marker. */ }
  const marker = "\n… tool result truncated; retry with narrower inputs …\n";
  const tail = Math.floor(MAX_MODEL_TOOL_RESULT_CHARS / 4);
  return {
    text: text.slice(0, MAX_MODEL_TOOL_RESULT_CHARS - tail - marker.length) +
      marker + text.slice(-tail),
    truncated: true,
  };
};
const normalize = (call: NormalizedToolCall, outcome: BeaverOutcome): NormalizedToolResult => {
  const id = call.id;
  const visible = visibleText(outcome.result, call.name === LOAD_TOOLS_NAME);
  // A failed tool result is otherwise invisible outside the model's context; name it in the server log.
  if (outcome.result.isError) console.warn("[assistant-tool] failed", { id, detail: visible.text.slice(0, 600) });
  return {
    tool_use_id: id,
    content: visible.text,
    ...outcome.metadata,
    status: visible.truncated ? "truncated" : outcome.metadata?.status ??
      (outcome.result.isError ? "error" : "ok"),
    ...(outcome.terminal && { terminal: true }),
  };
};

type Check = ReturnType<AjvJsonSchemaValidator["getValidator"]>;
type Compiled<Context> = { tool: BeaverTool<Context>; input: Check; output?: Check };
type Execution = { call: NormalizedToolCall; outcome: BeaverOutcome };
type OnResult = (call: NormalizedToolCall, outcome: BeaverOutcome) => void;

/** Reuse already-discovered schemas in hosted replay; a fresh chat still starts deferred. */
export function previouslyVisibleTools(messages: readonly LlmMessage[]) {
  return messages.flatMap(message => message.modelState?.messages ?? []).flatMap(message =>
    message.role === "assistant" && Array.isArray(message.content) ? message.content.flatMap(part => {
      if (part.type !== "tool-call") return [];
      const names = part.toolName === LOAD_TOOLS_NAME ? jsonRecord(part.input)?.names : [];
      return [part.toolName, ...(Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [])];
    }) : []);
}

export class TurnToolRegistry<Context> {
  readonly #tools: Compiled<Context>[];
  readonly #byName = new Map<string, Compiled<Context>>();
  readonly #active = new Set<string>();
  #mutated = false;

  constructor(tools: BeaverTool<Context>[], previouslyVisible: readonly string[] = []) {
    const visible = new Set(previouslyVisible);
    this.#tools = tools.map((candidate) => {
      const parsed = ToolSchema.safeParse(schema(candidate));
      if (!parsed.success) throw new Error(
        `Invalid tool ${candidate.name || "<empty>"}: ${parsed.error.message}`);
      const name = candidate.name.trim();
      if (!name || name === LOAD_TOOLS_NAME) {
        throw new Error(`Reserved or empty tool name: ${name || "<empty>"}`);
      }
      if (this.#byName.has(name)) throw new Error(`Duplicate tool: ${name}`);
      if (typeof candidate.execute !== "function") throw new Error(`Tool ${name} has no executor`);
      const compiled: Compiled<Context> = {
        tool: { ...candidate, name },
        input: validator.getValidator(candidate.inputSchema),
        ...(candidate.outputSchema && {
          output: validator.getValidator(candidate.outputSchema),
        }),
      };
      this.#byName.set(name, compiled);
      if (!candidate.specialist || visible.has(name)) this.#active.add(name);
      return compiled;
    });
  }

  specialists() {
    return this.#tools.flatMap(({ tool }) => this.#active.has(tool.name) ? [] : [tool.name]);
  }
  visible() {
    const specialists = this.specialists();
    return [
      ...(specialists.length ? [loader(specialists)] : []),
      ...this.#tools.flatMap(({ tool }) => this.#active.has(tool.name) ? [schema(tool)] : []),
    ];
  }
  all() {
    const specialists = this.specialists();
    return [
      ...(specialists.length ? [loader(specialists)] : []),
      ...this.#tools.map(({ tool }) => schema(tool)),
    ];
  }
  activity(call: NormalizedToolCall) {
    // Reaching for a tool is machinery, not an act the reader follows, and a call whose
    // arguments the schema rejects never runs: neither is work to show as a step.
    const compiled = this.#byName.get(call.name);
    return compiled?.input(call.input).valid
      ? compiled.tool.activity?.(call.input) ?? null : null;
  }
  activityCitations(call: NormalizedToolCall) {
    return this.#byName.get(call.name)?.tool.activityCitations?.(call.input) ?? [];
  }

  async run(
    calls: NormalizedToolCall[],
    context: Context,
    signal: AbortSignal = new AbortController().signal,
    onResult?: OnResult,
  ): Promise<NormalizedToolResult[]> {
    if (new Set(calls.map(call => call.id)).size !== calls.length)
      throw new Error("Duplicate tool call IDs");
    const serial = calls.some((call) => {
      if (call.name === LOAD_TOOLS_NAME) return true;
      const setting = this.#byName.get(call.name)?.tool.sequential;
      return typeof setting === "function" ? setting(call.input) : setting === true;
    });
    const executions = serial
      ? await this.#serial(calls, context, signal, onResult)
      : await this.#parallel(calls, context, signal, onResult);
    const terminal = executions.length > 0 && executions.every(({ outcome }) => outcome.terminal);
    return executions.map(({ call, outcome }) => normalize(call, { ...outcome, terminal }));
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
            this.#mutated ||= results[index].outcome.mutated === true;
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
      let executed = results.some(({ outcome }) => outcome.pause)
        ? { call, outcome: failedOutcome("waiting_for_user") }
        : await this.#execute(call, context, signal);
      if (executed.outcome.pause && this.#mutated) executed = {
        call,
        outcome: failedOutcome(
          "ask_inputs_after_mutation",
          "ask_inputs must run before document or workflow changes",
        ),
      };
      this.#mutated ||= executed.outcome.mutated === true;
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
    if (signal.aborted) throw signal.reason ?? new Error("Tool call cancelled");
    if (call.name === LOAD_TOOLS_NAME) {
      const checked = validator.getValidator(
        loader([...this.#byName.keys()]).inputSchema)(call.input);
      return { call, outcome: checked.valid
        ? { result: this.#load(call.input.names as string[]) }
        : failedOutcome("invalid_arguments", checked.errorMessage) };
    }
    const compiled = this.#byName.get(call.name);
    if (!compiled) return { call, outcome: failedOutcome("unknown_tool", `Unknown tool: ${call.name}`) };
    const checked = compiled.input(call.input);
    if (!checked.valid) {
      if (compiled.tool.onInvalidInput) return { call,
        outcome: compiled.tool.onInvalidInput(call.input, checked.errorMessage ?? "Invalid arguments") };
      // Rejected arguments never reach the tool, so log them here or the failure is invisible.
      console.error("[assistant-tool] rejected arguments",
        { tool: call.name, detail: checked.errorMessage?.slice(0, 500) });
      return { call, outcome: failedOutcome("invalid_arguments", checked.errorMessage) };
    }
    // A valid call to an in-scope specialist is its own load: clients that already
    // hold the schema (native tool search, MCP catalogs) need no separate loader round.
    this.#active.add(call.name);
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Tool call cancelled");
      const outcome = await compiled.tool.execute(call.input, context, signal, call);
      const parsed = CallToolResultSchema.safeParse(outcome?.result);
      if (!parsed.success) throw new Error(`Malformed tool result: ${parsed.error.message}`);
      if (compiled.output && !parsed.data.isError) {
        if (!parsed.data.structuredContent) throw new Error(
          "Tool declared outputSchema but returned no structuredContent");
        const output = compiled.output(parsed.data.structuredContent);
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
    const tools = names.map(name => schema(this.#byName.get(name)!.tool));
    const result = toolText({ ok: true, loaded: added, tools });
    // Never acknowledge a partial/truncated definition as a successful load.
    if (visibleText(result, true).truncated) return toolText({ ok: false, error: "tool_definitions_too_large",
      detail: "Load fewer tools in one call." }, true);
    added.forEach((name) => this.#active.add(name));
    return result;
  }
}
