"use client";

import { useCallback, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode, requiresAccount } from "@/app/lib/authMode";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";

export default function BeaverLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);

    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

    const handleSidebarToggle = () => {
        if (window.matchMedia("(min-width: 768px)").matches) {
            setDesktopSidebarOpen((open) => !open);
        } else {
            setMobileSidebarOpen((open) => !open);
        }
    };

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (authLoading) {
        return <FullScreenLoader />;
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <PageChromeContext.Provider value={{ mobileActionsContainer }}>
                <SidebarContext.Provider
                    value={{
                        setSidebarOpen: (open) => {
                            if (
                                window.matchMedia("(min-width: 768px)")
                                    .matches
                            ) {
                                setDesktopSidebarOpen(open);
                            } else {
                                setMobileSidebarOpen(open);
                            }
                        },
                    }}
                >
                    <div className="h-dvh flex flex-col bg-app-background">
                        <div className="flex-1 flex min-w-0 overflow-visible">
                            <AppSidebar
                                desktopOpen={desktopSidebarOpen}
                                mobileOpen={mobileSidebarOpen}
                                onToggle={handleSidebarToggle}
                            />
                            <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
                                {/* Mobile header */}
                                <div className="relative z-20 flex md:hidden items-center gap-3 overflow-visible px-4 pt-3 pb-2 shrink-0">
                                    <button
                                        onClick={handleSidebarToggle}
                                        className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-app-surface text-gray-700 hover:bg-app-floating"
                                        title="Open sidebar"
                                        aria-label="Open sidebar"
                                    >
                                        <PanelLeft className="h-4 w-4" />
                                    </button>
                                    <div
                                        ref={handleMobileActionsContainerRef}
                                        className="ml-auto flex min-w-0 flex-1 items-center justify-end"
                                    />
                                </div>
                                <main className="flex h-full w-full flex-1 flex-col overflow-y-auto md:overflow-hidden">
                                    {isAnonymousMode &&
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
                                    ) : (
                                        children
                                    )}
                                </main>
                            </div>
                        </div>
                    </div>
                </SidebarContext.Provider>
            </PageChromeContext.Provider>
        </ChatHistoryProvider>
    );
}
