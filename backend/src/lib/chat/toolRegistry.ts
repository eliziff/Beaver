import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedToolCall, NormalizedToolResult } from "../llm";
import { safeErrorLog } from "../safeError";
import type { AskInputsEvent } from "./types";
import type { LegalEvidenceReceipt } from "./legalEvidence";
import type { ReadSubagentRegion } from "./readSubagents";

export const LOAD_TOOLS_NAME = "load_tools";
export const SPECIALIST_LIMIT = 3;
export const MAX_MODEL_TOOL_RESULT_CHARS = 64_000;

export type BeaverOutcome = {
  result: CallToolResult;
  metadata?: Omit<NormalizedToolResult, "tool_use_id" | "content" | "terminal">;
  events?: unknown[];
  evidence?: LegalEvidenceReceipt[];
  pause?: AskInputsEvent;
  mutated?: boolean;
  terminal?: boolean;
};
export type BeaverTool<Context> = Tool & {
  specialist?: boolean;
  research?: boolean;
  reader?: readonly ReadSubagentRegion[];
  sequential?: boolean | ((input: Record<string, unknown>) => boolean);
  activity?: (input: Record<string, unknown>) => string | null;
  execute(
    input: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
    call: Readonly<NormalizedToolCall>,
  ): Promise<BeaverOutcome>;
};
export type ToolBatch = {
  results: NormalizedToolResult[];
  outcomes: BeaverOutcome[];
  pause?: AskInputsEvent;
  mutated: boolean;
  events: unknown[];
  evidence: LegalEvidenceReceipt[];
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
const loader = (names: string[], limit: number): Tool => ({
  name: LOAD_TOOLS_NAME,
  description: `Load up to ${limit} exact specialist tool names for this turn.`,
  inputSchema: {
    type: "object",
    properties: { names: {
      type: "array", minItems: 1, maxItems: limit, uniqueItems: true,
      items: names.length ? { type: "string", enum: names } : { type: "string" },
    } },
    required: ["names"],
    additionalProperties: false,
  },
});

export const toolText = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError && { isError: true }),
});
export const toolResultText = (result: CallToolResult) => result.content
  .map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
const withoutUrls = (value: unknown): unknown => Array.isArray(value)
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
  const evidenceRefs = outcome.evidence?.flatMap((receipt) => receipt.span_text ? [{
    handle: receipt.evidence_id,
    filename: receipt.name ?? receipt.citation,
    locator: receipt.locator.label,
    text: receipt.span_text,
    exactSha256: receipt.exact_span_sha256 ?? receipt.span_sha256,
    kind: "evidence" as const,
  }] : []);
  return {
    tool_use_id: id,
    content: visible.text,
    ...outcome.metadata,
    ...(!outcome.metadata?.evidenceRefs && evidenceRefs?.length && { evidenceRefs }),
    status: outcome.metadata?.status ??
      (visible.truncated ? "truncated" : outcome.result.isError ? "error" : "ok"),
    ...(outcome.terminal && { terminal: true }),
  };
};

type Check = ReturnType<AjvJsonSchemaValidator["getValidator"]>;
type Compiled<Context> = { tool: BeaverTool<Context>; input: Check; output?: Check };
type Execution = { call: NormalizedToolCall; outcome: BeaverOutcome };
const errorOutcome = (error: string, detail?: string): BeaverOutcome => ({
  result: toolText({ ok: false, error, ...(detail && { detail }) }, true),
});

export class TurnToolRegistry<Context> {
  readonly #tools: Compiled<Context>[];
  readonly #byName = new Map<string, Compiled<Context>>();
  readonly #active = new Set<string>();
  readonly #loaded = new Set<string>();
  #mutated = false;

  constructor(tools: BeaverTool<Context>[]) {
    this.#tools = tools.map((candidate) => {
      const parsed = ToolSchema.safeParse(schema(candidate));
      if (!parsed.success) throw new Error(
        `Invalid tool ${candidate.name || "<empty>"}: ${parsed.error.message}`);
      const name = candidate.name.trim();
      if (!name || name === LOAD_TOOLS_NAME) {
        throw new Error(`Reserved or empty tool name: ${name || "<empty>"}`);
      }
      if (this.#byName.has(name)) throw new Error(`Duplicate tool: ${name}`);
      const compiled: Compiled<Context> = {
        tool: { ...candidate, name },
        input: validator.getValidator(candidate.inputSchema),
        ...(candidate.outputSchema && {
          output: validator.getValidator(candidate.outputSchema),
        }),
      };
      this.#byName.set(name, compiled);
      if (!candidate.specialist) this.#active.add(name);
      return compiled;
    });
  }

  specialists() {
    return this.#tools.flatMap(({ tool }) => this.#active.has(tool.name) ? [] : [tool.name]);
  }
  visible() {
    const specialists = this.specialists(), remaining = SPECIALIST_LIMIT - this.#loaded.size;
    return [
      ...(remaining > 0 && specialists.length ? [loader(specialists, remaining)] : []),
      ...this.#tools.flatMap(({ tool }) => this.#active.has(tool.name) ? [schema(tool)] : []),
    ];
  }
  all() {
    const specialists = this.specialists();
    return [
      ...(specialists.length ? [loader(specialists, SPECIALIST_LIMIT)] : []),
      ...this.#tools.map(({ tool }) => schema(tool)),
    ];
  }
  specialistPrompt() {
    const names = this.specialists();
    return names.length
      ? `Specialist tools available through load_tools: ${names.join(", ")}. Load only exact names needed for the task.`
      : "";
  }
  activity(call: NormalizedToolCall) {
    return call.name === LOAD_TOOLS_NAME ? "Loading tools"
      : this.#byName.get(call.name)?.tool.activity?.(call.input) ?? null;
  }

  async run(
    calls: NormalizedToolCall[],
    context: Context,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ToolBatch> {
    const serial = calls.some((call) => {
      const setting = this.#byName.get(call.name)?.tool.sequential;
      return typeof setting === "function" ? setting(call.input) : setting === true;
    });
    const executions = serial
      ? await this.#serial(calls, context, signal)
      : await Promise.all(calls.map((call) => this.#execute(call, context, signal)));
    this.#mutated ||= executions.some(({ outcome }) => outcome.mutated);
    const terminal = executions.length > 0 && executions.every(({ outcome }) => outcome.terminal);
    const outcomes = executions.map(({ outcome }) => outcome);
    return {
      results: executions.map(({ call, outcome }) => normalize(call.id, { ...outcome, terminal })),
      outcomes,
      pause: outcomes.find(({ pause }) => pause)?.pause,
      mutated: outcomes.some(({ mutated }) => mutated === true),
      events: outcomes.flatMap(({ events }) => events ?? []),
      evidence: outcomes.flatMap(({ evidence }) => evidence ?? []),
    };
  }

  async #serial(calls: NormalizedToolCall[], context: Context, signal: AbortSignal) {
    const results: Execution[] = [];
    let mutated = this.#mutated;
    for (const call of calls) {
      let executed = results.some(({ outcome }) => outcome.pause)
        ? { call, outcome: errorOutcome("waiting_for_user") }
        : await this.#execute(call, context, signal);
      if (executed.outcome.pause && mutated) executed = {
        call,
        outcome: errorOutcome(
          "ask_inputs_after_mutation",
          "ask_inputs must run before document or workflow changes",
        ),
      };
      mutated ||= executed.outcome.mutated === true;
      results.push(executed);
    }
    return results;
  }

  async #execute(
    call: NormalizedToolCall,
    context: Context,
    signal: AbortSignal,
  ): Promise<Execution> {
    if (call.name === LOAD_TOOLS_NAME) {
      const checked = validator.getValidator(
        loader(this.specialists(), SPECIALIST_LIMIT).inputSchema)(call.input);
      return { call, outcome: checked.valid
        ? { result: this.#load(call.input.names as string[]) }
        : errorOutcome("invalid_arguments", checked.errorMessage) };
    }
    const compiled = this.#byName.get(call.name);
    if (!compiled || !this.#active.has(call.name)) return {
      call,
      outcome: errorOutcome(compiled ? "tool_not_loaded" : "unknown_tool",
        compiled ? `Load ${call.name} before calling it.` : `Unknown tool: ${call.name}`),
    };
    const checked = compiled.input(call.input);
    if (!checked.valid) return { call, outcome: errorOutcome(
      "invalid_arguments", checked.errorMessage) };
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Tool call cancelled");
      const outcome = await compiled.tool.execute(call.input, context, signal, call);
      const parsed = CallToolResultSchema.safeParse(outcome?.result);
      if (!parsed.success) throw new Error(`Malformed tool result: ${parsed.error.message}`);
      if (compiled.output) {
        if (!parsed.data.structuredContent) throw new Error(
          "Tool declared outputSchema but returned no structuredContent");
        const output = compiled.output(parsed.data.structuredContent);
        if (!output.valid) throw new Error(`Invalid structuredContent: ${output.errorMessage}`);
      }
      return { call, outcome: { ...outcome, result: parsed.data } };
    } catch (error) {
      console.error("[assistant-tool] execution failed", { tool: call.name, ...safeErrorLog(error) });
      return { call, outcome: {
        ...errorOutcome("tool_error", "Tool execution failed"),
        metadata: { status: "error" },
      } };
    }
  }

  #load(names: string[]) {
    const unknown = names.filter((name) => !this.#byName.has(name));
    if (unknown.length) return toolText({ ok: false, error: "unknown_tools", unknown }, true);
    const added = names.filter((name) => !this.#active.has(name));
    if (this.#loaded.size + added.length > SPECIALIST_LIMIT) return toolText({
      ok: false, error: `At most ${SPECIALIST_LIMIT} specialist tools may be loaded per turn`,
    }, true);
    added.forEach((name) => { this.#active.add(name); this.#loaded.add(name); });
    return toolText({ ok: true, loaded: added });
  }
}
