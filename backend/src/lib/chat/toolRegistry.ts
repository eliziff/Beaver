import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../llm";
import type { AskInputsEvent } from "./types";

export const LOAD_TOOLS_NAME = "load_tools";
export const SPECIALIST_LIMIT = 3;

export type ToolEffect = "read" | "write" | "interactive" | "external";
export type ToolBatch = {
  results: NormalizedToolResult[];
  pause?: AskInputsEvent;
};
export type ToolExecutor<Context> = (
  calls: NormalizedToolCall[],
  context: Context,
) => Promise<ToolBatch>;
export type ToolEntry<Context> = {
  schema: OpenAIToolSchema;
  effects: readonly ToolEffect[];
  available: (capabilities: ReadonlySet<string>) => boolean;
  execute: ToolExecutor<Context>;
  project: (
    result: NormalizedToolResult,
    call: NormalizedToolCall,
  ) => NormalizedToolResult;
  activity: (call: NormalizedToolCall) => string | null;
};

export const bindToolSchemas = <Context>(
  schemas: OpenAIToolSchema[],
  execute: ToolExecutor<Context>,
  effects: readonly ToolEffect[] | ((schema: OpenAIToolSchema) => readonly ToolEffect[]) = ["read"],
  project: ToolEntry<Context>["project"] = (result) => result,
  activity: ToolEntry<Context>["activity"] = () => null,
): ToolEntry<Context>[] => schemas.map((schema) => ({
  schema,
  effects: typeof effects === "function" ? effects(schema) : effects,
  available: () => true,
  execute,
  project,
  activity,
}));

export const RESIDENT_TOOL_NAMES = new Set([
  "ask_inputs",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "generate_docx",
  "generate_excel",
  "generate_ppt",
  "search_sources",
  "note_up",
  "submit_grounded_answer",
]);

const reply = (tool_use_id: string, value: unknown): NormalizedToolResult => ({
  tool_use_id,
  content: JSON.stringify(value),
});

const nameOf = (tool: OpenAIToolSchema) => tool.function.name;

function loaderSchema(names: string[], limit: number): OpenAIToolSchema {
  return {
    type: "function",
    function: {
      name: LOAD_TOOLS_NAME,
      description:
        "Load up to three named specialist Beaver tools for this turn. Use exact names from the enum. This does not search or rank tools.",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            minItems: 1,
            maxItems: limit,
            items: { type: "string", enum: names },
            description: "Exact specialist tool names to load.",
          },
        },
        required: ["names"],
        additionalProperties: false,
      },
    },
  };
}

export class TurnToolRegistry<Context> {
  readonly #catalog: ToolEntry<Context>[];
  readonly #byName: Map<string, ToolEntry<Context>>;
  readonly #active: Set<string>;
  readonly #loaded = new Set<string>();

  constructor(
    tools: ToolEntry<Context>[],
    alwaysActive: Iterable<string> = [],
    capabilities: ReadonlySet<string> = new Set(),
  ) {
    this.#byName = new Map(tools
      .filter((tool) => tool.available(capabilities))
      .map((tool) => [nameOf(tool.schema), tool]));
    this.#catalog = [...this.#byName.values()];
    this.#active = new Set([
      ...this.#catalog
        .filter(({ schema, effects }) =>
          RESIDENT_TOOL_NAMES.has(nameOf(schema)) || effects.includes("external")
        )
        .map(({ schema }) => nameOf(schema)),
      ...alwaysActive,
    ]);
  }

  visible() {
    const specialists = this.specialists();
    const remaining = SPECIALIST_LIMIT - this.#loaded.size;
    return [
      ...(remaining && specialists.length
        ? [loaderSchema(specialists, remaining)]
        : []),
      ...this.#catalog.flatMap(({ schema }) =>
        this.#active.has(nameOf(schema)) ? [schema] : []),
    ];
  }

  all() {
    const specialists = this.specialists();
    return [
      ...(specialists.length
        ? [loaderSchema(specialists, SPECIALIST_LIMIT)]
        : []),
      ...this.#catalog.map(({ schema }) => schema),
    ];
  }

  specialists() {
    return this.#catalog.map(({ schema }) => nameOf(schema))
      .filter((name) => !this.#active.has(name));
  }

  specialistPrompt() {
    const names = this.specialists();
    return names.length
      ? `Specialist tools available through load_tools: ${names.join(", ")}. Load only the exact names needed for the task.`
      : "";
  }

  activity(call: NormalizedToolCall) {
    return call.name === LOAD_TOOLS_NAME
      ? "Loading tools"
      : this.#byName.get(call.name)?.activity(call) ?? null;
  }

  async run(calls: NormalizedToolCall[], context: Context): Promise<ToolBatch> {
    const results = new Map<string, NormalizedToolResult>();
    const groups = new Map<ToolExecutor<Context>, NormalizedToolCall[]>();
    for (const call of calls) {
      if (call.name === LOAD_TOOLS_NAME) {
        results.set(call.id, this.#load(call));
      } else if (!this.#active.has(call.name)) {
        results.set(call.id, reply(call.id, {
          ok: false,
          error: "tool_not_loaded",
          detail: this.#byName.has(call.name)
            ? `Load ${call.name} with load_tools before calling it.`
            : `Unknown tool: ${call.name}`,
        }));
      } else {
        const execute = this.#byName.get(call.name)!.execute;
        groups.set(execute, [...(groups.get(execute) ?? []), call]);
      }
    }
    const batches = await Promise.all([...groups].map(([execute, grouped]) =>
      execute(grouped, context)));
    const callsById = new Map(calls.map((call) => [call.id, call]));
    const executed = batches.flatMap((batch) => batch.results).map((result) => {
      const call = callsById.get(result.tool_use_id);
      return call
        ? this.#byName.get(call.name)?.project(result, call) ?? result
        : result;
    });
    const byId = new Map(executed.map((result) => [result.tool_use_id, result]));
    return {
      results: calls.map((call) => results.get(call.id) ?? byId.get(call.id) ??
        reply(call.id, { ok: false, error: "Tool result is unavailable" })),
      pause: batches.find((batch) => batch.pause)?.pause,
    };
  }

  #load(call: NormalizedToolCall) {
    const raw = call.input.names;
    const names = Array.isArray(raw)
      ? [...new Set(raw.filter((name): name is string => typeof name === "string"))]
      : [];
    if (!names.length || names.length > SPECIALIST_LIMIT) {
      return reply(call.id, {
        ok: false,
        error: `names must contain one to ${SPECIALIST_LIMIT} exact tool names`,
      });
    }
    const unknown = names.filter((name) => !this.#byName.has(name));
    if (unknown.length) {
      return reply(call.id, {
        ok: false,
        error: "unknown_tools",
        unknown,
        available: this.specialists(),
      });
    }
    const added = names.filter((name) => !this.#active.has(name));
    if (this.#loaded.size + added.length > SPECIALIST_LIMIT) {
      return reply(call.id, {
        ok: false,
        error: `At most ${SPECIALIST_LIMIT} specialist tools may be loaded per turn`,
      });
    }
    added.forEach((name) => {
      this.#active.add(name);
      this.#loaded.add(name);
    });
    return reply(call.id, { ok: true, loaded: added });
  }
}
