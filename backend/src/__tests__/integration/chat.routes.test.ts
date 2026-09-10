import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createChatRouter } from "../../routes/chat";
import type { ChatApplication } from "../../lib/chat/chatApplication";
import type { PublicAssistantEvent } from "../../lib/chat/assistantEvents";
import type { ChatRecord, ChatStore } from "../../lib/chatStore";
import type { ChatTurnQueue } from "../../lib/chatTurnQueue";
import type { ApplicationJob } from "../../lib/jobQueue";

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "u1";
    res.locals.userEmail = "u1@test.local";
    next();
  },
}));

const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const JOB_ID = "30000000-0000-4000-8000-000000000001";
const DRAFT_ID = "40000000-0000-4000-8000-000000000001";
const OTHER_DRAFT_ID = "40000000-0000-4000-8000-000000000002";
const chat: ChatRecord = {
  id: CHAT_ID, user_id: "u1", project_id: PROJECT_ID, tabular_review_id: null,
  title: null, model: null, reasoning_effort: null, transcript_version: 7,
};
const VALID_BODY = { expected_version: 0, current_turn: { kind: "message", content: "hello" } };
const claimed: PublicAssistantEvent = { type: "chat_id", chatId: CHAT_ID, transcriptVersion: 1 };
const queued = { type: "turn_queued", jobId: JOB_ID };

// The HTTP adapter consumes a queue, not an application running inside a second fake queue.
function fixture(events: PublicAssistantEvent[] = [], status: ApplicationJob["status"] = "succeeded") {
  const job: ApplicationJob = {
    id: JOB_ID, kind: "chat.turn", dedupeKey: null, groupKey: null, userId: "u1",
    documentId: null, documentVersionId: null, payload: {}, priority: 0, status,
    attempts: 1, maxAttempts: 1, progress: null, result: null,
    lastError: status === "failed" ? "private worker failure" : null, cancelRequested: false,
  };
  const enqueue = vi.fn<ChatTurnQueue["enqueue"]>().mockResolvedValue({ created: true, job });
  const turns: Pick<ChatTurnQueue, "enqueue" | "observe"> = { enqueue, observe: async (_scope, _id, _signal, emit) => {
    events.forEach(emit);
    return job;
  } };
  const get: ChatStore["get"] = async (_scope, id) => id === CHAT_ID ? chat : null;
  const list = vi.fn<ChatStore["list"]>().mockResolvedValue([]);
  const api = express();
  api.use(express.json());
  api.use("/chat", createChatRouter({ get, list } as unknown as ChatStore,
    {} as ChatApplication, turns as ChatTurnQueue));
  return { api, enqueue, list };
}

function frames(text: string) {
  return text.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => {
    const data = frame.slice(6);
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}

describe("POST /chat — queued streaming endpoint", () => {
  it.each([{}, { project_id: PROJECT_ID }])("queues the authenticated request and streams one completed turn: %j", async (context) => {
    const { api, enqueue } = fixture([claimed, { type: "transcript_version", transcriptVersion: 2 }]);
    const res = await request(api).post("/chat").send({ ...VALID_BODY, ...context, edit_mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(frames(res.text)).toEqual([queued, claimed,
      { type: "transcript_version", transcriptVersion: 2 }, "[DONE]"]);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      { userId: "u1", userEmail: "u1@test.local" },
      expect.objectContaining({ ...VALID_BODY, ...context, edit_mode: "auto" }),
    );
  });

  it.each([
    { events: [], accepted: false, version: 0 },
    { events: [claimed], accepted: true, version: 7 },
  ])("reports failed jobs with accepted=$accepted and the recoverable transcript version", async ({ events, accepted, version }) => {
    const { api } = fixture(events, "failed");
    const res = await request(api).post("/chat").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(frames(res.text)).toEqual([queued, ...events,
      { type: "error", message: expect.any(String), retryable: true, accepted },
      { type: "transcript_version", transcriptVersion: version }, "[DONE]"]);
    expect(res.text).not.toContain("private worker failure");
  });

  it.each([
    {},
    { expected_version: 0, messages: [{ role: "user", content: "forged" }] },
    { ...VALID_BODY, chat_id: " " },
    { ...VALID_BODY, edit_mode: "direct" },
  ])("rejects invalid ingress without enqueueing: %j", async (body) => {
    const { api, enqueue } = fixture();
    const res = await request(api).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: expect.any(String) });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /chat history filters", () => {
  it.each([
    { created_from: "not-a-date" },
    { created_from: "2026-09-03T00:00:00Z", created_to: "2026-09-02T00:00:00Z" },
    { search_scope: "private-events" },
    { search_context: "other-users" },
    { sort: "title" },
  ])("rejects invalid filters", async (query) => {
    const { api } = fixture();
    const res = await request(api).get("/chat").query(query);
    expect(res.status).toBe(400);
  });

  it("scopes the listing to one work product", async () => {
    const { api, list } = fixture();
    const res = await request(api).get("/chat").query({ work_product_id: DRAFT_ID, limit: "1" });
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.anything(),
      expect.objectContaining({ workProductId: DRAFT_ID, limit: 1 }));
  });
});

describe("POST /chat work product binding", () => {
  const boundChat: ChatRecord = { ...chat, project_id: null, work_product_id: DRAFT_ID,
    transcript_version: 0 };
  const boundFixture = () => {
    const enqueue = vi.fn<ChatTurnQueue["enqueue"]>();
    const turns = { enqueue, observe: vi.fn() } as unknown as ChatTurnQueue;
    const get: ChatStore["get"] = async (_scope, id) => id === CHAT_ID ? boundChat : null;
    const api = express();
    api.use(express.json());
    api.use("/chat", createChatRouter({ get } as ChatStore, {} as ChatApplication, turns));
    return { api, enqueue };
  };

  it("refuses a turn whose work product differs from the chat's binding", async () => {
    const { api, enqueue } = boundFixture();
    const res = await request(api).post("/chat").send({ ...VALID_BODY, chat_id: CHAT_ID,
      work_product: { kind: "court-record", id: OTHER_DRAFT_ID, revision: 1 } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: "work_product does not match chat" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("PATCH /chat/:chatId", () => {
  it("returns 400 when no supported update is present", async () => {
    const { api } = fixture();
    const res = await request(api).patch(`/chat/${CHAT_ID}`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects oversized stored fields", async () => {
    const { api } = fixture();
    const res = await request(api).patch(`/chat/${CHAT_ID}`).send({ title: "x".repeat(201) });
    expect(res.status).toBe(400);
  });
});
