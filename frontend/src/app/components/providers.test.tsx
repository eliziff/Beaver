// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/contexts/AuthContext", () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    UserProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));
import { Providers } from "./providers";

describe("Providers", () => {
    it("uses a composed login gate", () => {
        const Gate = ({ children }: { children: React.ReactNode }) => <section aria-label="Login gate">{children}</section>;
        render(<Providers LoginGate={Gate}><p>Cloud application</p></Providers>);
        expect(screen.getByRole("region", { name: "Login gate" })).toContainElement(
            screen.getByText("Cloud application"),
        );
    });
});
