import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DRAFTING_STYLE } from "@/app/lib/draftingStyle";

const mocks = vi.hoisted(() => ({ update: vi.fn(async () => true) }));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { draftingStyle: DEFAULT_DRAFTING_STYLE },
        loading: false,
        updateDraftingStyle: mocks.update,
    }),
}));

import { DraftingStyleSettings } from "./DraftingStyleSettings";

describe("DraftingStyleSettings", () => {
    beforeEach(() => mocks.update.mockClear());

    it("offers document-specific citation placement through labelled native controls", async () => {
        const user = userEvent.setup();
        render(<DraftingStyleSettings />);

        expect(screen.getByLabelText("To")).toHaveValue("File");
        expect(screen.getByLabelText("From")).toHaveValue("AI Assistant");

        expect(screen.getByLabelText("Factum heading numbering")).toBeVisible();
        await user.selectOptions(screen.getByLabelText("Factum source links"), "false");
        expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
            documents: expect.objectContaining({
                factum: expect.objectContaining({ citationHyperlinks: false }),
            }),
        }));
        const citation = screen.getByLabelText("Factum citation placement");
        expect(screen.getByRole("option", { name: "After each paragraph" })).toBeVisible();
        await user.selectOptions(citation, "after-paragraph");

        expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
            documents: expect.objectContaining({
                factum: expect.objectContaining({
                    citationPlacement: "after-paragraph",
                }),
            }),
        }));
        expect(await screen.findByText("Saved")).toBeVisible();
    });
});
