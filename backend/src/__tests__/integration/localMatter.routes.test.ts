import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import request from "supertest";
import * as XLSX from "xlsx";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  supabaseCalls: 0,
  toolResults: [] as string[],
  modelInputs: [] as {
    systemPrompt: string;
    messages: { role: string; content: string }[];
  }[],
  streamChatWithTools: vi.fn(),
}));

vi.mock("../../lib/localMode", () => ({
  isLocalRuntime: () => true,
}));

vi.mock("../../lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/supabase")>()),
  createServerSupabase: () => {
    mocks.supabaseCalls += 1;
    throw new Error("Supabase must not be used in account-free matter routes");
  },
}));

vi.mock("../../lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/llm")>()),
  streamChatWithTools: mocks.streamChatWithTools,
}));

let dataHome: string;
let closeLocalStores: (() => Promise<void>) | null = null;

function pageDocuments(body: {
  items?: { kind: string; document?: { id: string; filename: string } }[];
}) {
  return (body.items ?? []).flatMap((item) =>
    item.kind === "document" && item.document ? [item.document] : [],
  );
}

function streamedContent(body: string) {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; text?: string })
    .filter((event) => event.type === "content_delta")
    .map((event) => event.text ?? "")
    .join("");
}

function spreadsheetBytes(value: string) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([[value]]),
    "Sheet1",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function loadApi() {
  vi.resetModules();
  const { api } = await import("../../api");
  closeLocalStores = async () => {
    (await import("../../lib/sqliteDatabase")).closeSqliteDatabase();
  };
  return api;
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-matter-routes-"));
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
  vi.stubEnv(
    "MIKE_LOCAL_DATA_DIR",
    path.join(dataHome, "apps", "mike", "library"),
  );
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SECRET_KEY", "");
  mocks.supabaseCalls = 0;
  mocks.toolResults.length = 0;
  mocks.modelInputs.length = 0;
  mocks.streamChatWithTools.mockReset();
  mocks.streamChatWithTools.mockImplementation(async (params) => {
    mocks.modelInputs.push({
      systemPrompt: params.systemPrompt,
      messages: params.messages,
    });
    const toolResults = await params.runTools?.([
      { id: "list-documents", name: "Glob", input: { pattern: "*" } },
    ]);
    if (toolResults?.[0]) mocks.toolResults.push(toolResults[0].content);
    params.callbacks?.onContentDelta?.("Scoped answer");
    return { fullText: "Scoped answer" };
  });
});

afterEach(async () => {
  await closeLocalStores?.();
  closeLocalStores = null;
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("account-free matter routes", () => {
  it("passes the client-work-product presumption to the provider", async () => {
    const api = await loadApi();
    const streamed = await request(api).post("/chat").send({
      expected_version: 0,
      current_turn: { kind: "message", content: "Draft an agreement." },
    });

    expect(streamed.status).toBe(200);
    expect(mocks.modelInputs[0].systemPrompt).toContain(
      "Presume legal work product is for a client or matter, not for the user personally, unless the user clearly says otherwise.",
    );
  });

  it("moves a Library document into one matter and isolates matter chat", async () => {
    let api = await loadApi();
    const firstMatter = await request(api)
      .post("/projects")
      .send({ name: "Appeal", cm_number: "CA-42", practice: "Litigation" });
    const secondMatter = await request(api)
      .post("/projects")
      .send({ name: "Separate matter" });
    expect(firstMatter.status).toBe(201);
    expect(firstMatter.body).toMatchObject({
      name: "Appeal",
      cm_number: "CA-42",
      practice: "Litigation",
      shared_with: [],
      owner_email: null,
    });
    expect(secondMatter.status).toBe(201);

    const source = await request(api)
      .post("/library/files/documents")
      .attach("file", spreadsheetBytes("record"), "appeal-record.xlsx");
    const unrelated = await request(api)
      .post("/library/files/documents")
      .attach("file", spreadsheetBytes("other"), "unrelated.xlsx");
    expect(source.status).toBe(201);
    expect(unrelated.status).toBe(201);

    const attached = await request(api).post(
      `/projects/${firstMatter.body.id}/documents/${source.body.id}`,
    );
    expect(attached.status).toBe(200);
    expect(attached.body.id).toBe(source.body.id);

    const library = await request(api).get("/library/files");
    expect(pageDocuments(library.body).map((row) => row.id)).toEqual([
      unrelated.body.id,
    ]);

    const firstDetail = await request(api).get(
      `/projects/${firstMatter.body.id}`,
    );
    const secondDetail = await request(api).get(
      `/projects/${secondMatter.body.id}`,
    );
    expect(firstDetail.body).not.toHaveProperty("documents");
    expect(secondDetail.body).not.toHaveProperty("documents");
    expect(pageDocuments((await request(api).get(
      `/projects/${firstMatter.body.id}/directory`,
    )).body).map((document) => document.id)).toEqual([source.body.id]);
    expect(pageDocuments((await request(api).get(
      `/projects/${secondMatter.body.id}/directory`,
    )).body)).toEqual([]);

    const createdChat = await request(api)
      .post("/chat/create")
      .send({ project_id: firstMatter.body.id });
    expect(createdChat.status).toBe(200);

    const assistantHistory = await request(api).get("/chat");
    expect(assistantHistory.body).toEqual([]);

    const streamed = await request(api)
      .post("/chat")
      .send({
        project_id: firstMatter.body.id,
        chat_id: createdChat.body.id,
        expected_version: 0,
        current_turn: { kind: "message", content: "Read this matter." },
      });
    expect(streamed.status).toBe(200);
    expect(streamedContent(streamed.text)).toBe("Scoped answer");
    expect(mocks.toolResults.at(-1)).toContain("appeal-record.xlsx");
    expect(mocks.toolResults.at(-1)).not.toContain("unrelated.xlsx");
    const matterHistory = await request(api).get(
      `/projects/${firstMatter.body.id}/chats`,
    );
    expect(matterHistory.body).toHaveLength(1);
    expect(matterHistory.body[0].id).toBe(createdChat.body.id);

    const missingFocus = await request(api)
      .post("/chat")
      .send({
        project_id: firstMatter.body.id,
        chat_id: createdChat.body.id,
        expected_version: 2,
        current_turn: {
          kind: "message",
          content: "Use the unrelated file.",
        },
        attached_documents: [
          { filename: "missing.xlsx", document_id: randomUUID() },
        ],
      });
    expect(missingFocus.status).toBe(400);
    expect(missingFocus.body.detail).toMatch(/unavailable/u);

    const [{ createChatStore }, { sqliteChatRepository }, { generateChatTitle }] = await Promise.all([
      import("../../lib/chatStore"),
      import("../../lib/sqliteChatRepository"),
      import("../../lib/chatTitle"),
    ]);
    const chatStore = createChatStore(
      sqliteChatRepository, generateChatTitle,
      { project: async () => false, review: async () => false },
    );
    const user = { userId: "00000000-0000-0000-0000-000000000001" };
    const messages = (await chatStore.transcript(user, createdChat.body.id))!;
    const assistant = [...messages].reverse().find(
      (message) => message.role === "assistant",
    )!;
    await chatStore.commitTurn(user, createdChat.body.id, {
      expectedVersion: 2,
      assistantMessage: {
        id: assistant.id,
        content: [
          ...(Array.isArray(assistant.content) ? assistant.content : []),
        {
          type: "ask_inputs",
          items: [
            {
              id: "documents",
              kind: "documents",
              document_types: ["Record"],
            },
          ],
        },
        ],
      },
    });

    const continued = await request(api)
      .post("/chat")
      .send({
        project_id: firstMatter.body.id,
        chat_id: createdChat.body.id,
        expected_version: 3,
        current_turn: {
          kind: "ask_inputs_response",
          content: "Continue with my selections.",
          files: [
            {
              filename: "spoofed-current-turn-name.xlsx",
              document_id: source.body.id,
            },
          ],
          responses: [
            {
              id: "documents",
              kind: "documents",
              filenames: ["appeal-record.xlsx"],
              documents: [
                {
                  document_id: source.body.id,
                  filename: "spoofed-response-name.xlsx",
                },
              ],
            },
          ],
        },
        displayed_doc: {
          filename: "spoofed-display-name.xlsx",
          document_id: source.body.id,
        },
        attached_documents: [
          {
            filename: "spoofed-attachment-name.xlsx",
            document_id: source.body.id,
          },
        ],
      });
    expect(continued.status).toBe(200);
    const focusedInput = mocks.modelInputs.at(-1)!;
    expect(focusedInput.systemPrompt).toContain(
      'Displayed document: "appeal-record.xlsx"',
    );
    expect(focusedInput.systemPrompt).toContain(
      'User-attached documents for this turn:\n- "appeal-record.xlsx"',
    );
    expect(focusedInput.systemPrompt).not.toContain("spoofed");
    const lastContent = focusedInput.messages.at(-1)?.content ?? "";
    expect(lastContent).toContain(
      "[The user attached the following document(s) to this message:\n" +
        "- doc-0: appeal-record.xlsx]",
    );
    expect(lastContent).toContain(
      "[User responses to requested inputs]\n" +
        "- Documents requested for Record: appeal-record.xlsx",
    );
    expect(`${focusedInput.systemPrompt}\n${lastContent}`).not.toContain(source.body.id);
    // Attachments are announced, not preloaded: the manifest above names the
    // document; its text stays behind the Library tools.
    expect(lastContent).not.toContain("full text:");

    const continuedChat = await request(api).get(
      `/chat/${createdChat.body.id}`,
    );
    expect(
      continuedChat.body.messages.map((row: { role: string }) => row.role),
    ).toEqual(["user", "assistant"]);
    expect(
      continuedChat.body.messages[1].content.map(
        (event: { type: string }) => event.type,
      ),
    ).toEqual([
      "content",
      "ask_inputs",
      "ask_inputs_response",
      "content",
    ]);

    const wrongMatter = await request(api)
      .post("/chat")
      .send({
        project_id: secondMatter.body.id,
        chat_id: createdChat.body.id,
        expected_version: 5,
        current_turn: { kind: "message", content: "Cross the boundary." },
      });
    expect(wrongMatter.status).toBe(400);
    expect(wrongMatter.body.detail).toMatch(/does not match/u);

    const malformed = await request(api)
      .post("/chat")
      .send({
        project_id: firstMatter.body.id,
        expected_version: 5,
        current_turn: { kind: "message", content: 7 },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.detail).toEqual(expect.any(String));

    await closeLocalStores?.();
    closeLocalStores = null;
    api = await loadApi();

    const reloadedMatter = await request(api).get(
      `/projects/${firstMatter.body.id}`,
    );
    const reloadedChat = await request(api).get(
      `/chat/${createdChat.body.id}`,
    );
    expect(reloadedMatter.body).not.toHaveProperty("documents");
    expect(pageDocuments((await request(api).get(
      `/projects/${firstMatter.body.id}/directory`,
    )).body)[0].id).toBe(source.body.id);
    expect(reloadedChat.body.chat.project_id).toBe(firstMatter.body.id);
    expect(
      reloadedChat.body.messages.map((row: { role: string }) => row.role),
    ).toEqual(["user", "assistant"]);

    const deletedThroughKnowledge = await request(api).delete(
      `/projects/${firstMatter.body.id}`,
    );
    const orphanedChat = await request(api).get(`/chat/${createdChat.body.id}`);
    expect(deletedThroughKnowledge.status).toBe(204);
    expect(orphanedChat.status).toBe(404);
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("uses explicit chat documents without changing matter membership", async () => {
    let api = await loadApi();
    const matter = await request(api)
      .post("/projects")
      .send({ name: "Appeal" });
    const source = await request(api)
      .post("/library/files/documents")
      .attach("file", Buffer.from("record"), "appeal-record.xlsx");
    const store = await import("../../lib/__tests__/support/localDocumentFixtures");
    const foreign = await store.createLocalDocument({
      userId: "00000000-0000-0000-0000-000000000099",
      kind: "file",
      filename: "foreign.docx",
      bytes: Buffer.from("foreign"),
    });
    const chat = await request(api)
      .post("/chat/create")
      .send({ project_id: matter.body.id });
    const turn = (expectedVersion: number) =>
      request(api)
        .post("/chat")
        .send({
          project_id: matter.body.id,
          chat_id: chat.body.id,
          expected_version: expectedVersion,
          current_turn: {
            kind: "message",
            content: "Use this document.",
            files: [
              {
                filename: source.body.filename,
                document_id: source.body.id,
              },
            ],
          },
          attached_documents: [
            {
              filename: source.body.filename,
              document_id: source.body.id,
            },
          ],
        });

    expect((await turn(0)).status).toBe(200);
    expect((await turn(2)).status).toBe(200);
    expect(pageDocuments((await request(api).get(
      `/projects/${matter.body.id}/directory`,
    )).body)).toEqual([]);

    const rejected = await request(api)
      .post("/chat")
      .send({
        project_id: matter.body.id,
        chat_id: chat.body.id,
        expected_version: 4,
        current_turn: {
          kind: "message",
          content: "Use another user's document.",
          files: [
            {
              filename: foreign.filename,
              document_id: foreign.id,
            },
          ],
        },
      });
    expect(rejected.status).toBe(400);
    expect(rejected.body.detail).toMatch(/unavailable/u);

    await closeLocalStores?.();
    closeLocalStores = null;
    api = await loadApi();
    expect(pageDocuments((await request(api).get(
      `/projects/${matter.body.id}/directory`,
    )).body)).toEqual([]);
  });

  it("returns 400 for malformed local project fields", async () => {
    const api = await loadApi();
    for (const payload of [
      { name: 7 },
      { name: "x".repeat(121) },
      { name: "Appeal", cm_number: 7 },
      { name: "Appeal", practice: [] },
    ]) {
      const response = await request(api).post("/projects").send(payload);
      expect(response.status).toBe(400);
    }
    expect((await request(api).get("/projects")).body).toEqual({
      items: [],
      next_cursor: null,
    });
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("detaches a document from one matter without deleting the Library file", async () => {
    const api = await loadApi();
    const firstMatter = await request(api)
      .post("/projects")
      .send({ name: "Appeal" });
    const secondMatter = await request(api)
      .post("/projects")
      .send({ name: "Separate matter" });
    const source = await request(api)
      .post("/library/files/documents")
      .attach("file", Buffer.from("record"), "appeal-record.xlsx");

    expect(
      (
        await request(api).post(
          `/projects/${firstMatter.body.id}/documents/${source.body.id}`,
        )
      ).status,
    ).toBe(200);
    const copied = await request(api).post(
      `/projects/${secondMatter.body.id}/documents/${source.body.id}`,
    );
    expect(copied.status).toBe(201);
    expect(copied.body.id).not.toBe(source.body.id);

    const detached = await request(api).delete(
      `/projects/${firstMatter.body.id}/documents/${source.body.id}`,
    );

    expect(detached.status).toBe(204);
    expect(pageDocuments((await request(api).get(
      `/projects/${firstMatter.body.id}/directory`,
    )).body)).toEqual([]);
    expect(pageDocuments((await request(api).get(
      `/projects/${secondMatter.body.id}/directory`,
    )).body).map((row) => row.id)).toEqual([copied.body.id]);
    expect(pageDocuments((await request(api).get("/library/files")).body)
      .map((row) => row.id)).toEqual([source.body.id]);
    expect(
      (
        await request(api).delete(
          `/projects/${firstMatter.body.id}/documents/${source.body.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(api).delete(
          `/projects/${randomUUID()}/documents/${source.body.id}`,
        )
      ).status,
    ).toBe(404);
    expect(mocks.supabaseCalls).toBe(0);
  });

  it("bulk-deletes local chats, projects, and reviews through the shared applications", async () => {
    const api = await loadApi();
    expect((await request(api).post("/chat/create").send({})).status).toBe(200);
    expect((await request(api).post("/projects").send({ name: "Appeal" })).status).toBe(201);
    expect((await request(api).post("/tabular-review").send({
      title: "Review", document_ids: [], columns_config: [],
    })).status).toBe(201);

    expect((await request(api).delete("/user/chats")).status).toBe(204);
    expect((await request(api).delete("/user/tabular-reviews")).status).toBe(204);
    expect((await request(api).delete("/user/projects")).status).toBe(204);

    expect((await request(api).get("/chat")).body).toEqual([]);
    expect((await request(api).get("/projects")).body.items).toEqual([]);
    expect((await request(api).get("/tabular-review")).body.items).toEqual([]);
  });

});
