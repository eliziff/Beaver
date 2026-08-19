import { beforeEach, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm")>()),
  streamChatWithTools: stream,
}));

import { assistantTools } from "./assistantTools";
import { createBenchmarkEvidence, registerLegalEvidence } from "./legalEvidence";
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
  })).rejects.toMatchObject({ fullText: "" });
  expect(stream).toHaveBeenCalledTimes(3);
});
