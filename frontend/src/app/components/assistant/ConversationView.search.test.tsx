import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationView } from "./ConversationView";
import { createAssistantSessionState } from "@/app/lib/assistantSession";

vi.mock("./ChatInput", () => ({ ChatInput: () => <textarea aria-label="Message" defaultValue="Unsent draft" /> }));
afterEach(() => vi.unstubAllGlobals());

it("opens a loaded search hit, leaves transcript text unhighlighted, and follows another hit without clearing the draft", () => {
    const scrolled: HTMLElement[] = [];
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
    const props = { chatId: "chat", handleChat: vi.fn(), cancel: vi.fn(),
        searchMessageId: "canonical-user" };
    const empty = createAssistantSessionState({ chatId: "chat" });
    const loaded = createAssistantSessionState({ chatId: "chat", messages: [
        { id: "canonical-user", role: "user", content: "Review lease **terms** please." },
        { id: "canonical-assistant", role: "assistant", content: "The lease terms are here." },
    ] });
    const view = render(<ConversationView {...props} session={empty} />);
    expect(scrolled).toHaveLength(0);
    view.rerender(<ConversationView {...props} session={loaded} />);
    expect(loaded.messages[0].id).toBe("canonical-user");
    expect(scrolled.at(-1)?.closest("[data-message-id]"))
        .toHaveAttribute("data-message-id", "canonical-user");
    expect(view.container.querySelector("mark")).toBeNull();
    view.rerender(<ConversationView {...props} session={loaded} searchMessageId="canonical-assistant" />);
    expect(scrolled.at(-1)?.closest("[data-message-id]"))
        .toHaveAttribute("data-message-id", "canonical-assistant");
    expect(view.container.querySelector('[data-message-id="canonical-user"] mark')).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Unsent draft");
});
