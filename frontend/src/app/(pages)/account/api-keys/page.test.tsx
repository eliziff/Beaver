import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeySettings as ApiKeysPage } from "@/app/components/settings/ApiKeySettings";

const mocks = vi.hoisted(() => ({ local: true }));
vi.mock("@/app/lib/authMode", () => ({
    get isLocalMode() {
        return mocks.local;
    },
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: false, source: null },
                openai: { configured: false, source: null },
                deepseek: { configured: true, source: "env" },
                openrouter: { configured: false, source: null },
                meta: { configured: false, source: null },
                courtlistener: { configured: true, source: "env" },
            },
        },
        updateApiKey: vi.fn(),
    }),
}));

describe("local API-key settings", () => {
    beforeEach(() => {
        mocks.local = true;
    });

    it("shows environment status without secret controls", () => {
        render(<ApiKeysPage />);

        expect(screen.getAllByText("Configured")).toHaveLength(2);
        expect(screen.getAllByText("Not configured")).toHaveLength(5);
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Save" }),
        ).not.toBeInTheDocument();
    });

    it("keeps editable controls in cloud mode", () => {
        mocks.local = false;
        const { container } = render(<ApiKeysPage />);
        const inputs = Array.from(
            container.querySelectorAll<HTMLInputElement>('input[name="key"]'),
        );

        expect(inputs).toHaveLength(7);
        expect(inputs.filter((input) => input.disabled)).toHaveLength(2);
        expect(
            screen.getAllByRole("button", { name: "Save" }),
        ).toHaveLength(7);
    });
});
