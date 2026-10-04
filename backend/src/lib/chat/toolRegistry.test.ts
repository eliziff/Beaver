import { describe, expect, it, vi } from "vitest";
import type { NormalizedToolCall } from "../llm";
import { TurnToolRegistry, toolText, type BeaverTool } from "./toolRegistry";

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

  it("validates literally without scalar coercion", async () => {
    const registry = new TurnToolRegistry([tool("read")]);
    const batch = await registry.run(
      [call("1", "read", { count: "3" })],
      { order: [] },
    );
    expect(batch[0].status).toBe("error");
    expect(payload(batch[0].content).error).toBe("invalid_arguments");
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

  it.each(["parallel", "serial"])("settles started %s work after result delivery fails", async (mode) => {
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
    expect(ask.content).toBe("waiting");
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
});


it("rejects duplicate call identities before any tool effects", async () => {
  const execute = vi.fn(async () => ({ result: toolText("changed"), mutated: true }));
  const registry = new TurnToolRegistry([tool("change", { sequential: true, execute })]);
  await expect(registry.run([call("same", "change"), call("same", "change")], { order: [] }))
    .rejects.toThrow(/Duplicate/i);
  expect(execute).not.toHaveBeenCalled();
});
