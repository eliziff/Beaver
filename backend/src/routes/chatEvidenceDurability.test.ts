import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipDocumentBytes } from "../lib/__tests__/support/documentBytes";
import type { ChatStore } from "../lib/chatStore";

const pendingMemory: Promise<void>[] = [];
const mocks = vi.hoisted(() => ({
  matterDocuments: undefined as string[] | undefined,
  preflightFailure: false,
  providerMessages: [] as { role: string; content: string }[][],
  queryIds: [] as string[][],
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
vi.mock("../lib/codexCatalog", () => ({
  getCodexModelCatalog: async () => ({
    source: "live",
    models: [{
      slug: "gpt-5.6-luna", displayName: "Luna",
      supportedReasoningLevels: [{ effort: "low" }],
    }],
  }),
}));
vi.mock("../lib/chat/assistantTools", () => ({
  assistantTools: (runtime: {
    userId: string;
    scope: "main" | "reader";
    artifactFor(documentId: string, versionId: string): string;
    onMutationCommitted(): void;
    legalEvidence?: { queries: Map<string, unknown> };
  }) => {
    if (runtime.scope === "main")
      mocks.queryIds.push([...(runtime.legalEvidence?.queries.keys() ?? [])]);
    return [
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
    }));
  },
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
    { providerSessionFeatures },
    { inlineChatTurnQueue },
    { localDocuments, localLibraryStore, localProjects },
  ] = await Promise.all([
    import("./chat"),
    import("../lib/relationalTabularRepository"),
    import("../lib/chatStore"),
    import("../lib/relationalChatRepository"),
    import("../lib/chatTitle"),
    import("../lib/chat/chatApplication"),
    import("../lib/providerSessionFeatures"),
    import("../lib/__tests__/support/inlineChatTurnQueue"),
    import("../lib/__tests__/support/localDocumentFixtures"),
  ]);
  const chats = createChatStore(
    chatRepository, generateChatTitle, {
      project: async (scope, id) => !!await localProjects.get(scope, id),
      review: async () => false,
      research: async (scope, id) => !!await (await import("../lib/researchFile"))
        .readResearchFile(localDocuments, scope, id),
    },
  );
  const documents = mocks.preflightFailure
    ? { ...localDocuments, versions: async () => {
        throw new Error("Injected document preflight failure");
      } }
    : localDocuments;
  const { createSourceWorkspaceApplication } = await import("../lib/sourceWorkspaceApplication"),
    { createSourceWorkspacesRouter } = await import("./sourceWorkspaces"),
    sources = createSourceWorkspaceApplication(documents, { chats, tables: tabularRepository,
      tabular: async () => { throw new Error("Table operations are not part of this chat fixture"); } });
  const memory = (await import("../lib/memoryApplication")).createMemoryApplication(
    await (await import("../lib/relationalDatabase")).relationalDatabase(), async () => { throw new Error("Curation is asynchronous"); });
  const application = createChatApplication({
    chats, sources,
    documents,
    library: localLibraryStore,
    projects: localProjects,
    tabular: tabularRepository,
    features: {
      load: async () => ({ includeResearchTools: true }),
      ...providerSessionFeatures,
      memory: { capture: (...args) => memory.capture(...args), complete: (...args) => {
        pendingMemory.push(memory.complete(...args));
      } },
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/source-workspaces", createSourceWorkspacesRouter(sources));
  app.use("/chat", createChatRouter(
    chats,
    application,
    inlineChatTurnQueue(application),
  ));
  return { app, store: chats, projects: localProjects, documents, memory };
}

function postMessage(app: express.Express, chatId: string, expectedVersion: number, content: string) {
  return request(app).post("/chat").send({
    chat_id: chatId,
    expected_version: expectedVersion,
    current_turn: { kind: "message", content },
  });
}

function rejectWhenAborted({ abortSignal }: { abortSignal?: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    abortSignal?.addEventListener("abort", () => {
      const error = new Error("Stream aborted.");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
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
  mocks.queryIds.length = 0;
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
  await Promise.all(pendingMemory.splice(0));
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

  it("promotes chat receipts as a working revision, not an assistant version", async () => {
    const { createLegalEvidenceTurnState, legalEvidenceReceiptEvent,
      registerLegalResearchQueries } = await import("../lib/chat/legalEvidence");
    const { createResearchFileState, pageResearchItems, readResearchFile,
      researchFileMarkdown } = await import("../lib/researchFile");
    const evidence = createLegalEvidenceTurnState();
    registerLegalResearchQueries(evidence, [{ call_id: "search", tool: "search_sources",
      executed_at: "2026-09-01T00:00:00.000Z", executor_version: "legal-source-search-v1",
      input: { query: "fairness" }, results: [{ rank: 1,
        resource: "source://a2aj/%5B%222026%20SCC%201%22%2C%22cases%22%2C%22scc%22%5D" }] }],
    "test-model");
    const loaded = await loadApp(), chat = await request(loaded.app).post("/chat/create").send({}),
      event = legalEvidenceReceiptEvent(evidence)!, workspace = await loaded.documents.create(
        { userId: USER_ID }, { filename: "Fairness.research.md", fileType: "md",
          bytes: Buffer.from(researchFileMarkdown("Fairness", createResearchFileState())) });
    await loaded.store.commitTurn({ userId: USER_ID }, chat.body.id, { expectedVersion: 0,
      assistantMessage: { id: crypto.randomUUID(), content: [event] } });
    const response = await request(loaded.app)
      .post(`/source-workspaces/${workspace.id}/bind`).send({ chatId: chat.body.id });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ versionId: workspace.current_version_id,
      workingRevision: 1 });
    expect((await loaded.documents.versions({ userId: USER_ID }, workspace.id))?.versions)
      .toHaveLength(1);
    const saved = (await readResearchFile(loaded.documents,
      { userId: USER_ID }, workspace.id))!;
    expect(saved.state.queries?.count).toBe(1);
    expect(saved.state.chats).toEqual([chat.body.id]);
    expect((await loaded.store.get({ userId: USER_ID }, chat.body.id))?.research_file_id).toBe(workspace.id);
    expect((await pageResearchItems(loaded.documents, { userId: USER_ID }, saved,
      "queries")).items).toHaveLength(1);
  });

  it("makes prior chat query receipts available to next-turn tools without re-emitting them", async () => {
    const { createLegalEvidenceTurnState, legalEvidenceReceiptEvent,
      registerLegalResearchQueries } = await import("../lib/chat/legalEvidence");
    const evidence = createLegalEvidenceTurnState();
    registerLegalResearchQueries(evidence, [{ call_id: "prior-search", tool: "search_sources",
      executed_at: "2026-09-01T00:00:00.000Z", executor_version: "legal-source-search-v1",
      input: { query: "standard of review" }, results: [{ rank: 1,
        resource: "source://a2aj/%5B%222019%20SCC%2065%22%2C%22cases%22%2C%22scc%22%5D" }] }],
    "test-model");
    const event = legalEvidenceReceiptEvent(evidence)!, queryId = event.queries[0].query_id;
    const loaded = await loadApp(), created = await request(loaded.app).post("/chat/create").send({});
    await loaded.store.commitTurn({ userId: USER_ID }, created.body.id, { expectedVersion: 0,
      assistantMessage: { id: crypto.randomUUID(), content: [event] } });

    const response = await postMessage(loaded.app, created.body.id, 1, "Save that search.");

    expect(response.status).toBe(200);
    expect(mocks.queryIds.at(-1)).toContain(queryId);
    const durable = await storedChat(loaded.store, created.body.id), latest =
      durable?.messages.filter(({ role }) => role === "assistant").at(-1);
    expect((latest?.content as Array<{ type?: string }>).some(({ type }) =>
      type === "legal_evidence_receipt")).toBe(false);
  });

  it("keeps only the latest durable snapshot for each reading agent", async () => {
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      if (params.providerSession) return { fullText: "Reader result." };
      await params.runTools?.([{
        id: "load-readers", name: "load_tools",
        input: { names: ["delegate_read"] },
      }]);
      await params.runTools?.([{
        id: "round", name: "delegate_read", input: { assignments: [
          { task: "Read note A", scope: "note A", jurisdiction: "CA" },
          { task: "Read note B", scope: "note B", jurisdiction: "CA" },
        ] },
      }]);
      return { fullText: "Done." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});

    expect((await request(loaded.app).post("/chat").send({
      chat_id: created.body.id,
      expected_version: 0,
      subagents: true,
      subagent_model: "gpt-5.6-luna",
      subagent_effort: "low",
      current_turn: { kind: "message", content: "Compare two notes." },
    })).status).toBe(200);
    const events = (await storedChat(loaded.store, created.body.id))!
      .messages[1].content as Record<string, unknown>[];

    const readers = events.filter(({ type }) => type === "subagent_run");
    expect(readers.map(({ id }) => id)).toEqual(["round:1", "round:2"]);
    expect(readers.every(({ status }) => status !== "running")).toBe(true);
  });

  it("omits empty chats from history without invalidating their direct route", async () => {
    const loaded = await loadApp();
    const empty = await request(loaded.app).post("/chat/create").send({});
    const used = await request(loaded.app).post("/chat/create").send({});
    expect((await postMessage(loaded.app, used.body.id, 0, "Hello")).status).toBe(200);

    const history = await request(loaded.app).get("/chat");
    expect(history.body.map(({ id }: { id: string }) => id)).toEqual([used.body.id]);
    expect((await request(loaded.app).get(`/chat/${empty.body.id}`)).status).toBe(200);
  });

  it("restores prior evidence once without replaying it through model history", async () => {
    const { createTnaEvidence } = await import("../lib/chat/legalEvidence");
    const evidence = createTnaEvidence({
      jurisdiction: "CA",
      sourceClass: "case",
      stableSourceId: "case:retained",
      sourceText: "The retained passage answers the question.",
      spanText: "The retained passage answers the question.",
      citation: "2026 SCC 1",
      name: "Example v State",
      dataset: "fixture",
      externalUrl: "https://example.test/case",
      locatorKind: "paragraph",
      locatorLabel: "par12",
    });
    mocks.runLocalAssistantTool.mockImplementation(
      async (_userId: unknown, call: { id: string }) => ({
        result: { tool_use_id: call.id, content: JSON.stringify({ ok: true }) },
        mutated: false,
        events: [],
        terminal: false,
        evidence: [evidence],
      }),
    );
    let turn = 0;
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      mocks.systemPrompts.push(params.systemPrompt);
      mocks.providerMessages.push(
        (await import("../lib/llm/sdk")).modelMessages(params.messages, params.model)
          .map(message => ({ role: message.role, content: typeof message.content === "string"
            ? message.content : JSON.stringify(message.content) })),
      );
      if (turn++ === 0) {
        await params.runTools?.([{
          id: "read-1",
          name: "Read",
          input: { file_path: "source" },
        }]);
      }
      const text = "Done.";
      params.callbacks?.onContentDelta?.(text);
      return { fullText: text };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    expect((await postMessage(loaded.app, created.body.id, 0, "Inspect this.")).status).toBe(200);
    const current = await storedChat(loaded.store, created.body.id);
    expect((await postMessage(loaded.app, created.body.id, current!.transcript_version, "Use it again.")).status).toBe(200);

    const followUp = mocks.providerMessages.at(-1)!;
    expect(mocks.systemPrompts.at(-1)).not.toContain(evidence.evidence_id);
    expect(mocks.systemPrompts[0]).toBe(mocks.systemPrompts.at(-1));
    expect(followUp.filter(({ content }) => content.includes(evidence.evidence_id))).toHaveLength(1);
    expect(followUp.at(-2)).toEqual({ role: "user", content: "Use it again." });
    expect(followUp.at(-1)?.content).toContain("[Current application context");
    expect(followUp.slice(0, mocks.providerMessages[0].length)).toEqual(mocks.providerMessages[0]);
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
    const accepted = await postMessage(loaded.app, created.body.id, 0, "Accepted turn");
    expect(accepted.status).toBe(200);
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);

    const stale = await postMessage(loaded.app, created.body.id, 0, "Stale duplicate");
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
    const first = postMessage(loaded.app, created.body.id, 0, "Long turn")
      .then((response) => response);

    await vi.waitFor(async () => {
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
      expect(
      (await storedChat(loaded.store, created.body.id))
        ?.transcript_version,
      ).toBe(1);
    });
    const overlapping = await postMessage(loaded.app, created.body.id, 1, "Overlapping turn");
    expect(overlapping.status).toBe(409);
    expect(overlapping.body).toMatchObject({
      code: "chat_turn_in_progress",
      current_version: 1,
    });
    expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(1);
    expect(await storedChat(loaded.store, created.body.id)).toMatchObject({
      transcript_version: 1,
      messages: [{ role: "user", content: "Long turn" }, { role: "assistant",
        content: [expect.objectContaining({ type: "model_messages", id: expect.stringMatching(/^context:/) })] }],
    });
    expect((await request(loaded.app)
      .get(`/chat/${created.body.id}?after_version=1`)).status).toBe(204);
    expect((await request(loaded.app)
      .get(`/chat/${created.body.id}?after_version=0`)).body.chat)
      .toMatchObject({ transcript_version: 1, turn_in_progress: true });

    release();
    expect((await first).status).toBe(200);
  });

  it("reveals and persists one complete final response", async () => {
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

    const response = await postMessage(loaded.app, created.body.id, 0, "Draft a lease");
    const finalEvents = response.text
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as {
        type?: string; text?: string; citations?: unknown[];
      })
      .filter((event) => event.type === "content_final");

    expect(finalEvents).toEqual([{ type: "content_final", text: expected, citations: [] }]);
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
    const listener = loaded.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => listener.once("listening", resolve));
    const port = (listener.address() as AddressInfo).port;
    const controller = new AbortController();
    const clientResult = fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: created.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Keep working" },
      }),
      signal: controller.signal,
    }).then((response) => response.text()).catch(() => undefined);

    try {
      await vi.waitFor(() => {
        expect(mocks.streamChatWithTools).toHaveBeenCalledOnce();
      });
      controller.abort();
      await clientResult;
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
    } finally {
      listener.close();
    }
  });

  it("aborts an active turn only through the explicit stop endpoint", async () => {
    mocks.streamChatWithTools.mockImplementation(rejectWhenAborted);
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const activeRequest = postMessage(loaded.app, created.body.id, 0, "Stop explicitly")
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
          content: [expect.objectContaining({ type: "model_messages" }), { type: "turn_status", status: "cancelled" }],
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

    const response = await postMessage(loaded.app, created.body.id, 0, "Start the answer");

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
            expect.objectContaining({ type: "model_messages" }),
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

    await postMessage(loaded.app, created.body.id, 0, "Cancel this turn");

    expect(
      await storedChat(loaded.store, created.body.id),
    ).toMatchObject({
      transcript_version: 2,
      messages: [
        { role: "user", content: "Cancel this turn" },
        {
          role: "assistant",
          content: [
            expect.objectContaining({ type: "model_messages" }),
            { type: "content", text: "Work in progress" },
            { type: "turn_status", status: "cancelled" },
          ],
        },
      ],
    });
  });

  it("does not resurrect a chat deleted during an active turn", async () => {
    mocks.streamChatWithTools.mockImplementation(rejectWhenAborted);
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const running = postMessage(loaded.app, created.body.id, 0, "Long answer")
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
    mocks.streamChatWithTools.mockImplementation(rejectWhenAborted);
    const loaded = await loadApp();
    const created = await request(loaded.app)
      .post("/chat/create")
      .send({ project_id: PROJECT_ID });
    const running = postMessage(loaded.app, created.body.id, 0, "Long matter answer")
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

  it.each(["missing file", "missing project", "another user's project"] as const)(
    "rejects %s before creating a chat or contacting the model",
    async (kind) => {
      const { app, projects } = await loadApp();
      const privateProject = await projects.create({ userId: "other-user" }, {
        name: "Private matter", cmNumber: null, practice: null, sharedWith: [],
      });
      const project_id = {
        "missing file": undefined,
        "missing project": crypto.randomUUID(),
        "another user's project": privateProject.id,
      }[kind];
      const files = kind === "missing file" ? [{ document_id: crypto.randomUUID() }] : [];
      const response = await request(app).post("/chat").send({
        project_id, expected_version: 0,
        current_turn: { kind: "message", content: "Review this matter.", files },
      });

      expect(response.status).toBe(200);
      expect(response.text).toContain('"accepted":false');
      expect(response.text).not.toContain('"type":"chat_id"');
      expect(response.text).not.toContain("Private matter");
      expect(response.text.match(/data: \[DONE\]/gu)).toHaveLength(1);
      expect(mocks.streamChatWithTools).not.toHaveBeenCalled();
      // History omits empty chats, so inspect durable rows, not GET /chat.
      const { localDatabaseSync } = await import("../lib/relationalDatabase");
      expect(localDatabaseSync().prepare("SELECT id FROM chats").all()).toEqual([]);
    },
  );

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

    expect(failed.status).toBe(200);
    expect(failed.text).toContain('"accepted":false');
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

    const asked = await postMessage(loaded.app, created.body.id, 0, "Prepare the filing plan.");

    expect(asked.status).toBe(200);
    expect(asked.text).toContain('"type":"ask_inputs"');
    expect(asked.text).not.toContain('"type":"content_reset"');
    expect(asked.text).not.toContain('"type":"content_final"');
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
    expect(changedRetry.status).toBe(200);
    expect(changedRetry.text).toContain('"accepted":false');
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
      JSON.stringify({ type: "content_final", text: expected, citations: [] }),
    );
    const assistant = (await storedChat(loaded.store, created.body.id))!
      .messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toContainEqual({
      type: "content",
      text: expected,
    });
  });

  it("executes every mixed-batch call without treating it as terminal", async () => {
    mocks.runLocalAssistantTool.mockImplementation(async (_userId: unknown, call: { id: string; name: string }) => ({
      result: { tool_use_id: call.id, content: "New evidence." }, evidence: [],
      mutated: call.name === "Write", terminal: call.name === "Write",
      events: call.name === "Write" ? [{ type: "document_artifact", action: "created", filename: "Draft.docx",
        document_id: "mock-document", version_id: "mock-version", version_number: 1,
        download_url: "/documents/mock-document/download" }] : [],
    }));
    let results: { content: string; terminal?: boolean }[] = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      results = await params.runTools([
        { id: "read", name: "Read", input: { file_path: "source.docx" } },
        { id: "create", name: "Write", input: { filename: "Draft.docx", content: "# Draft" } },
      ]);
      params.callbacks?.onContentDelta?.("Reviewed and created.");
      return { fullText: "Reviewed and created." };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await postMessage(loaded.app, created.body.id, 0, "Read and draft.");
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('"type":"error"');
    expect(mocks.runLocalAssistantTool).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.some(result => result.terminal)).toBe(false);
    expect(results[0].content).toBe("New evidence.");
    expect(JSON.parse(results[1].content)).toMatchObject({ artifact: "draft-1", filename: "Draft.docx" });
    expect(JSON.stringify((await storedChat(loaded.store, created.body.id))?.messages)).toContain('"type":"document_artifact"');
  });

  it("persists authorized work and pauses subsequent effects for a clarification", async () => {
    mocks.runLocalAssistantTool.mockImplementation(async (_userId: unknown, call: { id: string }) => ({
      result: { tool_use_id: call.id, content: "Created the draft." }, mutated: true, terminal: true, evidence: [],
      events: [{ type: "document_artifact", action: "created", filename: "Draft.docx",
        document_id: "mock-document", version_id: "mock-version", version_number: 1,
        download_url: "/documents/mock-document/download" }],
    }));
    let results: { content: string }[] = [];
    mocks.streamChatWithTools.mockImplementation(async (params) => {
      const calls = [
        { id: "create-doc", name: "Write", input: { filename: "Draft.docx", content: "# Draft" } },
        { id: "question", name: "ask_inputs", input: { items: [{ id: "forum", kind: "choice",
          question: "Which forum?", options: [{ value: "Ontario" }] }] } },
        { id: "later-edit", name: "Edit", input: { old_text: "Draft", new_text: "Final" } },
      ];
      calls.forEach(call => params.callbacks?.onToolCallStart?.(call));
      results = await params.runTools(calls);
      return { fullText: "" };
    });
    const loaded = await loadApp();
    const created = await request(loaded.app).post("/chat/create").send({});
    const response = await postMessage(loaded.app, created.body.id, 0, "Create the draft, then ask.");
    // Assertions stay outside the provider double: an exception inside it is an ordinary application error.
    expect(response.status).toBe(200);
    expect(results.map(result => JSON.parse(result.content))).toEqual([
      expect.objectContaining({ ok: true, artifact: "draft-1", filename: "Draft.docx" }),
      { ok: true, status: "waiting_for_user" },
      expect.objectContaining({ ok: false, error: "waiting_for_user" }),
    ]);
    expect(mocks.runLocalAssistantTool).toHaveBeenCalledTimes(1);
    expect(response.text).toContain('"type":"ask_inputs"');
    expect(response.text).not.toContain('"type":"error"');
    const history = JSON.stringify((await storedChat(loaded.store, created.body.id))?.messages);
    expect(history).toContain('"type":"document_artifact"');
    expect(history).toContain('"type":"local_mutation_committed"');
    expect(history).toContain('"type":"ask_inputs"');
    expect(history).not.toContain('"type":"error"');
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

    expect(response.status).toBe(200);
    expect(response.text).toContain('"accepted":false');
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
      await sessions.readProviderSession(USER_ID, created.body.id),
    ).toMatchObject({
      continuation_id: replacementThread,
      transcript_version: 4,
    });
  });
});


it.each(["host", "native", "model-switch"])("reformats stored grounded claims without reads after %s compaction", async kind => {
  const { createLegalEvidenceTurnState, createLibraryEvidence, registerLegalEvidence,
    submitLegalEvidenceAnswer, legalEvidenceReceiptEvent } = await import("../lib/chat/legalEvidence");
  const state = createLegalEvidenceTurnState(), passage = "The response deadline is 15 days after delivery.";
  const receipt = createLibraryEvidence({ documentId: "retained", versionId: "v1", filename: "Notice.txt",
    sourceText: passage, spanText: passage, start: 0, end: passage.length });
  registerLegalEvidence(state, receipt);
  const claims = [{ text: 'The notice says “15 days”.', evidence_ids: [receipt.evidence_id] }];
  expect(submitLegalEvidenceAnswer({ claims }, state).ok).toBe(true);
  const loaded = await loadApp(), created = await request(loaded.app).post("/chat/create").send({});
  const checkpoint = kind === "host" ? { type: "context_checkpoint", schema_version: 1,
    summary: "Research completed; the user wants a table.", keep_current: false }
    : { type: "model_messages", id: "native-checkpoint", model: "gpt-5.5", compacted: true,
      messages: [{ role: "assistant", content: [{ type: "custom", kind: "openai.compaction",
        providerOptions: { openai: { itemId: "cp1", encryptedContent: "opaque" } } }] }] };
  await loaded.store.commitTurn({ userId: USER_ID }, created.body.id, { expectedVersion: 0,
    userMessage: { id: crypto.randomUUID(), content: "Read the notice." },
    assistantMessage: { id: crypto.randomUUID(), content: [legalEvidenceReceiptEvent(state)!,
      { type: "content", text: 'The notice says “15 days”. [1]' }, checkpoint] as never } });
  let previous = claims;
  mocks.streamChatWithTools.mockImplementation(async params => {
    const wire = (await import("../lib/llm/sdk")).modelMessages(params.messages, params.model);
    const offered = [params.systemPrompt, ...wire.map(message => typeof message.content === "string" ? message.content : "")]
      .flatMap(text => text.split("\n").flatMap(line => {
        try { const value = JSON.parse(line); return Array.isArray(value) ? [value] : []; }
        catch { return []; }
      }));
    expect(offered).toContainEqual(previous);
    previous = previous.map(claim => ({ ...claim, text: `| Answer |\n| --- |\n| ${claims[0].text} |` }));
    const result = await params.runTools([{ id: "format", name: "submit_grounded_answer", input: { claims: previous, replace: null } }]);
    expect(result[0].terminal).toBe(true);
    return { fullText: "" };
  });
  for (let index = 0; index < 2; index++) {
    const version = (await storedChat(loaded.store, created.body.id))!.transcript_version;
    const response = await request(loaded.app).post("/chat").send({ chat_id: created.body.id,
      expected_version: version, model: kind === "model-switch" ? "gemini-3-flash-preview" : "gpt-5.5",
      current_turn: { kind: "message", content: "Make that a table; change nothing substantive." } });
    expect(response.text).toContain('"type":"content_final"');
    expect(response.text).toContain("15 days");
  }
  expect(mocks.runLocalAssistantTool).not.toHaveBeenCalled();
  const events = (await storedChat(loaded.store, created.body.id))!.messages.at(-1)!.content as any[];
  expect(events.find(event => event.type === "legal_evidence_receipt").claims[0].evidence_ids).toEqual([receipt.evidence_id]);
});

it("keeps SDK reads and steering in causal order across a failed read-only retry", async () => {
  let attempt = 0;
  const model = "gemini-3-flash-preview", turn_id = crypto.randomUUID();
  mocks.streamChatWithTools.mockImplementation(async params => {
    if (attempt++ === 0) {
      await params.callbacks.onModelMessages({ model, messages: [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "r1", toolName: "Read", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "r1", toolName: "Read",
          output: { type: "text", value: "Already read: exact source passage" } }] },
      ] });
      params.callbacks.onSteer({ id: "steer1", text: "Use only the saved passage." });
      await params.callbacks.onModelMessages({ model, messages: [{ role: "assistant", content: "After steering" }] });
      throw new Error("Interrupted after a completed read");
    }
    const history = JSON.stringify(params.messages);
    expect(history).toContain("Already read: exact source passage");
    expect(history.indexOf("Use only the saved passage.")).toBeLessThan(history.indexOf("After steering"));
    params.callbacks.onContentDelta("Resumed without rereading.");
    return { fullText: "Resumed without rereading." };
  });
  const loaded = await loadApp(), created = await request(loaded.app).post("/chat/create").send({});
  const current_turn = { kind: "message", turn_id, content: "Read and answer." };
  await request(loaded.app).post("/chat").send({ chat_id: created.body.id, expected_version: 0, model, current_turn });
  const failed = (await storedChat(loaded.store, created.body.id))!;
  const events = failed.messages.at(-1)!.content as any[];
  expect(events.filter(event => event.type === "model_messages" && event.id.startsWith("context:"))).toHaveLength(1);
  expect(events.filter(event => ["model_messages", "steering"].includes(event.type) && !event.id?.startsWith("context:")).map(event => event.type))
    .toEqual(["model_messages", "steering", "model_messages"]);
  const retry = await request(loaded.app).post("/chat").send({ chat_id: created.body.id,
    expected_version: failed.transcript_version, model, current_turn });
  expect(retry.text).toContain("Resumed without rereading.");
  const resumed = (await storedChat(loaded.store, created.body.id))!.messages.at(-1)!.content as any[];
  expect(resumed.filter(event => event.type === "model_messages" && event.id.startsWith("context:"))).toHaveLength(1);
  expect(retry.text).not.toContain("Current application context");
  expect(mocks.runLocalAssistantTool).not.toHaveBeenCalled();
});

describe("memory turn eligibility", () => {
  it("adds low-authority memory context and learns only after successful transcript persistence", async () => {
    const { app, store, memory } = await loadApp();
    await memory.update({ userId: USER_ID }, { scope: "app", ownerId: USER_ID },
      { revision: 0, enabled: true, content: "Use Canadian spelling." });
    const created = await request(app).post("/chat/create").send({});
    const response = await postMessage(app, created.body.id, 0, "I prefer numbered paragraphs.");
    expect(response.status).toBe(200);
    await Promise.all(pendingMemory.splice(0));
    expect(mocks.providerMessages[0][0]).toMatchObject({ role: "user", content: expect.stringContaining("Canadian spelling") });
    expect(mocks.systemPrompts[0]).not.toContain("Use Canadian spelling.");
    const chat = await storedChat(store, created.body.id);
    expect(JSON.stringify(chat?.messages)).not.toContain("PERSISTED MEMORY");
    const { relationalDatabase, sql } = await import("../lib/relationalDatabase");
    const receipts = (await (await relationalDatabase()).query(sql`SELECT input_text,transcript_version FROM memory_receipts`)).rows;
    expect(receipts).toEqual([{ input_text: "I prefer numbered paragraphs.", transcript_version: chat!.transcript_version }]);
    mocks.streamChatWithTools.mockRejectedValueOnce(new Error("Provider failure"));
    await postMessage(app, created.body.id, chat!.transcript_version, "Do not learn a failed turn.");
    await Promise.all(pendingMemory.splice(0));
    expect((await (await relationalDatabase()).query(sql`SELECT id FROM memory_receipts`)).rows).toHaveLength(1);
  });
});
