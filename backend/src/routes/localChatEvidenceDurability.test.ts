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
        messages: [{ role: "user", content: "Look up the exact paragraph." }],
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
        messages: [
          {
            role: "user",
            content: "Continue from the compacted conversation.",
          },
        ],
      });

    expect(secondTurn.status).toBe(200);
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
        messages: [{ role: "user", content: "Look up this matter source." }],
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
        messages: [{ role: "user", content: "Use only current matter data." }],
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
        messages: [{ role: "user", content: "Use several exact passages." }],
      });

    const event = registryEvent(
      loaded.store.getAnonymousChat(USER_ID, created.body.id)!,
    ) as { handles: { handle: string }[] };
    expect(event.handles.map((item) => item.handle)).toEqual(
      handles.slice(-20),
    );
  });
});
