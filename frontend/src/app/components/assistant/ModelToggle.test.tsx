import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReasoningEffortToggle } from "./ModelToggle";

vi.mock("@/app/lib/mikeApi", () => ({
    getCodexModelCatalog: vi.fn().mockResolvedValue({
        source: "live",
        models: [
            {
                slug: "gpt-test",
                displayName: "GPT Test",
                defaultReasoningLevel: "low",
                supportedReasoningLevels: [
                    { effort: "low" },
                    { effort: "ultra" },
                ],
            },
        ],
    }),
}));

describe("ReasoningEffortToggle", () => {
    it("exposes effort as a separate control", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(
            <ReasoningEffortToggle
                model="codex-exec"
                value="low"
                onChange={onChange}
            />,
        );

        const trigger = await screen.findByRole("button", {
            name: "Reasoning effort: low",
        });
        await user.click(trigger);
        await user.click(
            await screen.findByRole("menuitem", { name: "ultra" }),
        );

        expect(onChange).toHaveBeenCalledWith("ultra");
    });
});
