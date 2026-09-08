import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
beforeEach(() => { auth.user = null; });
afterEach(() => vi.unstubAllGlobals());

vi.mock("react-router-dom", () => ({
    useLocation: () => ({ pathname: "/assistant" }),
}));
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
        function Probe() {
            const history = useChatHistoryContext();
            return <><p>{history.chats?.map(({ id }) => id).join(",")}</p>
                <button onClick={history.loadMoreChats}>More</button></>;
        }
        render(<ChatHistoryProvider><Probe /></ChatHistoryProvider>);
        await screen.findByText(first.slice(0, 20).map(({ id }) => id).join(","));
        fireEvent.click(screen.getByRole("button", { name: "More" }));
        await screen.findByText(first.map(({ id }) => id).join(","));
    });

    it("keeps the latest history when an older refresh arrives late", async () => {
        auth.user = { id: "user-1" };
        const requests: ((response: Response) => void)[] = [];
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))));
        function Probe() {
            const history = useChatHistoryContext();
            return <><p>{history.chats?.map(({ id }) => id).join(",")}</p>
                <button onClick={() => void history.loadChats()}>Refresh</button></>;
        }
        render(<ChatHistoryProvider><Probe /></ChatHistoryProvider>);
        await act(async () => requests[0](Response.json([{ id: "a" }, { id: "b" }])));
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
        await act(async () => requests[2](Response.json([{ id: "b" }, { id: "a" }])));
        expect(screen.getByText("b,a")).toBeVisible();
        await act(async () => requests[1](Response.json([{ id: "a" }, { id: "b" }])));
        expect(screen.getByText("b,a")).toBeVisible();
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
        let history!: ReturnType<typeof useChatHistoryContext>;
        function Probe() {
            const [error, setError] = useState("");
            history = useChatHistoryContext();
            return <>
                <p>{history.chats?.map((chat) => `${chat.id}:${chat.project_id ?? "none"}`).join(",")}</p>
                <button onClick={() => void history.moveChat("chat-a", "project-1")}>Move chat</button>
                <button onClick={() => void history.moveChat("chat-a", "missing").catch((error) => setError(error.message))}>Try missing project</button>
                {error && <p role="alert">{error}</p>}
            </>;
        }
        render(<ChatHistoryProvider><Probe /></ChatHistoryProvider>);
        await screen.findByText("chat-a:none,chat-b:none");
        history.prepareChat("chat-a");
        const moved: string[] = [];
        const unsubscribe = history.onProjectMove((id, projectId) => moved.push(`${id}:${projectId}`));
        fireEvent.click(screen.getByRole("button", { name: "Move chat" }));
        await screen.findByText("chat-a:project-1,chat-b:none");
        expect(history.takePreparedChat("chat-a")).toBeNull();
        expect(moved).toEqual(["chat-a:project-1"]);
        fireEvent.click(screen.getByRole("button", { name: "Try missing project" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Missing project");
        expect(screen.getByText("chat-a:project-1,chat-b:none")).toBeVisible();
        expect(moved).toEqual(["chat-a:project-1"]);
        unsubscribe();
    });

    it("is scoped, one-shot, and does not invalidate consumers", async () => {
        const onRender = vi.fn();
        const message = { role: "user" as const, content: "Draft this" };
        let results: unknown[] = [];

        function Probe() {
            const history = useChatHistoryContext();
            return (
                <>
                    <span>stable:{history.chats?.length ?? "loading"}</span>
                    <button
                        onClick={() => {
                            history.stagePendingChatMessage("chat-a", message);
                            results = [
                                history.peekPendingChatMessage("chat-b"),
                                history.claimPendingChatMessage("chat-b"),
                                history.peekPendingChatMessage("chat-a"),
                                history.claimPendingChatMessage("chat-a"),
                                history.claimPendingChatMessage("chat-a"),
                            ];
                        }}
                    >
                        Exercise handoff
                    </button>
                </>
            );
        }

        render(
            <ChatHistoryProvider>
                <Profiler id="history-consumer" onRender={onRender}>
                    <Probe />
                </Profiler>
            </ChatHistoryProvider>,
        );
        await waitFor(() => expect(screen.getByText("stable:0")).toBeVisible());
        const settledRenders = onRender.mock.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "Exercise handoff" }));
        expect(results).toEqual([null, null, message, message, null]);
        expect(onRender).toHaveBeenCalledTimes(settledRenders);
    });
});
