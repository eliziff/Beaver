import { beforeEach, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));

import { DOCUMENT_TOOLS } from "./assistantTools";
import { createBenchmarkEvidence, registerLegalEvidence } from "./legalEvidence";
import { runChatTurn, type ChatToolContext } from "./turnEngine";
import {
  toolText,
  TurnToolRegistry,
  type BeaverTool,
} from "./toolRegistry";
import type { Tool } from "../llm";
import { RESOURCE_TOOLS } from "./resourceTools";
import { CITATOR_TOOLS } from "./tools/citatorTools";
import { COMPARE_VERSIONS_TOOLS } from "./tools/compareVersionsTool";
import {
  COURTLISTENER_TOOL_NAMES,
  COURTLISTENER_TOOLS,
} from "./tools/courtlistenerTools";
import { SEARCH_SOURCES_TOOL } from "./tools/sourceSearchTools";
import { ADVANCED_DOCX_EDIT_TOOL, WRITE_TOOL } from "./tools/toolSchemas";

const ASSISTANT_TOOL_SCHEMAS = [
  ...RESOURCE_TOOLS,
  ...DOCUMENT_TOOLS,
  WRITE_TOOL,
  ADVANCED_DOCX_EDIT_TOOL,
  ...COMPARE_VERSIONS_TOOLS,
  SEARCH_SOURCES_TOOL,
  ...COURTLISTENER_TOOLS.filter(({ name }) =>
    name === COURTLISTENER_TOOL_NAMES.findInCase ||
    name === COURTLISTENER_TOOL_NAMES.verifyCitations),
  ...CITATOR_TOOLS,
];

const RESIDENT = new Set([
  "Glob", "Grep", "Read", "Edit", "Write", "search_sources", "note_up",
]);
const definition = (
  schema: Tool,
  specialist = false,
): BeaverTool<ChatToolContext> => ({
  ...schema,
  specialist,
  async execute() { return { result: toolText({ ok: true }) }; },
});

beforeEach(() => {
  stream.mockReset();
});

it("loads exact specialist names and rejects hidden calls", async () => {
  stream.mockImplementationOnce(async ({ systemPrompt, tools, staticTools, resolveTools, runTools }) => {
    const names = tools.map((tool: Tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThanOrEqual(16_500);
    expect(names).toContain("load_tools");
    expect(names).toContain("submit_grounded_answer");
    expect(names).toContain("Read");
    expect(names).not.toContain("transform_docx");
    expect(staticTools.map((tool: Tool) => tool.name)).toContain("edit_docx_advanced");
    expect(staticTools.map((tool: Tool) => tool.name)).toContain("load_tools");
    expect(systemPrompt).toContain("edit_docx_advanced");
    expect(systemPrompt).toContain("load_tools");
    const [hidden] = await runTools([{
      id: "hidden-1",
      name: "edit_docx_advanced",
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
        "edit_docx_advanced",
        "link_docx_citations",
        "fix_docx_supras",
      ] },
    }]);
    const loaded = resolveTools();
    expect(loaded.map((tool: Tool) => tool.name)).toContain("edit_docx_advanced");
    expect(loaded.map((tool: Tool) => tool.name)).not.toContain("load_tools");
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
    createTools: () => ASSISTANT_TOOL_SCHEMAS.map((schema) =>
      definition(schema, !RESIDENT.has(schema.name))),
    emit: () => undefined,
    done: () => undefined,
  });
});

it("preserves one tool activity through running and completed states", async () => {
  const events: unknown[] = [];
  stream.mockImplementationOnce(async ({ callbacks, runTools }) => {
    const call = { id: "read-1", name: "Read", input: { file_path: "x" } };
    callbacks.onToolCallStart(call);
    await runTools([call]);
    return { fullText: "Done." };
  });
  const read = ASSISTANT_TOOL_SCHEMAS.find(({ name }) => name === "Read")!;

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Read x." }],
    activityDetail: "tools",
    createTools: () => [definition(read)],
    emit: (event) => events.push(event),
    done: () => undefined,
  });

  expect(events).toEqual(expect.arrayContaining([{
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading x from your Library",
    status: "running",
  }, {
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading x from your Library",
    status: "completed",
  }]));
  expect(result.events).toContainEqual({
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading x from your Library",
    status: "completed",
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
      return [];
    },
    emit: (event) => emitted.push(event),
    done: () => undefined,
  });

  expect(call).toBe(2);
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
    createTools: () => [],
    emit: () => undefined,
    done: () => undefined,
  })).rejects.toMatchObject({ fullText: "" });
  expect(stream).toHaveBeenCalledTimes(3);
});

it("keeps externally registered tools directly visible", () => {
  const external = ASSISTANT_TOOL_SCHEMAS.find(
    ({ name }) => name === "verify_citations",
  )!;
  const registry = new TurnToolRegistry([definition(external)]);

  expect(registry.visible().map(({ name }) => name))
    .toEqual(["verify_citations"]);
  expect(registry.specialists()).toEqual([]);
});
