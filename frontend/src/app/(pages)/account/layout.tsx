import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { connectorsEnabled, isLocalMode } from "@/app/lib/authMode";
import { accountTabButtonClassName } from "./accountStyles";

const TABS = [
    { label: "General", href: "/account" },
    { label: "Features", href: "/account/features" },
    { label: "Privacy & data", href: "/account/privacy-data" },
    { label: "Security", href: "/account/security" },
    { label: "Models", href: "/account/models" },
    { label: "API keys", href: "/account/api-keys" },
    { label: "Connectors", href: "/account/connectors" },
];

export default function AccountLayout() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const tabs = TABS.filter(({ href }) =>
        (href !== "/account/connectors" || connectorsEnabled) &&
        (!isLocalMode || ["/account/features", "/account/api-keys", "/account/connectors"].includes(href))
    );
    const activeTab =
        tabs.find(({ href }) =>
            pathname === href ||
            (href !== "/account" && pathname.startsWith(href))
        ) ?? tabs[0];

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="font-eb-garamond text-4xl font-medium">
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
                            onChange={(event) => navigate(event.target.value)}
                            className="h-9 w-auto max-w-full rounded-lg border border-gray-200 bg-white px-3 pr-8 text-sm text-gray-800 shadow-sm outline-none focus:border-gray-300 md:hidden"
                        >
                            {tabs.map(({ label, href }) => (
                                <option key={href} value={href}>
                                    {label}
                                </option>
                            ))}
                        </select>
                        <ul className="mb-0 hidden gap-1 md:flex md:flex-col">
                            {tabs.map((tab) => {
                                const active = tab === activeTab;
                                return (
                                    <li key={tab.href}>
                                        <Link
                                            aria-current={active ? "page" : undefined}
                                            to={tab.href}
                                            className={accountTabButtonClassName(active)}
                                        >
                                            {tab.label}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </nav>
                    <div className="min-w-0 outline-none">
                        <Outlet />
                    </div>
                </div>
            </main>
        </div>
    );
}
