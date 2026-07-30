import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { setJurisdictionPreference } from "./jurisdictionPreferences";
import { JurisdictionDock } from "./JurisdictionDock";

vi.mock("next/navigation", () => ({
    usePathname: () => "/assistant/chat/chat-1",
}));

beforeEach(() => localStorage.clear());

it("lets the user hide the optional Assistant jurisdiction panel", async () => {
    setJurisdictionPreference({
        mode: "presume",
        jurisdictions: ["ca-ab"],
        showAssistantPanel: true,
    });
    render(<JurisdictionDock />);

    await userEvent.click(
        screen.getByRole("button", { name: /Jurisdiction/ }),
    );
    expect(screen.getByRole("checkbox", { name: "Alberta" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Hide panel" }));

    expect(
        screen.queryByRole("complementary", {
            name: "Jurisdiction preference",
        }),
    ).not.toBeInTheDocument();
});
