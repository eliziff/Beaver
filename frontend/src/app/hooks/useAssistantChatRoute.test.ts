import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAssistantChatRoute } from "./useAssistantChatRoute";

const mocks = vi.hoisted(() => ({
    BeaverApiError: class BeaverApiError extends Error {
        status: number;
        constructor({ message, status }: { message: string; status: number }) {
            super(message);
            this.status = status;
        }
    },
    replace: vi.fn(),
    getChat: vi.fn(),
    getProject: vi.fn(),
    updateChatProject: vi.fn(),
    useAssistantChat: vi.fn(),
    setMessages: vi.fn(),
    setTranscriptVersion: vi.fn(),
    resumeRunningTurn: vi.fn(),
    messages: [] as { role: string; content: string }[],
    loading: false,
    chats: [] as { id: string; title: string | null }[],
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    BeaverApiError: mocks.BeaverApiError,
    getChat: mocks.getChat,
    getProject: mocks.getProject,
    updateChatProject: mocks.updateChatProject,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ chats: mocks.chats }),
}));
vi.mock("./useAssistantChat", () => ({
    useAssistantChat: mocks.useAssistantChat,
}));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.messages = [];
    mocks.loading = false;
    mocks.chats = [];
    mocks.getProject.mockResolvedValue({ id: "project-1", name: "Project" });
    mocks.useAssistantChat.mockImplementation(() => ({
        state: {
            messages: mocks.messages,
            run: mocks.loading ? { id: "run-1", status: "running" } : null,
        },
        actions: {
            setMessages: mocks.setMessages,
            setTranscriptVersion: mocks.setTranscriptVersion,
            resumeRunningTurn: mocks.resumeRunningTurn,
        },
    }));
});

it("stays on the chat when loading fails temporarily", async () => {
    mocks.getChat.mockRejectedValue(
        new mocks.BeaverApiError({ message: "Too many requests", status: 429 }),
    );

    renderHook(() => useAssistantChatRoute({ chatId: "chat-1" }));

    await waitFor(() => expect(mocks.getChat).toHaveBeenCalled());
    expect(mocks.replace).not.toHaveBeenCalled();
});

it("reconnects to a turn that kept running after navigation", async () => {
    const messages = [{ role: "user", content: "Research this" }];
    mocks.getChat.mockResolvedValue({
        chat: {
            id: "chat-1",
            project_id: null,
            user_id: "owner-1",
            title: "Research",
            transcript_version: 4,
            turn_in_progress: true,
            created_at: "",
        },
        messages,
    });

    renderHook(() => useAssistantChatRoute({ chatId: "chat-1" }));

    await waitFor(() =>
        expect(mocks.resumeRunningTurn).toHaveBeenCalledWith("chat-1", 4),
    );
    expect(mocks.setMessages).toHaveBeenCalledWith(messages, true);
});

it("loads one canonical standalone transcript and metadata", async () => {
    const messages = [{ role: "assistant", content: "Loaded answer" }];
    mocks.getChat.mockResolvedValue({
        chat: {
            id: "chat-1",
            project_id: null,
            user_id: "owner-1",
            title: "Loaded title",
            transcript_version: 7,
            created_at: "",
        },
        messages,
    });

    const { result, rerender } = renderHook(() =>
        useAssistantChatRoute({ chatId: "chat-1" }),
    );

    await waitFor(() => expect(result.current.chatLoaded).toBe(true));
    expect(result.current.chatTitle).toBe("Loaded title");
    expect(result.current.chatOwnerId).toBe("owner-1");
    expect(mocks.setTranscriptVersion).toHaveBeenCalledWith(7);
    expect(mocks.setMessages).toHaveBeenCalledWith(messages, false);
    expect(mocks.replace).not.toHaveBeenCalled();

    mocks.chats = [{ id: "chat-1", title: "Renamed title" }];
    rerender();
    expect(result.current.chatTitle).toBe("Renamed title");
});

it("keeps a valid empty chat open", async () => {
    mocks.getChat.mockResolvedValue({
        chat: {
            id: "chat-1",
            project_id: null,
            user_id: "owner-1",
            title: null,
            transcript_version: 0,
            created_at: "",
        },
        messages: [],
    });

    renderHook(() => useAssistantChatRoute({ chatId: "chat-1" }));

    await waitFor(() => expect(mocks.setMessages).toHaveBeenCalledWith([], false));
    expect(mocks.replace).not.toHaveBeenCalled();
});

it("redirects a project-bound standalone chat without loading it twice", async () => {
    mocks.getChat.mockResolvedValue({
        chat: {
            id: "chat-1",
            project_id: "project-1",
            user_id: "owner-1",
            title: "Project chat",
            created_at: "",
        },
        messages: [{ role: "assistant", content: "Existing" }],
    });
    mocks.getProject.mockResolvedValue({
        id: "project-1",
        name: "Matter one",
    });

    const { result } = renderHook(() =>
        useAssistantChatRoute({ chatId: "chat-1" }),
    );

    await waitFor(() =>
        expect(mocks.replace).toHaveBeenCalledWith(
            "/projects/project-1/assistant/chat/chat-1",
        ),
    );
    await waitFor(() =>
        expect(result.current.chatProjectName).toBe("Matter one"),
    );
    expect(result.current.chatProjectId).toBe("project-1");
    expect(mocks.setMessages).not.toHaveBeenCalled();
});

it("keeps a pending turn and defers project routing until it finishes", async () => {
    mocks.messages = [{ role: "user", content: "Pending request" }];
    mocks.loading = true;
    mocks.updateChatProject.mockResolvedValue({ project_id: "project-2" });
    const { result, rerender } = renderHook(() =>
        useAssistantChatRoute({ chatId: "chat-1" }),
    );

    await act(async () => {
        await result.current.changeProject("project-2");
    });
    expect(mocks.getChat).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.useAssistantChat).toHaveBeenLastCalledWith({
        chatId: "chat-1",
        projectId: "project-2",
    });

    mocks.loading = false;
    rerender();
    await waitFor(() =>
        expect(mocks.replace).toHaveBeenCalledWith(
            "/projects/project-2/assistant/chat/chat-1",
        ),
    );
});
