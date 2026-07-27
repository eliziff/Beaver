import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppSidebar } from "./AppSidebar";

const mocks = vi.hoisted(() => ({
  pathname: "/assistant/chat/assistant-chat",
  anonymousMode: true,
  profile: null as { displayName: string; tier: string } | null,
  setCurrentChatId: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    prefetch: _prefetch,
    onClick,
    ...props
  }: React.ComponentProps<"a"> & { prefetch?: boolean }) => (
    <a
      {...props}
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
  }: {
    chat: { title: string | null };
    isActive: boolean;
    href: string;
    onNavigate?: () => void;
  }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onNavigate?.();
      }}
      aria-current={isActive ? "page" : undefined}
    >
      {chat.title}
    </a>
  ),
}));

describe("AppSidebar", () => {
  beforeEach(() => {
    mocks.pathname = "/assistant/chat/assistant-chat";
    mocks.anonymousMode = true;
    mocks.profile = null;
    vi.clearAllMocks();
  });

  it("gives Assistant history the remaining height after primary navigation", () => {
    const onToggle = vi.fn();
    render(<AppSidebar mobileOpen onToggle={onToggle} />);

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
    expect(mocks.setCurrentChatId).toHaveBeenCalledWith("assistant-chat");

    mocks.setCurrentChatId.mockClear();
    fireEvent.click(
      within(history).getByRole("link", { name: "Assistant matter" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
    expect(mocks.setCurrentChatId).not.toHaveBeenCalled();
  });

  it("keeps primary navigation fixed when navigating to Authorities", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AppSidebar mobileOpen={false} onToggle={onToggle} />,
    );
    const labelsBefore = within(
      screen.getByRole("navigation", { name: "Primary" }),
    )
      .getAllByRole("link")
      .map((link) => link.textContent);

    const authorities = screen.getByRole("link", { name: "Authorities" });
    expect(authorities).toHaveAttribute("href", "/table-of-authorities");
    fireEvent.click(authorities);
    expect(onToggle).not.toHaveBeenCalled();

    mocks.pathname = "/table-of-authorities";
    rerender(<AppSidebar mobileOpen={false} onToggle={onToggle} />);

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
    expect(screen.getByRole("complementary")).toHaveClass("md:w-64");
    expect(screen.getByRole("complementary")).not.toHaveClass("md:w-14");
  });

  it("exposes local tools while hiding the cloud-only workflow builder", () => {
    render(<AppSidebar mobileOpen={false} onToggle={vi.fn()} />);

    expect(
      screen.getByRole("link", { name: "Tabular Review" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Workflows" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/account/api-keys",
    );
  });

  it("uses native account disclosure and closes it on mobile navigation", () => {
    mocks.anonymousMode = false;
    mocks.profile = { displayName: "Example User", tier: "Pro" };
    const onToggle = vi.fn();
    render(<AppSidebar mobileOpen onToggle={onToggle} />);

    const details = document.querySelector("details");
    expect(details?.querySelector("summary")).toHaveTextContent("Example User");
    details!.open = true;

    const account = screen.getByRole("link", { name: "Account Settings" });
    expect(account).toHaveAttribute("href", "/account");
    fireEvent.click(account);

    expect(details).not.toHaveAttribute("open");
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
