import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));
function sidebar(mobileOpen: boolean, onToggle = vi.fn()) {
  return (
    <AppSidebar
      mobileOpen={mobileOpen}
      onToggle={onToggle}
    />
  );
}

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => mocks.replace,
  Link: ({
    children,
    onClick,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to: string }) => (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "user@example.test" },
  }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: mocks.profile }),
}));
const sidebarChats = [
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
      {
        id: "assistant-chat-2",
        project_id: null,
        user_id: "user-1",
        title: "Second matter",
        created_at: "2026-07-26T00:00:00Z",
      },
      {
        id: "assistant-chat-3",
        project_id: null,
        user_id: "user-1",
        title: "Third matter",
        created_at: "2026-07-25T00:00:00Z",
      },
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
vi.mock("@/app/components/shared/SidebarChatItem", () => ({
  SidebarChatItem: ({
    chat,
    isActive,
    to,
    onNavigate,
    onClearSelection,
    onSelect,
    onDragChat,
    isSelected,
    selectedCount,
    isSelectionActionOwner,
    onMoveToProject,
    onDeleteSelection,
  }: {
    chat: { id: string; title: string | null };
    isActive: boolean;
    isSelected?: boolean;
    selectedCount?: number;
    isSelectionActionOwner?: boolean;
    to: string;
    onNavigate?: () => void;
    onClearSelection?: () => void;
    onSelect?: (modifiers: {
      shiftKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
    }) => void;
    onDragChat?: (event: React.DragEvent<HTMLDivElement>) => void;
    onMoveToProject?: () => void;
    onDeleteSelection?: () => Promise<void>;
  }) => (
    <div
      data-chat-id={chat.id}
      data-selected={isSelected || undefined}
      draggable
      onDragStart={onDragChat}
    >
      <a
        href={to}
        onClick={(event) => {
          event.preventDefault();
          if (event.shiftKey || event.ctrlKey || event.metaKey) {
            onSelect?.(event);
            return;
          }
          onClearSelection?.();
          onNavigate?.();
        }}
        aria-current={isActive ? "page" : undefined}
      >
        {chat.title}
      </a>
      {onMoveToProject ? (
        <button type="button" onClick={onMoveToProject}>
          Move {chat.title} to project
        </button>
      ) : null}
      <div
        data-row-actions
        hidden={!!selectedCount && !isSelectionActionOwner}
      >
        <button
          type="button"
          onClick={() => void onDeleteSelection?.()}
        >
          {selectedCount && isSelectionActionOwner
            ? `Delete ${selectedCount} selected chats`
            : `Delete ${chat.title}`}
        </button>
      </div>
    </div>
  ),
}));
vi.mock("@/app/components/assistant/SelectAssistantProjectModal", () => ({
  SelectAssistantProjectModal: ({
    open,
    onSelectProject,
  }: {
    open: boolean;
    onSelectProject?: (projectId: string | null) => Promise<void> | void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Choose project">
        <button
          type="button"
          onClick={() => void onSelectProject?.("project-1")}
        >
          Matter One
        </button>
      </div>
    ) : null,
}));

describe("AppSidebar", () => {
  beforeEach(() => {
    mocks.pathname = "/assistant/chat/assistant-chat";
    mocks.localMode = true;
    mocks.profile = null;
    vi.clearAllMocks();
    mocks.loadChats.mockResolvedValue(undefined);
    mocks.listChats.mockResolvedValue([]);
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
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "tab",
        { name: "Assistant" },
      ),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      within(history).getByRole("link", { name: "Assistant matter" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("contains mobile focus, closes on Escape, and restores the opener", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open sidebar";
    document.body.append(opener);
    opener.focus();
    const onToggle = vi.fn();
    const { rerender } = render(sidebar(true, onToggle));

    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const close = within(dialog).getByRole("button", {
      name: "Close sidebar",
    });
    await waitFor(() => expect(close).toHaveFocus());

    const first = within(dialog).getByRole("link", { name: "Beaver" });
    const last = within(dialog).getByRole("link", { name: "Activity log" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(sidebar(false, onToggle));
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
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

  it("opens the activity log directly and closes the mobile sidebar", () => {
    const onToggle = vi.fn();
    render(sidebar(true, onToggle));
    const link = screen.getByRole("link", { name: "Activity log" });
    expect(link).toHaveAttribute("href", "/history");
    fireEvent.click(link);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("moves an Assistant chat through the shared project chooser", async () => {
    render(sidebar(false));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Move Assistant matter to project",
      }),
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Choose project" }),
      ).getByRole("button", { name: "Matter One" }),
    );

    await waitFor(() =>
      expect(mocks.moveChat).toHaveBeenCalledWith(
        "assistant-chat",
        "project-1",
      ),
    );
    expect(screen.queryByRole("dialog", { name: "Choose project" })).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("uses Shift for ranges, Ctrl for toggles, and drags the selection", async () => {
    render(sidebar(false));

    fireEvent.click(screen.getByRole("link", { name: "Assistant matter" }));
    fireEvent.click(screen.getByRole("link", { name: "Third matter" }), {
      shiftKey: true,
    });

    expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("link", { name: "Second matter" }), {
      ctrlKey: true,
    });
    expect(document.querySelectorAll('[data-selected="true"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole("link", { name: "Second matter" }), {
      ctrlKey: true,
    });

    const recycle = screen.getByRole("button", {
      name: "Move 3 selected chats to Recycling bin",
    });
    expect(
      document.querySelectorAll('[data-selected="true"]'),
    ).toHaveLength(3);

    const values = new Map<string, string>();
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: "none",
      dropEffect: "none",
      setData(type: string, value: string) {
        values.set(type, value);
        if (!this.types.includes(type)) this.types.push(type);
      },
      getData(type: string) {
        return values.get(type) ?? "";
      },
    };
    fireEvent.dragStart(
      document.querySelector('[data-chat-id="assistant-chat"]')!,
      { dataTransfer },
    );
    fireEvent.dragEnter(recycle, { dataTransfer });
    fireEvent.drop(recycle, { dataTransfer });

    await waitFor(() => expect(mocks.deleteChat).toHaveBeenCalledTimes(3));
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat");
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat-2");
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat-3");
    expect(mocks.replace).toHaveBeenCalledWith("/assistant", { replace: true });
  });

  it("gives only the topmost selected chat the row actions", () => {
    render(sidebar(false));

    fireEvent.click(screen.getByRole("link", { name: "Assistant matter" }));
    fireEvent.click(screen.getByRole("link", { name: "Third matter" }), {
      shiftKey: true,
    });

    const rows = [
      "assistant-chat",
      "assistant-chat-2",
      "assistant-chat-3",
    ].map((id) => document.querySelector(`[data-chat-id="${id}"]`)!);
    expect(
      rows[0].querySelector("[data-row-actions]"),
    ).not.toHaveAttribute("hidden");
    expect(rows[1].querySelector("[data-row-actions]")).toHaveAttribute(
      "hidden",
    );
    expect(rows[2].querySelector("[data-row-actions]")).toHaveAttribute(
      "hidden",
    );
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
