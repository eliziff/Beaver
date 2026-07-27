import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ApiKeysPage from "./page";

vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: false, source: null },
                openai: { configured: false, source: null },
                deepseek: { configured: true, source: "env" },
                openrouter: { configured: false, source: null },
                courtlistener: { configured: true, source: "env" },
            },
        },
        updateApiKey: vi.fn(),
    }),
}));

describe("anonymous API-key settings", () => {
    it("shows environment status without secret controls", () => {
        render(<ApiKeysPage />);

        expect(screen.getAllByText("Configured")).toHaveLength(2);
        expect(screen.getAllByText("Not configured")).toHaveLength(4);
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Save" }),
        ).not.toBeInTheDocument();
    });
});
