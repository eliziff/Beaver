import { beforeEach, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));
vi.mock("../codexCatalog", () => ({
  getCodexModelCatalog: async () => ({
    models: [{ slug: "gpt-5.6-luna", displayName: "Luna", supportedReasoningLevels: [
      { effort: "high", description: "" },
    ] }],
  }),
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
  const evidence = createTnaEvidence({
    jurisdiction: "CA", sourceClass: "case", stableSourceId: "case-1",
    sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.",
    citation: "2024 SCC 1", name: "Example v Example", dataset: "test",
    externalUrl: "https://example.test/case",
    locatorKind: "paragraph", locatorLabel: "12",
  });
  const read: BeaverTool<ChatToolContext> = {
    ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!,
    async execute() { return { result: toolText({ ok: true }), evidence: [evidence] }; },
  };

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
  }, expect.objectContaining({
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading v1 from your Library",
    status: "completed",
    citations: [expect.objectContaining({ ref: 1, citation: "2024 SCC 1", locator: "12" })],
  })]));
  expect(result.events).toContainEqual(expect.objectContaining({
    type: "tool_activity",
    id: "read-1",
    tool: "Read",
    label: "Reading v1 from your Library",
    status: "completed",
    citations: [expect.objectContaining({ ref: 1, citation: "2024 SCC 1" })],
  }));
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

it("keeps failed reader checkpoints resumable in the same turn", async () => {
  const privateEvents: Record<string, unknown>[] = [];
  const publicEvents: Record<string, unknown>[] = [];
  const resumed: string[] = [];
  let session = 0;
  stream.mockImplementation(async (params) => {
    if (params.providerSession) {
      params.callbacks.onToolCallStart({
        id: `reader-tool-${session + 1}`,
        name: "search_sources",
        input: { query: "authority" },
      });
      if (params.providerSession.continuationId)
        resumed.push(params.providerSession.continuationId);
      params.providerSession.onContinuationId?.(`reader-session-${++session}`);
      throw new Error("Grounding verification failed after correction attempts");
    }
    expect(params.staticTools.map(({ name }: { name: string }) => name))
      .toEqual(expect.arrayContaining(["delegate_read", "resume_read"]));
    await params.runTools([{
      id: "load-readers", name: "load_tools",
      input: { names: ["delegate_read", "resume_read"] },
    }]);
    const delegated = await params.runTools([{
      id: "round", name: "delegate_read", input: { assignments: [
        { task: "Read note A", scope: "note A", jurisdiction: "CA" },
        { task: "Read note B", scope: "note B", jurisdiction: "CA" },
      ] },
    }]);
    expect(JSON.parse(delegated[0].content).readers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ resume_id: "round:1" }),
        expect.objectContaining({ resume_id: "round:2" }),
      ]));
    const resume = await params.runTools([{
      id: "resume", name: "resume_read",
      input: { ids: ["round:1", "round:2"] },
    }]);
    expect(JSON.parse(resume[0].content).readers).toHaveLength(2);
    return { fullText: "Done." };
  });

  await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Summarize two notes." }],
    createTools: () => [],
    emit: (event) => publicEvents.push(event as Record<string, unknown>),
    onSubagentEvent: (event) => privateEvents.push(event),
    subagentMode: "beaver",
  });

  expect(resumed.sort()).toEqual(["reader-session-1", "reader-session-2"]);
  expect(privateEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "error", resume: expect.any(Object) }),
  ]));
  expect(publicEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      status: "error",
      error: "Grounding verification failed; this reading agent can be resumed.",
    }),
  ]));
  expect(publicEvents.some((event) => "resume" in event || "publicError" in event))
    .toBe(false);
  expect(publicEvents.filter((event) => event.status === "running" && event.activity))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ activity: expect.objectContaining({ id: "reader-tool-1" }) }),
    ]));
  expect(publicEvents.some((event) =>
    event.status === "running" && event.activity && "activities" in event)).toBe(false);
  expect(privateEvents).toContainEqual(expect.objectContaining({
    status: "running",
    activities: [expect.objectContaining({ id: "reader-tool-1" })],
  }));
});

it("streams native subagent deltas while retaining durable snapshots", async () => {
  const publicEvents: Record<string, unknown>[] = [];
  const privateEvents: Record<string, unknown>[] = [];
  const running = {
    id: "native-1", task: "Read the authorities", model: "gpt-5.6-luna",
    effort: "high", status: "running" as const,
    activities: [{ id: "native-tool-1", label: "Searching", status: "running" as const }],
    activity: { id: "native-tool-1", label: "Searching", status: "running" as const },
  };
  stream.mockImplementationOnce(async ({ callbacks }) => {
    callbacks.onSubagentUpdate(running);
    callbacks.onSubagentUpdate({
      ...running,
      status: "completed",
      output: "Found it.",
      activities: [{ ...running.activities[0], status: "completed" }],
      activity: { ...running.activity, status: "completed" },
    });
    return { fullText: "Done." };
  });

  await runChatTurn({
    model: "codex:gpt-5.6-luna",
    systemPrompt: "",
    messages: [{ role: "user", content: "Research." }],
    createTools: () => [],
    emit: (event) => publicEvents.push(event as Record<string, unknown>),
    onSubagentEvent: (event) => privateEvents.push(event),
  });

  expect(publicEvents).toContainEqual(expect.objectContaining({
    type: "subagent_run", id: "native-1", status: "running",
    activity: expect.objectContaining({ id: "native-tool-1", tool: "native" }),
  }));
  expect(publicEvents.some((event) => event.status === "running" && "activities" in event))
    .toBe(false);
  expect(publicEvents).toContainEqual(expect.objectContaining({
    id: "native-1", status: "completed",
    activities: [expect.objectContaining({ id: "native-tool-1", tool: "native" })],
  }));
  expect(privateEvents[0]).toEqual(expect.objectContaining({
    activities: [expect.objectContaining({ id: "native-tool-1" })],
  }));
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
