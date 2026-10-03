import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Chat } from "@/app/lib/api/chat";

import { AppSidebar } from "./AppSidebar";

const mocks = vi.hoisted(() => ({
  pathname: "/assistant/chat/assistant-chat",
  localMode: true,
  profile: null as { displayName: string } | null,
  loadChats: vi.fn(),
  deleteChat: vi.fn(),
  replace: vi.fn(),
  moveChat: vi.fn(),
  listChats: vi.fn(),
  listProjects: vi.fn(),
}));
function sidebar(mobileOpen: boolean, onToggle = vi.fn()) {
  return <MemoryRouter><AppSidebar mobileOpen={mobileOpen} onToggle={onToggle} /></MemoryRouter>;
}

vi.mock("react-router-dom", async (original) => ({
  ...await original<typeof import("react-router-dom")>(),
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => mocks.replace,
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "user@example.test" },
  }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: mocks.profile }),
}));
function chat(id: string, title: string, created_at: string, project_id: string | null = null): Chat {
  return { id, title, created_at, project_id, user_id: "user-1" };
}
const sidebarChats = [
  chat("assistant-chat", "Assistant matter", "2026-07-27T00:00:00Z"),
  chat("project-chat", "Project matter", "2026-07-27T00:00:00Z", "project-1"),
  chat("assistant-chat-2", "Second matter", "2026-07-26T00:00:00Z"),
  chat("assistant-chat-3", "Third matter", "2026-07-25T00:00:00Z"),
];
vi.mock("@/app/lib/api/chat", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/lib/api/chat")>(),
  listChats: mocks.listChats,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    chats: sidebarChats,
    hasMoreChats: false,
    loadMoreChats: vi.fn(),
    loadChats: mocks.loadChats,
    renameChat: vi.fn(),
    deleteChat: mocks.deleteChat,
    moveChat: mocks.moveChat,
  }),
}));
vi.mock("@/app/lib/authMode", () => ({
  get isLocalMode() {
    return mocks.localMode;
  },
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
  ...await original<typeof import("@/app/lib/api/projects")>(),
  listProjects: mocks.listProjects,
}));

describe("AppSidebar", () => {
  beforeEach(() => {
    mocks.pathname = "/assistant/chat/assistant-chat";
    mocks.localMode = true;
    mocks.profile = null;
    vi.clearAllMocks();
    mocks.loadChats.mockResolvedValue(undefined);
    mocks.listChats.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue({
      items: [{ id: "project-1", name: "Matter One" }], next_cursor: null,
    });
    mocks.deleteChat.mockResolvedValue(undefined);
    mocks.moveChat.mockResolvedValue({
      id: "assistant-chat",
      title: "Assistant matter",
      project_id: "project-1",
    });
  });

  it("keeps conversations under Assistant with separate resume and new-conversation links", () => {
    const onToggle = vi.fn();
    render(sidebar(true, onToggle));

    const history = screen.getByRole("region", {
      name: "Assistant conversations",
    });
    expect(
      within(history).getByRole("link", { name: "Assistant matter" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "Assistant" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/assistant");
    expect(within(history).queryByText("Project matter")).not.toBeInTheDocument();
    fireEvent.click(
      within(history).getByRole("link", { name: "Assistant matter" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps workspace links visible and resumes Assistant after visiting a tool", () => {
    const { rerender } = render(sidebar(false));
    expect(screen.getByRole("searchbox", { name: "Search history" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workflows" })).toBeInTheDocument();
    mocks.pathname = "/workflows";
    rerender(sidebar(false));
    expect(screen.getByRole("link", { name: "Workflows" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Projects" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse history" }));
    expect(screen.queryByRole("link", { name: "Assistant matter" })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search history" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand history" }));
    expect(screen.getByRole("link", { name: "Assistant matter" })).toBeVisible();
  });

  it("focuses inline history with Ctrl K without changing the chat draft", () => {
    render(<>{sidebar(false)}<textarea aria-label="Message" defaultValue="Unsent text" /></>);
    const search = screen.getByRole("searchbox", { name: "Search history" });
    vi.spyOn(search, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(search).toHaveFocus();
    expect(input).toHaveValue("Unsent text");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("finds an older chat through inline history and links directly to it", async () => {
    mocks.listChats.mockResolvedValue([{ ...sidebarChats[0], id: "older-chat", title: "Older matter" }]);
    render(sidebar(false));
    expect(screen.queryByRole("link", { name: "Older matter" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search history" }), { target: { value: "Older" } });
    const result = await screen.findByRole("link", { name: "Older matter" });
    expect(result).toHaveAttribute("href", "/assistant/chat/older-chat");
    fireEvent.click(result);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens one Settings modal in cloud mode", async () => {
    mocks.localMode = false;
    mocks.profile = null;
    const onToggle = vi.fn();
    render(sidebar(true, onToggle));

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(
      await screen.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 }),
    ).toBeVisible();
    const account = screen.getByRole("link", { name: "Account" });
    expect(account).toHaveAttribute("href", "/account");
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
