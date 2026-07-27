import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";

const mocks = vi.hoisted(() => ({
  pathname: "/assistant/chat/assistant-chat",
  push: vi.fn(),
  setCurrentChatId: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "user@example.test" },
  }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    chats: [
      {
        id: "assistant-chat",
        project_id: null,
        user_id: "user-1",
        title: "Assistant matter",
        created_at: "2026-07-27T00:00:00Z",
      },
      {
        id: "project-chat",
        project_id: "project-1",
        user_id: "user-1",
        title: "Project matter",
        created_at: "2026-07-27T00:00:00Z",
      },
    ],
    hasMoreChats: false,
    loadMoreChats: vi.fn(),
    setCurrentChatId: mocks.setCurrentChatId,
    renameChat: vi.fn(),
    deleteChat: vi.fn(),
  }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/components/shared/SidebarChatItem", () => ({
  SidebarChatItem: ({
    chat,
    isActive,
    onSelect,
  }: {
    chat: { title: string | null };
    isActive: boolean;
    onSelect: () => void;
  }) => (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "page" : undefined}
    >
      {chat.title}
    </button>
  ),
}));

describe("AppSidebar history ownership", () => {
  beforeEach(() => {
    mocks.pathname = "/assistant/chat/assistant-chat";
    vi.clearAllMocks();
  });

  it("keeps non-project chat history inside the active Assistant section", () => {
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const assistant = screen.getByRole("group", { name: "Assistant" });
    expect(
      within(assistant).getByRole("button", { name: "Assistant history" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(assistant).getByRole("button", { name: "Assistant matter" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(assistant).queryByText("Project matter")).not.toBeInTheDocument();
    expect(
      within(assistant).getByRole("button", { name: "Assistant" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("marks nested tool routes active without exposing a global history area", () => {
    mocks.pathname = "/table-of-authorities";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const authorities = screen.getByRole("group", { name: "Authorities" });
    expect(
      within(authorities).getByRole("button", { name: "Authorities" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("group", { name: "Assistant" }),
    ).not.toHaveTextContent("History");
    expect(screen.queryByText("Assistant History")).not.toBeInTheDocument();
  });
});
