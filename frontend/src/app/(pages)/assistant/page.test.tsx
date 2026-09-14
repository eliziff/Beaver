import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import AssistantPage from "./page";

const capture = vi.hoisted(() => vi.fn());
const history = vi.hoisted(() => ({ saveChat: vi.fn() }));
vi.mock("@/app/components/assistant/InitialView", () => ({
    InitialView: (props: unknown) => {
        capture(props);
        return <p>Assistant ready</p>;
    },
}));
vi.mock("@/app/components/assistant/assistantLaunch", () => ({
    takeNewChatDocuments: () => [],
}));
vi.mock("@/app/lib/chatDrafts", () => ({ writeChatDraft: vi.fn() }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: history.saveChat, loadChats: vi.fn(),
        stagePendingChatMessage: vi.fn() }),
}));
beforeEach(() => {
    capture.mockClear();
    history.saveChat.mockReset();
    history.saveChat.mockResolvedValue("chat-1");
});

it("restores a workflow handoff in the Assistant composer", () => {
    const workflow = { workflow: {
        id: "templates", variant_id: "builtin-draft-from-template", title: "Templates",
    }, documentTab: "templates" as const };
    render(<MemoryRouter initialEntries={[{ pathname: "/assistant", state: workflow }]}>
        <AssistantPage />
    </MemoryRouter>);

    expect(screen.getByText("Assistant ready")).toBeInTheDocument();
    expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({
        initialWorkflow: workflow,
    }));
});

it("does not create a chat until the draft has content or an attachment", async () => {
    render(<MemoryRouter><AssistantPage /></MemoryRouter>);
    const props = capture.mock.calls.at(-1)![0] as {
        onDraftChange: (draft: unknown) => Promise<unknown>;
    };

    await props.onDraftChange({ role: "user", content: "   ", documents: [] });
    expect(history.saveChat).not.toHaveBeenCalled();

    await props.onDraftChange({ role: "user", content: "a", documents: [] });
    expect(history.saveChat).toHaveBeenCalledTimes(1);
});

