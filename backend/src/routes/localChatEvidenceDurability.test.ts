import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeHandles: [] as string[],
  finalizerHandleSets: [] as string[][],
  matterDocuments: undefined as string[] | undefined,
  preflightFailure: false,
  progressiveDisclosure: false,
  providerMessages: [] as { role: string; content: string }[][],
  providerReferences: new Map<string, string[]>(),
  systemPrompts: [] as string[],
  appendLocalPdfPinpointLinks: vi.fn(),
  readLocalPdfEvidenceReceipt: vi.fn(),
  runLocalAssistantTools: vi.fn(),
  streamChatWithTools: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isAnonymousLocalMode: () => true }));
vi.mock("../lib/llm", () => ({
  completeText: vi.fn(),
  DEFAULT_MAIN_MODEL: "gpt-5.2",
  modelSupportsImageInput: () => true,
  streamChatWithTools: mocks.streamChatWithTools,
}));
vi.mock("../lib/chat/localAssistantTools", () => ({
  LOCAL_ASSISTANT_TOOLS: [],
  MODEL_COVERAGE_ROUTING: false,
  NAV_TOOL_SHAPE: mocks.progressiveDisclosure ? "address" : "legacy",
  PROGRESSIVE_DISCLOSURE_ENABLED: mocks.progressiveDisclosure,
  RESEARCH_TOOLS_DISABLED: false,
  MAX_TOOL_RESULT_CHARS: 64_000,
  SUPPRESS_DUPLICATE_WHOLE_READS: true,
  RESIDENT_AUTHORING_ENABLED: false,
  TERMINAL_AUTHORING_ENABLED:
    process.env.MIKE_TERMINAL_AUTHORING === "1",
  UPSTREAM_MIKE_TOOL_SHAPE: false,
  UPSTREAM_NATIVE_MIKE_SHAPE: false,
  ADAPTIVE_MIKE_TOOL_SHAPE: false,
  CODING_TOOL_SHAPE: false,
  COMPACT_AUTHOR_MIKE_TOOL_SHAPE: false,
  MARKDOWN_SWAP_MIKE_TOOL_SHAPE: false,
  MARKDOWN_E2E_MIKE_TOOL_SHAPE: false,
  MARKDOWN_READ_DOCX: false,
  LEAN_BATCH_FAMILY_TOOL_SHAPE: false,
  LEAN_BATCH_HARDREFS_TOOL_SHAPE: false,
  LEAN_BATCH_TOOL_SHAPE: false,
  GROUNDING_FIRST_ENABLED: false,
  CITATION_CONTRACT_ENABLED: false,
  CITATION_CONTRACT_V2_ENABLED: false,
  FIND_QUERY_NORM_ENABLED: false,
  INDEX_ATTACH_GATED: false,
  INDEX_COMPACT_HEADINGS: false,
  NO_DEFERRAL_ENABLED: false,
  EXPOSURE_ECHO_ENABLED: false,
  CODING_NEUTRAL_PROMPT_ENABLED: false,
  CODING_PARITY_ENABLED: false,
  CODING_TOC_FILES_ENABLED: false,
  GREP_PER_FILE_BUDGET_ENABLED: false,
  TRIAGE_WORKFLOW_ENABLED: false,
  DRAFT_EDIT_ENABLED: false,
  FINAL_ARM_ENABLED: false,
  FINAL_AGENT_LOOP_ENABLED: false,
  GREP_SECTION_CONTEXT_ENABLED: false,
  SCOPED_REREAD_ENABLED: false,
  TYPED_RANGE_ENABLED: false,
  REQUIREMENTS_ECHO_ENABLED: false,
  REQECHO_DRAFT_MODE_ENABLED: false,
  COMPOSITION_CHECK_ENABLED: false,
  MIKE_GREP_FAMILY_TOOL_SHAPE: false,
  MIKE_GREP_TOOL_SHAPE: false,
  MIKE_LEGAL_TOOL_SHAPE: false,
  MIKE_LEGAL_GUIDED_TOOL_SHAPE: false,
  MIKE_STRUCTURE_PATHS_TOOL_SHAPE: false,
  ORIGIN_MIKE_TOOL_SHAPE: false,
  WHOLE_READ_MAX_CHARS: 0,
  WORKING_SET_GREP_DEFAULT_HEAD_LIMIT: 8,
  WORKING_SET_GREP_MAX_HEAD_LIMIT: 24,
  WORKING_SET_GREP_LINE_MAX_CHARS: 800,
  WORKING_SET_PAGE_MAX_CHARS: 24_000,
  WORKING_SET_PATH: ".mike/working-sets/evidence.txt",
  createLocalAssistantRequirementsState: () => ({}),
  pendingFinalAgentDraft: () => null,
  partitionTools: () =>
    mocks.progressiveDisclosure
      ? {
          resident:
            process.env.MIKE_FULL_HANDOFF_PROMPT_VARIANT === "legacy-v5"
              ? ["Glob", "Grep", "Read", "describe_tools"].map((name) => ({
                  function: { name },
                }))
              : process.env.MIKE_DRAFT_HANDOFF_MODE === "paged" ||
                  process.env.MIKE_CONTINUOUS_EVIDENCE === "1"
                ? [
                    "Glob",
                    "Grep",
                    "Read",
                    "library_lookup",
                    "describe_tools",
                  ].map((name) => ({ function: { name } }))
                : [{ function: { name: "describe_tools" } }],
          deferred: [{ function: { name: "library_revise_docx" } }],
        }
      : {
          resident: [
            "Read",
            "library_lookup",
            "library_create_docx",
            "library_revise_docx",
            "library_apply_text_ops",
            "Edit",
          ].map((name) => ({ function: { name } })),
          deferred: [],
        },
  describeToolsTool: (_tools: unknown[], allowEvidenceSelection = false) => ({
    type: "function",
    function: {
      name: "describe_tools",
      description: "Load a deferred tool domain.",
      parameters: {
        type: "object",
        properties: {
          domains: {
            type: "array",
            items: { type: "string", enum: ["drafting"] },
          },
          ...(allowEvidenceSelection
            ? {
                carry_evidence: {
                  type: "array",
                  items: { type: "string" },
                },
              }
            : {}),
        },
        required: ["domains"],
      },
    },
  }),
  toolsForDomains: (tools: unknown[], domains: string[]) =>
    mocks.progressiveDisclosure && domains.includes("drafting") ? tools : [],
  runLocalAssistantTools: mocks.runLocalAssistantTools,
  extractLocalDocument: async () => null,
}));
vi.mock("../lib/chat/localPdfEvidenceState", () => ({
  appendLocalPdfPinpointLinks: mocks.appendLocalPdfPinpointLinks,
  providerPdfReferencesForTurn: (
    _handles: ReadonlySet<string>,
    handle: string,
  ) => mocks.providerReferences.get(handle) ?? [],
}));
vi.mock("../lib/localPdfLookup", () => ({
  readLocalPdfEvidenceReceipt: mocks.readLocalPdfEvidenceReceipt,
}));
vi.mock("../lib/localDocumentStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/localDocumentStore")>();
  return {
    ...actual,
    listLocalDocumentsById: (...args: Parameters<
      typeof actual.listLocalDocumentsById
    >) =>
      mocks.preflightFailure
        ? Promise.reject(new Error("Injected local store failure"))
        : actual.listLocalDocumentsById(...args),
  };
});
vi.mock("../lib/legalKnowledgeGraphStore", () => ({
  legalKnowledgeGraphStore: () => ({
    getMatter: () => ({ id: "20000000-0000-4000-8000-000000000001" }),
    listMatterDocumentIds: () => mocks.matterDocuments,
  }),
}));

const USER_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "30000000-0000-4000-8000-000000000001";
const VERSION_ID = "40000000-0000-4000-8000-000000000001";
const HANDLE = `mike-evidence:v1:${"a".repeat(64)}`;
const PROVIDER_REFERENCE_ONE = `mike-provider-pdf:v1:govinfo:${"b".repeat(64)}:${"c".repeat(64)}`;
const PROVIDER_REFERENCE_TWO = `mike-provider-pdf:v1:courtlistener:${"d".repeat(64)}:${"c".repeat(64)}`;
const REGISTRY_EVENT = "local_pdf_evidence_handles";

let dataHome: string;

async function loadApp() {
  vi.resetModules();
  const [{ chatRouter }, store] = await Promise.all([
    import("./chat"),
    import("../lib/anonymousChatStore"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/chat", chatRouter);
  return { app, store };
}

function registryEvent(chat: {
  messages: { role: string; content: unknown }[];
}) {
  const assistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  return Array.isArray(assistant?.content)
    ? assistant.content.find(
        (event) =>
          !!event &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          (event as { type?: unknown }).type === REGISTRY_EVENT,
      )
    : undefined;
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-evidence-chat-"));
  vi.stubEnv("AUTH_MODE", "anonymous");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
  mocks.activeHandles.length = 0;
  mocks.finalizerHandleSets.length = 0;
  mocks.matterDocuments = undefined;
  mocks.preflightFailure = false;
  mocks.progressiveDisclosure = false;
  mocks.providerMessages.length = 0;
  mocks.providerReferences.clear();
  mocks.systemPrompts.length = 0;
  mocks.appendLocalPdfPinpointLinks.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockReset();
  mocks.runLocalAssistantTools.mockReset();
  mocks.streamChatWithTools.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockImplementation(async (handle) => ({
    handle,
    source: {
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
    },
  }));
  mocks.runLocalAssistantTools.mockImplementation(
    async (...args: unknown[]) => {
      const handles = args[7] as Set<string>;
      for (const handle of mocks.activeHandles) handles.add(handle);
      return [];
    },
  );
  mocks.appendLocalPdfPinpointLinks.mockImplementation(
    async (answer: string, _userId: string, handles: ReadonlySet<string>) => {
      mocks.finalizerHandleSets.push([...handles]);
      return answer;
    },
  );
  mocks.streamChatWithTools.mockImplementation(async (params) => {
    mocks.systemPrompts.push(params.systemPrompt);
    mocks.providerMessages.push(
      params.messages.map(({ role, content }) => ({ role, content })),
    );
    if (mocks.activeHandles.length > 0) {
      await params.runTools?.([
        { id: "lookup", name: "library_lookup", input: {} },
      ]);
    }
    const text =
      mocks.systemPrompts.length === 1
        ? "The lookup was useful, but this answer contains no quotation."
        : '"This later quotation must not auto-link from an old handle."';
    params.callbacks?.onContentDelta?.(text);
    return { fullText: text };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous chat PDF evidence durability", () => {
  it("enforces progressive tool disclosure across provider iterations", async () => {
    mocks.progressiveDisclosure = true;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify(
            call.name === "describe_tools"
              ? { ok: true, domains: ["drafting"], opened: ["library_revise_docx"] }
              : { ok: true, action: "revised" },
          ),
        })),
    );
    let initialNames: string[] = [];
    let openedNames: string[] = [];
    let sameBatch: Array<{ content: string }> = [];
    let nextIteration: Array<{ content: string }> = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      initialNames = params.resolveTools().map((tool) => tool.function.name);
      sameBatch = await params.runTools([
        { id: "hidden-same-batch", name: "library_revise_docx", input: {} },
        { id: "open-drafting", name: "describe_tools", input: { domains: ["drafting"] } },
      ]);
      openedNames = params.resolveTools().map((tool) => tool.function.name);
      nextIteration = await params.runTools([
        { id: "hidden-next-turn", name: "library_revise_docx", input: {} },
      ]);
      params.callbacks?.onContentDelta?.("Done.");
      return { fullText: "Done." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000006",
        content: "Revise the draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(initialNames).toEqual(["describe_tools"]);
    expect(JSON.parse(sameBatch[0].content).error).toContain("not loaded");
    expect(JSON.parse(sameBatch[1].content)).toMatchObject({ ok: true });
    expect(openedNames).toEqual(["library_revise_docx"]);
    expect(JSON.parse(nextIteration[0].content)).toMatchObject({ ok: true });
    expect(
      mocks.runLocalAssistantTools.mock.calls.map((entry) =>
        entry[1].map((call: { name: string }) => call.name),
      ),
    ).toEqual([["describe_tools"], ["library_revise_docx"]]);
  });

  it("executes evidence and mutation calls from the same model batch", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) =>
          call.name === "library_lookup"
            ? {
                tool_use_id: call.id,
                content: "CONTROLLING TEXT",
                evidenceRefs: [
                  {
                    handle: "exact:controlling",
                    filename: "source.docx",
                    locator: "section 2",
                    text: "CONTROLLING TEXT",
                    kind: "evidence" as const,
                  },
                ],
              }
            : {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: true,
                  receipt: "mike-document:v1",
                  action: "revised",
                  version_id: VERSION_ID,
                }),
              },
        ),
    );
    let sameBatchMutationAction = "";
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const mixed = await params.runTools?.([
        { id: "evidence", name: "library_lookup", input: {} },
        { id: "early-edit", name: "library_revise_docx", input: {} },
      ]);
      sameBatchMutationAction = JSON.parse(
        mixed?.[1]?.content ?? "{}",
      ).action;
      params.callbacks?.onContentDelta?.("Done.");
      return { fullText: "Done." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000013",
        content: "Read the controlling text and revise the draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(sameBatchMutationAction).toBe("revised");
    expect(
      mocks.runLocalAssistantTools.mock.calls.map((entry) =>
        entry[1].map((call: { name: string }) => call.name),
      ),
    ).toEqual([["library_lookup", "library_revise_docx"]]);
    expect(response.text).not.toContain('"type":"content_reset"');
    expect(response.text).not.toContain('"type":"evidence_handoff"');
    expect(response.text).not.toContain('"type":"research_checkpoint_request"');
  });

  it("researches and drafts in one provider trajectory with exact evidence mounted", async () => {
    vi.stubEnv("MIKE_CONTINUOUS_EVIDENCE", "1");
    vi.stubEnv("MIKE_BENCHMARK_TRACE_TOOLS", "1");
    mocks.progressiveDisclosure = true;
    let mountedAfterFirstBatch = "";
    mocks.runLocalAssistantTools.mockImplementation(
      async (...args: unknown[]) => {
        const calls = args[1] as { id: string; name: string }[];
        const workingSets = args[12] as
          | Map<string, { text: string }>
          | undefined;
        return calls.map((call) => {
          if (call.name === "library_lookup") {
            return {
              tool_use_id: call.id,
              content: "FIRST FACT",
              evidenceRefs: [
                {
                  handle: "exact:first",
                  filename: "first-source.docx",
                  locator: "section 1",
                  text: "FIRST FACT",
                  kind: "evidence" as const,
                },
              ],
            };
          }
          if (call.name === "describe_tools") {
            return {
              tool_use_id: call.id,
              content: JSON.stringify({
                ok: true,
                domains: ["drafting"],
                opened: ["library_revise_docx"],
              }),
            };
          }
          if (call.name === "Grep") {
            mountedAfterFirstBatch =
              workingSets?.get(".mike/working-sets/evidence.txt")?.text ?? "";
            return {
              tool_use_id: call.id,
              content: "SECOND FACT",
              evidenceRefs: [
                {
                  handle: "exact:second",
                  filename: "second-source.html",
                  locator: "paragraph 2",
                  text: "SECOND FACT",
                  kind: "evidence" as const,
                },
              ],
            };
          }
          return {
            tool_use_id: call.id,
            content: JSON.stringify({
              ok: true,
              action: "revised",
              receipt: "mike-document:v1",
              version_id: VERSION_ID,
            }),
          };
        });
      },
    );
    let invocationCount = 0;
    let sameBatchMutationAction = "";
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocationCount += 1;
      await params.runTools?.([
        { id: "research", name: "library_lookup", input: {} },
        {
          id: "open-drafting",
          name: "describe_tools",
          input: { domains: ["drafting"] },
        },
      ]);
      const mixedResults = await params.runTools?.([
        { id: "new-evidence", name: "Grep", input: { pattern: "SECOND" } },
        { id: "too-early", name: "library_revise_docx", input: {} },
      ]);
      sameBatchMutationAction = JSON.parse(
        mixedResults?.[1]?.content ?? "{}",
      ).action;
      params.callbacks?.onContentDelta?.("Done.");
      return { fullText: "Done." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000012",
        content: "Research the sources and revise the draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(invocationCount).toBe(1);
    expect(sameBatchMutationAction).toBe("revised");
    expect(mountedAfterFirstBatch).toContain("FIRST FACT");
    expect(
      mocks.runLocalAssistantTools.mock.calls.map((entry) =>
        entry[1].map((call: { name: string }) => call.name),
      ),
    ).toEqual([
      ["library_lookup", "describe_tools"],
      ["Grep", "library_revise_docx"],
    ]);
    expect(response.text).toContain('"type":"evidence_working_set_receipt"');
    expect(response.text).toContain("FIRST FACT");
    expect(response.text).toContain("SECOND FACT");
    expect(response.text).not.toContain('"type":"research_checkpoint_request"');
    expect(response.text).not.toContain('"type":"research_context_refresh"');
    expect(response.text).not.toContain('"type":"evidence_handoff"');
    expect(response.text).not.toContain('"type":"content_reset"');
  });

  it("can start drafting with the legacy v5 exact-evidence handoff", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    vi.stubEnv("MIKE_FULL_HANDOFF_PROMPT_VARIANT", "legacy-v5");
    mocks.progressiveDisclosure = true;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            domains: ["drafting"],
            opened: ["library_revise_docx"],
          }),
        })),
    );
    let invocation = 0;
    let terminal = false;
    let freshMessages: Array<{ role: string; content: string }> = [];
    let freshToolNames: string[] = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        const [opened] = await params.runTools?.([
          {
            id: "open-drafting",
            name: "describe_tools",
            input: { domains: ["drafting"] },
          },
        ]);
        terminal = opened.terminal === true;
        params.callbacks?.onContentDelta?.("Research-phase preface.");
        return { fullText: "Research-phase preface." };
      }
      freshMessages = params.messages;
      freshToolNames = params.tools.map((tool) => tool.function.name);
      params.callbacks?.onContentDelta?.("Final drafting answer.");
      return { fullText: "Final drafting answer." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000007",
        content: "Revise the draft from the evidence.",
      },
    });

    expect(response.status).toBe(200);
    expect(terminal).toBe(true);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2);
    expect(freshMessages).toHaveLength(1);
    expect(freshMessages[0].content).toContain("ORIGINAL REQUEST");
    expect(freshMessages[0].content).toContain(
      "Revise the draft from the evidence.",
    );
    expect(freshMessages[0].content).toContain("fresh drafting context");
    expect(freshMessages[0].content).toContain("already loaded");
    expect(freshMessages[0].content).toContain("tool domain");
    expect(freshMessages[0].content).not.toContain("previous research agent");
    expect(freshToolNames).toEqual([
      "Glob",
      "Grep",
      "Read",
      "library_revise_docx",
    ]);
    expect(response.text).toContain('"type":"content_reset"');
    expect(response.text).toContain("Final drafting answer.");
    const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    expect(JSON.stringify(chat.messages)).not.toContain(
      "Research-phase preface.",
    );
  });

  it("keeps v5 research continuous until its single drafting handoff", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    vi.stubEnv("MIKE_RESEARCH_CONTEXT_REFRESH", "0");
    vi.stubEnv("MIKE_FULL_HANDOFF_PROMPT_VARIANT", "legacy-v5");
    vi.stubEnv("MIKE_BENCHMARK_TRACE_TOOLS", "1");
    mocks.progressiveDisclosure = true;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) =>
          call.name === "describe_tools"
            ? {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: true,
                  domains: ["output_document"],
                  opened: ["library_create_docx"],
                }),
              }
            : {
                tool_use_id: call.id,
                content: "EXACT RESEARCH FACT",
                evidenceRefs: [
                  {
                    handle: "exact:v5",
                    filename: "source.docx",
                    locator: "section 1",
                    text: "EXACT RESEARCH FACT",
                  },
                ],
              },
        ),
    );
    let invocation = 0;
    let draftingPrompt = "";
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        await params.runTools?.([
          { id: "research", name: "Grep", input: { pattern: "FACT" } },
        ]);
        const [opened] = await params.runTools?.([
          {
            id: "open-output",
            name: "describe_tools",
            input: { domains: ["output_document"] },
          },
        ]);
        expect(opened.terminal).toBe(true);
        return { fullText: "Research complete." };
      }
      draftingPrompt = params.messages[0]?.content ?? "";
      return { fullText: "Draft complete." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000017",
        content: "Research and draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2);
    expect(draftingPrompt).toContain("fresh drafting context");
    expect(draftingPrompt).toContain("EXACT RESEARCH FACT");
    expect(response.text).not.toContain('"type":"research_context_refresh"');
    expect(response.text.match(/"type":"evidence_handoff"/gu)).toHaveLength(1);
    expect(response.text.match(/"type":"content_reset"/gu)).toHaveLength(1);
  });

  it("replaces accumulated research history with a compact evidence checkpoint", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: "latest exact result",
          evidenceRefs: [
            {
              handle: "exact:research",
              filename: "source.docx",
              locator: "section 1",
              text: "latest exact result",
            },
          ],
        })),
    );
    let invocation = 0;
    let terminal = false;
    let refreshedMessages: Array<{ role: string; content: string }> = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        const [result] = await params.runTools?.([
          { id: "research", name: "library_lookup", input: {} },
        ]);
        terminal = result.terminal === true;
        params.callbacks?.onContentDelta?.("Discarded research-phase chatter.");
        return { fullText: "Discarded research-phase chatter." };
      }
      refreshedMessages = params.messages;
      params.callbacks?.onContentDelta?.("Final answer.");
      return { fullText: "Final answer." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000009",
        content: "Analyze the source.",
      },
    });

    expect(response.status).toBe(200);
    expect(terminal).toBe(true);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2);
    expect(refreshedMessages).toHaveLength(1);
    expect(refreshedMessages[0].content).toContain("Analyze the source.");
    expect(refreshedMessages[0].content).toContain("DURABLE EVIDENCE INDEX");
    expect(refreshedMessages[0].content).toContain("latest exact result");
    expect(refreshedMessages[0].content).not.toContain(
      "Discarded research-phase chatter.",
    );
    expect(response.text).toContain('"type":"content_reset"');
    const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    expect(JSON.stringify(chat.messages)).not.toContain(
      "Discarded research-phase chatter.",
    );
  });

  it("keeps repeated research continuations bounded to the latest result", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    const firstEvidence = `FIRST_PREVIEW ${"x".repeat(160)} FIRST_SECRET_TAIL`;
    const secondEvidence = `SECOND_PREVIEW ${"y".repeat(160)} SECOND_SECRET_TAIL`;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => {
          const first = call.id === "first";
          const text = first ? firstEvidence : secondEvidence;
          return {
            tool_use_id: call.id,
            content: text,
            evidenceRefs: [
              {
                handle: `exact:${call.id}`,
                filename: `${call.id}.docx`,
                locator: "section 1",
                text,
              },
            ],
          };
        }),
    );
    let invocation = 0;
    let finalMessages: Array<{ role: string; content: string }> = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        await params.runTools?.([
          { id: "first", name: "library_lookup", input: {} },
        ]);
        params.callbacks?.onContentDelta?.("FIRST_REASONING_TRANSCRIPT");
        return { fullText: "FIRST_REASONING_TRANSCRIPT" };
      }
      if (invocation === 2) {
        expect(params.messages).toHaveLength(1);
        expect(params.messages[0].content).toContain("FIRST_SECRET_TAIL");
        await params.runTools?.([
          { id: "second", name: "library_lookup", input: {} },
        ]);
        params.callbacks?.onContentDelta?.("SECOND_REASONING_TRANSCRIPT");
        return { fullText: "SECOND_REASONING_TRANSCRIPT" };
      }
      finalMessages = params.messages;
      params.callbacks?.onContentDelta?.("Bounded final answer.");
      return { fullText: "Bounded final answer." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000010",
        content: "Analyze both sources.",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(3);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0].content).toContain("Analyze both sources.");
    expect(finalMessages[0].content).toContain("first.docx");
    expect(finalMessages[0].content).toContain("SECOND_SECRET_TAIL");
    expect(finalMessages[0].content).not.toContain("FIRST_SECRET_TAIL");
    expect(finalMessages[0].content).not.toContain("FIRST_REASONING_TRANSCRIPT");
    expect(finalMessages[0].content).not.toContain("SECOND_REASONING_TRANSCRIPT");
  });

  it("checkpoints research and demand-pages exact evidence into drafting", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    vi.stubEnv("MIKE_DRAFT_HANDOFF_MODE", "paged");
    vi.stubEnv("MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS", "0");
    vi.stubEnv("MIKE_BENCHMARK_TRACE_TOOLS", "1");
    mocks.progressiveDisclosure = true;
    const exact = `TARGET FACT\n${"x".repeat(5_000)}\nSECRET_TAIL`;
    let mountedEvidence = "";
    mocks.runLocalAssistantTools.mockImplementation(
      async (...args: unknown[]) => {
        const calls = args[1] as {
          id: string;
          name: string;
          input?: Record<string, unknown>;
        }[];
        const workingSets = args[12] as
          | Map<string, { text: string }>
          | undefined;
        return calls.map((call) => {
          if (call.id === "failed-sibling") {
            return {
              tool_use_id: call.id,
              content: JSON.stringify({ ok: false, error: "probe failed" }),
              status: "error" as const,
            };
          }
          if (call.name === "Glob") {
            return { tool_use_id: call.id, content: "source.docx\tchars=5019" };
          }
          if (call.name === "library_lookup") {
            return {
              tool_use_id: call.id,
              content: exact,
              evidenceRefs: [
                {
                  handle: "exact:paged",
                  filename: "source.docx",
                  locator: "section 9.2",
                  text: exact,
                  kind: "evidence" as const,
                },
                {
                  handle: "exact:target",
                  filename: "source.docx",
                  locator: "section 9.2",
                  text: "TARGET FACT",
                  kind: "evidence" as const,
                },
              ],
            };
          }
          if (call.name === "describe_tools") {
            return {
              tool_use_id: call.id,
              content: JSON.stringify({
                ok: true,
                domains: ["drafting"],
                opened: ["library_revise_docx"],
              }),
            };
          }
          if (call.name === "Grep") {
            mountedEvidence =
              workingSets?.get(".mike/working-sets/evidence.txt")?.text ?? "";
            if (call.input?.pattern === "NEW") {
              return {
                tool_use_id: call.id,
                content: "NEW FACT",
                evidenceRefs: [
                  {
                    handle: "exact:new",
                    filename: "new-source.html",
                    locator: "paragraph 4",
                    text: "NEW FACT",
                    kind: "evidence" as const,
                  },
                ],
              };
            }
            return {
              tool_use_id: call.id,
              content: "TARGET FACT",
              evidenceRefs: [
                {
                  handle: "exact:target",
                  filename: "source.docx",
                  locator: "section 9.2",
                  text: "TARGET FACT",
                  kind: "evidence" as const,
                  durableUnionBacked: true,
                },
              ],
            };
          }
          return { tool_use_id: call.id, content: JSON.stringify({ ok: true }) };
        });
      },
    );
    let invocation = 0;
    let checkpointMessages: Array<{ role: string; content: string }> = [];
    let refreshedMessages: Array<{ role: string; content: string }> = [];
    let draftingMessages: Array<{ role: string; content: string }> = [];
    let draftingGrepResult = "";
    let duplicateDraftingGrepStatus = "";
    let redraftingMessages: Array<{ role: string; content: string }> = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        const results = await params.runTools?.([
          { id: "inventory", name: "Glob", input: { pattern: "*" } },
          { id: "research", name: "library_lookup", input: {} },
          { id: "failed-sibling", name: "Grep", input: { pattern: "(" } },
          {
            id: "premature-drafting",
            name: "describe_tools",
            input: {
              domains: ["drafting"],
              drafting_brief: "Premature brief.",
            },
          },
        ]);
        expect(results?.[1].terminal).toBe(true);
        expect(JSON.parse(results?.[3].content ?? "{}")).toMatchObject({
          status: "research_checkpoint_pending",
        });
        expect(results?.[3].terminal).not.toBe(true);
        return { fullText: "Discarded research chatter." };
      }
      if (invocation === 2) {
        checkpointMessages = params.messages;
        expect(params.systemPrompt).toBe(
          "You maintain a compact research checkpoint. Call checkpoint_research with the replacement brief.",
        );
        expect(params.tools.map((tool) => tool.function.name)).toEqual([
          "checkpoint_research",
        ]);
        const [saved] = await params.runTools?.([
          {
            id: "checkpoint",
            name: "checkpoint_research",
            input: {
              brief:
                "Target fact controls. Verify source.docx section 9.2 before drafting.",
              continue_research: true,
            },
          },
        ]);
        expect(saved.terminal).toBe(true);
        return { fullText: "" };
      }
      if (invocation === 3) {
        refreshedMessages = params.messages;
        const [reread, opened] = await params.runTools?.([
          {
            id: "verify-before-drafting",
            name: "library_lookup",
            input: {},
          },
          {
            id: "open-drafting",
            name: "describe_tools",
            input: {
              domains: ["drafting"],
              drafting_brief: "LOSSY UNREVIEWED REPLACEMENT",
            },
          },
        ]);
        expect(reread.content).toContain("SECRET_TAIL");
        expect(reread.status).not.toBe("already_exposed");
        expect(opened.terminal).toBe(true);
        return { fullText: "Research complete." };
      }
      if (invocation === 4) {
        draftingMessages = params.messages;
        const [grep, duplicate] = await params.runTools?.([
          {
            id: "draft-grep",
            name: "Grep",
            input: {
              pattern: "TARGET",
              path: ".mike/working-sets/evidence.txt",
              output_mode: "content",
            },
          },
          {
            id: "draft-grep-duplicate",
            name: "Grep",
            input: {
              pattern: "TARGET",
              path: ".mike/working-sets/evidence.txt",
              output_mode: "content",
            },
          },
        ]);
        draftingGrepResult = grep.content;
        duplicateDraftingGrepStatus = duplicate.status ?? "";
        const [newEvidence] = await params.runTools?.([
          {
            id: "draft-reresearch",
            name: "Grep",
            input: { pattern: "NEW", output_mode: "working_set" },
          },
        ]);
        expect(newEvidence.terminal).toBe(true);
        return { fullText: "Discarded pre-checkpoint draft." };
      }
      if (invocation === 5) {
        expect(params.tools.map((tool) => tool.function.name)).toEqual([
          "checkpoint_research",
        ]);
        const [saved] = await params.runTools?.([
          {
            id: "reresearch-checkpoint",
            name: "checkpoint_research",
            input: {
              brief:
                "Target fact and new fact control. Verify source.docx section 9.2 and new-source.html paragraph 4.",
              continue_research: false,
            },
          },
        ]);
        expect(saved.terminal).toBe(true);
        return { fullText: "" };
      }
      redraftingMessages = params.messages;
      params.callbacks?.onContentDelta?.("Final drafting answer.");
      return { fullText: "Final drafting answer." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000011",
        content: "Draft from the researched evidence.",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(6);
    expect(checkpointMessages[0].content).toContain("SECRET_TAIL");
    expect(checkpointMessages[0].content).toContain("source.docx\tchars=5019");
    expect(checkpointMessages[0].content).toContain("PINNED ORIENTATION");
    expect(refreshedMessages[0].content).toContain("Target fact controls");
    expect(refreshedMessages[0].content).toContain("source.docx\tchars=5019");
    expect(refreshedMessages[0].content).toContain("PINNED ORIENTATION");
    expect(refreshedMessages[0].content).not.toContain("SECRET_TAIL");
    expect(draftingMessages[0].content).toContain("You are the drafting agent");
    expect(draftingMessages[0].content).toContain("Target fact controls");
    expect(draftingMessages[0].content).toContain("PINNED ORIENTATION");
    expect(draftingMessages[0].content).not.toContain(
      "LOSSY UNREVIEWED REPLACEMENT",
    );
    expect(draftingMessages[0].content).toContain(
      ".mike/working-sets/evidence.txt",
    );
    expect(draftingMessages[0].content).not.toContain("SECRET_TAIL");
    expect(mountedEvidence).toContain("SECRET_TAIL");
    expect(draftingGrepResult).toBe("TARGET FACT");
    expect(duplicateDraftingGrepStatus).toBe("already_exposed");
    expect(redraftingMessages[0].content).toContain(
      "Target fact and new fact control",
    );
    expect(redraftingMessages[0].content).toContain("new-source.html");
    expect(response.text).toContain('"type":"evidence_working_set_receipt"');
    const checkpointReceipts = loaded.store
      .getAnonymousChat(USER_ID, created.body.id)!
      .messages.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Record<string, unknown>[])
          : [],
      )
      .filter((event) => event.type === "research_checkpoint_receipt");
    expect(checkpointReceipts).toHaveLength(2);
    expect(checkpointReceipts.map((event) => event.brief)).toEqual([
      "Target fact controls. Verify source.docx section 9.2 before drafting.",
      "Target fact and new fact control. Verify source.docx section 9.2 and new-source.html paragraph 4.",
    ]);
    expect(checkpointReceipts.every((event) =>
      /^[0-9a-f]{64}$/u.test(String(event.brief_sha256)),
    )).toBe(true);
    const visibleChat = await request(loaded.app).get(`/chat/${created.body.id}`);
    expect(JSON.stringify(visibleChat.body)).not.toContain(
      "research_checkpoint_receipt",
    );
    expect(response.text).toContain(
      "Target fact and new fact control. Verify source.docx section 9.2 and new-source.html paragraph 4.",
    );
    expect(response.text).toContain('"orientation_chars":');
    expect(response.text).toContain("SECRET_TAIL");
    expect(response.text).toContain("NEW FACT");
  });

  it("fails closed when the checkpoint agent does not save a checkpoint", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    vi.stubEnv("MIKE_DRAFT_HANDOFF_MODE", "paged");
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: "material evidence",
          evidenceRefs: [
            {
              handle: "exact:fail-closed",
              filename: "source.docx",
              locator: "section 1",
              text: "material evidence",
              kind: "evidence" as const,
            },
          ],
        })),
    );
    let invocation = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      invocation += 1;
      if (invocation === 1) {
        await params.runTools?.([
          { id: "research", name: "library_lookup", input: {} },
        ]);
        return { fullText: "discarded research chatter" };
      }
      expect(params.tools.map((tool) => tool.function.name)).toEqual([
        "checkpoint_research",
      ]);
      return { fullText: "I forgot to call the checkpoint tool." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000012",
        content: "Research, then draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2);
    expect(response.text).toContain(
      "Research checkpoint was not saved; refusing to continue",
    );
  });

  it("withholds drafting tools until an over-cap evidence union is selected", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    // A cap is exact. The host must not silently reinterpret it as 2x.
    vi.stubEnv("MIKE_EVIDENCE_HANDOFF_MAX_CHARS", "10");
    mocks.progressiveDisclosure = true;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            domains: ["drafting"],
            opened: ["library_revise_docx"],
          }),
          evidenceRefs: [
            {
              handle: "exact:test",
              filename: "source.docx",
              locator: "section 1",
              text: "evidence over cap",
              kind: "evidence" as const,
            },
          ],
        })),
    );
    let namesAfterSelection: string[] = [];
    let selectionResult: { content: string; status?: string } | null = null;
    let bypassResult: { content: string } | null = null;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      [selectionResult] = await params.runTools?.([
        {
          id: "open-drafting",
          name: "describe_tools",
          input: { domains: ["drafting"] },
        },
      ]);
      namesAfterSelection = params.resolveTools().map(
        (tool) => tool.function.name,
      );
      [bypassResult] = await params.runTools?.([
        { id: "premature-draft", name: "library_revise_docx", input: {} },
      ]);
      params.callbacks?.onContentDelta?.("Research complete.");
      return { fullText: "Research complete." };
    });

    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000008",
        content: "Revise the draft from the evidence.",
      },
    });

    expect(response.status).toBe(200);
    expect(selectionResult?.status).toBe("selection_required");
    const selectionPayload = JSON.parse(selectionResult!.content);
    expect(selectionPayload.status).toBe("selection_required");
    expect(selectionPayload.evidence_manifest_items).toBe(1);
    expect(selectionPayload.evidence_manifest).toContain(
      "alias\tlocator\tchars\tpreview",
    );
    expect(namesAfterSelection).toEqual(["describe_tools"]);
    expect(JSON.parse(bypassResult!.content).error).toContain("not loaded");
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(response.text).not.toContain('"type":"content_reset"');
  });

  it("passes a selected document and system workflow into the provider turn", async () => {
    const localDocuments = await import("../lib/localDocumentStore");
    const document = await localDocuments.createLocalDocument({
      userId: USER_ID,
      kind: "file",
      filename: "Lease.docx",
      bytes: Buffer.from("test-docx-bytes"),
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        service_tier: "fast",
        current_turn: {
          kind: "message",
          content: "extract key terms",
          files: [
            {
              filename: document.filename,
              document_id: document.id,
            },
          ],
          workflow: {
            id: "builtin-extract-key-terms",
            title: "Extract Key Terms",
          },
        },
        attached_documents: [
          {
            filename: document.filename,
            document_id: document.id,
          },
        ],
        displayed_doc: {
          filename: document.filename,
          document_id: document.id,
        },
      });

    expect(response.status).toBe(200);
    expect(mocks.streamChatWithTools.mock.calls[0]?.[0]).toMatchObject({
      serviceTier: "fast",
    });
    expect(mocks.providerMessages[0]?.at(-1)?.content).toContain(
      `- Lease.docx (document_id: ${document.id})`,
    );
    expect(mocks.systemPrompts[0]).toContain(
      `Displayed document: "Lease.docx" (document_id: ${document.id})`,
    );
    expect(mocks.providerMessages[0]?.at(-1)?.content).toContain(
      "[Workflow: Extract Key Terms (id: builtin-extract-key-terms)]",
    );
    expect(mocks.systemPrompts[0]).toContain(
      "then call library_revise_docx",
    );
    expect(mocks.systemPrompts[0]).toContain(
      "Do not substitute a prose list of proposed or suggested changes",
    );
    expect(mocks.systemPrompts[0]).toContain(
      "shows created and edited document cards automatically",
    );
  });

  it("uses an explicitly selected owned document without changing the project", async () => {
    const localDocuments = await import("../lib/localDocumentStore");
    const document = await localDocuments.createLocalDocument({
      userId: USER_ID,
      kind: "file",
      filename: "Retainer.docx",
      bytes: Buffer.from("test-docx-bytes"),
    });
    mocks.matterDocuments = [];
    const loaded = await loadApp();
    const created = await request(loaded.app)
      .post("/chat/create")
      .send({ project_id: PROJECT_ID });

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        project_id: PROJECT_ID,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Review this document.",
          files: [
            {
              filename: document.filename,
              document_id: document.id,
            },
          ],
        },
        attached_documents: [
          {
            filename: document.filename,
            document_id: document.id,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(mocks.matterDocuments).toEqual([]);
  });

  it("carries a hidden registry across reload and compacted client history", async () => {
    mocks.activeHandles.push(HANDLE);
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const firstTurn = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Look up the exact paragraph.",
        },
      });

    expect(firstTurn.status).toBe(200);
    expect(mocks.finalizerHandleSets[0]).toEqual([HANDLE]);
    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toEqual({
      type: REGISTRY_EVENT,
      schema_version: 1,
      handles: [
        {
          handle: HANDLE,
          document_id: DOCUMENT_ID,
          version_id: VERSION_ID,
        },
      ],
    });

    const visible = await request(loaded.app).get(`/chat/${created.body.id}`);
    expect(visible.status).toBe(200);
    expect(JSON.stringify(visible.body)).not.toContain(HANDLE);
    expect(JSON.stringify(visible.body)).not.toContain(REGISTRY_EVENT);

    mocks.activeHandles.length = 0;
    loaded = await loadApp();
    const secondTurn = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "message",
          content: "Continue from the compacted conversation.",
        },
      });

    expect(secondTurn.status).toBe(200);
    expect(mocks.providerMessages[1]).toEqual([
      { role: "user", content: "Look up the exact paragraph." },
      {
        role: "assistant",
        content:
          "The lookup was useful, but this answer contains no quotation.",
      },
      {
        role: "user",
        content: "Continue from the compacted conversation.",
      },
    ]);
    expect(mocks.systemPrompts[1]).toContain(HANDLE);
    expect(mocks.systemPrompts[1]).toContain("library_evidence");
    expect(mocks.finalizerHandleSets[1]).toEqual([]);
    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toMatchObject({
      handles: [{ handle: HANDLE }],
    });

    const refreshed = await request(loaded.app).get(`/chat/${created.body.id}`);
    expect(JSON.stringify(refreshed.body)).not.toContain(HANDLE);
    expect(JSON.stringify(refreshed.body)).not.toContain(REGISTRY_EVENT);
  });

  it("retains mirrored provider evidence across reload inside a matter", async () => {
    mocks.activeHandles.push(HANDLE);
    mocks.providerReferences.set(HANDLE, [
      PROVIDER_REFERENCE_ONE,
      PROVIDER_REFERENCE_TWO,
    ]);
    mocks.matterDocuments = [];
    let loaded = await loadApp();
    const created = await request(loaded.app)
      .post("/chat/create")
      .send({ project_id: PROJECT_ID });
    const firstCurrentTurn = {
      kind: "message",
      turn_id: "70000000-0000-4000-8000-000000000001",
      content: "Use the exact provider PDF passage.",
    };

    const firstTurn = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      project_id: PROJECT_ID,
      expected_version: 0,
      current_turn: firstCurrentTurn,
    });

    expect(firstTurn.status).toBe(200);
    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toEqual({
      type: REGISTRY_EVENT,
      schema_version: 1,
      handles: [
        { handle: HANDLE, source_reference: PROVIDER_REFERENCE_ONE },
        { handle: HANDLE, source_reference: PROVIDER_REFERENCE_TWO },
      ],
    });
    expect(mocks.readLocalPdfEvidenceReceipt).not.toHaveBeenCalled();

    const visible = await request(loaded.app).get(`/chat/${created.body.id}`);
    expect(visible.text).not.toContain(HANDLE);
    expect(visible.text).not.toContain(PROVIDER_REFERENCE_ONE);
    expect(visible.text).not.toContain(PROVIDER_REFERENCE_TWO);

    const durableVersion = loaded.store.getAnonymousChat(
      USER_ID,
      created.body.id,
    )!.transcript_version;
    mocks.activeHandles.length = 0;
    mocks.providerReferences.clear();
    loaded = await loadApp();
    const replay = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      project_id: PROJECT_ID,
      expected_version: durableVersion,
      current_turn: firstCurrentTurn,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("chat_turn_already_completed");

    const secondTurn = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        project_id: PROJECT_ID,
        expected_version: durableVersion,
        current_turn: {
          kind: "message",
          turn_id: "70000000-0000-4000-8000-000000000002",
          content: "Continue from the exact provider evidence.",
        },
      });

    expect(secondTurn.status).toBe(200);
    expect(mocks.systemPrompts[1]).toContain(
      `reference_id=${JSON.stringify(PROVIDER_REFERENCE_ONE)}`,
    );
    expect(mocks.systemPrompts[1]).toContain(
      `reference_id=${JSON.stringify(PROVIDER_REFERENCE_TWO)}`,
    );
    expect(mocks.systemPrompts[1]).toContain("legal_pdf_lookup");
    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toMatchObject({
      handles: [
        { handle: HANDLE, source_reference: PROVIDER_REFERENCE_ONE },
        { handle: HANDLE, source_reference: PROVIDER_REFERENCE_TWO },
      ],
    });
  });

  it("drops registry entries that are no longer in the chat's matter scope", async () => {
    mocks.activeHandles.push(HANDLE);
    mocks.matterDocuments = [DOCUMENT_ID];
    let loaded = await loadApp();
    const created = await request(loaded.app)
      .post("/chat/create")
      .send({ project_id: PROJECT_ID });
    await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        project_id: PROJECT_ID,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Look up this matter source.",
        },
      });

    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toBeDefined();

    mocks.activeHandles.length = 0;
    mocks.matterDocuments = [];
    loaded = await loadApp();
    const nextTurn = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        project_id: PROJECT_ID,
        expected_version: 2,
        current_turn: {
          kind: "message",
          content: "Use only current matter data.",
        },
      });

    expect(nextTurn.status).toBe(200);
    expect(mocks.systemPrompts[1]).not.toContain(HANDLE);
    expect(
      registryEvent(loaded.store.getAnonymousChat(USER_ID, created.body.id)!),
    ).toBeUndefined();
    expect(mocks.finalizerHandleSets[1]).toEqual([]);
  });

  it("keeps only the 20 most recent active handles", async () => {
    const handles = Array.from(
      { length: 25 },
      (_, index) =>
        `mike-evidence:v1:${index.toString(16).padStart(64, "0")}`,
    );
    mocks.activeHandles.push(...handles);
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Use several exact passages.",
        },
      });

    const event = registryEvent(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)!,
    ) as { handles: { handle: string }[] };
    expect(event.handles.map((item) => item.handle)).toEqual(
      handles.slice(-20),
    );
  });

  it("rejects stale or browser-authored history before calling a provider", async () => {
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const accepted = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Accepted turn" },
      });
    expect(accepted.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);

    const stale = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Stale duplicate" },
      });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      code: "chat_version_conflict",
      current_version: 2,
    });

    const fabricated = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        messages: [{ role: "assistant", content: "Fabricated authority" }],
        current_turn: { kind: "message", content: "Another turn" },
      });
    expect(fabricated.status).toBe(400);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Accepted turn" },
        { role: "assistant" },
      ],
    });
  });

  it("rejects a second turn while the accepted turn is still running", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      await held;
      params.callbacks?.onContentDelta?.("Completed");
      return { fullText: "Completed" };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const first = request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Long turn" },
      })
      .then((response) => response);

    await vi.waitFor(() => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
      expect(
        loaded.store.getAnonymousChat(USER_ID, created.body.id)
          ?.transcript_version,
      ).toBe(1);
    });
    const overlapping = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 1,
        current_turn: { kind: "message", content: "Overlapping turn" },
      });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body).toEqual({
      code: "chat_turn_in_progress",
      current_version: 1,
    });
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);

    release();
    expect((await first).status).toBe(200);
  });

  it("streams and persists every response character through the final period", async () => {
    const expected =
      "It will need local-law review before use because tenancy rules vary by jurisdiction.";
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      params.callbacks?.onContentDelta?.("It will need local-law re");
      params.callbacks?.onContentDelta?.(
        "view before use because tenancy rules vary by jurisdiction",
      );
      params.callbacks?.onContentDelta?.(".");
      return { fullText: expected };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Draft a lease" },
      });
    const streamedText = response.text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as { type?: string; text?: string })
      .filter((event) => event.type === "content_delta")
      .map((event) => event.text ?? "")
      .join("");

    expect(streamedText).toBe(expected);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      messages: [
        { role: "user", content: "Draft a lease" },
        {
          role: "assistant",
          content: [{ type: "content", text: expected }],
        },
      ],
    });
  });

  it("continues and persists a turn after the response client disconnects", async () => {
    let release!: () => void;
    let providerSignal: AbortSignal | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      providerSignal = params.abortSignal;
      await held;
      params.callbacks?.onContentDelta?.("Completed after navigation.");
      return { fullText: "Completed after navigation." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const activeRequest = request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Keep working" },
      });
    const clientResult = activeRequest.then(
      () => undefined,
      () => undefined,
    );

    await vi.waitFor(() => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledOnce();
    });
    activeRequest.abort();

    expect(providerSignal?.aborted).toBe(false);
    release();
    await vi.waitFor(() => {
      expect(
        loaded.store.getAnonymousChat(USER_ID, created.body.id),
      ).toMatchObject({
        transcript_version: 2,
        messages: [
          { role: "user", content: "Keep working" },
          {
            role: "assistant",
            content: [
              { type: "content", text: "Completed after navigation." },
            ],
          },
        ],
      });
    });
    await clientResult;
  });

  it("aborts an active turn only through the explicit stop endpoint", async () => {
    mocks.streamChatWithTools.mockImplementation(
      async (params) =>
        new Promise((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Stream aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const activeRequest = request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Stop explicitly" },
      })
      .then((response) => response);

    await vi.waitFor(() => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledOnce();
    });
    const stopped = await request(loaded.app)
      .post(`/chat/${created.body.id}/stop`)
      .send({});

    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true });
    expect((await activeRequest).status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Stop explicitly" },
        {
          role: "assistant",
          content: [{ type: "content", text: "Cancelled by user." }],
        },
      ],
    });
  });

  it("persists partial content and terminal failures for canonical replay", async () => {
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      params.callbacks?.onContentDelta?.("Partial answer");
      throw new Error("Provider failed");
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Start the answer" },
      });

    expect(response.status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Start the answer" },
        {
          role: "assistant",
          content: [
            { type: "content", text: "Partial answer" },
            { type: "error", message: "Provider failed" },
          ],
        },
      ],
    });
  });

  it("persists partial content and cancellation markers", async () => {
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      params.callbacks?.onContentDelta?.("Work in progress");
      const error = new Error("Stream aborted.");
      error.name = "AbortError";
      throw error;
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Cancel this turn" },
      });

    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Cancel this turn" },
        {
          role: "assistant",
          content: [
            { type: "content", text: "Work in progress" },
            { type: "content", text: "Cancelled by user." },
          ],
        },
      ],
    });
  });

  it("does not resurrect a chat deleted during an active turn", async () => {
    mocks.streamChatWithTools.mockImplementation(
      async (params) =>
        new Promise((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Stream aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const running = request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Long answer" },
      })
      .then((response) => response);

    await vi.waitFor(() => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    });
    expect(
      (await request(loaded.app).delete(`/chat/${created.body.id}`)).status,
    ).toBe(204);
    expect((await running).status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toBeNull();
  });

  it("moves chats through the Recycling bin before permanent deletion", async () => {
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    expect(
      (await request(loaded.app).delete(`/chat/${created.body.id}`)).status,
    ).toBe(204);
    expect(
      (await request(loaded.app).get(`/chat/${created.body.id}`)).status,
    ).toBe(404);
    expect((await request(loaded.app).get("/chat")).body).toEqual([]);
    expect(
      (await request(loaded.app).get("/chat/recycling-bin")).body,
    ).toEqual([
      expect.objectContaining({
        id: created.body.id,
        deleted_at: expect.any(String),
      }),
    ]);

    expect(
      (
        await request(loaded.app).post(
          `/chat/${created.body.id}/restore`,
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(loaded.app).get(`/chat/${created.body.id}`)).status,
    ).toBe(200);

    await request(loaded.app).delete(`/chat/${created.body.id}`);
    expect(
      (
        await request(loaded.app).delete(
          `/chat/${created.body.id}/permanent`,
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(loaded.app).get("/chat/recycling-bin")).body,
    ).toEqual([]);
  });

  it("persists project association changes across reload", async () => {
    mocks.matterDocuments = [];
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const associated = await request(loaded.app)
      .patch(`/chat/${created.body.id}`)
      .send({ project_id: PROJECT_ID });
    expect(associated.status).toBe(200);
    expect(associated.body).toMatchObject({
      id: created.body.id,
      project_id: PROJECT_ID,
    });

    loaded = await loadApp();
    expect((await request(loaded.app).get(`/chat/${created.body.id}`)).body.chat)
      .toMatchObject({
        id: created.body.id,
        project_id: PROJECT_ID,
      });

    const unlinked = await request(loaded.app)
      .patch(`/chat/${created.body.id}`)
      .send({ project_id: null });
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.project_id).toBeNull();

    loaded = await loadApp();
    expect((await request(loaded.app).get(`/chat/${created.body.id}`)).body.chat)
      .toMatchObject({
        id: created.body.id,
        project_id: null,
      });
  });

  it("does not resurrect project chats deleted with their matter", async () => {
    mocks.matterDocuments = [];
    mocks.streamChatWithTools.mockImplementation(
      async (params) =>
        new Promise((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Stream aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const loaded = await loadApp();
    const created = await request(loaded.app)
      .post("/chat/create")
      .send({ project_id: PROJECT_ID });
    const running = request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Long matter answer" },
      })
      .then((response) => response);

    await vi.waitFor(() => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    });
    loaded.store.deleteAnonymousProjectChats(USER_ID, PROJECT_ID);
    expect((await running).status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toBeNull();
  });

  it("does not create a ghost chat when a new turn fails validation", async () => {
    const loaded = await loadApp();

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Use a missing file",
          files: [
            {
              filename: "missing.pdf",
              document_id: "50000000-0000-4000-8000-000000000001",
            },
          ],
        },
      });

    expect(response.status).toBe(400);
    expect(loaded.store.listAnonymousChats(USER_ID)).toEqual([]);
  });

  it("contains unexpected preflight failures without crashing Express", async () => {
    mocks.preflightFailure = true;
    const loaded = await loadApp();

    const failed = await request(loaded.app)
      .post("/chat")
      .send({
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Trigger a local read",
          files: [
            {
              filename: "evidence.pdf",
              document_id: DOCUMENT_ID,
            },
          ],
        },
      });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ detail: "Local chat failed" });
    expect(loaded.store.listAnonymousChats(USER_ID)).toEqual([]);

    mocks.preflightFailure = false;
    expect(
      (await request(loaded.app).post("/chat/create").send({})).status,
    ).toBe(200);
  });

  it("durably pauses for model-requested inputs and validates the reply", async () => {
    let providerRound = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      mocks.providerMessages.push(
        params.messages.map(({ role, content }) => ({ role, content })),
      );
      if (providerRound++ === 0) {
        params.callbacks?.onContentDelta?.("I need one detail.");
        const call = {
          id: "ask-forum",
          name: "ask_inputs",
          input: {
            items: [
              {
                id: "forum",
                kind: "choice",
                question: "Which forum?",
                options: [{ value: "Ontario" }, { value: "Alberta" }],
                allow_other: false,
              },
            ],
          },
        };
        params.callbacks?.onToolCallStart?.(call);
        expect(await params.runTools?.([call])).toEqual([
          {
            tool_use_id: "ask-forum",
            content: JSON.stringify({
              ok: true,
              status: "waiting_for_user",
            }),
          },
        ]);
        params.callbacks?.onContentDelta?.(" This must be suppressed.");
        if (params.abortSignal?.aborted) {
          const error = new Error("Stream aborted.");
          error.name = "AbortError";
          throw error;
        }
        return { fullText: "I need one detail. This must be suppressed." };
      }
      params.callbacks?.onContentDelta?.("Continuing with Ontario.");
      return { fullText: "Continuing with Ontario." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const asked = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Prepare the filing plan.",
        },
      });

    expect(asked.status).toBe(200);
    expect(asked.text).toContain('"type":"ask_inputs"');
    expect(asked.text).toContain('"type":"content_reset"');
    expect(asked.text).not.toContain("This must be suppressed");
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Prepare the filing plan." },
        {
          role: "assistant",
          content: [
            {
              type: "ask_inputs",
              items: [
                {
                  id: "forum",
                  kind: "choice",
                  question: "Which forum?",
                  options: [{ value: "Ontario" }, { value: "Alberta" }],
                  allow_other: true,
                  other_label: "Write your own answer",
                },
              ],
            },
          ],
        },
      ],
    });

    const forgedQuestion = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          content: "Quebec",
          responses: [
            {
              id: "forum",
              kind: "choice",
              question: "A different question?",
              answer: "Ontario",
            },
          ],
        },
      });
    expect(forgedQuestion.status).toBe(400);

    const emptyAnswer = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          content: "",
          responses: [
            {
              id: "forum",
              kind: "choice",
              question: "Which forum?",
              answer: "",
            },
          ],
        },
      });
    expect(emptyAnswer.status).toBe(400);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)
        ?.transcript_version,
    ).toBe(2);

    const answered = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          content: "Browser-authored prose is not authoritative.",
          responses: [
            {
              id: "forum",
              kind: "choice",
              question: "Which forum?",
              answer: "Quebec",
            },
          ],
        },
      });
    expect(answered.status).toBe(200);
    expect(mocks.providerMessages[1].at(-1)).toEqual({
      role: "user",
      content:
        "[User responses to requested inputs]\n- Which forum?: Quebec",
    });
    const durable = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    expect(durable.transcript_version).toBe(4);
    expect(
      (durable.messages[1].content as Record<string, unknown>[]).find(
        (event) => event.type === "ask_inputs_response",
      ),
    ).toMatchObject({
      type: "ask_inputs_response",
      content: "Responses to Beaver's questions:\n1. Which forum?\nQuebec",
      responses: [
        {
          id: "forum",
          kind: "choice",
          question: "Which forum?",
          answer: "Quebec",
        },
      ],
    });
  });

  it("keeps a failed structured continuation retryable without duplicating it", async () => {
    let continuationAttempt = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      mocks.providerMessages.push(
        params.messages.map(({ role, content }) => ({ role, content })),
      );
      if (continuationAttempt++ === 0) {
        params.callbacks?.onContentDelta?.("Partial continuation.");
        throw new Error("Provider failed");
      }
      params.callbacks?.onContentDelta?.("Completed continuation.");
      return { fullText: "Completed continuation." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    loaded.store.appendAnonymousMessage(
      chat,
      {
        role: "assistant",
        content: [
          {
            type: "ask_inputs",
            items: [
              {
                id: "forum",
                kind: "choice",
                question: "Which forum?",
                options: [{ value: "Ontario" }, { value: "Alberta" }],
                allow_other: false,
                other_label: "Other",
              },
            ],
          },
        ],
      },
      0,
    );
    const responseTurn = {
      kind: "ask_inputs_response",
      content: "Ontario",
      responses: [
        {
          id: "forum",
          kind: "choice",
          question: "Which forum?",
          answer: "Ontario",
        },
      ],
    };

    const failed = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 1,
        current_turn: responseTurn,
      });
    expect(failed.status).toBe(200);
    expect(chat.transcript_version).toBe(3);

    const changedRetry = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 3,
        current_turn: {
          ...responseTurn,
          content: "Alberta",
          responses: [{ ...responseTurn.responses[0], answer: "Alberta" }],
        },
      });
    expect(changedRetry.status).toBe(400);
    expect(changedRetry.body.detail).toMatch(/retry the same response/iu);
    expect(chat.transcript_version).toBe(3);

    const retried = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 3,
        current_turn: responseTurn,
      });
    expect(retried.status).toBe(200);
    expect(chat.transcript_version).toBe(4);
    const events = chat.messages[0].content as Record<string, unknown>[];
    expect(
      events.filter((event) => event.type === "ask_inputs_response"),
    ).toHaveLength(1);
    expect(
      mocks.providerMessages[1].filter(
        (message) =>
          message.role === "user" &&
          message.content.includes("Which forum?: Ontario"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    { label: "provider failure", cancelled: false },
    { label: "provider cancellation", cancelled: true },
  ])(
    "blocks an exact structured retry after a committed mutation and $label",
    async ({ cancelled }) => {
      mocks.runLocalAssistantTools.mockImplementation(
        async (_userId: unknown, calls: { id: string }[]) =>
          calls.map((call) => ({
            tool_use_id: call.id,
            content: JSON.stringify({
              ok: true,
              receipt: "mike-document:v1",
              action: "created",
              version_id: "mock-version",
            }),
          })),
      );
      mocks.streamChatWithTools.mockImplementation(async (params) => {
        const mutation = {
          id: "create-doc",
          name: "library_create_docx",
          input: { title: "Draft", sections: [] },
        };
        expect(await params.runTools?.([mutation])).toEqual([
          {
            tool_use_id: mutation.id,
            content: JSON.stringify({
              ok: true,
              receipt: "mike-document:v1",
              action: "created",
              version_id: "mock-version",
            }),
          },
        ]);
        const error = new Error(
          cancelled ? "Stream aborted." : "Provider failed",
        );
        if (cancelled) error.name = "AbortError";
        throw error;
      });
      let loaded = await loadApp();
      const created = await request(loaded.app).post("/chat/create").send({});
      const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
      loaded.store.appendAnonymousMessage(
        chat,
        {
          role: "assistant",
          content: [
            {
              type: "ask_inputs",
              items: [
                {
                  id: "forum",
                  kind: "choice",
                  question: "Which forum?",
                  options: [{ value: "Ontario" }],
                  allow_other: false,
                },
              ],
            },
          ],
        },
        0,
      );
      const responseTurn = {
        kind: "ask_inputs_response",
        content: "Ontario",
        responses: [
          {
            id: "forum",
            kind: "choice",
            question: "Which forum?",
            answer: "Ontario",
          },
        ],
      };

      const failed = await request(loaded.app)
        .post("/chat")
        .send({
          chat_id: created.body.id,
          expected_version: 1,
          current_turn: responseTurn,
        });

      expect(failed.status).toBe(200);
      expect(failed.text).toContain('"retryable":false');
      expect(chat.transcript_version).toBe(4);
      const events = chat.messages[0].content as Record<string, unknown>[];
      expect(
        events.filter(
          (event) => event.type === "local_mutation_committed",
        ),
      ).toEqual([
        { type: "local_mutation_committed", schema_version: 1 },
      ]);
      const visible = await request(loaded.app).get(`/chat/${created.body.id}`);
      expect(visible.text).not.toContain("local_mutation_committed");
      loaded = await loadApp();
      expect(
        loaded.store.getAnonymousChat(USER_ID, created.body.id)
          ?.transcript_version,
      ).toBe(4);

      const retried = await request(loaded.app)
        .post("/chat")
        .send({
          chat_id: created.body.id,
          expected_version: 4,
          current_turn: responseTurn,
        });

      expect(retried.status).toBe(409);
      expect(retried.body).toEqual({
        code: "chat_retry_blocked_after_mutation",
        current_version: 4,
        detail:
          "The prior continuation changed local data before it stopped. Review that result before sending a new instruction.",
      });
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
      expect(mocks.runLocalAssistantTools).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a failed turn retryable after a successful no-op edit report", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            action: "no_changes",
            change_count: 0,
          }),
        })),
    );
    let attempt = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      if (attempt++ === 0) {
        await params.runTools?.([
          {
            id: "no-op",
            name: "library_apply_text_ops",
            input: { document_id: DOCUMENT_ID, ops: [] },
          },
        ]);
        throw new Error("Provider failed after no-op");
      }
      params.callbacks?.onContentDelta?.("Retried after no-op.");
      return { fullText: "Retried after no-op." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const currentTurn = {
      kind: "message",
      turn_id: "50000000-0000-4000-8000-000000000005",
      content: "Normalize the document.",
    };

    const failed = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: currentTurn,
    });
    expect(failed.status).toBe(200);
    expect(failed.text).not.toContain('"retryable":false');
    const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    expect(JSON.stringify(chat.messages)).not.toContain(
      "local_mutation_committed",
    );

    const retried = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: chat.transcript_version,
      current_turn: currentTurn,
    });
    expect(retried.status).toBe(200);
    expect(retried.text).toContain("Retried after no-op.");
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2);
  });

  it("recognizes a completed mutating normal turn after restart", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            version_id: "mock-version",
          }),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      await params.runTools?.([
        {
          id: "create-doc",
          name: "library_create_docx",
          input: { title: "Draft", sections: [] },
        },
      ]);
      params.callbacks?.onContentDelta?.("The draft was created.");
      return { fullText: "The draft was created." };
    });
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const currentTurn = {
      kind: "message",
      turn_id: "50000000-0000-4000-8000-000000000001",
      content: "Create the draft.",
    };

    const first = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: currentTurn,
    });
    expect(first.status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)
        ?.transcript_version,
    ).toBe(3);

    loaded = await loadApp();
    const replay = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 3,
      current_turn: currentTurn,
    });

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({
      code: "chat_turn_already_completed",
      current_version: 3,
    });
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(mocks.runLocalAssistantTools).toHaveBeenCalledTimes(1);
    const visible = await request(loaded.app).get(`/chat/${created.body.id}`);
    expect(visible.text).not.toContain("turn_id");
    expect(visible.text).not.toContain("local_turn_completed");
  });

  it("reruns an exact failed normal turn without keeping failed attempt history", async () => {
    let attempt = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      mocks.providerMessages.push(
        params.messages.map(({ role, content }) => ({ role, content })),
      );
      if (attempt++ === 0) {
        params.callbacks?.onContentDelta?.("Discarded partial answer.");
        throw new Error("Provider failed");
      }
      const text = attempt === 2 ? "Retried answer." : "Later answer.";
      params.callbacks?.onContentDelta?.(text);
      return { fullText: text };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const currentTurn = {
      kind: "message",
      turn_id: "50000000-0000-4000-8000-000000000003",
      content: "Answer this once.",
    };

    await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: currentTurn,
    });
    const staleRetry = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 1,
      current_turn: currentTurn,
    });
    expect(staleRetry.status).toBe(409);
    expect(staleRetry.body.code).toBe("chat_version_conflict");

    const retried = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 2,
      current_turn: currentTurn,
    });
    expect(retried.status).toBe(200);
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)
        ?.transcript_version,
    ).toBe(4);

    await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 4,
      current_turn: {
        kind: "message",
        turn_id: "50000000-0000-4000-8000-000000000004",
        content: "Continue.",
      },
    });
    const futureHistory = JSON.stringify(mocks.providerMessages.at(-1));
    expect(futureHistory).toContain("Retried answer.");
    expect(futureHistory).not.toContain("Discarded partial answer.");
    expect(futureHistory).not.toContain(
      "previous assistant response ended before completion",
    );
  });

  it("blocks a mutating normal turn that failed before restart", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            version_id: "mock-version",
          }),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      await params.runTools?.([
        {
          id: "create-doc",
          name: "library_create_docx",
          input: { title: "Draft", sections: [] },
        },
      ]);
      throw new Error("Provider failed after mutation");
    });
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const currentTurn = {
      kind: "message",
      turn_id: "50000000-0000-4000-8000-000000000002",
      content: "Create the draft.",
    };

    const failed = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: currentTurn,
    });
    expect(failed.status).toBe(200);
    expect(failed.text).toContain('"retryable":false');

    loaded = await loadApp();
    const durableVersion =
      loaded.store.getAnonymousChat(USER_ID, created.body.id)!
        .transcript_version;
    const replay = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: durableVersion,
      current_turn: currentTurn,
    });

    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("chat_retry_blocked_after_mutation");
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(mocks.runLocalAssistantTools).toHaveBeenCalledTimes(1);
  });

  it("streams and persists the original Mike created-document event", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            document_id: DOCUMENT_ID,
            version_id: VERSION_ID,
            version_number: 1,
            filename: "Draft.docx",
            download_url:
              `/single-documents/${DOCUMENT_ID}/file?version_id=${VERSION_ID}`,
          }),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      await params.runTools?.([
        {
          id: "create-doc",
          name: "library_create_docx",
          input: { title: "Draft", markdown: "# Draft" },
        },
      ]);
      params.callbacks?.onContentDelta?.("The Word draft is ready.");
      return { fullText: "The Word draft is ready." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: { kind: "message", content: "Create the draft." },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"type":"doc_created_start"');
    expect(response.text).toContain('"type":"doc_created"');
    const persisted = loaded.store
      .getAnonymousChat(USER_ID, created.body.id)!
      .messages.filter((message) => message.role === "assistant")
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      ) as Record<string, unknown>[];
    expect(persisted).toContainEqual({
      type: "doc_created",
      filename: "Draft.docx",
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      version_number: 1,
      download_url:
        `/single-documents/${DOCUMENT_ID}/file?version_id=${VERSION_ID}`,
    });
  });

  it.each([
    {
      label: "the public revise tool",
      toolName: "library_revise_docx",
      codingResult: false,
    },
    { label: "coding-shaped Edit", toolName: "Edit", codingResult: true },
  ])("streams and persists the Mike redline event contract for $label", async ({
    toolName,
    codingResult,
  }) => {
    const annotation = {
      kind: "edit",
      edit_id: "60000000-0000-4000-8000-000000000001",
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      version_number: 2,
      change_id: "7",
      del_w_id: "8",
      ins_w_id: "9",
      deleted_text: "Original",
      inserted_text: "Revised",
      context_before: "",
      context_after: " provision.",
      status: "pending",
    };
    const mutationReceipt = JSON.stringify({
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      version_number: 2,
      filename: "Draft.docx",
      download_url:
        `/single-documents/${DOCUMENT_ID}/file?version_id=${VERSION_ID}`,
      annotations: [annotation],
    });
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: codingResult
            ? "Updated Draft.docx: 1 tracked change applied."
            : mutationReceipt,
          ...(codingResult ? { mutationReceipt } : {}),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const call = {
        id: "revise-doc",
        name: toolName,
        input: {
          document_id: DOCUMENT_ID,
          version_id: VERSION_ID,
          edits: [],
        },
      };
      params.callbacks?.onToolCallStart?.(call);
      const [toolResult] = (await params.runTools?.([call])) ?? [];
      if (codingResult) {
        expect(toolResult.content).toBe(
          "Updated Draft.docx: 1 tracked change applied.",
        );
      }
      params.callbacks?.onContentDelta?.("The tracked revision is ready.");
      return { fullText: "The tracked revision is ready." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        content: "Revise the draft.",
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"type":"doc_edited_start"');
    expect(response.text).toContain('"type":"doc_edited"');
    const chat = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    const persisted = chat.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      ) as Record<string, unknown>[];
    expect(persisted).toContainEqual({
      type: "doc_edited",
      filename: "Draft.docx",
      document_id: DOCUMENT_ID,
      version_id: VERSION_ID,
      version_number: 2,
      download_url:
        `/single-documents/${DOCUMENT_ID}/file?version_id=${VERSION_ID}`,
      annotations: [annotation],
    });
  });

  it("joins provider message blocks without splitting words or sentences", async () => {
    const expected =
      "I’ll fix clear typographical errors. I found the editable copy.";
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      params.callbacks?.onContentDelta?.(
        "I’ll fix clear typographic",
      );
      params.callbacks?.onContentBlockEnd?.();
      params.callbacks?.onContentDelta?.("al errors.");
      params.callbacks?.onContentBlockEnd?.();
      params.callbacks?.onContentDelta?.("I found the editable copy.");
      return { fullText: expected };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      current_turn: {
        kind: "message",
        content: "Fix the document.",
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      JSON.stringify({ type: "content_final", text: expected }),
    );
    const assistant = loaded.store
      .getAnonymousChat(USER_ID, created.body.id)!
      .messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual({
      type: "content",
      text: expected,
    });
  });

  it("ends the provider loop only after a successful all-create batch", async () => {
    vi.stubEnv("MIKE_TERMINAL_AUTHORING", "1");
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call, index) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            filename: `draft-${index + 1}.docx`,
            document_id: `mock-document-${index + 1}`,
            version_id: `mock-version-${index + 1}`,
            version_number: 1,
            download_url: `/documents/mock-document-${index + 1}`,
          }),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const results = await params.runTools?.([
        {
          id: "create-one",
          name: "library_create_docx",
          input: { title: "First draft", sections: [] },
        },
        {
          id: "create-two",
          name: "library_create_docx",
          input: { title: "Second draft", sections: [] },
        },
      ]);
      expect(results).toHaveLength(2);
      expect(results?.every((result) => result.terminal === true)).toBe(true);
      return { fullText: "" };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Create both drafts." },
      });

    expect(response.status).toBe(200);
    expect(
      response.text.match(/"type":"doc_created_start"/gu) ?? [],
    ).toHaveLength(2);
  });

  it("executes every mixed-batch call without treating it as terminal", async () => {
    vi.stubEnv("MIKE_TERMINAL_AUTHORING", "1");
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string; name: string }[]) =>
        calls.map((call) =>
          call.name === "library_create_docx"
            ? {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: true,
                  receipt: "mike-document:v1",
                  action: "created",
                  version_id: "mock-version",
                }),
              }
            : {
                tool_use_id: call.id,
                content: JSON.stringify({ ok: true, text: "New evidence." }),
                evidenceSegments: [{}],
              },
        ),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const results = await params.runTools?.([
        { id: "read", name: "Read", input: { file_path: "source.docx" } },
        {
          id: "create",
          name: "library_create_docx",
          input: { title: "Draft", sections: [] },
        },
      ]);
      expect(results?.some((result) => result.terminal)).toBe(false);
      expect(JSON.parse(results?.[1].content ?? "{}")).toMatchObject({
        action: "created",
      });
      params.callbacks?.onContentDelta?.("Reviewed and created.");
      return { fullText: "Reviewed and created." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Read and draft." },
      });

    expect(response.status).toBe(200);
  });

  it("does not pause Codex after a mutation has already committed", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
        tool_use_id: call.id,
        content: JSON.stringify({
          ok: true,
          receipt: "mike-document:v1",
          action: "created",
          version_id: "mock-version",
        }),
        })),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const mutation = {
        id: "create-doc",
        name: "library_create_docx",
        input: { title: "Draft", sections: [] },
      };
      params.callbacks?.onToolCallStart?.(mutation);
      expect(await params.runTools?.([mutation])).toEqual([
        {
          tool_use_id: mutation.id,
          content: JSON.stringify({
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            version_id: "mock-version",
          }),
        },
      ]);
      const ask = {
        id: "late-question",
        name: "ask_inputs",
        input: {
          items: [
            {
              id: "forum",
              kind: "choice",
              question: "Which forum?",
              options: [{ value: "Ontario" }],
            },
          ],
        },
      };
      params.callbacks?.onToolCallStart?.(ask);
      const [rejectedAsk] = (await params.runTools?.([ask])) ?? [];
      expect(JSON.parse(rejectedAsk.content)).toMatchObject({
        ok: false,
        error: expect.stringContaining("before document or workflow changes"),
      });
      expect(params.abortSignal?.aborted).toBe(false);
      params.callbacks?.onContentDelta?.("The draft was created.");
      return { fullText: "The draft was created." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: {
          kind: "message",
          content: "Create the draft, then ask.",
        },
      });

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('"type":"ask_inputs"');
    expect(
      JSON.stringify(
        loaded.store.getAnonymousChat(USER_ID, created.body.id)?.messages,
      ),
    ).not.toContain('"type":"ask_inputs"');
  });

  it("rejects an ask-input response when no question is pending", async () => {
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    const response = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: {
          kind: "ask_inputs_response",
          content: "Ontario",
          responses: [
            {
              id: "forum",
              kind: "choice",
              question: "Forum?",
              answer: "Ontario",
            },
          ],
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/no assistant question/iu);
    expect(mocks.streamChatWithTools).not.toHaveBeenCalled();
    expect(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)
        ?.transcript_version,
    ).toBe(0);
  });

  it("resumes one Codex thread across reload with only the current turn", async () => {
    const threadId = "50000000-0000-4000-8000-000000000001";
    const calls: {
      providerSession?: { continuationId?: string };
      systemPrompt: string;
      messages: { role: string; content: string }[];
    }[] = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      calls.push({
        providerSession: params.providerSession,
        systemPrompt: params.systemPrompt,
        messages: params.messages.map(({ role, content }) => ({
          role,
          content,
        })),
      });
      const text = calls.length === 1 ? "First answer." : "Second answer.";
      params.callbacks?.onContentDelta?.(text);
      return { fullText: text, continuationId: threadId };
    });
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const first = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "high",
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "60000000-0000-4000-8000-000000000001",
        content: "First turn.",
      },
    });
    expect(first.status).toBe(200);

    loaded = await loadApp();
    const second = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "high",
      expected_version: 2,
      current_turn: {
        kind: "message",
        turn_id: "60000000-0000-4000-8000-000000000002",
        content: "Second turn.",
      },
    });

    expect(second.status).toBe(200);
    expect(calls[0].providerSession).toEqual({ persist: true });
    expect(calls[0].systemPrompt).toContain("library_lookup");
    expect(calls[1]).toMatchObject({
      providerSession: { persist: true, continuationId: threadId },
      systemPrompt: "",
      messages: [{ role: "user", content: "Second turn." }],
    });
    const sessions = await import("../lib/anonymousProviderSessionStore");
    expect(
      sessions.readAnonymousCodexSession(USER_ID, created.body.id),
    ).toMatchObject({
      continuation_id: threadId,
      transcript_version: 4,
    });

    const changedEffort = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "max",
      expected_version: 4,
      current_turn: {
        kind: "message",
        turn_id: "60000000-0000-4000-8000-000000000003",
        content: "Third turn.",
      },
    });
    expect(changedEffort.status).toBe(200);
    expect(calls[2].providerSession).toEqual({ persist: true });
    expect(calls[2].systemPrompt).toContain("library_lookup");
    expect(calls[2].messages).toHaveLength(5);
  });

  it("does not resume a Codex thread after progressive disclosure changes its tool schema", async () => {
    vi.stubEnv("MIKE_CONTEXT_HANDOFF", "1");
    mocks.progressiveDisclosure = true;
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            domains: ["drafting"],
            opened: ["library_revise_docx"],
          }),
        })),
    );
    const calls: {
      providerSession?: { continuationId?: string };
      systemPrompt: string;
      messages: { role: string; content: string }[];
    }[] = [];
    let invocation = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      calls.push({
        providerSession: params.providerSession,
        systemPrompt: params.systemPrompt,
        messages: params.messages.map(({ role, content }) => ({ role, content })),
      });
      invocation += 1;
      if (invocation === 1) {
        await params.runTools?.([
          {
            id: "open-drafting",
            name: "describe_tools",
            input: { domains: ["drafting"] },
          },
        ]);
        return {
          fullText: "Research complete.",
          continuationId: "50000000-0000-4000-8000-000000000010",
        };
      }
      const text = invocation === 2 ? "Draft answer." : "Follow-up answer.";
      params.callbacks?.onContentDelta?.(text);
      return {
        fullText: text,
        continuationId:
          invocation === 2
            ? "50000000-0000-4000-8000-000000000011"
            : "50000000-0000-4000-8000-000000000012",
      };
    });

    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const first = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "high",
      expected_version: 0,
      current_turn: {
        kind: "message",
        turn_id: "60000000-0000-4000-8000-000000000010",
        content: "Draft from the evidence.",
      },
    });
    expect(first.status).toBe(200);
    const sessions = await import("../lib/anonymousProviderSessionStore");
    expect(
      sessions.readAnonymousCodexSession(USER_ID, created.body.id),
    ).toBeNull();

    loaded = await loadApp();
    const second = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "high",
      expected_version: 2,
      current_turn: {
        kind: "message",
        turn_id: "60000000-0000-4000-8000-000000000011",
        content: "Check one more point.",
      },
    });

    expect(second.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[2].providerSession).toEqual({ persist: true });
    expect(calls[2].systemPrompt).toContain("describe_tools");
    expect(calls[2].messages).toEqual([
      { role: "user", content: "Draft from the evidence." },
      { role: "assistant", content: "Draft answer." },
      { role: "user", content: "Check one more point." },
    ]);
  });

  it("rebuilds from the transcript when a claimed Codex resume fails before activity", async () => {
    const firstThread = "50000000-0000-4000-8000-000000000001";
    const replacementThread = "50000000-0000-4000-8000-000000000002";
    const calls: {
      providerSession?: { continuationId?: string };
      messages: { role: string; content: string }[];
    }[] = [];
    let invocation = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      calls.push({
        providerSession: params.providerSession,
        messages: params.messages.map(({ role, content }) => ({
          role,
          content,
        })),
      });
      invocation += 1;
      if (invocation === 2) throw new Error("Codex session is unavailable");
      const text = invocation === 1 ? "First answer." : "Recovered answer.";
      params.callbacks?.onContentDelta?.(text);
      return {
        fullText: text,
        continuationId:
          invocation === 1 ? firstThread : replacementThread,
      };
    });
    let loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "max",
      expected_version: 0,
      current_turn: { kind: "message", content: "First turn." },
    });

    loaded = await loadApp();
    const second = await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      model: "codex:gpt-5.6-luna",
      reasoning_effort: "max",
      expected_version: 2,
      current_turn: { kind: "message", content: "Second turn." },
    });

    expect(second.status).toBe(200);
    expect(
      JSON.stringify(
        loaded.store.getAnonymousChat(USER_ID, created.body.id)?.messages,
      ),
    ).toContain("Recovered answer.");
    expect(calls[1]).toMatchObject({
      providerSession: { persist: true, continuationId: firstThread },
      messages: [{ role: "user", content: "Second turn." }],
    });
    expect(calls[2].providerSession).toEqual({ persist: true });
    expect(calls[2].messages).toEqual([
      { role: "user", content: "First turn." },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second turn." },
    ]);
    const sessions = await import("../lib/anonymousProviderSessionStore");
    expect(
      sessions.readAnonymousCodexSession(USER_ID, created.body.id),
    ).toMatchObject({
      continuation_id: replacementThread,
      transcript_version: 4,
    });
  });
});
