import type { PropsWithChildren } from "react";
import { render, screen } from "@testing-library/react";
import {
    createMemoryRouter,
    RouterProvider,
    type RouteObject,
} from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AppShell from "./layout";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ authLoading: false, isAuthenticated: true }),
}));
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));
vi.mock("@/app/lib/runtimeConfig", () => ({
    getRuntimeConfig: () => ({ capabilities: { connectors: false } }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    ChatHistoryProvider: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/app/components/shared/AppSidebar", () => ({
    AppSidebar: () => <nav aria-label="Application" />,
}));
vi.mock("@/app/components/shared/KeyboardShortcuts", () => ({
    KeyboardShortcuts: () => null,
}));
vi.mock("@/app/components/assistant/AutomationRun", () => ({
    AssistantAutomationActivity: () => null,
}));

const children: RouteObject[] = [
    {
        path: "account/security",
        handle: { cloudOnly: true },
        element: <p>Security settings</p>,
    },
    { path: "account/features", element: <p>Feature settings</p> },
    {
        path: "account/connectors",
        handle: { capability: "connectors" },
        element: <p>Connector settings</p>,
    },
    {
        path: "history",
        element: <p>History</p>,
    },
    { path: "assistant", element: <p>Assistant route</p> },
];

function renderPath(path: string) {
    const router = createMemoryRouter(
        [{ path: "/", element: <AppShell />, children }],
        { initialEntries: [path] },
    );
    return render(<RouterProvider router={router} />);
}

describe("local route access", () => {
    it("keeps local settings available while hiding account-only settings", () => {
        const view = renderPath("/account/security");
        expect(screen.getByText("Unavailable in local mode")).toBeVisible();
        expect(screen.queryByText("Security settings")).not.toBeInTheDocument();

        view.unmount();
        renderPath("/account/features");
        expect(screen.getByText("Feature settings")).toBeVisible();
    });

    it("renders shared local history", async () => {
        renderPath("/history");
        expect(await screen.findByText("History")).toBeVisible();
    });

    it("hides capabilities disabled by the server", () => {
        renderPath("/account/connectors");
        expect(screen.getByText("Unavailable in this deployment")).toBeVisible();
        expect(screen.queryByText("Connector settings")).not.toBeInTheDocument();
    });
});
