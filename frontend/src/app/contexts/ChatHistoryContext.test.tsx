import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryProvider, useChatHistoryContext } from "./ChatHistoryContext";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
beforeEach(() => { auth.user = null; });
afterEach(() => vi.unstubAllGlobals());
vi.mock("react-router-dom", () => ({ useLocation: () => ({ pathname: "/assistant" }) }));
vi.mock("@/app/contexts/AuthContext", () => ({ useAuth: () => ({ user: auth.user }) }));
const history = () => renderHook(useChatHistoryContext, { wrapper: ChatHistoryProvider });

describe("ChatHistoryProvider pending message handoff", () => {
    it("shows each chat once when activity moves it across history pages", async () => {
        auth.user = { id: "user-1" };
        const first = Array.from({ length: 21 }, (_, index) => ({ id: `chat-${index}` }));
        vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(
            new URL(url, "http://localhost").searchParams.get("offset") === "20"
                ? [{ id: "chat-19" }, { id: "chat-20" }] : first)));
        const { result } = history();
        await waitFor(() => expect(result.current.chats).toEqual(first.slice(0, 20)));
        await act(() => result.current.loadMoreChats());
        expect(result.current.chats).toEqual(first);
    });

    it("keeps the latest history when an older refresh arrives late", async () => {
        auth.user = { id: "user-1" };
        const requests: ((response: Response) => void)[] = [];
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))));
        const { result } = history();
        await act(async () => requests[0](Response.json([{ id: "a" }, { id: "b" }])));
        act(() => { void result.current.loadChats(); });
        act(() => { void result.current.loadChats(); });
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
        const { result } = history();
        await waitFor(() => expect(result.current.chats).toEqual([chat, { ...chat, id: "chat-b" }]));
        result.current.prepareChat("chat-a");
        const moved = vi.fn(), unsubscribe = result.current.onProjectMove(moved);
        await act(() => result.current.moveChat("chat-a", "project-1"));
        const expected = [{ ...chat, project_id: "project-1" }, { ...chat, id: "chat-b" }];
        expect(result.current.chats).toEqual(expected);
        expect(result.current.takePreparedChat("chat-a")).toBeNull();
        expect(moved.mock.calls).toEqual([["chat-a", "project-1"]]);
        await act(async () => {
            await expect(result.current.moveChat("chat-a", "missing")).rejects.toThrow("Missing project");
        });
        expect(result.current.chats).toEqual(expected);
        expect(moved.mock.calls).toEqual([["chat-a", "project-1"]]);
        unsubscribe();
    });

    it("is scoped, one-shot, and does not invalidate consumers", async () => {
        const consume = vi.fn();
        const { result } = renderHook(() => {
            consume();
            return useChatHistoryContext();
        }, { wrapper: ChatHistoryProvider });
        await waitFor(() => expect(result.current.chats).toEqual([]));
        const settledRenders = consume.mock.calls.length;
        const message = { role: "user" as const, content: "Draft this" };
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
        expect(consume).toHaveBeenCalledTimes(settledRenders);
    });
});
