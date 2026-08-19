import { lazy, Suspense, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PanelLeft } from "lucide-react";
import { AssistantAutomationActivity } from "@/app/components/assistant/AutomationRun";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { KeyboardShortcuts } from "@/app/components/shared/KeyboardShortcuts";
import { AuthoritiesLoadingFrame } from "@/app/components/shared/TableOfAuthoritiesFrame";
import { useAuth } from "@/app/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { isLocalMode, requiresAccount } from "@/app/lib/authMode";

const TableOfAuthoritiesHost = lazy(() =>
    import("@/app/components/shared/TableOfAuthoritiesHost").then((module) => ({
        default: module.TableOfAuthoritiesHost,
    })),
);

export default function AppShell() {
    const { isAuthenticated, authLoading } = useAuth();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const authoritiesActive = pathname === "/table-of-authorities";
    const [authoritiesOrigin, setAuthoritiesOrigin] = useState<string | null>(null);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const authoritiesIntent = authoritiesOrigin === pathname;
    const authoritiesVisible = authoritiesActive || authoritiesIntent;
    const authoritiesMounted = authoritiesVisible;

    useEffect(() => {
        if (authoritiesOrigin === null) return;
        const rollback = window.setTimeout(
            () => setAuthoritiesOrigin(null),
            pathname === authoritiesOrigin ? 2_000 : 0,
        );
        return () => window.clearTimeout(rollback);
    }, [authoritiesOrigin, pathname]);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            navigate("/login", { replace: true });
        }
    }, [authLoading, isAuthenticated, navigate]);

    if (!authLoading && !isAuthenticated) return null;
    const toggleSidebar = () => setMobileSidebarOpen((open) => !open);
    const prepareAuthorities = () => {
        if (authoritiesActive) return;
        void import("@/app/components/shared/TableOfAuthoritiesHost");
        setAuthoritiesOrigin(pathname);
    };

    return (
        <ChatHistoryProvider>
            <KeyboardShortcuts />
            <a
                href="#main-content"
                className="sr-only z-50 rounded bg-white px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
            >
                Skip to content
            </a>
            <SidebarContext.Provider
                value={{
                    setSidebarOpen: (open) => {
                        if (!window.matchMedia("(min-width: 1024px)").matches) {
                            setMobileSidebarOpen(open);
                        }
                    },
                }}
            >
                <div className="flex h-dvh flex-col bg-app-background">
                    <div className="flex min-w-0 flex-1 overflow-visible">
                        <AppSidebar
                            mobileOpen={mobileSidebarOpen}
                            onToggle={toggleSidebar}
                            onAuthoritiesNavigate={prepareAuthorities}
                        />
                        <div
                            inert={mobileSidebarOpen}
                            className="relative flex h-dvh w-full flex-1 flex-col lg:overflow-hidden"
                        >
                            <div className="relative z-20 flex shrink-0 items-center px-4 pb-2 pt-3 lg:hidden">
                                <button
                                    type="button"
                                    onClick={toggleSidebar}
                                    className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                    aria-label="Open sidebar"
                                >
                                    <PanelLeft aria-hidden="true" className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="relative flex min-h-0 w-full flex-1">
                                <main
                                    id="main-content"
                                    className="flex h-full w-full flex-1 flex-col overflow-y-auto md:max-lg:has-[aside[data-assistant-dock]]:overflow-visible md:max-lg:has-[aside[data-assistant-dock]]:pe-3.5 lg:overflow-hidden"
                                >
                                    {authLoading ? (
                                        <p className="m-auto px-6 text-sm text-gray-500" role="status">
                                            Loading…
                                        </p>
                                    ) : isLocalMode && requiresAccount(pathname) ? (
                                        <div className="m-auto px-6 text-center">
                                            <h1 className="font-serif text-2xl font-medium text-gray-900">
                                                Unavailable in local mode
                                            </h1>
                                            <p className="mt-2 text-sm text-gray-500">
                                                This feature is not available locally yet.
                                            </p>
                                        </div>
                                    ) : (
                                        <Outlet />
                                    )}
                                </main>
                                {authoritiesMounted && (
                                    <Suspense
                                        fallback={
                                            authoritiesVisible ? <AuthoritiesLoadingFrame /> : null
                                        }
                                    >
                                        <TableOfAuthoritiesHost
                                            active={
                                                authoritiesActive &&
                                                !authLoading &&
                                                isAuthenticated
                                            }
                                            pending={authoritiesIntent}
                                            enabled={
                                                !authLoading &&
                                                isAuthenticated &&
                                                authoritiesVisible
                                            }
                                        />
                                    </Suspense>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <AssistantAutomationActivity />
            </SidebarContext.Provider>
        </ChatHistoryProvider>
    );
}
