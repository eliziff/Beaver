"use client";

import { useMemo, useState } from "react";
import { PanelLeft, Settings, Trash2 } from "lucide-react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
  ChatSkeuoIcon,
  LibrarySkeuoIcon,
  TableOfAuthoritiesSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { cn } from "@/app/lib/utils";
import {
  APP_SURFACE_ACTIVE_CLASS,
  APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import { RecyclingBinModal } from "@/app/components/assistant/RecyclingBinModal";
import { AppSettingsModal } from "@/app/components/settings/AppSettingsModal";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { updateChatProject } from "@/app/lib/beaverApi";
import type { Chat } from "@/app/components/shared/types";

const NAV_ITEMS = [
  { href: "/assistant", label: "Assistant", icon: ChatSkeuoIcon },
  { href: "/projects", label: "Projects", icon: FolderSvgIcon },
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
  onAuthoritiesNavigate: () => void;
}

export function AppSidebar({
  mobileOpen,
  onToggle,
  onAuthoritiesNavigate,
}: AppSidebarProps) {
  const [recyclingOpen, setRecyclingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatProjectTarget, setChatProjectTarget] = useState<Chat | null>(null);
  const [movingChatIds, setMovingChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const { chats, hasMoreChats, loadMoreChats, loadChats } =
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
    () =>
      chats?.filter(
        (chat) => !chat.project_id && !movingChatIds.has(chat.id),
      ) ?? chats,
    [chats, movingChatIds],
  );

  async function moveChatToProject(projectId: string | null) {
    const chat = chatProjectTarget;
    if (!chat) return;
    setMovingChatIds((current) => new Set(current).add(chat.id));
    setChatProjectTarget(null);
    try {
      const updated = await updateChatProject(chat.id, projectId);
      if (routeChatId === chat.id) {
        window.dispatchEvent(
          new CustomEvent("beaver:chat-project-moved", {
            detail: {
              chatId: chat.id,
              projectId: updated.project_id,
            },
          }),
        );
      }
      await loadChats().catch(() => {});
    } finally {
      setMovingChatIds((current) => {
        const next = new Set(current);
        next.delete(chat.id);
        return next;
      });
    }
  }

  return (
    <>
      {/* Compact layouts use an overlay so the page keeps its working width. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[98] bg-gray-950/30 lg:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          mobileOpen
            ? "max-lg:h-[calc(100dvh-1rem)] max-lg:w-64"
            : "max-lg:hidden",
          "lg:h-[calc(100dvh-1.5rem)] lg:w-64",
          "my-2 ml-2 mr-0 lg:my-3 lg:ml-3 lg:mr-0 rounded-2xl border border-gray-300 bg-app-surface overflow-visible",
          "flex flex-col absolute lg:relative z-[99] [contain:paint]",
        )}
      >
        <div className="flex items-center justify-between px-2.5 py-3">
          <div className="px-2">
            <Link
              href="/assistant"
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
              "flex h-9 w-9 items-center p-2.5 lg:hidden",
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
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <div key={href} className="px-2.5 py-0.5">
                <Link
                  href={href}
                  onNavigate={
                    href === "/table-of-authorities"
                      ? onAuthoritiesNavigate
                      : undefined
                  }
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
                        onMoveToProject={() => {
                          setChatProjectTarget(chat);
                          if (mobileOpen) onToggle();
                        }}
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
            <div className="shrink-0 px-2.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  setRecyclingOpen(true);
                  if (mobileOpen) onToggle();
                }}
                className={cn(
                  "flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium text-gray-700",
                  APP_SURFACE_HOVER_CLASS,
                )}
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                Recycling bin
              </button>
            </div>
          </section>
        )}

        <div className="mt-auto p-1">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              if (mobileOpen) onToggle();
            }}
            className={cn(
              "flex h-11 w-full items-center gap-3 rounded-xl border-t border-gray-300 px-3 text-sm font-medium text-gray-700",
              APP_SURFACE_HOVER_CLASS,
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            Settings
          </button>
        </div>
      </aside>
      {chatProjectTarget && (
        <SelectAssistantProjectModal
          open
          onClose={() => setChatProjectTarget(null)}
          chatTitle={chatProjectTarget.title}
          currentLocation="Assistant"
          currentProjectId={chatProjectTarget.project_id}
          onSelectProject={moveChatToProject}
        />
      )}
      {recyclingOpen && (
        <RecyclingBinModal
          open
          onClose={() => setRecyclingOpen(false)}
          onRestored={loadChats}
        />
      )}
      {settingsOpen && (
        <AppSettingsModal open onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}
