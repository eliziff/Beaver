import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from "react";import { BookOpenText, History, PanelLeft, Settings, Trash2 } from "lucide-react";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
  ChatSkeuoIcon,
  LibrarySkeuoIcon,
  TableOfAuthoritiesSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { cn } from "@/app/lib/utils";
import { isLocalMode } from "@/app/lib/authMode";
import {
  APP_SURFACE_ACTIVE_CLASS,
  APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
const loadRecyclingBinModal = () =>  import("@/app/components/assistant/RecyclingBinModal").then(    (module) => module.RecyclingBinModal,  );const loadSettingsModal = () =>  import("@/app/components/settings/AppSettingsModal").then(    (module) => module.AppSettingsModal,  );const RecyclingBinModal = lazy(async () => ({  default: await loadRecyclingBinModal(),}));const AppSettingsModal = lazy(async () => ({  default: await loadSettingsModal(),}));const SelectAssistantProjectModal = lazy(() =>  import("@/app/components/assistant/SelectAssistantProjectModal").then(    (module) => ({ default: module.SelectAssistantProjectModal }),  ),);import { updateChatProject } from "@/app/lib/beaverApi";
import type { Chat } from "@/app/components/shared/types";
const NAV_ITEMS = [
  { href: "/assistant", label: "Assistant", icon: ChatSkeuoIcon },
  { href: "/projects", label: "Projects", icon: FolderSvgIcon },
  { href: "/library", label: "Library", icon: LibrarySkeuoIcon },
  { href: "/sources", label: "Sources", icon: BookOpenText },
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
  ...(!isLocalMode
    ? [{ href: "/history", label: "History", icon: History }]
    : []),
];
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const CHAT_DRAG_TYPE = "application/x-beaver-chat-ids";
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
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [recyclingDragOver, setRecyclingDragOver] = useState(false);
  const [recyclingBusy, setRecyclingBusy] = useState(false);
  const [movingChatIds, setMovingChatIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selectionAnchorRef = useRef<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const { chats, hasMoreChats, loadMoreChats, loadChats, deleteChat } =
    useChatHistoryContext();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!mobileOpen) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const frame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (
        opener?.isConnected &&
        sidebarRef.current?.contains(document.activeElement)
      ) {
        opener.focus();
      }
    };
  }, [mobileOpen]);
  const routeChatId = pathname.startsWith("/assistant/chat/")
    ? pathname.split("/").pop() ?? null
    : (pathname.match(/^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/)?.[1] ??
      null);
  const assistantChats =
    chats?.filter(
      (chat) => !chat.project_id && !movingChatIds.has(chat.id),
    ) ?? chats;
  const selectionActionChatId =
    assistantChats?.find((chat) => selectedChatIds.has(chat.id))?.id ?? null;
  function selectChat(
    chatId: string,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) {
    const ids = assistantChats?.map((chat) => chat.id) ?? [];
    setSelectedChatIds((current) => {
      if (modifiers.shiftKey && selectionAnchorRef.current) {
        const anchor = ids.indexOf(selectionAnchorRef.current);
        const target = ids.indexOf(chatId);
        if (anchor >= 0 && target >= 0) {
          const next =
            modifiers.ctrlKey || modifiers.metaKey
              ? new Set(current)
              : new Set<string>();
          for (
            let index = Math.min(anchor, target);
            index <= Math.max(anchor, target);
            index += 1
          ) {
            next.add(ids[index]);
          }
          return next;
        }
      }
      selectionAnchorRef.current = chatId;
      const next = new Set(current);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }
  function dragChat(chatId: string, event: DragEvent<HTMLDivElement>) {
    const ids = selectedChatIds.has(chatId)
      ? [...selectedChatIds]
      : [chatId];
    if (!selectedChatIds.has(chatId)) {
      selectionAnchorRef.current = chatId;
      setSelectedChatIds(new Set(ids));
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(CHAT_DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.setData("text/plain", ids.join(","));
  }
  async function recycleChats(ids: string[]) {
    const uniqueIds = [...new Set(ids)].filter((id) =>
      assistantChats?.some((chat) => chat.id === id),
    );
    if (!uniqueIds.length) return;
    setRecyclingBusy(true);
    setRecyclingDragOver(false);
    try {
      await Promise.all(uniqueIds.map((id) => deleteChat(id)));
      if (routeChatId && uniqueIds.includes(routeChatId)) {
        navigate("/assistant", { replace: true });
      }
    } finally {
      setSelectedChatIds(new Set());
      selectionAnchorRef.current = null;
      setRecyclingBusy(false);
    }
  }
  function dropChats(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    let ids: unknown;
    try {
      ids = JSON.parse(event.dataTransfer.getData(CHAT_DRAG_TYPE));
    } catch {
      ids = null;
    }
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
      void recycleChats(ids);
    } else {
      setRecyclingDragOver(false);
    }
  }
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
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[98] bg-gray-950/30 lg:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}
      <aside
        ref={sidebarRef}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? "Navigation" : undefined}
        onKeyDown={(event) => {
          if (!mobileOpen) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onToggle();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              FOCUSABLE_SELECTOR,
            ),
          );
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className={cn(
          mobileOpen
            ? "max-lg:h-[calc(100dvh-1rem)] max-lg:w-64"
            : "max-lg:hidden",
          "lg:h-[calc(100dvh-1.5rem)] lg:w-64",
          "my-2 ml-2 mr-0 lg:my-3 lg:ml-3 lg:mr-0 rounded-2xl border border-gray-300 bg-app-surface overflow-visible",
          "flex flex-col absolute lg:relative z-[99] overscroll-contain [contain:paint]",
        )}
      >
        <div className="flex items-center justify-between px-2.5 py-3">
          <div className="px-2">
            <Link
              to="/assistant"
              className="flex items-center gap-1.5 hover:opacity-80"
              onClick={mobileOpen ? onToggle : undefined}
            >
              <BeaverIcon size={22} />
              <span className="text-2xl font-light font-serif">Beaver</span>
            </Link>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
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
                  to={href}
                  onClick={() => {
                    if (href === "/table-of-authorities") {
                      onAuthoritiesNavigate?.();
                    }
                    if (mobileOpen) onToggle();
                  }}
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
                        isSelected={selectedChatIds.has(chat.id)}
                        selectedCount={selectedChatIds.size}
                        isSelectionActionOwner={
                          selectionActionChatId === chat.id
                        }
                        to={`/assistant/chat/${chat.id}`}
                        onNavigate={mobileOpen ? onToggle : undefined}
                        onClearSelection={() => {
                          setSelectedChatIds(new Set());
                          selectionAnchorRef.current = chat.id;
                        }}
                        onSelect={(modifiers) =>
                          selectChat(chat.id, modifiers)
                        }
                        onDragChat={(event) => dragChat(chat.id, event)}
                        onMoveToProject={() => {
                          setChatProjectTarget(chat);
                          if (mobileOpen) onToggle();
                        }}
                        onDeleteSelection={() =>
                          recycleChats([...selectedChatIds])
                        }
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
                disabled={recyclingBusy}
                onPointerEnter={() => void loadRecyclingBinModal()}
                onClick={() => {
                  if (selectedChatIds.size) {
                    void recycleChats([...selectedChatIds]);
                  } else {
                    setRecyclingOpen(true);
                  }
                  if (mobileOpen) onToggle();
                }}
                onDragEnter={(event) => {
                  if (event.dataTransfer.types.includes(CHAT_DRAG_TYPE)) {
                    event.preventDefault();
                    setRecyclingDragOver(true);
                  }
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(CHAT_DRAG_TYPE)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    setRecyclingDragOver(false);
                  }
                }}
                onDrop={dropChats}
                aria-label={
                  selectedChatIds.size
                    ? `Move ${selectedChatIds.size} selected ${selectedChatIds.size === 1 ? "chat" : "chats"} to Recycling bin`
                    : "Recycling bin"
                }
                className={cn(
                  "flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm font-medium text-gray-700 disabled:opacity-50",
                  recyclingDragOver
                    ? "bg-red-100 text-red-800"
                    : APP_SURFACE_HOVER_CLASS,
                )}
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                Recycling bin
                <span
                  aria-hidden="true"
                  className="ml-auto w-5 text-right text-xs tabular-nums text-red-700"
                >
                  {selectedChatIds.size || ""}
                </span>
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {selectedChatIds.size
                  ? `${selectedChatIds.size} ${selectedChatIds.size === 1 ? "chat" : "chats"} selected`
                  : ""}
              </span>
            </div>
          </section>
        )}
        <div className="mt-auto border-t border-gray-300 p-1">
          <button            type="button"            onPointerEnter={() => void loadSettingsModal()}            onClick={() => {              setSettingsOpen(true);
              if (mobileOpen) onToggle();
            }}
            className={cn(
              "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium text-gray-700",
              APP_SURFACE_HOVER_CLASS,
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            Settings
          </button>
        </div>
      </aside>
      <Suspense fallback={null}>        {chatProjectTarget && (          <SelectAssistantProjectModal            open            onClose={() => setChatProjectTarget(null)}            chatTitle={chatProjectTarget.title}            currentLocation="Assistant"            currentProjectId={chatProjectTarget.project_id}            onSelectProject={moveChatToProject}          />        )}        {recyclingOpen && (          <RecyclingBinModal            open            onClose={() => setRecyclingOpen(false)}            onRestored={loadChats}          />        )}        {settingsOpen && (          <AppSettingsModal open onClose={() => setSettingsOpen(false)} />        )}      </Suspense>    </>
  );
}
