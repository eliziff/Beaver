import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipDocumentBytes } from "../lib/__tests__/support/documentBytes";
import type { ChatStore } from "../lib/chatStore";

const mocks = vi.hoisted(() => ({
  matterDocuments: undefined as string[] | undefined,
  preflightFailure: false,
  providerMessages: [] as { role: string; content: string }[][],
  systemPrompts: [] as string[],
  runLocalAssistantTool: vi.fn(),
  streamChatWithTools: vi.fn(),
}));

vi.mock("../lib/localMode", () => ({ isLocalRuntime: () => true }));
vi.mock("../lib/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/llm")>(),
  completeText: vi.fn(),
  DEFAULT_MAIN_MODEL: "gpt-5.2",
  modelSupportsImageInput: () => true,
  streamChatWithTools: mocks.streamChatWithTools,
}));
vi.mock("../lib/chat/assistantTools", () => ({
  assistantTools: (runtime: {
    userId: string;
    scope: "main" | "reader";
    artifactFor(documentId: string, versionId: string): string;
    onMutationCommitted(): void;
  }) => [
    {
      name: "Read",
      inputSchema: { type: "object", additionalProperties: true },
      annotations: { readOnlyHint: true },
      reader: ["CA", "US", "UK"],
    },
    {
      name: "Edit",
      inputSchema: { type: "object", additionalProperties: true },
      sequential: true,
    },
    {
      name: "Write",
      inputSchema: { type: "object", additionalProperties: true },
      sequential: true,
    },
  ].map((schema) => ({
    ...schema,
    async execute(input: Record<string, unknown>, _context: unknown, signal: AbortSignal, call: { id: string; name: string }) {
      const execution = await mocks.runLocalAssistantTool(
        runtime.userId,
        { ...call, input },
        runtime,
        signal,
      );
      if (execution.mutated) runtime.onMutationCommitted();
      const documentEvent = execution.events.find(
        (event: { type?: string }) => event.type === "document_artifact",
      );
      const artifact = documentEvent?.document_id
        ? runtime.artifactFor(documentEvent.document_id, documentEvent.version_id)
        : undefined;
      const { tool_use_id: _id, content, terminal: _terminal, ...metadata } = execution.result;
      return {
        result: {
          content: [{
            type: "text",
            text: artifact
              ? JSON.stringify({ ok: true, artifact, filename: documentEvent.filename })
              : content,
          }],
        },
        metadata,
        ...(runtime.scope === "main" && execution.events.length
          ? { events: execution.events }
          : {}),
        ...(execution.evidence.length ? { evidence: execution.evidence } : {}),
        ...(execution.mutated ? { mutated: true } : {}),
        ...(execution.terminal ||
            (schema.name === "Write" && documentEvent?.action === "created")
          ? { terminal: true }
          : {}),
      };
    },
  })),
}));
vi.mock("../lib/documentProjectionService", () => ({
  documentProjectionService: {
    peekPdfState: vi.fn(async () => null),
    removePdf: vi.fn(async () => undefined),
  },
}));
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "30000000-0000-4000-8000-000000000001";

let dataHome: string;

async function loadApp() {
  try {
    await (await import("../lib/relationalDatabase")).closeRelationalDatabase();
  } catch {}
  vi.resetModules();
  const [
    { createChatRouter },
    { tabularRepository },
    { createChatStore },
    { chatRepository },
    { generateChatTitle },
    { createChatApplication },
    { sqliteChatFeatures },
    { localDocuments, localLibraryStore, localProjects },
  ] = await Promise.all([
    import("./chat"),
    import("../lib/relationalRepositories"),
    import("../lib/chatStore"),
    import("../lib/relationalRepositories"),
    import("../lib/chatTitle"),
    import("../lib/chat/chatApplication"),
    import("../lib/sqliteChatFeatures"),
    import("../lib/__tests__/support/localDocumentFixtures"),
  ]);
  const chats = createChatStore(
    chatRepository, generateChatTitle, {
      project: async (scope, id) => !!await localProjects.get(scope, id),
      review: async () => false,
    },
  );
  const documents = mocks.preflightFailure
    ? { ...localDocuments, versions: async () => {
        throw new Error("Injected document preflight failure");
      } }
    : localDocuments;
  const application = createChatApplication({
    chats,
    documents,
    library: localLibraryStore,
    projects: localProjects,
    tabular: tabularRepository,
    features: {
      load: async () => ({ includeResearchTools: true }),
      ...sqliteChatFeatures,
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/chat", createChatRouter(
    chats,
    application,
  ));
  return { app, store: chats, projects: localProjects };
}

async function storedChat(store: ChatStore, chatId: string) {
  const [chat, messages] = await Promise.all([
    store.get({ userId: USER_ID }, chatId),
    store.transcript({ userId: USER_ID }, chatId),
  ]);
  return chat && messages ? { ...chat, messages } : null;
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-evidence-chat-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
  (await import("../lib/relationalDatabase")).localDatabaseSync()
    .prepare(
      `INSERT OR IGNORE INTO projects
        (user_id,id,name,created_at,updated_at)
       VALUES (?,?,?,?,?)`,
    ).run(USER_ID, PROJECT_ID, "Test matter", new Date().toISOString(),
      new Date().toISOString());
  mocks.matterDocuments = undefined;
  mocks.preflightFailure = false;
  mocks.providerMessages.length = 0;
  mocks.systemPrompts.length = 0;
  mocks.runLocalAssistantTool.mockReset();
  mocks.streamChatWithTools.mockReset();
  mocks.runLocalAssistantTool.mockImplementation(
    async (_userId: unknown, call: { id: string }) => ({
        result: { tool_use_id: call.id, content: JSON.stringify({ ok: true }) },
        mutated: false,
        events: [],
        terminal: false,
        evidence: [],
      }),
  );
  mocks.streamChatWithTools.mockImplementation(async (params) => {
    mocks.systemPrompts.push(params.systemPrompt);
    mocks.providerMessages.push(
      params.messages.map(({ role, content }) => ({ role, content })),
    );
    const text = "The lookup was useful.";
    params.callbacks?.onContentDelta?.(text);
    return { fullText: text };
  });
});

afterEach(async () => {
  try {
    await (await import("../lib/relationalDatabase")).closeRelationalDatabase();
  } catch {}
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  });
});

describe("chat PDF evidence durability", () => {

  it("omits empty chats from history without invalidating their direct route", async () => {
    const loaded = await loadApp();
    const empty = await request(loaded.app).post("/chat/create").send({});
    const used = await request(loaded.app).post("/chat/create").send({});
    expect((await request(loaded.app).post("/chat").send({
      chat_id: used.body.id,
      expected_version: 0,
      current_turn: { kind: "message", content: "Hello" },
    })).status).toBe(200);

    const history = await request(loaded.app).get("/chat");
    expect(history.body.map(({ id }: { id: string }) => id)).toEqual([used.body.id]);
    expect((await request(loaded.app).get(`/chat/${empty.body.id}`)).status).toBe(200);
  });

  it("uses an explicitly selected owned document without changing the project", async () => {
    const localDocuments = await import(
      "../lib/__tests__/support/localDocumentFixtures"
    );
    const document = await localDocuments.createLocalDocument({
      userId: USER_ID,
      kind: "file",
      filename: "Retainer.docx",
      bytes: await zipDocumentBytes("test-docx-bytes"),
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
              document_id: document.id,
            },
          ],
        },
      });

    expect(response.status).toBe(200);
    expect(mocks.matterDocuments).toEqual([]);
    const providerInput = [
      mocks.systemPrompts.at(-1),
      ...mocks.providerMessages.at(-1)!.map(({ content }) => content),
    ].join("\n");
    expect(providerInput).toContain("Retainer.docx");
    expect(providerInput).not.toContain(document.id);
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
    expect(stale.body).toMatchObject({
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
      await storedChat(loaded.store, created.body.id),
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

    await vi.waitFor(async () => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
      expect(
      (await storedChat(loaded.store, created.body.id))
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
    expect(overlapping.body).toMatchObject({
      code: "chat_turn_in_progress",
      current_version: 1,
    });
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(await storedChat(loaded.store, created.body.id)).toMatchObject({
      transcript_version: 1,
      messages: [{ role: "user", content: "Long turn" }],
    });

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
      await storedChat(loaded.store, created.body.id),
    ).toMatchObject({
      messages: [
        { role: "user", content: "Draft a lease" },
        {
          role: "assistant",
          content: expect.arrayContaining([{ type: "content", text: expected }]),
        },
      ],
    });
  });

  it("keeps a durable turn running when the response client disconnects", async () => {
    let providerSignal: AbortSignal | undefined;
    let finishProvider!: () => void;
    mocks.streamChatWithTools.mockImplementation(async (params) =>
      new Promise((resolve) => {
        providerSignal = params.abortSignal;
        finishProvider = () => {
          const text = "Finished after the client disconnected.";
          params.callbacks?.onContentDelta?.(text);
          resolve({ fullText: text });
        };
      }));
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
    finishProvider();
    await vi.waitFor(async () => {
      expect(providerSignal?.aborted).toBe(false);
      expect(
        await storedChat(loaded.store, created.body.id),
      ).toMatchObject({
        transcript_version: 2,
        messages: [
          { role: "user", content: "Keep working" },
          {
            role: "assistant",
            content: expect.arrayContaining([{
              type: "content",
              text: "Finished after the client disconnected.",
            }]),
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
      await storedChat(loaded.store, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Stop explicitly" },
        {
          role: "assistant",
          content: [{ type: "turn_status", status: "cancelled" }],
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
      await storedChat(loaded.store, created.body.id),
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
      await storedChat(loaded.store, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Cancel this turn" },
        {
          role: "assistant",
          content: [
            { type: "content", text: "Work in progress" },
            { type: "turn_status", status: "cancelled" },
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
      await storedChat(loaded.store, created.body.id),
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
    await loaded.projects.delete({ userId: USER_ID }, PROJECT_ID);
    expect((await running).status).toBe(200);
    expect(
      await storedChat(loaded.store, created.body.id),
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
              document_id: "50000000-0000-4000-8000-000000000001",
            },
          ],
        },
      });

    expect(response.status).toBe(400);
    expect(await loaded.store.list({ userId: USER_ID }, {})).toEqual([]);
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
              document_id: DOCUMENT_ID,
            },
          ],
        },
      });

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ detail: "Chat operation failed" });
    expect(await loaded.store.list({ userId: USER_ID }, {})).toEqual([]);

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
              },
            ],
          },
        };
        params.callbacks?.onToolCallStart?.(call);
        const [result] = await params.runTools?.([call]) ?? [];
        expect(result).toMatchObject({ tool_use_id: "ask-forum" });
        expect(JSON.parse(result.content)).toEqual({
          ok: true,
          status: "waiting_for_user",
        });
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
      await storedChat(loaded.store, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Prepare the filing plan." },
        {
          role: "assistant",
          content: expect.arrayContaining([
            {
              type: "ask_inputs",
              items: [
                {
                  id: "forum",
                  kind: "choice",
                  question: "Which forum?",
                  options: [{ value: "Ontario" }, { value: "Alberta" }],
                },
              ],
            },
          ]),
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

    const invalidAnswer = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          responses: [
            {
              id: "forum",
              kind: "choice",
              answer: 7,
            },
          ],
        },
      });
    expect(invalidAnswer.status).toBe(400);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(
      (await storedChat(loaded.store, created.body.id))
        ?.transcript_version,
    ).toBe(2);

    const answered = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          responses: [
            {
              id: "forum",
              kind: "choice",
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
    const durable = (await storedChat(loaded.store, created.body.id))!;
    expect(durable.transcript_version).toBe(4);
    expect(
      (durable.messages[1].content as Record<string, unknown>[]).find(
        (event) => event.type === "ask_inputs_response",
      ),
    ).toMatchObject({
      type: "ask_inputs_response",
      responses: [
        {
          id: "forum",
          kind: "choice",
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
    await loaded.store.commitTurn({ userId: USER_ID }, created.body.id, {
      expectedVersion: 0,
      assistantMessage: {
        id: crypto.randomUUID(),
        content: [
          {
            type: "ask_inputs",
            items: [
              {
                id: "forum",
                kind: "choice",
                question: "Which forum?",
                options: [{ value: "Ontario" }, { value: "Alberta" }],
              },
            ],
          },
        ],
      },
    });
    const responseTurn = {
      kind: "ask_inputs_response",
      responses: [
        {
          id: "forum",
          kind: "choice",
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
    expect((await storedChat(loaded.store, created.body.id))
      ?.transcript_version).toBe(3);

    const changedRetry = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 3,
        current_turn: {
          ...responseTurn,
          responses: [{ ...responseTurn.responses[0], answer: "Alberta" }],
        },
      });
    expect(changedRetry.status).toBe(400);
    expect(changedRetry.body.detail).toMatch(/retry the same response/iu);
    expect((await storedChat(loaded.store, created.body.id))
      ?.transcript_version).toBe(3);

    const retried = await request(loaded.app)
      .post("/chat")
      .send({
        chat_id: created.body.id,
        expected_version: 3,
        current_turn: responseTurn,
      });
    expect(retried.status).toBe(200);
    expect((await storedChat(loaded.store, created.body.id))
      ?.transcript_version).toBe(5);
    const events = (await storedChat(loaded.store, created.body.id))!
      .messages[0].content as Record<string, unknown>[];
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

  it("keeps a failed turn retryable after a successful no-op edit report", async () => {
    mocks.runLocalAssistantTool.mockImplementation(
      async (_userId: unknown, call: { id: string }) => ({
        result: {
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            action: "no_changes",
            change_count: 0,
          }),
        },
        mutated: false,
        events: [],
        terminal: false,
        evidence: [],
      }),
    );
    let attempt = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      if (attempt++ === 0) {
        await params.runTools?.([
          {
            id: "no-op",
            name: "Edit",
            input: { file_path: "contract.docx", ops: [] },
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
    const chat = (await storedChat(loaded.store, created.body.id))!;
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
      (await storedChat(loaded.store, created.body.id))
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
      model: "codex:gpt-5.6-luna",
      current_turn: {
        kind: "message",
        content: "Fix the document.",
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      JSON.stringify({ type: "content_final", text: expected }),
    );
    const assistant = (await storedChat(loaded.store, created.body.id))!
      .messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual({
      type: "content",
      text: expected,
    });
  });

  it("executes every mixed-batch call without treating it as terminal", async () => {
    mocks.runLocalAssistantTool.mockImplementation(
      async (_userId: unknown, call: { id: string; name: string }) =>
        call.name === "Write"
          ? {
              result: {
                tool_use_id: call.id,
                content: JSON.stringify({
                  ok: true,
                  action: "created",
                  version_id: "mock-version",
                }),
              },
              mutated: true,
              events: [{
                type: "document_artifact",
                action: "created",
                filename: "Draft.docx",
                document_id: "mock-document",
                version_id: "mock-version",
                version_number: 1,
                download_url: "/documents/mock-document/download",
                resource: "document",
              }],
              terminal: true,
              evidence: [],
            }
          : {
              result: {
                tool_use_id: call.id,
                content: JSON.stringify({ ok: true, text: "New evidence." }),
              },
              mutated: false,
              events: [],
              terminal: false,
              evidence: [],
            },
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const results = await params.runTools?.([
        { id: "read", name: "Read", input: { file_path: "source.docx" } },
        {
          id: "create",
          name: "Write",
          input: { kind: "docx", filename: "Draft.docx", content: "# Draft" },
        },
      ]);
      expect(results?.some((result) => result.terminal)).toBe(false);
      expect(JSON.parse(results?.[1].content ?? "{}")).toMatchObject({
        artifact: "draft-1",
        filename: "Draft.docx",
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
    mocks.runLocalAssistantTool.mockImplementation(
      async (_userId: unknown, call: { id: string }) => ({
        result: {
          tool_use_id: call.id,
          content: JSON.stringify({
            ok: true,
            action: "created",
            version_id: "mock-version",
          }),
        },
        mutated: true,
        events: [{
          type: "document_artifact",
          action: "created",
          filename: "Draft.docx",
          document_id: "mock-document",
          version_id: "mock-version",
          version_number: 1,
          download_url: "/documents/mock-document/download",
          resource: "document",
        }],
        terminal: true,
        evidence: [],
      }),
    );
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const mutation = {
        id: "create-doc",
        name: "Write",
        input: { kind: "docx", filename: "Draft.docx", content: "# Draft" },
      };
      params.callbacks?.onToolCallStart?.(mutation);
      expect(await params.runTools?.([mutation])).toEqual([{
        tool_use_id: mutation.id,
        content: JSON.stringify({
          ok: true,
          artifact: "draft-1",
          filename: "Draft.docx",
        }),
        terminal: true,
      }]);
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
        (await storedChat(loaded.store, created.body.id))?.messages,
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
          responses: [
            {
              id: "forum",
              kind: "choice",
              answer: "Ontario",
            },
          ],
        },
      });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/no assistant question/iu);
    expect(mocks.streamChatWithTools).not.toHaveBeenCalled();
    expect(
      (await storedChat(loaded.store, created.body.id))
        ?.transcript_version,
    ).toBe(0);
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
        (await storedChat(loaded.store, created.body.id))?.messages,
      ),
    ).toContain("Recovered answer.");
    expect(calls[1]).toMatchObject({
      providerSession: { persist: true, continuationId: firstThread },
      messages: [{ role: "user", content: "Second turn." }],
    });
    expect(calls[2].providerSession).toMatchObject({ persist: true });
    expect(calls[2].messages).toEqual([
      { role: "user", content: "First turn." },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second turn." },
    ]);
    const sessions = await import("../lib/providerSessionStore");
    expect(
      sessions.readProviderSession(USER_ID, created.body.id),
    ).toMatchObject({
      continuation_id: replacementThread,
      transcript_version: 4,
    });
  });
});
