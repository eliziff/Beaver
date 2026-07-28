"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode } from "@/app/lib/authMode";
import { accountTabButtonClassName } from "./accountStyles";

interface TabDef {
    id: string;
    label: string;
    href: string;
}

const TABS: TabDef[] = [
    { id: "general", label: "General", href: "/account" },
    { id: "features", label: "Features", href: "/account/features" },
    {
        id: "privacy-data",
        label: "Privacy & data",
        href: "/account/privacy-data",
    },
    { id: "security", label: "Security", href: "/account/security" },
    { id: "models", label: "Models", href: "/account/models" },
    { id: "api-keys", label: "API keys", href: "/account/api-keys" },
    { id: "connectors", label: "Connectors", href: "/account/connectors" },
];

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (!authLoading && !isAuthenticated) {
        return null;
    }

    const tabs = isAnonymousMode
        ? TABS.filter((tab) => tab.id === "api-keys")
        : TABS;
    const activeTab =
        tabs.find(
            (tab) =>
                pathname === tab.href ||
                (tab.href !== "/account" && pathname.startsWith(tab.href)),
        ) ?? tabs[0];

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="text-4xl font-medium font-eb-garamond">
                    Settings
                </h1>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 md:grid-cols-[224px_minmax(0,1fr)] md:gap-x-10">
                    <nav
                        aria-label="Settings"
                        className="z-10 min-w-0 self-start md:sticky md:top-4 md:-ml-3"
                    >
                        <select
                            aria-label="Settings section"
                            value={activeTab.href}
                            onChange={(event) =>
                                router.push(event.target.value)
                            }
                            className="h-9 w-auto max-w-full rounded-lg border border-gray-200 bg-white px-3 pr-8 text-sm text-gray-800 shadow-sm outline-none focus:border-gray-300 md:hidden"
                        >
                            {tabs.map((tab) => (
                                <option key={tab.id} value={tab.href}>
                                    {tab.label}
                                </option>
                            ))}
                        </select>
                        <ul className="mb-0 hidden gap-1 md:flex md:flex-col">
                            {tabs.map((tab) => {
                                const active = tab === activeTab;
                                return (
                                    <li key={tab.id}>
                                        <button
                                            type="button"
                                            aria-current={
                                                active ? "page" : undefined
                                            }
                                            onClick={() =>
                                                router.push(tab.href)
                                            }
                                            className={accountTabButtonClassName(
                                                active,
                                            )}
                                        >
                                            {tab.label}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>

                    <div
                        className="min-w-0 outline-none"
                        aria-busy={authLoading || undefined}
                    >
                        {authLoading ? (
                            <p className="py-8 text-sm text-gray-500">
                                Loading settings…
                            </p>
                        ) : (
                            children
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
