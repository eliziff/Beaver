import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantSessionState } from "./assistantSession";

vi.mock("@/app/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("removeProjectDocument", () => {
  it.each([
    [
      "anonymous",
      "http://localhost:3001/projects/matter-1/documents/document-1",
    ],
    ["required", "http://localhost:3001/single-documents/document-1"],
  ])("uses the %s removal route", async (authMode, expectedUrl) => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", authMode);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { removeProjectDocument } = await import("./beaverApi");

    await removeProjectDocument("matter-1", "document-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("apiFetch", () => {
  it("preserves native Headers values and overrides", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("./beaverApi");

    await apiFetch("/health", {
      headers: new Headers({ Accept: "text/plain", "X-Test": "kept" }),
    });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("accept")).toBe("text/plain");
    expect(headers.get("x-test")).toBe("kept");
  });
});

describe("getChat", () => {
  it("settles work left running by an interrupted backend turn", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [
        { id: "user-1", role: "user", turn_id: "turn-1", content: "Research this" },
        {
          id: "assistant-1",
          role: "assistant",
          turn_id: "turn-1",
          content: [{
            type: "subagent_run",
            id: "scout:1",
            agent: "scout",
            task: "Research",
            model: "codex",
            effort: "high",
            status: "running",
            activities: [{ id: "read-1", label: "Reading", status: "running" }],
          }],
        },
      ],
    }), { headers: { "Content-Type": "application/json" } })));
    const { getChat } = await import("./beaverApi");

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });
    const assistant = state.messages[1];

    expect(messages[0].turnId).toBe("turn-1");
    expect(assistant).toMatchObject({
      turnId: "turn-1",
      turnStatus: "interrupted",
      activities: [expect.objectContaining({
        id: "reader:scout:1",
        status: "interrupted",
      })],
    });
    expect(state.readers[0]).toMatchObject({ id: "scout:1", status: "interrupted" });
  });

  it("keeps cancellation metadata out of assistant prose", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [{
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "content", text: "Partial answer." },
          { type: "content", text: "Continued answer." },
          { type: "turn_status", status: "cancelled" },
        ],
      }],
    }), { headers: { "Content-Type": "application/json" } })));
    const { getChat } = await import("./beaverApi");

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });

    expect(state.messages[0]).toMatchObject({
      turnStatus: "cancelled",
      blocks: [
        expect.objectContaining({ text: "Partial answer." }),
        expect.objectContaining({ text: "Continued answer." }),
      ],
    });
    expect(state.messages[0].role === "assistant" ? state.messages[0].blocks.map(({ text }) => text).join("\n\n") : "").toBe("Partial answer.\n\nContinued answer.");
  });

  it("marks a durable user turn with no response as interrupted", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      chat: { id: "chat-1", turn_in_progress: false },
      messages: [{
        id: "user-1",
        role: "user",
        turn_id: "turn-1",
        content: "Research this",
      }],
    }), { headers: { "Content-Type": "application/json" } })));
    const { getChat } = await import("./beaverApi");

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });

    expect(messages[0]).toMatchObject({
      turnId: "turn-1",
    });
    expect(state.rejectedTurn?.message).toMatchObject({ turnId: "turn-1" });
  });
});
