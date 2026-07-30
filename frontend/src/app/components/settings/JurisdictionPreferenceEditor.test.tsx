import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import {
    jurisdictionPreferenceForChat,
    readJurisdictionPreference,
} from "@/app/components/assistant/jurisdictionPreferences";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";

beforeEach(() => localStorage.clear());

it("stores multiple standing jurisdictions and can return to asking", async () => {
    const user = userEvent.setup();
    render(<JurisdictionPreferenceEditor />);

    await user.click(
        screen.getByRole("radio", { name: /Use selected jurisdictions/ }),
    );
    await user.type(
        screen.getByRole("searchbox", { name: "Find a province or state" }),
        "Alberta",
    );
    await user.click(screen.getByRole("checkbox", { name: "Alberta" }));
    await user.clear(
        screen.getByRole("searchbox", { name: "Find a province or state" }),
    );
    await user.type(
        screen.getByRole("searchbox", { name: "Find a province or state" }),
        "New York",
    );
    await user.click(screen.getByRole("checkbox", { name: "New York" }));

    expect(jurisdictionPreferenceForChat()).toEqual({
        mode: "presume",
        jurisdictions: [
            "Alberta, Canada",
            "New York, United States",
        ],
    });

    await user.click(screen.getByRole("radio", { name: /Ask when needed/ }));
    expect(jurisdictionPreferenceForChat()).toEqual({
        mode: "ask",
        jurisdictions: [],
    });
    expect(readJurisdictionPreference().jurisdictions).toHaveLength(2);
});

it("persists the optional Assistant panel control", async () => {
    render(<JurisdictionPreferenceEditor />);

    await userEvent.click(
        screen.getByRole("checkbox", { name: /Show in Assistant/ }),
    );

    expect(readJurisdictionPreference().showAssistantPanel).toBe(true);
});
