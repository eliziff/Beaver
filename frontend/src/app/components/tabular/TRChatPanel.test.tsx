import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRChatPanel } from "./TRChatPanel";

const api = vi.hoisted(() => ({
    getChats: vi.fn(),
    getMessages: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    deleteTabularChat: vi.fn(),
    getTabularChats: api.getChats,
    getTabularChatMessages: api.getMessages,
    mapTRMessages: (messages: unknown[]) => messages,
    renameTabularChat: vi.fn(),
    streamTabularChat: vi.fn(),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { tabularModel: "gemini-3-flash-preview" },
        updateModelPreference: vi.fn(),
    }),
}));
vi.mock("../assistant/ModelToggle", () => ({ ModelToggle: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(120);
    api.getChats.mockResolvedValue([]);
    api.getMessages.mockResolvedValue([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Latest question" },
        { role: "assistant", content: "Latest answer" },
    ]);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it("renders loaded messages and positions the latest question before paint", async () => {
    const { container } = render(
        <TRChatPanel
            reviewId="review-1"
            initialChatId="chat-1"
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    await screen.findByText("Latest question");

    expect(
        (
            container.querySelector(
                ".flex-1.overflow-y-auto",
            ) as HTMLElement
        ).scrollTop,
    ).toBe(76);
    expect(container.querySelector('[style*="opacity"]')).toBeNull();
});
