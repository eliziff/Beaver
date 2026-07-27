"use client";

import { useState, useEffect, useMemo } from "react";
import {
  PanelLeft,
  User,
  ChevronsUpDown,
  ChevronDown,
  KeyRound,
} from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode } from "@/app/lib/authMode";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
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
import { ProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { listProjects } from "@/app/lib/beaverApi";
import type { Project } from "@/app/components/shared/types";
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
  desktopOpen: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
}

export function AppSidebar({
  desktopOpen,
  mobileOpen,
  onToggle,
}: AppSidebarProps) {
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { chats, hasMoreChats, loadMoreChats, setCurrentChatId } =
    useChatHistoryContext();
  const router = useRouter();
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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Project[] | null>(null);
  const assistantChats = useMemo(
    () => chats?.filter((chat) => !chat.project_id) ?? chats,
    [chats],
  );
  const expandedOnly = cn(
    !mobileOpen && "max-md:hidden",
    !desktopOpen && "md:hidden",
  );

  useEffect(() => {
    if (
      !user ||
      (pathname !== "/projects" && !pathname.startsWith("/projects/"))
    )
      return;
    listProjects()
      .then((projects) => {
        setRecentProjects(
          [...projects]
            .sort(
              (a, b) =>
                Date.parse(b.updated_at || b.created_at) -
                Date.parse(a.updated_at || a.created_at),
            )
            .slice(0, 5),
        );
      })
      .catch(() => {
        setRecentProjects([]);
      });
  }, [pathname, user]);

  const navigate = (href: string) => {
    if (!window.matchMedia("(min-width: 768px)").matches && mobileOpen) {
      onToggle();
    }
    router.push(href);
  };

  useEffect(() => {
    const handleClickOutside = () => setIsDropdownOpen(false);
    if (isDropdownOpen) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [isDropdownOpen]);

  useEffect(() => {
    setCurrentChatId(routeChatId);
  }, [routeChatId, setCurrentChatId]);

  const getUserInitials = (email: string) => {
    if (profile?.displayName)
      return profile.displayName.charAt(0).toUpperCase();
    return email.charAt(0).toUpperCase();
  };

  const getDisplayName = () => {
    if (!profile) return "";
    return profile.displayName || user?.email?.split("@")[0] || "";
  };

  const getUserTier = () => {
    if (!profile) return "";
    return profile.tier || "Free";
  };

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
      <div
        className={cn(
          mobileOpen
            ? "max-md:h-[calc(100dvh-1rem)] max-md:w-64"
            : "max-md:hidden",
          desktopOpen ? "md:w-64" : "md:w-14",
          "md:h-[calc(100dvh-1.5rem)]",
          "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 rounded-2xl border border-gray-200 bg-app-surface overflow-visible",
          "flex flex-col absolute md:relative z-[99]",
        )}
      >
        {/* Toggle + Logo */}
        <div className="flex items-center justify-between px-2.5 py-3">
          <div className={cn("px-2", expandedOnly)}>
              <Link
                href="/assistant"
                prefetch={false}
                className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                onClick={() => {
                  if (
                    !window.matchMedia("(min-width: 768px)").matches &&
                    mobileOpen
                  ) {
                    onToggle();
                  }
                }}
              >
                <BeaverIcon size={22} />
                <span className="text-2xl font-light font-serif">
                  Beaver
                </span>
              </Link>
          </div>
          <button
            onClick={onToggle}
            className={cn(
              "h-9 w-9 p-2.5 items-center flex transition-colors",
              "rounded-md",
              APP_SURFACE_HOVER_CLASS,
            )}
            title="Toggle sidebar"
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        <nav
          aria-label="Primary"
          className="min-h-0 flex-1 overflow-y-auto pb-2"
        >
          {NAV_ITEMS.filter(
            ({ href }) =>
              !isAnonymousMode ||
              (href !== "/tabular-reviews" && href !== "/workflows"),
          ).map(({ href, label, icon: Icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <div key={href} role="group" aria-label={label}>
                <div className="py-0.5 px-2.5">
                  <button
                    onClick={() => navigate(href)}
                    title={label}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left",
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
                    <span className={cn("text-sm font-medium", expandedOnly)}>
                      {label}
                    </span>
                  </button>
                </div>

                {isActive && href === "/assistant" && (
                  <div
                    className={cn(
                      "mb-2 min-h-0 flex-col",
                      expandedOnly,
                      (desktopOpen || mobileOpen) && "flex",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setHistoryCollapsed((value) => !value)}
                      aria-label="Assistant history"
                      aria-expanded={!historyCollapsed}
                      aria-controls="assistant-history"
                      className="mb-1 flex w-full items-center justify-between px-5 text-xs font-semibold text-gray-500 hover:text-gray-700"
                    >
                      <span>History</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 transition-transform ${
                          historyCollapsed ? "-rotate-90" : ""
                        }`}
                      />
                    </button>
                    <div
                      id="assistant-history"
                      className={cn(
                        "h-20 overflow-y-auto",
                        historyCollapsed && "hidden",
                      )}
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
                        <div
                          className="px-5 py-2 text-xs text-gray-500"
                        >
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
                                onSelect={() => {
                                  setCurrentChatId(chat.id);
                                  navigate(`/assistant/chat/${chat.id}`);
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
                                  "flex h-8 w-full items-center justify-start rounded-md px-3 text-left text-xs font-medium text-gray-500 transition-colors hover:text-gray-700",
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
                  </div>
                )}

                {isActive && href === "/projects" && (
                  <div className={cn("mb-2", expandedOnly)}>
                    <button
                      type="button"
                      onClick={() => setProjectsCollapsed((value) => !value)}
                      aria-expanded={!projectsCollapsed}
                      aria-controls="recent-projects"
                      className="mb-1 flex w-full items-center justify-between px-5 text-xs font-semibold text-gray-500 hover:text-gray-700"
                    >
                      <span>Recent projects</span>
                      <ChevronDown
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 transition-transform ${
                          projectsCollapsed ? "-rotate-90" : ""
                        }`}
                      />
                    </button>
                    {!projectsCollapsed && (
                      <div id="recent-projects">
                        {!recentProjects ? (
                          <div className="space-y-1 px-2.5">
                            {[50, 65, 45].map((width, index) => (
                              <div
                                key={index}
                                className="flex h-8 items-center rounded-md px-3"
                              >
                                <div
                                  className="h-3 rounded bg-gray-200"
                                  style={{ width: `${width}%` }}
                                />
                              </div>
                            ))}
                          </div>
                        ) : recentProjects.length === 0 ? (
                          <div className="px-5 py-2 text-xs text-gray-500">
                            No projects yet
                          </div>
                        ) : (
                          <div className="space-y-1 px-2.5">
                            {recentProjects.map((project) => {
                              const projectIsActive =
                                pathname === `/projects/${project.id}` ||
                                pathname.startsWith(
                                  `/projects/${project.id}/`,
                                );
                              return (
                                <button
                                  key={project.id}
                                  type="button"
                                  onClick={() =>
                                    navigate(`/projects/${project.id}`)
                                  }
                                  title={project.name}
                                  aria-current={
                                    projectIsActive ? "page" : undefined
                                  }
                                  className={cn(
                                    "flex h-8 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-xs transition-colors",
                                    projectIsActive
                                      ? `${APP_SURFACE_ACTIVE_CLASS} text-gray-900`
                                      : `text-gray-700 ${APP_SURFACE_HOVER_CLASS}`,
                                  )}
                                >
                                  <ProjectSvgIcon
                                    open={projectIsActive}
                                    className="h-3.5 w-3.5 shrink-0"
                                  />
                                  <span className="min-w-0 flex-1 truncate">
                                    {project.name}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* User Profile */}
        <div className="mt-auto p-1">
          {user && isAnonymousMode && (
            <button
              type="button"
              onClick={() => navigate("/account/api-keys")}
              title="API keys"
              aria-current={
                pathname === "/account/api-keys" ? "page" : undefined
              }
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border-t border-white/60 px-3 py-3 text-sm text-gray-700 transition-colors",
                pathname === "/account/api-keys"
                  ? APP_SURFACE_ACTIVE_CLASS
                  : APP_SURFACE_HOVER_CLASS,
              )}
            >
              <KeyRound className="h-4 w-4 shrink-0" />
              <span className={expandedOnly}>API keys</span>
            </button>
          )}
          {user && !isAnonymousMode && (
            <div className="relative">
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className={cn(
                  "flex items-center transition-colors w-full px-2.5 py-3 border-t",
                  "rounded-xl border-white/60",
                  pathname === "/account" || isDropdownOpen
                    ? APP_SURFACE_ACTIVE_CLASS
                    : APP_SURFACE_HOVER_CLASS,
                )}
                title={user.email}
              >
                <div className="h-6.5 w-6.5 flex-shrink-0 rounded-full bg-gray-700 flex items-center justify-center text-white text-sm font-medium font-serif">
                  {getUserInitials(user.email)}
                </div>
                <div
                  className={cn(
                    "text-left flex-1 min-w-0 pl-3 items-center justify-between gap-2",
                    expandedOnly,
                    (desktopOpen || mobileOpen) && "flex",
                  )}
                >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="text-sm font-medium text-gray-900 leading-none">
                        {getDisplayName()}
                      </div>
                      <div className="text-[12px] text-gray-500 leading-none">
                        {getUserTier()}
                      </div>
                    </div>
                    <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                </div>
              </button>

              {isDropdownOpen && (
                <div
                  className={cn(
                    "absolute bottom-full left-0 z-50 mb-1 w-56 p-1 whitespace-nowrap",
                    "bg-app-floating rounded-xl border border-gray-200 shadow-sm",
                  )}
                >
                  <button
                    onClick={() => {
                      router.push("/account");
                      setIsDropdownOpen(false);
                    }}
                    className={cn(
                      "w-full px-4 py-2 text-left text-sm text-gray-700 flex items-center gap-2 rounded-md",
                      "hover:bg-white",
                    )}
                  >
                    <User className="h-4 w-4" />
                    Account Settings
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
