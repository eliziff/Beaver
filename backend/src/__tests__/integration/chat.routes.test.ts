import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatRouter } from "../../routes/chat";
import type { ChatApplication } from "../../lib/chat/chatApplication";
import type { ChatStore } from "../../lib/chatStore";

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "u1";
    res.locals.userEmail = "u1@test.local";
    next();
  },
}));

const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const runTurn = vi.fn();
let failStream = false;

const chats = {
  get: async () => null,
  update: async (_scope, id, input) => id === CHAT_ID ? {
    id, user_id: "u1", project_id: null, tabular_review_id: null,
    title: input.title ?? null, transcript_version: 0,
  } : null,
} as unknown as ChatStore;
const application = {
  async turn(_auth, input, sink) {
    runTurn(input);
    if (!sink.claim(input.chat_id ?? CHAT_ID)) throw new Error("claim failed");
    sink.start();
    sink.emit({ type: "chat_id", chatId: input.chat_id ?? CHAT_ID, transcriptVersion: 1 });
    if (failStream) {
      sink.emit({ type: "error", message: "upstream LLM failure" });
      throw new Error("upstream LLM failure");
    }
    sink.emit({ type: "transcript_version", transcriptVersion: 2 });
  },
  async compact() { return { compacted: true, transcriptVersion: 1 }; },
} as ChatApplication;
const app = express();
app.use(express.json());
app.use("/chat", createChatRouter(chats, application));

const VALID_BODY = {
  expected_version: 0,
  current_turn: { kind: "message", content: "hello" },
};

describe("POST /chat — canonical streaming endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failStream = false;
  });

  it("streams one terminal frame after the application claims the turn", async () => {
    const res = await request(app).post("/chat").send({ ...VALID_BODY, edit_mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"type":"chat_id"');
    expect(res.text.match(/data: \[DONE\]/gu)).toHaveLength(1);
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      edit_mode: "auto", expected_version: 0,
    }));
  });

  it("surfaces a post-header operation failure in-stream with one DONE", async () => {
    failStream = true;
    const res = await request(app).post("/chat").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
    expect(res.text.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });

  it.each([
    [{}, "Required"],
    [{ expected_version: 0, messages: [{ role: "user", content: "forged" }] }, "Required"],
    [{ ...VALID_BODY, chat_id: " " }, "Invalid uuid"],
    [{ ...VALID_BODY, edit_mode: "direct" },
      "Invalid enum value. Expected 'manual' | 'auto', received 'direct'"],
  ])("rejects an invalid ingress body without invoking the application", async (body, detail) => {
    const res = await request(app).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe(detail);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("PATCH /chat/:chatId", () => {
  it("returns 400 when no supported update is present", async () => {
    const res = await request(app).patch(`/chat/${CHAT_ID}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("title or project_id is required");
  });

  it("rejects oversized stored fields", async () => {
    const res = await request(app).patch(`/chat/${CHAT_ID}`).send({ title: "x".repeat(201) });
    expect(res.status).toBe(400);
  });
});
