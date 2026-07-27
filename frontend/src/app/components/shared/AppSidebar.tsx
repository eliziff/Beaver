"use client";

import { useEffect, useMemo } from "react";
import { PanelLeft, User, ChevronsUpDown, KeyRound } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
  ChatSkeuoIcon,
  FolderSkeuoIcon,
  LibrarySkeuoIcon,
  TableOfAuthoritiesSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { cn } from "@/app/lib/utils";
import {
  APP_SURFACE_ACTIVE_CLASS,
  APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";

const NAV_ITEMS = [
  { href: "/assistant", label: "Assistant", icon: ChatSkeuoIcon },
  { href: "/projects", label: "Projects", icon: FolderSkeuoIcon },
  { href: "/library", label: "Library", icon: LibrarySkeuoIcon },
  {
    href: "/table-of-authorities",
    label: "Authorities",
    icon: TableOfAuthoritiesSkeuoIcon,
  },
  {
    href: "/tabular-reviews",
    label: "Tabular Review",
    icon: TabularReviewSkeuoIcon,
  },
  { href: "/workflows", label: "Workflows", icon: WorkflowSkeuoIcon },
];

interface AppSidebarProps {
  mobileOpen: boolean;
  onToggle: () => void;
}

export function AppSidebar({ mobileOpen, onToggle }: AppSidebarProps) {
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { chats, hasMoreChats, loadMoreChats, setCurrentChatId } =
    useChatHistoryContext();
  const pathname = usePathname();
  const routeChatId = useMemo(() => {
    if (pathname.startsWith("/assistant/chat/")) {
      return pathname.split("/").pop() ?? null;
    }

    const projectChatMatch = pathname.match(
      /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
    );
    return projectChatMatch?.[1] ?? null;
  }, [pathname]);
  const assistantChats = useMemo(
    () => chats?.filter((chat) => !chat.project_id) ?? chats,
    [chats],
  );

  useEffect(() => {
    setCurrentChatId(routeChatId);
  }, [routeChatId, setCurrentChatId]);

  if (!user) return null;

  return (
    <>
      {/* Mobile: tapping outside the expanded sidebar closes it. The
                sidebar (z-[99]) sits above this scrim (z-[98]); md+ is
                unaffected since the sidebar is part of the layout there. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[98] bg-gray-300/20 md:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          mobileOpen
            ? "max-md:h-[calc(100dvh-1rem)] max-md:w-64"
            : "max-md:hidden",
          "md:h-[calc(100dvh-1.5rem)] md:w-64",
          "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 rounded-2xl border border-gray-200 bg-app-surface overflow-visible",
          "flex flex-col absolute md:relative z-[99]",
        )}
      >
        <div className="flex items-center justify-between px-2.5 py-3">
          <div className="px-2">
            <Link
              href="/assistant"
              prefetch={false}
              className="flex items-center gap-1.5 hover:opacity-80"
              onClick={mobileOpen ? onToggle : undefined}
            >
              <BeaverIcon size={22} />
              <span className="text-2xl font-light font-serif">Beaver</span>
            </Link>
          </div>
          <button
            onClick={onToggle}
            className={cn(
              "flex h-9 w-9 items-center p-2.5 md:hidden",
              "rounded-md",
              APP_SURFACE_HOVER_CLASS,
            )}
            title="Close sidebar"
            aria-label="Close sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        <nav aria-label="Primary" className="shrink-0 pb-2">
          {NAV_ITEMS.filter(
            ({ href }) => !isAnonymousMode || href !== "/workflows",
          ).map(({ href, label, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <div key={href} className="px-2.5 py-0.5">
                <Link
                  href={href}
                  prefetch={false}
                  onClick={mobileOpen ? onToggle : undefined}
                  title={label}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex h-9 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left",
                    isActive
                      ? `${APP_SURFACE_ACTIVE_CLASS} text-gray-900`
                      : `text-gray-700 ${APP_SURFACE_HOVER_CLASS}`,
                  )}
                >
                  <Icon
                    className={`h-4 w-4 flex-shrink-0 ${
                      isActive ? "text-gray-900" : "text-black"
                    }`}
                  />
                  <span className="text-sm font-medium">{label}</span>
                </Link>
              </div>
            );
          })}
        </nav>

        {pathname.startsWith("/assistant") && (
          <section
            aria-label="Assistant history"
            className="flex min-h-0 flex-1 flex-col pb-2"
          >
            <h2 className="mb-1 px-5 text-xs font-semibold text-gray-500">
              History
            </h2>
            <div
              id="assistant-history"
              className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {!assistantChats ? (
                <div className="space-y-1.5 px-2.5">
                  {[45, 65].map((width, index) => (
                    <div
                      key={index}
                      className="flex h-8 items-center rounded-md px-2.5"
                    >
                      <div className="mr-2 h-3.5 w-3.5 shrink-0 rounded bg-gray-200" />
                      <div
                        className="h-3 rounded bg-gray-200"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  ))}
                </div>
              ) : assistantChats.length === 0 ? (
                <div className="px-5 py-2 text-xs text-gray-500">
                  No chats yet
                </div>
              ) : (
                <>
                  <div className="space-y-1.5 px-2.5">
                    {assistantChats.map((chat) => (
                      <SidebarChatItem
                        key={chat.id}
                        chat={chat}
                        isActive={routeChatId === chat.id}
                        href={`/assistant/chat/${chat.id}`}
                        onNavigate={mobileOpen ? onToggle : undefined}
                      />
                    ))}
                  </div>
                  {hasMoreChats && (
                    <div className="px-2.5 pt-1">
                      <button
                        type="button"
                        onClick={loadMoreChats}
                        className={cn(
                          "flex h-8 w-full items-center justify-start rounded-md px-3 text-left text-xs font-medium text-gray-500 hover:text-gray-700",
                          APP_SURFACE_HOVER_CLASS,
                        )}
                      >
                        Load more
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        <div className="mt-auto p-1">
          {isAnonymousMode ? (
            <Link
              href="/account/api-keys"
              prefetch={false}
              onClick={mobileOpen ? onToggle : undefined}
              title="API keys"
              aria-current={
                pathname === "/account/api-keys" ? "page" : undefined
              }
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border-t border-gray-300 px-3 py-3 text-sm text-gray-700",
                pathname === "/account/api-keys"
                  ? APP_SURFACE_ACTIVE_CLASS
                  : APP_SURFACE_HOVER_CLASS,
              )}
            >
              <KeyRound className="h-4 w-4 shrink-0" />
              <span>API keys</span>
            </Link>
          ) : (
            <details className="group relative">
              <summary
                className={cn(
                  "flex w-full cursor-pointer list-none items-center rounded-xl border-t border-gray-300 px-2.5 py-3 [&::-webkit-details-marker]:hidden",
                  pathname === "/account"
                    ? APP_SURFACE_ACTIVE_CLASS
                    : `${APP_SURFACE_HOVER_CLASS} group-open:bg-app-surface-active`,
                )}
                title={user.email}
                aria-label="Account menu"
              >
                <div className="h-6.5 w-6.5 flex-shrink-0 rounded-full bg-gray-700 flex items-center justify-center text-white text-sm font-medium font-serif">
                  {(profile?.displayName || user.email)
                    .charAt(0)
                    .toUpperCase()}
                </div>
                <div
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 pl-3 text-left"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="text-sm font-medium leading-none text-gray-900">
                      {profile
                        ? profile.displayName || user.email.split("@")[0]
                        : ""}
                    </div>
                    <div className="text-[12px] leading-none text-gray-500">
                      {profile ? profile.tier || "Free" : ""}
                    </div>
                  </div>
                  <ChevronsUpDown
                    aria-hidden="true"
                    className="h-4 w-4 flex-shrink-0 text-gray-500"
                  />
                </div>
              </summary>

              <div className="absolute bottom-full left-0 z-50 mb-1 w-56 whitespace-nowrap rounded-xl border border-gray-300 bg-white p-1">
                <Link
                  href="/account"
                  prefetch={false}
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    if (mobileOpen) onToggle();
                  }}
                  aria-current={pathname === "/account" ? "page" : undefined}
                  className="flex w-full items-center gap-2 rounded-md px-4 py-2 text-left text-sm text-gray-800 hover:bg-gray-100"
                >
                  <User className="h-4 w-4" />
                  Account Settings
                </Link>
              </div>
            </details>
          )}
        </div>
      </aside>
    </>
  );
}
