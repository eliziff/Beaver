import { expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));

import { ASSISTANT_TOOLS } from "./assistantTools";
import { runChatTurn } from "./turnEngine";
import { bindToolSchemas, TurnToolRegistry } from "./toolRegistry";

it("loads exact specialist names and rejects hidden calls", async () => {
  stream.mockImplementationOnce(async ({ systemPrompt, tools, staticTools, resolveTools, runTools }) => {
    const names = tools.map((tool: { function: { name: string } }) =>
      tool.function.name
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(16_500);
    expect(names).toContain("load_tools");
    expect(names).toContain("submit_grounded_answer");
    expect(names).toContain("Read");
    expect(names).not.toContain("transform_docx");
    expect(staticTools.map((tool: { function: { name: string } }) =>
      tool.function.name)).toContain("transform_docx");
    expect(staticTools.map((tool: { function: { name: string } }) =>
      tool.function.name)).toContain("load_tools");
    expect(systemPrompt).toContain("transform_docx");
    expect(systemPrompt).toContain("load_tools");
    const [hidden] = await runTools([{
      id: "hidden-1",
      name: "transform_docx",
      input: {},
    }]);
    expect(JSON.parse(hidden.content)).toMatchObject({
      ok: false,
      error: "tool_not_loaded",
    });
    await runTools([{
      id: "load-1",
      name: "load_tools",
      input: { names: [
        "transform_docx",
        "link_docx_citations",
        "fix_docx_supras",
      ] },
    }]);
    const loaded = resolveTools();
    expect(loaded.map((tool: { function: { name: string } }) =>
      tool.function.name)).toContain("transform_docx");
    expect(loaded.map((tool: { function: { name: string } }) =>
      tool.function.name)).not.toContain("load_tools");
    expect(loaded).toHaveLength(names.length + 2);
    expect(Buffer.byteLength(JSON.stringify(loaded))).toBeLessThanOrEqual(20_000);
    const [overflow] = await runTools([{
      id: "load-2",
      name: "load_tools",
      input: { names: ["lint_docx_structure"] },
    }]);
    expect(JSON.parse(overflow.content)).toMatchObject({ ok: false });
    return { fullText: "Done." };
  });

  await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Reply." }],
    createTools: () => bindToolSchemas(
      ASSISTANT_TOOLS,
      async () => ({ results: [] }),
    ),
    emit: () => undefined,
    done: () => undefined,
  });
});

it("emits canonical tool names in detailed activity without a custom label", async () => {
  const events: unknown[] = [];
  stream.mockImplementationOnce(async ({ callbacks }) => {
    callbacks.onToolCallStart({ id: "read-1", name: "Read", input: { path: "x" } });
    return { fullText: "Done." };
  });
  const read = ASSISTANT_TOOLS.find(({ function: { name } }) => name === "Read")!;

  await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Read x." }],
    activityDetail: "tools",
    createTools: () => bindToolSchemas(
      [read],
      async () => ({ results: [] }),
    ),
    emit: (event) => events.push(event),
    done: () => undefined,
  });

  expect(events).toContainEqual({
    type: "tool_call_start",
    name: "Read",
    id: "read-1",
    input: { path: "x" },
  });
});

it("keeps externally registered tools directly visible", () => {
  const external = ASSISTANT_TOOLS.find(
    ({ function: { name } }) => name === "verify_citations",
  )!;
  const registry = new TurnToolRegistry(bindToolSchemas(
    [external],
    async () => ({ results: [] }),
    ["external"],
  ));

  expect(registry.visible().map(({ function: { name } }) => name))
    .toEqual(["verify_citations"]);
  expect(registry.specialists()).toEqual([]);
});
