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
  providerMessages: [] as { role: string; content: string }[][],
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
  runLocalAssistantTools: mocks.runLocalAssistantTools,
}));
vi.mock("../lib/chat/localPdfEvidenceState", () => ({
  appendLocalPdfPinpointLinks: mocks.appendLocalPdfPinpointLinks,
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
  mocks.providerMessages.length = 0;
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
                  allow_other: false,
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

    const unavailableChoice = await request(loaded.app)
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
              question: "Which forum?",
              answer: "Quebec",
            },
          ],
        },
      });
    expect(unavailableChoice.status).toBe(400);
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
              answer: "Ontario",
            },
          ],
        },
      });
    expect(answered.status).toBe(200);
    expect(mocks.providerMessages[1].at(-1)).toEqual({
      role: "user",
      content:
        "[User responses to requested inputs]\n- Which forum?: Ontario",
    });
    const durable = loaded.store.getAnonymousChat(USER_ID, created.body.id)!;
    expect(durable.transcript_version).toBe(4);
    expect(
      (durable.messages[1].content as Record<string, unknown>[]).find(
        (event) => event.type === "ask_inputs_response",
      ),
    ).toMatchObject({
      type: "ask_inputs_response",
      content: "Responses to Beaver's questions:\n1. Which forum?\nOntario",
      responses: [
        {
          id: "forum",
          kind: "choice",
          question: "Which forum?",
          answer: "Ontario",
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

  it("recognizes a completed mutating normal turn after restart", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
          tool_use_id: call.id,
          content: JSON.stringify({ ok: true, receipt: "created" }),
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
          content: JSON.stringify({ ok: true, receipt: "created" }),
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

  it("does not pause Codex after a mutation has already committed", async () => {
    mocks.runLocalAssistantTools.mockImplementation(
      async (_userId: unknown, calls: { id: string }[]) =>
        calls.map((call) => ({
        tool_use_id: call.id,
        content: JSON.stringify({ ok: true, receipt: "mike-document:v1" }),
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
