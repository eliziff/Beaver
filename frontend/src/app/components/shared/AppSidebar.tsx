import { useNavigationPrefetch } from "@/app/hooks/useNavigationPrefetch";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { BookOpenCheck, BookOpenText, ChevronRight, Files, History, PanelLeft, Settings, SlidersHorizontal, SquarePen, Trash2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { BeaverIcon } from "@/app/components/chat/beaver-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
  ChatSkeuoIcon,
  TabularReviewSkeuoIcon,
  LibrarySkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { cn } from "@/app/lib/utils";
import {
  APP_SURFACE_ACTIVE_CLASS,
  APP_SURFACE_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";
import type { Chat } from "@/app/lib/api/chat";
import { RecyclingBinModal } from "@/app/components/assistant/RecyclingBinModal";
import { AppSettingsModal } from "@/app/components/settings/AppSettingsModal";
import { SelectAssistantProjectModal } from "@/app/components/assistant/SelectAssistantProjectModal";
import { SearchBar } from "@/app/components/ui/search-bar";
import { chatSearchPath, useChatSearch } from "@/app/components/assistant/chatSearch";
import { AdvancedHistorySearch } from "@/app/components/assistant/AdvancedHistorySearch";
import { ChatSearchResult } from "@/app/components/assistant/ChatSearchResult";
import { TabList } from "@/app/components/ui/tabs";
import { SidebarReviewHistory } from "@/app/components/tabular/SidebarReviewHistory";
import { CollectionState } from "./CollectionState";
const NAV_ITEMS = [
  { href: "/projects", label: "Projects", icon: FolderSvgIcon },
  { href: "/library", label: "Library", icon: LibrarySkeuoIcon },
  { href: "/sources", label: "Sources", icon: BookOpenText },
  { href: "/workflows", label: "Workflows", icon: WorkflowSkeuoIcon },
  { href: "/court-records", label: "Court Records", icon: Files },
  { href: "/table-of-authorities", label: "Authorities", icon: BookOpenCheck },
];
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const CHAT_DRAG_TYPE = "application/x-beaver-chat-ids";
interface AppSidebarProps {
  mobileOpen: boolean;
  onToggle: () => void;
}
export function AppSidebar({
  mobileOpen,
  onToggle,
}: AppSidebarProps) {
  const { pathname } = useLocation();
  const [recyclingOpen, setRecyclingOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState(() => pathname.startsWith("/tabular-reviews") ? "reviews" : "assistant");
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearchOnOpen = useRef(false);
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
  const { chats, loadChats, deleteChat, moveChat, hasMoreChats, loadMoreChats } =
    useChatHistoryContext();
  const search = historySearch.trim();
  const searchedChats = useChatSearch({ search }, !!search && historyTab === "assistant");
  const showingSearch = !!search && (searchedChats.loaded || searchedChats.items.length > 0 || !!searchedChats.error);
  const prefetch = useNavigationPrefetch();
  const navigate = useNavigate();
  useLayoutEffect(() => {
    if (pathname.startsWith("/tabular-reviews")) setHistoryTab("reviews");
    else if (pathname.startsWith("/assistant")) setHistoryTab("assistant");
  }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const sidebar = sidebarRef.current;
    const frame = requestAnimationFrame(() => {
      (focusSearchOnOpen.current ? searchRef : closeButtonRef).current?.focus();
      focusSearchOnOpen.current = false;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (
        opener?.isConnected &&
        sidebar?.contains(document.activeElement)
      ) {
        opener.focus();
      }
    };
  }, [mobileOpen]);
  useEffect(() => {
    function focusHistory(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setHistoryCollapsed(false);
      if (!searchRef.current?.getClientRects().length) {
        focusSearchOnOpen.current = true;
        onToggle();
      } else searchRef.current.focus();
    }
    document.addEventListener("keydown", focusHistory);
    return () => document.removeEventListener("keydown", focusHistory);
  }, [onToggle]);
  const routeChatId = pathname.startsWith("/assistant/chat/")
    ? pathname.split("/").pop() ?? null
    : (pathname.match(/^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/)?.[1] ??
      null);
  const assistantChats =
    (showingSearch ? searchedChats.items : chats)?.filter(
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
      await moveChat(chat.id, projectId);
    } finally {
      setMovingChatIds((current) => {
        const next = new Set(current);
        next.delete(chat.id);
        return next;
      });
    }
  }
  const closeNavigation = mobileOpen ? onToggle : undefined;
  const navLinks = (items: typeof NAV_ITEMS) => items.map(({ href, label, icon: Icon }) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return <Link key={href} to={href} onClick={closeNavigation}
      onPointerEnter={event => { if (event.pointerType !== "touch") prefetch(href); }} onFocus={() => prefetch(href)}
      aria-current={active ? "page" : undefined}
      className={cn("flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium [@media(max-height:500px)]:min-h-7 [@media(max-height:500px)]:py-0",
        active ? APP_SURFACE_ACTIVE_CLASS : APP_SURFACE_HOVER_CLASS)}>
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{label}
    </Link>;
  });
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
          if (!mobileOpen || (event.target as HTMLElement).closest('[role="menu"]')) return;
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
        <div className="flex shrink-0 items-center justify-between px-2.5 py-2">
          <div className="px-2">
            <Link
              to="/assistant"
              className="flex items-center gap-1.5 hover:opacity-80"
              onClick={mobileOpen ? onToggle : undefined}
            >
              <BeaverIcon size={22} />
              <span className="text-2xl font-medium font-serif">Beaver</span>
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
        <div className="flex min-h-0 flex-1 flex-col px-2.5">
          <nav aria-label="Primary" className="flex min-h-0 flex-col">
            <SearchBar ref={searchRef} size="sm" aria-label="Search history" aria-keyshortcuts="Control+k Meta+k" placeholder="Search history" value={historySearch} wrapperClassName="my-1 shrink-0"
              action={<button type="button" aria-label="Advanced search" title="Advanced search" aria-haspopup="dialog" onClick={() => { setAdvancedSearchOpen(true); closeNavigation?.(); }} className="grid size-6 shrink-0 place-items-center rounded text-gray-500 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900"><SlidersHorizontal aria-hidden="true" className="size-3.5" /></button>}
              onValueChange={(value) => { setHistorySearch(value); setHistoryCollapsed(false); }}
              onKeyDown={(event) => { if (event.key === "Escape" && historySearch) { event.stopPropagation(); setHistorySearch(""); } }} />
            <TabList value={historyTab} onValueChange={setHistoryTab} ariaLabel="Workspace history" variant="subtab"
              className="mb-1 [&_[role=tab]:hover]:bg-transparent [&_[aria-selected=false]:hover]:text-gray-500 [&_[aria-selected=true]:hover]:text-gray-900 [&_[aria-selected=true]]:border-red-600 [&_[aria-selected=true]]:font-semibold"
              options={[{ value: "assistant", label: <span className="flex items-center justify-center gap-1"><ChatSkeuoIcon className="size-5 shrink-0" />Assistant</span> }, { value: "reviews", label: <span className="flex items-center justify-center gap-1"><TabularReviewSkeuoIcon className="size-5 shrink-0" />Tabular review</span> }]} />
            <div className="relative">
              <button type="button" aria-label={historyCollapsed ? "Expand history" : "Collapse history"} aria-expanded={!historyCollapsed} onClick={() => setHistoryCollapsed(!historyCollapsed)} className="absolute right-0 top-0.5 z-10 grid size-7 place-items-center rounded text-gray-500 hover:bg-gray-100"><ChevronRight className={cn("size-3.5", !historyCollapsed && "rotate-90")} /></button>
            <div hidden={historyTab !== "reviews"}>
              <SidebarReviewHistory collapsed={historyCollapsed} active={historyTab === "reviews"} search={search} onNavigate={() => closeNavigation?.()} />
            </div>
            <div hidden={historyTab !== "assistant"}>
          <section id="assistant-conversations" aria-label="Assistant conversations" className="mb-2 flex min-h-0 flex-col [@media(max-height:500px)]:mb-0">
            <Link to="/assistant" onClick={() => { setHistorySearch(""); closeNavigation?.(); }} aria-label="New chat" className="mr-8 flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium text-gray-800 hover:bg-gray-100"><SquarePen className="size-3.5" />New chat</Link>
            {!historyCollapsed && <div
              id="assistant-history"
              aria-busy={!!search && searchedChats.loading}
              className="h-[clamp(2rem,calc(100dvh-33rem),10rem)] overflow-y-auto overscroll-contain ps-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {!assistantChats ? (
                <CollectionState loading className="min-h-8 justify-start px-2 text-xs">Loading…</CollectionState>
              ) : assistantChats.length === 0 ? (
                <div className="px-2 py-2 text-xs text-gray-500">
                  {search ? searchedChats.loading ? "Searching…" : searchedChats.error ? "Could not search history" : "0 results" : "No chats yet"}
                </div>
              ) : (
                <>
                  <div className="space-y-0">
                    {assistantChats.map((chat) => showingSearch ? <ChatSearchResult key={chat.id} chat={chat} query={searchedChats.searchQuery} compact isActive={routeChatId === chat.id} onNavigate={closeNavigation} /> : (
                      <SidebarChatItem
                        key={chat.id}
                        chat={chat}
                        showIcon={false}
                        isActive={routeChatId === chat.id}
                        isSelected={selectedChatIds.has(chat.id)}
                        selectedCount={selectedChatIds.size}
                        isSelectionActionOwner={
                          selectionActionChatId === chat.id
                        }
                        to={chatSearchPath(chat)}
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
                </>
              )}
              {(search ? searchedChats.hasMore : hasMoreChats) && <button type="button" disabled={!!search && searchedChats.loading} onClick={() => search ? void searchedChats.loadMore() : loadMoreChats()} className="h-8 w-full rounded-md px-2 text-left text-xs text-gray-500 hover:bg-gray-100">Load more</button>}
            </div>}
          </section></div></div>

            <div className="mb-2 shrink-0 border-b border-gray-200 pb-2">
              <button
                type="button"
                disabled={recyclingBusy}
                onClick={() => {
                  if (selectedChatIds.size) void recycleChats([...selectedChatIds]);
                  else setRecyclingOpen(true);
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
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-gray-500 hover:text-gray-900 disabled:opacity-50",
                  recyclingDragOver
                    ? "bg-red-100 text-red-800"
                    : APP_SURFACE_HOVER_CLASS,
                )}
              >
                <Trash2 className="size-3.5 shrink-0" />
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

            <div className="space-y-1">{navLinks(NAV_ITEMS)}</div>
          </nav>
        </div>
        <div className="shrink-0 border-t border-gray-300 p-1">
          <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              if (mobileOpen) onToggle();
            }}
            className={cn(
              "flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-sm font-medium text-gray-700",
              APP_SURFACE_HOVER_CLASS,
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            Settings
          </button>
          <Link to="/history" onClick={closeNavigation} aria-label="Activity log" title="Activity log" className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-gray-200/60">
            <History aria-hidden="true" className="h-4 w-4" />
          </Link>
          </div>
        </div>
      </aside>
        {advancedSearchOpen && <AdvancedHistorySearch initialQuery={historySearch} initialContext={historyTab === "reviews" ? "reviews" : "assistant"}
          onClose={() => setAdvancedSearchOpen(false)} />}
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
          <AppSettingsModal
            open
            onClose={() => setSettingsOpen(false)}
          />
        )}
    </>
  );
}

