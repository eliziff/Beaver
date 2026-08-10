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
    await user.click(screen.getByRole("switch", { name: "All of Canada" }));
    await user.type(
        screen.getByRole("searchbox"),
        "Alberta",
    );
    await user.click(screen.getByRole("checkbox", { name: "Alberta" }));
    await user.click(screen.getByRole("tab", { name: "US" }));
    await user.type(
        screen.getByRole("searchbox"),
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
        jurisdictions: ["Canada"],
    });
    expect(readJurisdictionPreference().jurisdictions).toHaveLength(2);
});
