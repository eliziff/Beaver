import { beforeEach, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));

import { ASSISTANT_TOOLS } from "./assistantTools";
import { createBenchmarkEvidence, registerLegalEvidence } from "./legalEvidence";
import { runChatTurn } from "./turnEngine";
import { bindToolSchemas, TurnToolRegistry } from "./toolRegistry";

beforeEach(() => {
  stream.mockReset();
});

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

  const result = await runChatTurn({
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
  expect(result.events).toContainEqual({
    type: "tool_call_start",
    name: "Read",
    id: "read-1",
    input: { path: "x" },
  });
});

it("repairs a failed grounded submission without exposing the validator error", async () => {
  const evidence = createBenchmarkEvidence({
    jurisdiction: "CA",
    sourceClass: "case",
    stableSourceId: "case-1",
    sourceText: "The appeal is allowed.",
    spanText: "The appeal is allowed.",
    citation: "2024 SCC 1",
    name: "Example v Example",
    dataset: "test",
    externalUrl: "https://example.test/case",
    locatorKind: "paragraph",
    locatorLabel: "par12",
  });
  const emitted: unknown[] = [];
  let call = 0;
  stream.mockImplementation(async (params) => {
    const { callbacks, messages, runTools } = params;
    call += 1;
    if (call === 1) {
      callbacks.onContentDelta?.("My favourite is Example v Example, 2024 SCC 1.");
      return { fullText: "My favourite is Example v Example, 2024 SCC 1." };
    }
    if (call === 2) throw new Error("temporary structuring failure");
    expect(messages.at(-1)?.content).toContain("did not pass Beaver's grounding gate");
    await runTools([{
      id: "grounded-1",
      name: "submit_grounded_answer",
      input: {
        claims: [{
          text: "My favourite is Example v Example.",
          evidence_ids: [evidence.evidence_id],
        }],
      },
    }]);
    return { fullText: "" };
  });

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "What is your favourite case?" }],
    createTools: (state) => {
      registerLegalEvidence(state, evidence);
      return bindToolSchemas([], async () => ({ results: [] }));
    },
    emit: (event) => emitted.push(event),
    done: () => undefined,
  });

  expect(call).toBe(3);
  expect(result.fullText).toContain("My favourite is Example v Example");
  expect(result.fullText).toContain("2024 SCC 1");
  expect(result.fullText).not.toContain("could not be structured");
  expect(emitted).toContainEqual({ type: "content_reset" });
});

it("does not preserve an unsupported draft after grounding repairs fail", async () => {
  stream.mockImplementation(async ({ callbacks }) => {
    callbacks.onContentDelta?.("R. v. Unsupported is decisive.");
    return { fullText: "R. v. Unsupported is decisive." };
  });

  await expect(runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Name a case." }],
    createTools: () => bindToolSchemas([], async () => ({ results: [] })),
    emit: () => undefined,
    done: () => undefined,
  })).rejects.toMatchObject({ fullText: "" });
  expect(stream).toHaveBeenCalledTimes(3);
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
