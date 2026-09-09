import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
  priorLegalEvidenceReceipts,
  priorLegalResearchQueryReceipts,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
} from "./legalEvidence";
import { UNVERIFIED_LEGAL_ANSWER } from "./legalOutputGate";
import { AssistantStreamError, runChatTurn, type ChatToolContext } from "./turnEngine";
import { toolText, type BeaverTool } from "./toolRegistry";
import { a2ajLegalSourceProvider } from "../legalSources/a2aj";
import { structureNative } from "../structureNative";
import { readResearchContext, readResearchContextInventory, researchReadCursors, type ResearchReadContext,
  type ResearchObserver } from "../researchReader";
import { parseAssistantEvent, type ReadSubagentEvent } from "./assistantEvents";
import type { DocumentStore } from "../documentStore";
import { sha256 } from "../hash";
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
afterEach(() => vi.restoreAllMocks());

it("starts from saved receipts and restores only cited sources for final pinpoints", async () => {
  const text = "The appeal is allowed.", native = await structureNative().deriveDocumentStructure({
    kind: "provider_text", input: { provider: "a2aj", citation: "2024 SCC 1",
      source_kind: "cases", text, dataset: "SCC", require_report_start: true },
  }), receipt = { ...createTnaEvidence({
    jurisdiction: "CA", sourceClass: "case", stableSourceId: "case-1",
    sourceText: text, spanText: text, citation: "2024 SCC 1", name: "Example v Example",
    dataset: "SCC", externalUrl: "https://example.test/case",
    locatorKind: "paragraph", locatorLabel: "par12",
  }), provider: "a2aj" as const, source_sha256: structureNative().documentRevision(native) },
    document = { docType: "cases" as const, dataset: "SCC", citation: receipt.citation,
      alternateCitation: null, name: receipt.name, date: null, url: receipt.external_url!,
      verifiedPdf: null, language: "en" as const, upstreamLicense: null, native, searchNative: native, searchText: text },
    load = vi.spyOn(a2ajLegalSourceProvider, "document").mockResolvedValue(document);
  stream.mockImplementationOnce(async ({ runTools }) => {
    expect(load).not.toHaveBeenCalled();
    await runTools([{ id: "answer", name: "submit_grounded_answer", input: {
      claims: [{ text, evidence_ids: [receipt.evidence_id] }],
    } }]);
    return { fullText: "" };
  });
  const result = await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "",
    messages: [{ role: "user", content: "What happened to the appeal?" }],
    priorEvidence: [receipt, { ...receipt, evidence_id: "e_unused", citation: "2023 SCC 2" }],
    createTools: () => [], emit: () => {},
  });
  expect(result.fullText).toBe(`${text} [1]`);
  expect(result.citations).toEqual([expect.objectContaining({ citation: "2024 SCC 1", locator: "12" })]);
  expect(result.evidence.evidence.get(receipt.evidence_id)?.document).toBe(document);
  expect(load.mock.calls.map(([request]) => request.citation)).toEqual([receipt.citation]);
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

it("publishes source identity immediately and settles each parallel read before the batch ends", async () => {
  const events: Record<string, unknown>[] = [];
  const source = { kind: "public_legal", ref: 1, provider: "tna", identifier: "ewca/civ/2024/1",
    citation: "[2024] EWCA Civ 1", title: "Example v Example", quotes: [] };
  const receipt = createTnaEvidence({
    jurisdiction: "CA", sourceClass: "case", stableSourceId: "case-1",
    sourceText: "The appeal is allowed.", spanText: "The appeal is allowed.",
    citation: "2024 SCC 1", name: "Example v Example", dataset: "test",
    locatorKind: "paragraph", locatorLabel: "12",
  });
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const read: BeaverTool<ChatToolContext> = {
    ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!,
    activityCitations: () => [source],
    async execute(input) {
      if (input.file_path === "document://slow/version/v1") {
        await slow;
        return { result: toolText({ ok: false }, true) };
      }
      return { result: toolText({ ok: true }), evidence: [receipt] };
    },
  };
  stream.mockImplementationOnce(async ({ callbacks, runTools }) => {
    const calls = ["slow", "fast"].map((id) => ({
      id, name: "Read", input: { file_path: `document://${id}/version/v1` },
    }));
    calls.forEach((call) => callbacks.onToolCallStart(call));
    expect(events.filter((event) => event.type === "tool_activity")).toEqual(
      calls.map(({ id }) => expect.objectContaining({ id, status: "running", citations: [source] })),
    );
    const batch = runTools(calls);
    try {
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        id: "fast", status: "completed", citations: [source],
      })));
      expect(events.filter((event) => event.id === "slow")).toHaveLength(1);
    } finally { releaseSlow(); }
    const results = await batch;
    expect(results.map(({ tool_use_id }: { tool_use_id: string }) => tool_use_id)).toEqual(["slow", "fast"]);
    return { fullText: "Done." };
  });
  const result = await runChatTurn({
    model: "gemini-3-flash-preview", systemPrompt: "",
    messages: [{ role: "user", content: "Read these two files." }],
    createTools: () => [read], emit: (event) => events.push(event),
  });
  expect(result.events).toContainEqual(expect.objectContaining({
    id: "slow", status: "error", citations: [source],
  }));
  expect(result.evidence.evidence.get(receipt.evidence_id)?.receipt).toEqual(receipt);
});

it("does not advertise resume when a reader never started", async () => {
  const privateEvents: Record<string, unknown>[] = [];
  const publicEvents: Record<string, unknown>[] = [];
  stream.mockImplementation(async (params) => {
    if (params.providerSession) {
      throw new Error("Codex app-server thread/start request timed out.");
    }
    await params.runTools([{
      id: "load-readers", name: "load_tools", input: { names: ["delegate_read"] },
    }]);
    await params.runTools([{
      id: "round", name: "delegate_read", input: { assignments: [
        { task: "Read note A", scope: "note A", jurisdiction: "CA" },
        { task: "Read note B", scope: "note B", jurisdiction: "CA" },
      ] },
    }]);
    return { fullText: "Done." };
  });

  await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Read a note." }],
    createTools: () => [],
    emit: (event) => publicEvents.push(event as Record<string, unknown>),
    onSubagentEvent: (event) => privateEvents.push(event),
    subagentMode: "beaver",
  });

  expect(privateEvents).toContainEqual(expect.objectContaining({
    status: "error", error: expect.stringContaining("thread/start"),
  }));
  expect(privateEvents.some((event) => "resume" in event)).toBe(false);
  expect(publicEvents).toContainEqual(expect.objectContaining({
    status: "error", error: "Reading agent failed before it started; retry it.",
  }));
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
    const { callbacks, runTools } = params;
    call += 1;
    if (call === 1) {
      callbacks.onContentDelta?.("My favourite is Example v Example, 2024 SCC 1.");
      return { fullText: "My favourite is Example v Example, 2024 SCC 1." };
    }
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

  const result = await runChatTurn({
    model: "gemini-3-flash-preview",
    systemPrompt: "",
    messages: [{ role: "user", content: "Name a case." }],
    createTools: () => [],
    emit: () => undefined,
  });
  expect(result).toMatchObject({ status: "complete", fullText: UNVERIFIED_LEGAL_ANSWER });
  expect(stream).toHaveBeenCalledTimes(3);
});

it.each(["R. v. Unsupported is decisive.", "See https://canlii.org/case."])(
  "repairs an extraction draft through its selected submission tool: %s", async (draft) => {
    const receipt = observedPassage("input", "The appeal is allowed.");
    let turns = 0;
    stream.mockImplementation(async ({ tools, callbacks, runTools, messages }) => {
      expect(tools.map(({ name }: { name: string }) => name)).toContain("submit_extraction");
      expect(tools.map(({ name }: { name: string }) => name)).not.toContain("submit_grounded_answer");
      if (++turns === 1) {
        callbacks.onContentDelta?.(draft);
        return { fullText: draft };
      }
      expect(messages.at(-1).content).toContain("finish with submit_extraction");
      await runTools([{ id: "answer", name: "submit_extraction", input: {
        claims: [{ text: receipt.span_text, evidence_ids: [receipt.evidence_id] }],
      } }]);
      return { fullText: "" };
    });
    const result = await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "",
      messages: [{ role: "user", content: "Extract the disposition." }], emit() {},
      submissionTool: "submit_extraction",
      createTools(state) {
        registerLegalEvidence(state, receipt);
        return [{ name: "submit_extraction", description: "Submit extraction", inputSchema: {
          type: "object", properties: {},
        }, async execute(input) {
          const result = submitLegalEvidenceAnswer(input, state);
          return { result: toolText(result), terminal: result.terminal === true };
        } }];
      },
    });
    expect(result.fullText).toBe(`${receipt.span_text} [1]`);
    expect(turns).toBe(2);
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

const observedPassage = (id: string, text: string) => createTnaEvidence({
  jurisdiction: "CA", sourceClass: "case", stableSourceId: id,
  sourceText: text, spanText: text, citation: "2024 SCC 1", name: "Example v Example",
  dataset: "test", locatorKind: "paragraph", locatorLabel: "12",
});
const observedRead = (evidence: ReturnType<typeof observedPassage>[]): BeaverTool<ChatToolContext> => ({
  ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!,
  reader: ["CA"],
  async execute(_input, _context, _signal, call) {
    return { result: toolText({ ok: true }), evidence, queryReceipts: [{
      call_id: call.id, tool: "Read", executed_at: "2026-09-05T12:00:00.000Z",
      executor_version: "legal-source-pattern-v1", input: { pattern: "appeal" },
      results: evidence.map(({ evidence_id }, rank) => ({ rank: rank + 1, evidence_id })),
    }] };
  },
});

it.each(["failure", "cancellation", "grounding exhaustion"])(
  "retains completed reads and searches after %s without keeping an answer", async (ending) => {
    const passage = observedPassage("observed", "The appeal is allowed."), signal = new AbortController();
    let called = false;
    stream.mockImplementation(async ({ callbacks, runTools }) => {
      if (!called) {
        called = true;
        await runTools([{ id: "observed-read", name: "Read", input: { file_path: "document://note/version/v1" } }]);
      }
      if (ending === "grounding exhaustion") {
        callbacks.onContentDelta?.("R. v. Unsupported is decisive.");
        return { fullText: "R. v. Unsupported is decisive." };
      }
      await runTools([{ id: "answer", name: "submit_grounded_answer", input: {
        claims: [{ text: passage.span_text, evidence_ids: [passage.evidence_id] }],
      } }]);
      if (ending === "cancellation") signal.abort(new DOMException("Cancelled", "AbortError"));
      throw signal.signal.reason ?? new Error("Provider disconnected");
    });
    const outcome = await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "",
      messages: [{ role: "user", content: "Cite this document." }], signal: signal.signal,
      createTools: () => [observedRead([passage])], emit() {},
    }).catch((error: unknown) => error);
    if (ending === "grounding exhaustion")
      expect(outcome).toMatchObject({ status: "complete", fullText: UNVERIFIED_LEGAL_ANSWER });
    else expect(outcome).toBeInstanceOf(AssistantStreamError);
    const events = (outcome as AssistantStreamError).events;
    expect(priorLegalEvidenceReceipts(events)).toEqual([passage]);
    expect(priorLegalResearchQueryReceipts(events)).toMatchObject([{ call_id: "observed-read" }]);
    expect(events.filter(({ type }) => type === "legal_evidence_receipt")).toMatchObject([
      { status: "passed", claims: [], failure: null },
    ]);
  });

it.each([false, true])("shares all subagent reads and searches when failed=%s", async (failed) => {
  const used = observedPassage("used", "The appeal is allowed."),
    extra = observedPassage("extra", "Costs are awarded to the appellant.");
  let reader = 0;
  stream.mockImplementation(async (params) => {
    if (params.providerSession) {
      await params.runTools([{ id: `reader-${++reader}`, name: "Read", input: { file_path: "document://note/version/v1" } }]);
      if (failed) throw new Error("Reader disconnected");
      await params.runTools([{ id: "reader-answer", name: "submit_grounded_answer", input: {
        claims: [{ text: used.span_text, evidence_ids: [used.evidence_id] }],
      } }]);
      return { fullText: "" };
    }
    await params.runTools([{ id: "load", name: "load_tools", input: { names: ["delegate_read"] } }]);
    await params.runTools([{ id: "readers", name: "delegate_read", input: { assignments: [
      { task: "Read the decision", scope: "Note A", jurisdiction: "CA" },
      { task: "Read the decision", scope: "Note B", jurisdiction: "CA" },
    ] } }]);
    await params.runTools([{ id: "parent-answer", name: "submit_grounded_answer", input: {
      claims: [{ text: extra.span_text, evidence_ids: [extra.evidence_id] }],
    } }]);
    return { fullText: "" };
  });
  const result = await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "",
    messages: [{ role: "user", content: "Research these two notes." }],
    createTools: () => [observedRead([used, extra])], emit() {}, subagentMode: "beaver",
  });
  expect(result.fullText).toBe(`${extra.span_text} [1]`);
  expect(priorLegalEvidenceReceipts(result.events)).toEqual(expect.arrayContaining([used, extra]));
  expect(priorLegalResearchQueryReceipts(result.events)).toMatchObject([
    { call_id: "reader-1", model: "codex:gpt-5.6-luna" },
    { call_id: "reader-2", model: "codex:gpt-5.6-luna" },
  ]);
});

it("reports new reads during a turn without duplicating transcript receipts", async () => {
  const passages = [observedPassage("first", "The appeal is allowed."),
    observedPassage("second", "Costs are awarded.")], observed: string[][] = [];
  let next = 0;
  const read = observedRead(passages);
  read.execute = async (...args) => observedRead([passages[next++]]).execute(...args);
  stream.mockImplementationOnce(async ({ runTools }) => {
    for (const [index, passage] of passages.entries()) {
      await runTools([{ id: `read-${index}`, name: "Read", input: { file_path: "document://note/version/v1" } }]);
      expect(observed[index]).toEqual([passage.evidence_id]);
    }
    return { fullText: "Finished reading." };
  });
  const result = await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "",
    messages: [{ role: "user", content: "Read these notes." }], createTools: () => [read], emit() {},
    onResearchObserved(event) { observed.push(event.evidence.map(({ evidence_id }) => evidence_id)); },
  });
  expect(observed).toHaveLength(2);
  expect(result.events.filter(({ type }) => type === "legal_evidence_receipt")).toHaveLength(1);
  expect(priorLegalEvidenceReceipts(result.events)).toEqual(passages);
});

it("resumes child source scopes, queries and coverage with the actual reading model", async () => {
  const resources = ["document://note-a/version/v1", "document://note-b/version/v1"],
    research: ResearchReadContext = { workspace: { documentId: "workspace", versionId: "w1", workingRevision: 4 },
      restricted: true, subjects: resources.map((resource, index) => ({ sourceId: `saved-${index}`, resource,
        reference: { provider: "library", kind: "document", id: `note-${index ? "b" : "a"}`, versionId: "v1" } })) },
    bytes = Buffer.from("First source sentence.\nSecond source sentence."),
    documents = { metadata: async () => ({ filename: "Notes.txt" }),
      projectionSource: async (_scope: unknown, documentId: string) => ({ documentId, versionId: "v1",
        fileType: "txt", sourceSha256: sha256(bytes), readBytes: () => bytes }) } as unknown as DocumentStore,
    observed: Parameters<ResearchObserver>[] = [], checkpoints: ReadSubagentEvent[] = [];
  stream.mockImplementation(async (params) => {
    if (params.providerSession) {
      const inventory = await params.runTools([{ id: "selection", name: "Read", input: { file_path: "selection" } }]);
      const resource = JSON.parse(inventory[0].content).items[0].resource,
        offset = params.providerSession.continuationId ? 2 : 1;
      expect(resource).toBeTruthy();
      params.providerSession.onContinuationId?.(resource);
      await params.runTools([{ id: `${resource}:${offset}`, name: "Read", input: { file_path: resource, offset, limit: 1 } }]);
      throw new Error("Reader connection stopped");
    }
    await params.runTools([{ id: "load", name: "load_tools", input: { names: ["delegate_read", "resume_read"] } }]);
    await params.runTools([{ id: "scopes", name: "delegate_read", input: { assignments: resources.map((resource, index) => ({
      task: "Read both source sentences", scope: `Note ${index}`, jurisdiction: "CA", resources: [resource],
    })) } }]);
    expect(observed).toHaveLength(2);
    await params.runTools([{ id: "resume", name: "resume_read", input: { ids: ["scopes:1", "scopes:2"] } }]);
    expect(observed).toHaveLength(4);
    return { fullText: "Reading stopped." };
  });
  await runChatTurn({ model: "gemini-3-flash-preview", systemPrompt: "", researchContext: research,
    operation: { executor: "assistant", chatId: "chat", turnId: "turn" },
    messages: [{ role: "user", content: "Read these two notes." }], subagentMode: "beaver", emit() {},
    onSubagentEvent(event) { if (event.status === "error") checkpoints.push(event); },
    async onResearchObserved(...args) { await Promise.resolve(); observed.push(args); },
    createTools(_state, assignment, context) {
      if (assignment === "main") return [];
      expect(context.operation).toMatchObject({ executor: "assistant", model: "codex:gpt-5.6-luna",
        chatId: "chat", turnId: "turn", subagentId: expect.stringMatching(/^scopes:/u) });
      expect(context.research?.subjects).toHaveLength(1);
      return [{ ...ASSISTANT_TOOLS.find(({ name }) => name === "Read")!, reader: ["CA"],
        async execute(input, context, signal, call) {
          if (input.file_path === "selection") return readResearchContextInventory(context.research!, {});
          const output = await readResearchContext(documents, { userId: "owner" }, context.research!, {
            resource: String(input.file_path), offset: Number(input.offset), limit: 1, signal, remainingOnly: true });
          return { ...output, queryReceipts: [{ call_id: call.id, tool: "Read", executed_at: "2026-09-06T08:00:00.000Z",
            executor_version: "legal-source-pattern-v1", input: { pattern: "source" },
            results: output.evidence!.map(({ evidence_id }, rank) => ({ rank: rank + 1, evidence_id })) }] };
        } }];
    },
  });
  expect(observed.map(([, operation]) => operation.model)).toEqual(Array(4).fill("codex:gpt-5.6-luna"));
  expect(observed.every(([, operation]) => operation.callId?.startsWith("document://note-") && operation.subagentId)).toBe(true);
  const latest = new Map(checkpoints.map((event) => [event.id, event]));
  for (const checkpoint of latest.values()) {
    expect(checkpoint.resume?.queries).toHaveLength(2);
    expect(checkpoint.resume?.evidence).toHaveLength(2);
    expect(researchReadCursors(checkpoint.resume!.research!)).toEqual([]);
    expect(parseAssistantEvent(JSON.parse(JSON.stringify(checkpoint)))).toEqual(checkpoint);
  }
});
