import { beforeEach, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));

import { assistantTools } from "./assistantTools";
import {
  createTnaEvidence,
  createPublicJournalPassageEvidence,
  registerLegalEvidence,
} from "./legalEvidence";
import { runChatTurn, type ChatToolContext } from "./turnEngine";
import { toolText, type BeaverTool } from "./toolRegistry";
const ASSISTANT_TOOLS = assistantTools<ChatToolContext>({
  userId: "test",
  scope: "main",
  documents: {} as never,
  library: {} as never,
  projects: {} as never,
  resolveArtifact: () => undefined,
  artifactFor: () => "draft-1",
  onMutationCommitted: () => undefined,
}).map((tool): BeaverTool<ChatToolContext> => ({
  ...tool,
  async execute() { return { result: toolText({ ok: true }) }; },
}));

beforeEach(() => {
  stream.mockReset();
});

it("preserves one tool activity through running and completed states", async () => {
  const events: unknown[] = [];
  stream.mockImplementationOnce(async ({ callbacks, runTools }) => {
    const call = {
      id: "read-1",
      name: "Read",
      input: { file_path: "document://x/version/v1" },
    };
    callbacks.onToolCallStart(call);
    await runTools([call]);
    return { fullText: "Done." };
  });
  const read = ASSISTANT_TOOLS.find(({ name }) => name === "Read")!;

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Read x." }],
    activityDetail: "tools",
    createTools: () => [read],
    emit: (event) => events.push(event),
  });

  expect(events).toEqual(expect.arrayContaining([{
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading v1 from your Library",
    status: "running",
  }, {
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading v1 from your Library",
    status: "completed",
  }]));
  expect(result.events).toContainEqual({
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading v1 from your Library",
    status: "completed",
  });
  expect(events).toContainEqual({ type: "content_final", text: "", citations: [] });
});

it("forwards nested tool progress to the provider inactivity watchdog", async () => {
  const heartbeat = vi.fn();
  const tool: BeaverTool<ChatToolContext> = {
    ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!,
    async execute(_input, context) {
      context.onActivity?.();
      return { result: toolText({ ok: true }) };
    },
  };
  stream.mockImplementationOnce(async ({ runTools }) => {
    await runTools([{
      id: "read-1",
      name: tool.name,
      input: { file_path: "document://x/version/v1" },
    }], heartbeat);
    return { fullText: "Done." };
  });

  await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Read x." }],
    createTools: () => [tool],
    emit: () => undefined,
  });

  expect(heartbeat).toHaveBeenCalledOnce();
});

it("persists private tool receipts without emitting them", async () => {
  const emitted: unknown[] = [];
  const receipt = {
    type: "mcp_tool_call" as const,
    connector_id: "connector-1",
    connector_name: "Private connector",
    tool_name: "lookup",
    openai_tool_name: "mcp_lookup",
    status: "ok" as const,
  };
  const tool: BeaverTool<ChatToolContext> = {
    ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!,
    async execute() {
      return { result: toolText({ ok: true }), events: [receipt] };
    },
  };
  stream.mockImplementationOnce(async ({ runTools }) => {
    await runTools([{
      id: "private-1", name: tool.name,
      input: { file_path: "document://x/version/v1" },
    }]);
    return { fullText: "Done." };
  });

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Use the connector." }],
    createTools: () => [tool],
    emit: (event) => emitted.push(event),
  });

  expect(result.events).toContainEqual(receipt);
  expect(emitted).not.toContainEqual(receipt);
});

it("repairs a failed grounded submission without exposing the validator error", async () => {
  const evidence = createTnaEvidence({
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
  });

  expect(call).toBe(2);
  expect(result.fullText).toContain("My favourite is Example v Example");
  expect(result.fullText).toContain("[1]");
  expect(result.fullText).not.toContain("http");
  expect(result.fullText).not.toContain("could not be structured");
  expect(emitted.filter((event) =>
    typeof event === "object" && event !== null &&
    String((event as { type?: unknown }).type).startsWith("content"),
  )).toEqual([{
    type: "content_final",
    text: result.fullText,
    citations: result.citations,
  }]);
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
  })).rejects.toMatchObject({ fullText: "" });
  expect(stream).toHaveBeenCalledTimes(3);
});

it("does not turn non-legal journal retrieval into a grounding repair", async () => {
  const evidence = createPublicJournalPassageEvidence({
    citation: "Poetry Review 1",
    name: "Reading Prufrock",
    date: "2026",
    url: "https://example.test/prufrock",
    text: "Prufrock is a dramatic monologue.",
    articleId: "poem-1",
    locatorKind: "page",
    locatorLabel: "page=1",
  });
  const emitted: unknown[] = [];
  stream.mockImplementationOnce(async ({ callbacks }) => {
    callbacks.onContentDelta?.("My favourite is The Love Song of J. Alfred Prufrock.");
    return { fullText: "My favourite is The Love Song of J. Alfred Prufrock." };
  });

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "What is your favourite poem?" }],
    createTools: (state) => {
      registerLegalEvidence(state, evidence);
      return [];
    },
    emit: (event) => emitted.push(event),
  });

  expect(stream).toHaveBeenCalledTimes(1);
  expect(result.fullText).toBe("My favourite is The Love Song of J. Alfred Prufrock.");
  expect(result.citations).toEqual([]);
  expect(emitted).not.toContainEqual({ type: "content_reset" });
});
