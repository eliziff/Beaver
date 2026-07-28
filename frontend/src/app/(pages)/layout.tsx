"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode, requiresAccount } from "@/app/lib/authMode";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { KeyboardShortcuts } from "@/app/components/shared/KeyboardShortcuts";
import { AssistantAutomationActivity } from "@/app/components/assistant/AutomationRun";
import { TableOfAuthoritiesHost } from "@/app/components/shared/TableOfAuthoritiesHost";

export default function BeaverLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const authoritiesActive = pathname === "/table-of-authorities";
    const [authoritiesOrigin, setAuthoritiesOrigin] = useState<string | null>(
        null,
    );
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

    const handleSidebarToggle = () => setMobileSidebarOpen((open) => !open);
    const handleAuthoritiesNavigate = () => {
        if (pathname === "/table-of-authorities") return;
        setAuthoritiesOrigin(pathname);
    };

    const authoritiesIntent = authoritiesOrigin === pathname;
    const authoritiesVisible = authoritiesActive || authoritiesIntent;

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
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (!authLoading && !isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <KeyboardShortcuts />
            <SidebarContext.Provider
                value={{
                    setSidebarOpen: (open) => {
                        if (!window.matchMedia("(min-width: 1024px)").matches) {
                            setMobileSidebarOpen(open);
                        }
                    },
                }}
            >
                <div className="h-dvh flex flex-col bg-app-background">
                    <div className="flex-1 flex min-w-0 overflow-visible">
                        <AppSidebar
                            mobileOpen={mobileSidebarOpen}
                            onToggle={handleSidebarToggle}
                            onAuthoritiesNavigate={handleAuthoritiesNavigate}
                        />
                        <div className="flex-1 flex flex-col h-dvh lg:overflow-hidden relative w-full">
                            <div className="relative z-20 flex shrink-0 items-center px-4 pb-2 pt-3 lg:hidden">
                                <button
                                    onClick={handleSidebarToggle}
                                    className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating"
                                    title="Open sidebar"
                                    aria-label="Open sidebar"
                                >
                                    <PanelLeft className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="relative flex min-h-0 w-full flex-1">
                                <main className="flex h-full w-full flex-1 flex-col overflow-y-auto lg:overflow-hidden">
                                    {authLoading ? (
                                        <p
                                            className="m-auto px-6 text-sm text-gray-500"
                                            role="status"
                                        >
                                            Loading…
                                        </p>
                                    ) : isAnonymousMode &&
                                      requiresAccount(pathname) ? (
                                        <div className="m-auto px-6 text-center">
                                            <h1 className="text-2xl font-medium font-serif text-gray-900">
                                                Unavailable in local mode
                                            </h1>
                                            <p className="mt-2 text-sm text-gray-500">
                                                This feature is not available
                                                locally yet.
                                            </p>
                                        </div>
                                    ) : authoritiesVisible ? null : (
                                        children
                                    )}
                                </main>
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
                                        (isAnonymousMode ||
                                            authoritiesActive ||
                                            authoritiesIntent)
                                    }
                                />
                            </div>
                        </div>
                    </div>
                </div>
                <AssistantAutomationActivity />
            </SidebarContext.Provider>
        </ChatHistoryProvider>
    );
}
