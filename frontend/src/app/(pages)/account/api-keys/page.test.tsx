import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeySettings as ApiKeysPage } from "@/app/components/settings/ApiKeySettings";

const mocks = vi.hoisted(() => ({ local: true, update: vi.fn(async () => true) }));
vi.mock("@/app/lib/api/auth", async (original) => ({
    ...await original<object>(),
    getMfaAssurance: async () => ({ currentLevel: null, nextLevel: null }),
}));
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
                "opencode-go": { configured: false, source: null },
                meta: { configured: false, source: null },
                courtlistener: { configured: true, source: "env" },
            },
        },
        updateApiKey: mocks.update,
    }),
}));

describe("local API-key settings", () => {
    beforeEach(() => {
        mocks.local = true;
    });

    it("saves a masked personal key over the local server key", async () => {
        render(<ApiKeysPage />);
        const input = screen.getByLabelText("DeepSeek");
        expect(input).toHaveAttribute("type", "password");
        expect(input).toBeEnabled();
        fireEvent.change(input, { target: { value: "personal-key" } });
        fireEvent.submit(input.closest("form")!);
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("deepseek", "personal-key"));
        await waitFor(() => expect(input).toHaveValue(""));
        expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    });

    it("keeps editable controls in cloud mode", () => {
        mocks.local = false;
        const { container } = render(<ApiKeysPage />);
        const inputs = Array.from(
            container.querySelectorAll<HTMLInputElement>('input[name="key"]'),
        );

        expect(inputs).toHaveLength(8);
        expect(inputs.filter((input) => input.disabled)).toHaveLength(0);
        expect(
            screen.getAllByRole("button", { name: "Save" }),
        ).toHaveLength(8);
    });
});
