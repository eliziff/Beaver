import { describe, expect, it, vi } from "vitest";
import type { NormalizedToolCall } from "../llm";
import { createTnaEvidence } from "./legalEvidence";
import {
  LOAD_TOOLS_NAME,
  MAX_MODEL_TOOL_RESULT_CHARS,
  TurnToolRegistry,
  toolText,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";

type Context = { order: string[] };

const call = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): NormalizedToolCall => ({ id, name, input });

const tool = (
  name: string,
  options: Partial<BeaverTool<Context>> = {},
): BeaverTool<Context> => ({
  name,
  inputSchema: {
    type: "object",
    properties: { count: { type: "integer" } },
    additionalProperties: false,
  },
  async execute(input) {
    return { result: toolText({ ok: true, input }) };
  },
  ...options,
});

const payload = (content: string) => JSON.parse(content);

describe("TurnToolRegistry", () => {
  it("rejects invalid, reserved, and duplicate definitions", () => {
    expect(() => new TurnToolRegistry([tool("")])).toThrow(/Invalid tool|empty/u);
    expect(() => new TurnToolRegistry([tool(LOAD_TOOLS_NAME)])).toThrow(/Reserved/u);
    expect(() => new TurnToolRegistry([tool("same"), tool("same")])).toThrow(/Duplicate/u);
    expect(() => new TurnToolRegistry([tool("word_python", { execute: undefined })])).toThrow(/no executor/u);
  });

  it("validates literally without scalar coercion", async () => {
    const registry = new TurnToolRegistry([tool("read")]);
    const batch = await registry.run(
      [call("1", "read", { count: "3" })],
      { order: [] },
    );
    expect(batch[0].status).toBe("error");
    expect(payload(batch[0].content).error).toBe("invalid_arguments");
  });

  it("shows no activity for a call the schema rejects", () => {
    const registry = new TurnToolRegistry([
      tool("read", { activity: () => "Checking draft" }),
    ]);
    expect(registry.activity(call("1", "read", { count: 3 }))).toBe("Checking draft");
    expect(registry.activity(call("2", "read", { count: "3" }))).toBeNull();
  });

  it("loads specialists by name or by a valid direct call and keeps every capability reachable", async () => {
    const registry = new TurnToolRegistry([
      tool("resident"),
      tool("one", { specialist: true }),
      tool("two", { specialist: true }),
      tool("three", { specialist: true }),
      tool("four", { specialist: true }),
    ]);
    expect(registry.visible().map(({ name }) => name)).toEqual([
      LOAD_TOOLS_NAME,
      "resident",
    ]);
    expect(payload((await registry.run(
      [call("0", "one", { count: "x" })], { order: [] },
    ))[0].content).error).toBe("invalid_arguments");
    for (const names of [["one", 0], ["one", "missing"]]) {
      const invalid = await registry.run([
        call("bad", LOAD_TOOLS_NAME, { names }),
      ], { order: [] });
      expect(payload(invalid[0].content).error).toBe("invalid_arguments");
    }
    expect(registry.visible().map(({ name }) => name)).toEqual([LOAD_TOOLS_NAME, "resident"]);
    const loaded = await registry.run([
      call("1", LOAD_TOOLS_NAME, { names: ["one", "two", "three"] }),
      call("2", "one"),
    ], { order: [] });
    expect(payload(loaded[0].content).loaded).toEqual(["one", "two", "three"]);
    expect(payload(loaded[0].content).tools.map((tool: { name: string }) => tool.name))
      .toEqual(["one", "two", "three"]);
    expect(payload(loaded[1].content).ok).toBe(true);
    // A valid direct call to a known specialist loads it without a loader round.
    const [direct] = await registry.run([call("4", "four", { count: 1 })], { order: [] });
    expect(payload(direct.content)).toEqual({ ok: true, input: { count: 1 } });
    expect(payload((await registry.run([call("5", "missing")], { order: [] }))[0].content).error)
      .toBe("unknown_tool");
    expect(registry.visible().map(({ name }) => name)).toEqual([
      "resident", "one", "two", "three", "four",
    ]);
  });

  it("runs parallel by default while preserving source result order", async () => {
    const finish: string[] = [];
    const registry = new TurnToolRegistry([
      tool("slow", {
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 15));
          finish.push("slow");
          return { result: toolText("slow") };
        },
      }),
      tool("fast", {
        async execute() {
          finish.push("fast");
          return { result: toolText("fast") };
        },
      }),
    ]);
    const batch = await registry.run([
      call("slow-id", "slow"),
      call("fast-id", "fast"),
    ], { order: [] });
    expect(finish).toEqual(["fast", "slow"]);
    expect(batch.map(({ tool_use_id }) => tool_use_id)).toEqual([
      "slow-id",
      "fast-id",
    ]);
  });

  it("bounds parallel tool execution", async () => {
    let active = 0, peak = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const registry = new TurnToolRegistry([tool("read", {
      async execute() {
        peak = Math.max(peak, ++active);
        await gate;
        active--;
        return { result: toolText("ok") };
      },
    })]);
    const running = registry.run(
      Array.from({ length: 5 }, (_, index) => call(`${index}`, "read")),
      { order: [] },
    );
    await Promise.resolve();
    expect(active).toBe(4);
    release();
    expect((await running)).toHaveLength(5);
    expect(peak).toBe(4);
  });

  it.each(["parallel", "serial"])("settles started %s work and retains mutations after result delivery fails", async (mode) => {
    let release!: () => void, deliveryFailed!: () => void, settled = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failureObserved = new Promise<void>((resolve) => { deliveryFailed = resolve; });
    const context = { order: [] as string[] }, failure = new Error("Event delivery failed");
    const registry = new TurnToolRegistry([
      tool("change", { sequential: mode === "serial", async execute(input, context) {
        context.order.push(`started ${input.count}`);
        if (input.count !== 0) await gate;
        context.order.push(`saved ${input.count}`);
        return { result: toolText("saved"), mutated: true };
      } }),
      tool("ask", { sequential: true, async execute() {
        return { result: toolText("waiting"), pause: { type: "ask_inputs",
          items: [{ id: "x", kind: "documents", document_types: [] }] } };
      } }),
    ]);
    const running = registry.run(Array.from({ length: 5 }, (_, index) =>
      call(String(index), "change", { count: index })), context, undefined, (call) => {
      if (call.id === "0") { deliveryFailed(); throw failure; }
    }).catch((error: unknown) => { settled = true; return error; });
    try {
      await failureObserved;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(mode === "serial");
      expect(context.order.filter((value) => value.startsWith("started")))
        .toEqual((mode === "serial" ? [0] : [0, 1, 2, 3]).map((index) => `started ${index}`));
    } finally { release(); }
    expect(await running).toBe(failure);
    expect(context.order.filter((value) => value.startsWith("saved")))
      .toEqual((mode === "serial" ? [0] : [0, 1, 2, 3]).map((index) => `saved ${index}`));
    const [ask] = await registry.run([call("ask", "ask")], context);
    expect(payload(ask.content).error).toBe("ask_inputs_after_mutation");
  });

  it("serializes a mixed batch and enforces pause-before-mutation", async () => {
    const changed = tool("change", {
      sequential: true,
      async execute(_input, context) {
        context.order.push("change");
        return { result: toolText({ ok: true }), mutated: true };
      },
    });
    const ask = tool("ask", {
      sequential: true,
      async execute(_input, context) {
        context.order.push("ask");
        return {
          result: toolText({ ok: true }),
          pause: { type: "ask_inputs", items: [{ id: "x", kind: "documents" }] },
        };
      },
    });
    const outcomes: BeaverOutcome[] = [];
    const before = await new TurnToolRegistry([changed, ask]).run([
      call("a", "ask"),
      call("b", "change"),
    ], { order: [] }, undefined, (_call, outcome) => outcomes.push(outcome));
    expect(outcomes[0].pause?.items).toHaveLength(1);
    expect(payload(before[1].content).error).toBe("waiting_for_user");

    const context = { order: [] as string[] };
    const registry = new TurnToolRegistry([changed, ask]);
    outcomes.length = 0;
    const after = await registry.run([
      call("a", "change"),
      call("b", "ask"),
    ], context, undefined, (_call, outcome) => outcomes.push(outcome));
    expect(context.order).toEqual(["change", "ask"]);
    expect(outcomes.every(({ pause }) => !pause)).toBe(true);
    expect(payload(after[1].content).error).toBe("ask_inputs_after_mutation");
  });

  it("bounds thrown and malformed results and validates structured output", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new TurnToolRegistry([
      tool("throws", {
        async execute() { throw new Error("x".repeat(3_000)); },
      }),
      tool("malformed", {
        async execute() {
          return { result: { content: [{ type: "bogus" }] } } as never;
        },
      }),
      tool("output", {
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        async execute() {
          return {
            result: {
              content: [{ type: "text", text: "bad" }],
              structuredContent: { ok: "yes" },
            },
          };
        },
      }),
    ]);
    const batch = await registry.run([
      call("1", "throws"),
      call("2", "malformed"),
      call("3", "output"),
    ], { order: [] });
    expect(batch.every(({ status }) => status === "error")).toBe(true);
    expect(batch[0].content.length).toBeLessThan(2_200);
    expect(batch[0].content).not.toContain("xxx");
    expect(payload(batch[0].content).detail).toBe("Tool execution failed");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("hides structured URLs and bounds every model-visible result", async () => {
    const evidence = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case-1",
      sourceText: "The appeal is allowed.",
      spanText: "The appeal is allowed.",
      citation: "2024 SCC 1",
      dataset: "test",
      locatorKind: "paragraph",
      locatorLabel: "par1",
    });
    const registry = new TurnToolRegistry([
      tool("structured", {
        async execute() {
          return {
            result: toolText({
              ok: true,
              source_url: "https://secret.example/source",
              nested: { href: "https://secret.example/link", label: "source" },
              quoted_text: "The document itself says https://public.example/",
            }),
            evidence: [evidence],
          };
        },
      }),
      tool("large", {
        async execute() {
          return { result: toolText("x".repeat(MAX_MODEL_TOOL_RESULT_CHARS + 500)) };
        },
      }),
    ]);
    const outcomes: BeaverOutcome[] = [];
    const batch = await registry.run([
      call("1", "structured"),
      call("2", "large"),
    ], { order: [] }, undefined, (_call, outcome) => outcomes.push(outcome));
    expect(payload(batch[0].content)).toEqual({
      ok: true,
      nested: { label: "source" },
      quoted_text: "The document itself says https://public.example/",
    });
    expect(payload(outcomes[0].result.content[0].type === "text"
      ? outcomes[0].result.content[0].text : "")).toHaveProperty(
      "source_url",
      "https://secret.example/source",
    );
    expect(outcomes[0].evidence).toEqual([evidence]);
    expect(batch[1].content).toHaveLength(MAX_MODEL_TOOL_RESULT_CHARS);
    expect(batch[1].content).toContain("tool result truncated");
    expect(batch[1].status).toBe("truncated");
  });

  it("passes the shared AbortSignal to executors", async () => {
    const seen = vi.fn();
    const registry = new TurnToolRegistry([tool("wait", {
      async execute(_input, _context, signal) {
        seen(signal);
        await new Promise<void>((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        ));
        return { result: toolText("unreachable") };
      },
    })]);
    const controller = new AbortController();
    const running = registry.run([call("1", "wait")], { order: [] }, controller.signal);
    controller.abort(new Error("cancelled"));
    const batch = await running;
    expect(seen).toHaveBeenCalledWith(controller.signal);
    expect(batch[0].status).toBe("error");
  });
});


it("rejects duplicate call identities before any tool effects", async () => {
  const execute = vi.fn(async () => ({ result: toolText("changed"), mutated: true }));
  const registry = new TurnToolRegistry([tool("change", { sequential: true, execute })]);
  await expect(registry.run([call("same", "change"), call("same", "change")], { order: [] }))
    .rejects.toThrow(/Duplicate/i);
  expect(execute).not.toHaveBeenCalled();
});

it("preserves explicit tool errors without applying the success output schema", async () => {
  const registry = new TurnToolRegistry([tool("read", {
    outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async () => ({ result: toolText("Source version changed; select the new version.", true) }),
  })]);
  expect(await registry.run([call("read", "read")], { order: [] })).toEqual([
    { tool_use_id: "read", content: "Source version changed; select the new version.", status: "error" },
  ]);
});

it("returns complete schemas on reload, preserving URL-named input properties", async () => {
  const definition = tool("fetch", { specialist: true, inputSchema: { type: "object",
    properties: { url: { type: "string", format: "uri" } }, required: ["url"] } });
  const registry = new TurnToolRegistry([definition]);
  for (const loaded of [["fetch"], []]) {
    const [result] = await registry.run([call("load", LOAD_TOOLS_NAME, { names: ["fetch"] })], { order: [] });
    expect(payload(result.content)).toEqual({ ok: true, loaded, tools: [{ name: "fetch", inputSchema: definition.inputSchema }] });
  }
});

it("does not activate tools when their definitions cannot be returned intact or loading is cancelled", async () => {
  const registry = new TurnToolRegistry([tool("large", { specialist: true,
    description: "x".repeat(MAX_MODEL_TOOL_RESULT_CHARS) })]);
  const [result] = await registry.run([call("load", LOAD_TOOLS_NAME, { names: ["large"] })], { order: [] });
  expect(payload(result.content).error).toBe("tool_definitions_too_large");
  expect(result.status).toBe("error");
  expect(registry.visible().map(tool => tool.name)).toEqual([LOAD_TOOLS_NAME]);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(registry.run([call("load", LOAD_TOOLS_NAME, { names: ["large"] })], { order: [] }, controller.signal))
    .rejects.toThrow("cancelled");
  expect(registry.visible().map(tool => tool.name)).toEqual([LOAD_TOOLS_NAME]);
});
