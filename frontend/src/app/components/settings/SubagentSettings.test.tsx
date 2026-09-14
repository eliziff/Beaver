import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { apiKeys: {} }, loading: false }),
}));
vi.mock("@/app/lib/modelCatalog", () => ({
    useModelCatalog: () => ({ models: [], readSubagents: { serverEnabled: true } }),
    preloadModelCatalog: () => Promise.resolve(),
}));

import { readAssistantPreferences } from "@/app/components/assistant/assistantPreferences";
import { SubagentSettings } from "./SubagentSettings";

describe("SubagentSettings", () => {
    beforeEach(() => window.localStorage.clear());

    it("toggles subagents on and off", async () => {
        const user = userEvent.setup();
        render(<SubagentSettings />);

        const toggle = screen.getByRole("switch", { name: "Subagents" });
        expect(toggle).not.toBeChecked();

        await user.click(toggle);
        expect(toggle).toBeChecked();
        expect(readAssistantPreferences().readSubagents.enabled).toBe(true);

        await user.click(toggle);
        expect(toggle).not.toBeChecked();
        expect(readAssistantPreferences().readSubagents.enabled).toBe(false);
    });
});
