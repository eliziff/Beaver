import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantSessionState } from "./assistantSession";

vi.mock("@/app/lib/supabase", () => ({
  getSupabase: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function configure(mode: "local" | "cloud") {
  const { initializeRuntimeConfig } = await import("./runtimeConfig");
  const config = mode === "local" ? { mode, capabilities: { connectors: false } } : {
    mode,
    capabilities: { connectors: true },
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: "test-key",
  };
  await initializeRuntimeConfig(async () => new Response(JSON.stringify(config)));
}

describe("removeProjectDocument", () => {
  it.each([
    [
      "local",
      "/api/projects/matter-1/documents/document-1",
    ],
    ["cloud", "/api/single-documents/document-1"],
  ] as const)("uses the %s removal route", async (authMode, expectedUrl) => {
    await configure(authMode);
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

describe("directoryResource", () => {
  it("uses one encoded directory contract for project and library storage", async () => {
    await configure("local");
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ items: [], next_cursor: null }),
      { headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const { directoryResource } = await import("./beaverApi");

    await directoryResource({ projectId: "matter/1" }).list({ parent_id: "folder/1" });
    await directoryResource({ library: "files" }).list();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/matter%2F1/directory?parent_id=folder%2F1",
      "/api/library/files",
    ]);
  });
});

describe("apiBlobRequest", () => {
  it("preserves native Headers values and overrides", async () => {
    await configure("local");
    const fetchMock = vi.fn(async () => new Response(new Blob(["file"])));
    vi.stubGlobal("fetch", fetchMock);
    const { apiBlobRequest } = await import("./beaverApi");

    await apiBlobRequest("/health", {
      headers: new Headers({ Accept: "text/plain", "X-Test": "kept" }),
    });

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("accept")).toBe("text/plain");
    expect(headers.get("x-test")).toBe("kept");
  });

  it("preserves structured API failure details for streamed operations", async () => {
    await configure("local");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "missing_api_key",
      detail: "Configure a provider",
      provider: "openai",
    }), { status: 401 })));
    const { streamTabularGeneration } = await import("./beaverApi");

    await expect(streamTabularGeneration("review-1")).rejects.toMatchObject({
      name: "BeaverApiError",
      message: "Configure a provider",
      status: 401,
      code: "missing_api_key",
      details: { provider: "openai" },
    });
  });
});

describe("getChat", () => {
  it("keeps crafted identifiers inside their route segment", async () => {
    await configure("local");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deleteChat } = await import("./beaverApi");

    await deleteChat("../user/account?confirm=true");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/chat/..%2Fuser%2Faccount%3Fconfirm%3Dtrue",
    );
  });

  it("settles work left running by an interrupted backend turn", async () => {
    await configure("local");
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
            task: "Research",
            status: "running",
            activities: [{ id: "read-1", tool: "read", label: "Reading", status: "running" }],
          }],
        },
      ],
    }), { headers: { "Content-Type": "application/json" } })));
    const { getChat } = await import("./beaverApi");

    const { chat, messages } = await getChat("chat-1");
    const state = createAssistantSessionState({ chatId: chat.id, messages });
    const assistant = state.messages[1];

    expect(messages[0].turn_id).toBe("turn-1");
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
    await configure("local");
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
    await configure("local");
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
      turn_id: "turn-1",
    });
    expect(state.rejectedTurn?.message).toMatchObject({ turnId: "turn-1" });
  });
});
