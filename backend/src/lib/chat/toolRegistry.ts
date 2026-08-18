import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import {
  CallToolResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { NormalizedToolCall, NormalizedToolResult } from "../llm";
import type { AskInputsEvent } from "./types";
import type { LegalEvidenceReceipt } from "./legalEvidence";
import { safeErrorLog } from "../safeError";

export const LOAD_TOOLS_NAME = "load_tools";
export const SPECIALIST_LIMIT = 3;
export const MAX_MODEL_TOOL_RESULT_CHARS = 64_000;

type ResultMetadata = Omit<
  NormalizedToolResult,
  "tool_use_id" | "content" | "terminal"
>;

export type BeaverOutcome = {
  result: CallToolResult;
  metadata?: ResultMetadata;
  events?: unknown[];
  evidence?: LegalEvidenceReceipt[];
  pause?: AskInputsEvent;
  mutated?: boolean;
  terminal?: boolean;
};

export type BeaverTool<Context> = Tool & {
  specialist?: boolean;
  reader?: boolean;
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
const schemaOf = ({
  name,
  title,
  description,
  inputSchema,
  outputSchema,
  annotations,
  execution,
  icons,
  _meta,
}: Tool): Tool => ({
  name,
  ...(title ? { title } : {}),
  ...(description ? { description } : {}),
  inputSchema,
  ...(outputSchema ? { outputSchema } : {}),
  ...(annotations ? { annotations } : {}),
  ...(execution ? { execution } : {}),
  ...(icons ? { icons } : {}),
  ...(_meta ? { _meta } : {}),
});

export const toolText = (value: unknown, isError = false): CallToolResult => ({
  content: [{
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value),
  }],
  ...(isError ? { isError: true } : {}),
});

export function toolResultText(result: CallToolResult) {
  return result.content.map((block) =>
    block.type === "text" ? block.text : JSON.stringify(block)
  ).join("\n");
}

const withoutStructuredUrls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutStructuredUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => /(?:^|_)(?:url|uri|href)$/iu.test(key)
      ? []
      : [[key, withoutStructuredUrls(item)]]));
};

const modelResultText = (result: CallToolResult) => {
  const visible = result.content.map((block) => {
    if (block.type !== "text") return JSON.stringify(block);
    try {
      return JSON.stringify(withoutStructuredUrls(JSON.parse(block.text)));
    } catch {
      return block.text;
    }
  }).join("\n");
  if (visible.length <= MAX_MODEL_TOOL_RESULT_CHARS) {
    return { content: visible, truncated: false };
  }
  const marker = "\n… tool result truncated; retry with narrower inputs …\n";
  const tail = Math.floor(MAX_MODEL_TOOL_RESULT_CHARS / 4);
  const head = MAX_MODEL_TOOL_RESULT_CHARS - tail - marker.length;
  return {
    content: visible.slice(0, head) + marker + visible.slice(-tail),
    truncated: true,
  };
};

const normalized = (
  id: string,
  outcome: BeaverOutcome,
): NormalizedToolResult => {
  const visible = modelResultText(outcome.result);
  return {
    tool_use_id: id,
    content: visible.content,
    ...outcome.metadata,
    ...(visible.truncated && !outcome.metadata?.status
      ? { status: "truncated" as const }
      : {}),
    ...(outcome.terminal ? { terminal: true } : {}),
  };
};

function loaderSchema(names: string[], limit: number): Tool {
  return {
    name: LOAD_TOOLS_NAME,
    description:
      `Load up to ${limit} exact specialist tool names for this turn. This does not search or rank tools.`,
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          minItems: 1,
          maxItems: limit,
          uniqueItems: true,
          items: names.length ? { type: "string", enum: names } : { type: "string" },
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
  };
}

type Compiled<Context> = {
  tool: BeaverTool<Context>;
  input: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  output?: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
};

type Prepared<Context> = {
  call: NormalizedToolCall;
  immediate?: CallToolResult;
  tool?: BeaverTool<Context>;
  output?: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
};

export class TurnToolRegistry<Context> {
  readonly #tools: Compiled<Context>[];
  readonly #byName: Map<string, Compiled<Context>>;
  readonly #active: Set<string>;
  readonly #loaded = new Set<string>();
  readonly #loaderInput: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  #mutated = false;

  constructor(tools: BeaverTool<Context>[]) {
    this.#byName = new Map();
    this.#tools = tools.map((tool) => {
      const parsed = ToolSchema.safeParse(schemaOf(tool));
      if (!parsed.success) {
        throw new Error(`Invalid tool ${tool.name || "<empty>"}: ${parsed.error.message}`);
      }
      const name = tool.name.trim();
      if (!name || name === LOAD_TOOLS_NAME) {
        throw new Error(`Reserved or empty tool name: ${name || "<empty>"}`);
      }
      if (this.#byName.has(name)) throw new Error(`Duplicate tool: ${name}`);
      const compiled: Compiled<Context> = {
        tool: { ...tool, name },
        input: validator.getValidator(tool.inputSchema),
        ...(tool.outputSchema
          ? { output: validator.getValidator(tool.outputSchema) }
          : {}),
      };
      this.#byName.set(name, compiled);
      return compiled;
    });
    this.#active = new Set(this.#tools
      .filter(({ tool }) => !tool.specialist)
      .map(({ tool }) => tool.name));
    this.#loaderInput = validator.getValidator(
      loaderSchema(this.specialists(), SPECIALIST_LIMIT).inputSchema,
    );
  }

  visible() {
    const specialists = this.specialists();
    const remaining = SPECIALIST_LIMIT - this.#loaded.size;
    return [
      ...(remaining && specialists.length
        ? [loaderSchema(specialists, remaining)]
        : []),
      ...this.#tools.flatMap(({ tool }) =>
        this.#active.has(tool.name) ? [schemaOf(tool)] : []),
    ];
  }

  all() {
    const specialists = this.specialists();
    return [
      ...(specialists.length ? [loaderSchema(specialists, SPECIALIST_LIMIT)] : []),
      ...this.#tools.map(({ tool }) => schemaOf(tool)),
    ];
  }

  specialists() {
    return this.#tools.map(({ tool }) => tool.name)
      .filter((name) => !this.#active.has(name));
  }

  specialistPrompt() {
    const names = this.specialists();
    return names.length
      ? `Specialist tools available through load_tools: ${names.join(", ")}. Load only exact names needed for the task.`
      : "";
  }

  activity(call: NormalizedToolCall) {
    return call.name === LOAD_TOOLS_NAME
      ? "Loading tools"
      : this.#byName.get(call.name)?.tool.activity?.(call.input) ?? null;
  }

  async run(
    calls: NormalizedToolCall[],
    context: Context,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ToolBatch> {
    const prepared = calls.map((call) => this.#prepare(call));
    const sequential = prepared.some(({ tool, call }) =>
      tool && (typeof tool.sequential === "function"
        ? tool.sequential(call.input)
        : tool.sequential === true));
    const executions = sequential
      ? await this.#serial(prepared, context, signal)
      : await Promise.all(prepared.map((item) => this.#execute(item, context, signal)));
    this.#mutated ||= executions.some(({ outcome }) => outcome.mutated);
    const terminal = executions.length > 0 &&
      executions.every(({ outcome }) => outcome.terminal === true);
    return {
      results: executions.map(({ call, outcome }) => normalized(call.id, {
        ...outcome,
        terminal,
      })),
      outcomes: executions.map(({ outcome }) => outcome),
      pause: executions.find(({ outcome }) => outcome.pause)?.outcome.pause,
      mutated: executions.some(({ outcome }) => outcome.mutated),
      events: executions.flatMap(({ outcome }) => outcome.events ?? []),
      evidence: executions.flatMap(({ outcome }) => outcome.evidence ?? []),
    };
  }

  #prepare(call: NormalizedToolCall): Prepared<Context> {
    if (call.name === LOAD_TOOLS_NAME) {
      const checked = this.#loaderInput(call.input);
      return {
        call,
        immediate: checked.valid
          ? this.#load(call.input)
          : toolText({
              ok: false,
              error: "invalid_arguments",
              detail: checked.errorMessage,
            }, true),
      };
    }
    const compiled = this.#byName.get(call.name);
    if (!compiled || !this.#active.has(call.name)) {
      return {
        call,
        immediate: toolText({
          ok: false,
          error: compiled ? "tool_not_loaded" : "unknown_tool",
          detail: compiled
            ? `Load ${call.name} with load_tools before calling it.`
            : `Unknown tool: ${call.name}`,
        }, true),
      };
    }
    const checked = compiled.input(call.input);
    return checked.valid
      ? { call, tool: compiled.tool, output: compiled.output }
      : {
          call,
          immediate: toolText({
            ok: false,
            error: "invalid_arguments",
            detail: checked.errorMessage,
          }, true),
        };
  }

  async #serial(
    prepared: Prepared<Context>[],
    context: Context,
    signal: AbortSignal,
  ) {
    const results: Array<{ call: NormalizedToolCall; outcome: BeaverOutcome }> = [];
    let mutated = this.#mutated;
    for (const item of prepared) {
      if (results.some(({ outcome }) => outcome.pause)) {
        results.push({
          call: item.call,
          outcome: { result: toolText({ ok: false, error: "waiting_for_user" }, true) },
        });
      } else {
        const executed = await this.#execute(item, context, signal);
        if (executed.outcome.pause && mutated) {
          executed.outcome = {
            result: toolText({
              ok: false,
              error: "ask_inputs_after_mutation",
              detail: "ask_inputs must run before any document or workflow change in a turn",
            }, true),
          };
        }
        mutated ||= executed.outcome.mutated === true;
        results.push(executed);
      }
    }
    return results;
  }

  async #execute(
    prepared: Prepared<Context>,
    context: Context,
    signal: AbortSignal,
  ) {
    const { call } = prepared;
    if (prepared.immediate) {
      return { call, outcome: { result: prepared.immediate } };
    }
    try {
      if (signal.aborted) throw signal.reason ?? new Error("Tool call cancelled");
      const outcome = await prepared.tool!.execute(call.input, context, signal, call);
      const parsed = CallToolResultSchema.safeParse(outcome?.result);
      if (!parsed.success) throw new Error(`Malformed tool result: ${parsed.error.message}`);
      if (prepared.output) {
        if (!parsed.data.structuredContent) {
          throw new Error("Tool declared outputSchema but returned no structuredContent");
        }
        const checked = prepared.output(parsed.data.structuredContent);
        if (!checked.valid) {
          throw new Error(`Invalid structuredContent: ${checked.errorMessage}`);
        }
      }
      return { call, outcome: { ...outcome, result: parsed.data } };
    } catch (error) {
      console.error("[assistant-tool] execution failed", {
        tool: call.name,
        ...safeErrorLog(error),
      });
      return {
        call,
        outcome: {
          result: toolText({
            ok: false,
            error: "tool_error",
            detail: "Tool execution failed",
          }, true),
          metadata: { status: "error" as const },
        },
      };
    }
  }

  #load(input: Record<string, unknown>) {
    const names = input.names as string[];
    const unknown = names.filter((name) => !this.#byName.has(name));
    if (unknown.length) {
      return toolText({ ok: false, error: "unknown_tools", unknown }, true);
    }
    const added = names.filter((name) => !this.#active.has(name));
    if (this.#loaded.size + added.length > SPECIALIST_LIMIT) {
      return toolText({
        ok: false,
        error: `At most ${SPECIALIST_LIMIT} specialist tools may be loaded per turn`,
      }, true);
    }
    added.forEach((name) => {
      this.#active.add(name);
      this.#loaded.add(name);
    });
    return toolText({ ok: true, loaded: added });
  }
}
