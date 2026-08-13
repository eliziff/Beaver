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
  anonymousMode: true,
  profile: null as { displayName: string; tier: string } | null,
  loadChats: vi.fn(),
  deleteChat: vi.fn(),
  replace: vi.fn(),
  updateChatProject: vi.fn(),
  onAuthoritiesNavigate: vi.fn(),
}));
function sidebar(mobileOpen: boolean, onToggle = vi.fn()) {
  return (
    <AppSidebar
      mobileOpen={mobileOpen}
      onToggle={onToggle}
      onAuthoritiesNavigate={mocks.onAuthoritiesNavigate}
    />
  );
}

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    onNavigate,
    ...props
  }: React.ComponentProps<"a"> & { onNavigate?: () => void }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onNavigate?.();
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
    ],
    hasMoreChats: false,
    loadMoreChats: vi.fn(),
    loadChats: mocks.loadChats,
    renameChat: vi.fn(),
    deleteChat: mocks.deleteChat,
  }),
}));
vi.mock("@/app/lib/beaverApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/beaverApi")>()),
  updateChatProject: mocks.updateChatProject,
}));
vi.mock("@/app/lib/authMode", () => ({
  get isAnonymousMode() {
    return mocks.anonymousMode;
  },
}));
vi.mock("@/app/components/shared/SidebarChatItem", () => ({
  SidebarChatItem: ({
    chat,
    isActive,
    href,
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
    href: string;
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
        href={href}
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
    mocks.anonymousMode = true;
    mocks.profile = null;
    vi.clearAllMocks();
    mocks.loadChats.mockResolvedValue(undefined);
    mocks.deleteChat.mockResolvedValue(undefined);
    mocks.updateChatProject.mockResolvedValue({
      id: "assistant-chat",
      title: "Assistant matter",
      project_id: "project-1",
    });
  });

  it("gives Assistant history the remaining height after primary navigation", () => {
    const onToggle = vi.fn();
    render(sidebar(true, onToggle));

    const history = screen.getByRole("region", {
      name: "Assistant history",
    });
    expect(history).toHaveClass("flex-1", "min-h-0");
    expect(document.querySelector("#assistant-history")).toHaveClass(
      "flex-1",
      "overflow-y-auto",
    );
    expect(
      within(history).getByRole("link", { name: "Assistant matter" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(history).queryByText("Project matter")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "link",
        { name: "Assistant" },
      ),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen
        .getByRole("link", { name: "Projects" })
        .querySelector("svg.lucide-folder"),
    ).not.toBeNull();
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
    const settings = within(dialog).getByRole("button", { name: "Settings" });
    settings.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(settings).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(sidebar(false, onToggle));
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it("keeps primary navigation fixed when navigating to Authorities", () => {
    const onToggle = vi.fn();
    const { rerender } = render(sidebar(false, onToggle));
    const labelsBefore = within(
      screen.getByRole("navigation", { name: "Primary" }),
    )
      .getAllByRole("link")
      .map((link) => link.textContent);

    const authorities = screen.getByRole("link", { name: "Authorities" });
    expect(authorities).toHaveAttribute("href", "/table-of-authorities");
    fireEvent.click(authorities);
    expect(mocks.onAuthoritiesNavigate).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();

    mocks.pathname = "/table-of-authorities";
    rerender(sidebar(false, onToggle));

    const labelsAfter = within(
      screen.getByRole("navigation", { name: "Primary" }),
    )
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labelsAfter).toEqual(labelsBefore);
    expect(
      screen.getByRole("link", { name: "Authorities" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("region", { name: "Assistant history" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveClass("lg:w-64");
    expect(screen.getByRole("complementary")).not.toHaveClass("md:w-14");
  });

  it("moves an Assistant chat through the shared project chooser", async () => {
    const moved = vi.fn();
    window.addEventListener("beaver:chat-project-moved", moved);
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
      expect(mocks.updateChatProject).toHaveBeenCalledWith(
        "assistant-chat",
        "project-1",
      ),
    );
    expect(mocks.loadChats).toHaveBeenCalledOnce();
    expect(moved).toHaveBeenCalledOnce();
    expect((moved.mock.calls[0][0] as CustomEvent).detail).toEqual({
      chatId: "assistant-chat",
      projectId: "project-1",
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    window.removeEventListener("beaver:chat-project-moved", moved);
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
    expect(recycle).toHaveClass("bg-red-100");
    fireEvent.drop(recycle, { dataTransfer });

    await waitFor(() => expect(mocks.deleteChat).toHaveBeenCalledTimes(3));
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat");
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat-2");
    expect(mocks.deleteChat).toHaveBeenCalledWith("assistant-chat-3");
    expect(mocks.replace).toHaveBeenCalledWith("/assistant");
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

  it("exposes local tools and read-only starter workflows", () => {
    render(sidebar(false));

    expect(
      screen.getByRole("link", { name: "Tabular Review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Workflows" }),
    ).toHaveAttribute("href", "/workflows");
    expect(screen.getByRole("button", { name: "Recycling bin" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
  });

  it("opens one Settings modal in cloud mode", async () => {
    mocks.anonymousMode = false;
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
