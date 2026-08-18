import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatApplicationError,
  type ChatApplication,
} from "../../lib/chat/chatApplication";
import type { ChatStore } from "../../lib/chatStore";
import type { TabularStore } from "../../lib/tabularStore";
import { createChatRouter } from "../../routes/chat";

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "u1";
    res.locals.userEmail = "u1@test.local";
    next();
  },
}));

const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
let projectAllowed = true;
let failStream = false;

const application = {
  async turn(_auth, _input, sink) {
    if (!projectAllowed) throw new ChatApplicationError(404, "Project not found");
    if (!sink.claim(CHAT_ID)) throw new ChatApplicationError(409, "A response is running");
    sink.start();
    sink.emit({ type: "chat_id", chatId: CHAT_ID, transcriptVersion: 1 });
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
app.use("/chat", createChatRouter(
  {} as TabularStore,
  {} as ChatStore,
  application,
));
const VALID_BODY = {
  project_id: PROJECT_ID,
  expected_version: 0,
  current_turn: { kind: "message", content: "hello" },
};

describe("POST /chat with a project capability", () => {
  beforeEach(() => {
    projectAllowed = true;
    failStream = false;
  });

  it("reveals no project when application access is denied", async () => {
    projectAllowed = false;
    const res = await request(app).post("/chat").send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Project not found");
  });

  it("streams SSE on the happy path", async () => {
    const res = await request(app).post("/chat").send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"type":"chat_id"');
  });

  it("keeps a post-header failure in the stream", async () => {
    failStream = true;
    const res = await request(app).post("/chat").send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
    expect(res.text.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });
});
