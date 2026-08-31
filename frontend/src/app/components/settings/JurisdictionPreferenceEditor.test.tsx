import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { jurisdictionPreferenceForChat } from "@/app/components/assistant/assistantPreferences";
import { JurisdictionPreferenceEditor } from "./JurisdictionPreferenceEditor";

const mocks = vi.hoisted(() => ({
    preference: { mode: "ask" as "ask" | "presume", jurisdictions: [] as string[] },
    updateProfile: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", async () => {
    const React = await import("react");
    return {
        useUserProfile: () => {
            const [preference, setPreference] = React.useState(mocks.preference);
            return {
                profile: { jurisdictionPreference: preference },
                updateProfile: async ({ jurisdictionPreference }: {
                    jurisdictionPreference: typeof mocks.preference;
                }) => {
                    mocks.preference = jurisdictionPreference;
                    mocks.updateProfile(jurisdictionPreference);
                    setPreference(jurisdictionPreference);
                    return true;
                },
            };
        },
    };
});

beforeEach(() => {
    mocks.preference = { mode: "ask", jurisdictions: [] };
    mocks.updateProfile.mockClear();
});

it("stores multiple standing jurisdictions and can return to asking", async () => {
    const user = userEvent.setup();
    render(<JurisdictionPreferenceEditor />);

    await user.click(
        screen.getByRole("radio", { name: /Use selected jurisdictions/ }),
    );
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

    expect(jurisdictionPreferenceForChat(mocks.preference)).toEqual({
        mode: "presume",
        jurisdictions: [
            "Alberta, Canada",
            "New York, United States",
        ],
    });

    await user.click(screen.getByRole("radio", { name: /Ask when needed/ }));
    expect(jurisdictionPreferenceForChat(mocks.preference)).toEqual({
        mode: "ask",
        jurisdictions: ["Canada"],
    });
    expect(mocks.preference.jurisdictions).toEqual(["ca-ab", "us-ny"]);
});
