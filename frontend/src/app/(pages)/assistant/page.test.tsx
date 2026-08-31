import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import AssistantPage from "./page";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@/app/components/assistant/InitialView", () => ({
    InitialView: (props: unknown) => {
        capture(props);
        return <p>Assistant ready</p>;
    },
}));
vi.mock("@/app/components/assistant/assistantLaunch", () => ({
    takeNewChatDocuments: () => [],
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: vi.fn(), stagePendingChatMessage: vi.fn() }),
}));

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
