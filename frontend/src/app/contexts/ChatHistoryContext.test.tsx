import { act, renderHook, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
beforeEach(() => { auth.user = null; });
afterEach(() => vi.unstubAllGlobals());

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: auth.user }),
}));

describe("ChatHistoryProvider pending message handoff", () => {
    it("shows each chat once when activity moves it across history pages", async () => {
        auth.user = { id: "user-1" };
        const first = Array.from({ length: 21 }, (_, index) => ({ id: `chat-${index}` }));
        vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
            new URL(url, "http://localhost").searchParams.get("offset") === "20"
                ? [{ id: "chat-19" }, { id: "chat-20" }] : first)));
        const { result } = renderHook(useChatHistoryContext, { wrapper: ChatHistoryProvider });
        await waitFor(() => expect(result.current.chats).toEqual(first.slice(0, 20)));
        act(() => result.current.loadMoreChats());
        await waitFor(() => expect(result.current.chats).toEqual(first));
    });

    it("keeps the latest history when an older refresh arrives late", async () => {
        auth.user = { id: "user-1" };
        const requests: ((response: Response) => void)[] = [];
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))));
        const { result } = renderHook(useChatHistoryContext, { wrapper: ChatHistoryProvider });
        await act(async () => requests[0](Response.json([{ id: "a" }, { id: "b" }])));
        act(() => { void result.current.loadChats(); void result.current.loadChats(); });
        await act(async () => requests[2](Response.json([{ id: "b" }, { id: "a" }])));
        expect(result.current.chats).toEqual([{ id: "b" }, { id: "a" }]);
        await act(async () => requests[1](Response.json([{ id: "a" }, { id: "b" }])));
        expect(result.current.chats).toEqual([{ id: "b" }, { id: "a" }]);
    });

    it("updates the moved chat, invalidates its prefetched location and leaves failed moves unchanged", async () => {
        auth.user = { id: "user-1" };
        const chat = { id: "chat-a", project_id: null, title: "Matter" };
        vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
            if (init.method === "PATCH") {
                const project = JSON.parse(String(init.body)).project_id;
                return project === "missing" ? Response.json({ detail: "Missing project" }, { status: 404 })
                    : Response.json({ ...chat, project_id: project });
            }
            return Response.json(url.endsWith("/chat/chat-a")
                ? { chat, messages: [] } : [chat, { ...chat, id: "chat-b" }]);
        }));
        const { result } = renderHook(useChatHistoryContext, { wrapper: ChatHistoryProvider });
        await waitFor(() => expect(result.current.chats).toEqual([chat, { ...chat, id: "chat-b" }]));
        result.current.prepareChat("chat-a");
        const moved: string[] = [];
        const unsubscribe = result.current.onProjectMove((id, projectId) => moved.push(`${id}:${projectId}`));
        try {
            await act(() => result.current.moveChat("chat-a", "project-1"));
            const expected = [{ ...chat, project_id: "project-1" }, { ...chat, id: "chat-b" }];
            expect(result.current.chats).toEqual(expected);
            expect(result.current.takePreparedChat("chat-a")).toBeNull();
            expect(moved).toEqual(["chat-a:project-1"]);
            await act(async () => {
                await expect(result.current.moveChat("chat-a", "missing")).rejects.toThrow("Missing project");
            });
            expect(result.current.chats).toEqual(expected);
            expect(moved).toEqual(["chat-a:project-1"]);
        } finally {
            unsubscribe();
        }
    });

    it("is scoped, one-shot, and does not invalidate consumers", async () => {
        const onRender = vi.fn();
        const message = { role: "user" as const, content: "Draft this" };
        const { result } = renderHook(useChatHistoryContext, {
            wrapper: ({ children }: { children: ReactNode }) => (
                <ChatHistoryProvider>
                    <Profiler id="history-consumer" onRender={onRender}>{children}</Profiler>
                </ChatHistoryProvider>
            ),
        });
        await waitFor(() => expect(result.current.chats).toEqual([]));
        const settledRenders = onRender.mock.calls.length;

        act(() => {
            result.current.stagePendingChatMessage("chat-a", message);
            expect([
                result.current.peekPendingChatMessage("chat-b"),
                result.current.claimPendingChatMessage("chat-b"),
                result.current.peekPendingChatMessage("chat-a"),
                result.current.claimPendingChatMessage("chat-a"),
                result.current.claimPendingChatMessage("chat-a"),
            ]).toEqual([null, null, message, message, null]);
        });
        expect(onRender).toHaveBeenCalledTimes(settledRenders);
    });
});
