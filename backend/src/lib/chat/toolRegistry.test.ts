import { describe, expect, it, vi } from "vitest";
import type { NormalizedToolCall } from "../llm";
import {
  LOAD_TOOLS_NAME,
  TurnToolRegistry,
  toolText,
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
  });

  it("validates literally without scalar coercion", async () => {
    const registry = new TurnToolRegistry([tool("read")]);
    const batch = await registry.run(
      [call("1", "read", { count: "3" })],
      { order: [] },
    );
    expect(batch.outcomes[0].result.isError).toBe(true);
    expect(payload(batch.results[0].content).error).toBe("invalid_arguments");
  });

  it("loads only exact specialist names with a three-tool turn cap", async () => {
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
      [call("0", "one")], { order: [] },
    )).results[0].content).error).toBe("tool_not_loaded");
    const invalid = await registry.run([
      call("bad", LOAD_TOOLS_NAME, { names: ["one", 0] }),
    ], { order: [] });
    expect(payload(invalid.results[0].content).error).toBe("invalid_arguments");
    expect(payload((await registry.run(
      [call("still-unloaded", "one")], { order: [] },
    )).results[0].content).error).toBe("tool_not_loaded");
    const loaded = await registry.run([
      call("1", LOAD_TOOLS_NAME, { names: ["one", "two", "three"] }),
      call("2", "one"),
    ], { order: [] });
    expect(payload(loaded.results[0].content).loaded).toEqual(["one", "two", "three"]);
    expect(payload(loaded.results[1].content).ok).toBe(true);
    expect(payload((await registry.run([
      call("3", LOAD_TOOLS_NAME, { names: ["four"] }),
    ], { order: [] })).results[0].content).ok).toBe(false);
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
    expect(batch.results.map(({ tool_use_id }) => tool_use_id)).toEqual([
      "slow-id",
      "fast-id",
    ]);
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
    const before = await new TurnToolRegistry([changed, ask]).run([
      call("a", "ask"),
      call("b", "change"),
    ], { order: [] });
    expect(before.pause?.items).toHaveLength(1);
    expect(payload(before.results[1].content).error).toBe("waiting_for_user");

    const context = { order: [] as string[] };
    const registry = new TurnToolRegistry([changed, ask]);
    const after = await registry.run([
      call("a", "change"),
      call("b", "ask"),
    ], context);
    expect(context.order).toEqual(["change", "ask"]);
    expect(after.pause).toBeUndefined();
    expect(payload(after.results[1].content).error).toBe("ask_inputs_after_mutation");
  });

  it("bounds thrown and malformed results and validates structured output", async () => {
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
    expect(batch.outcomes.every(({ result }) => result.isError)).toBe(true);
    expect(batch.results[0].content.length).toBeLessThan(2_200);
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
    expect(batch.outcomes[0].result.isError).toBe(true);
  });
});
