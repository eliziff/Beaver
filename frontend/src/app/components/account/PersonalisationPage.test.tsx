import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage, PersonalisationSettingsPage } from "./PersonalisationPage";

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    updateProfile: vi.fn(),
    location: { search: "", state: null as { next?: string } | null },
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.navigate,
    useLocation: () => mocks.location,
}));
vi.mock("@/app/components/site-logo", () => ({ SiteLogo: () => null }));
vi.mock("@/app/components/settings/JurisdictionPreferenceEditor", () => ({
    JurisdictionPreferenceEditor: () => null,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        loading: false,
        profile: {
            displayName: null,
            organisation: null,
            professionalTitle: null,
            practiceSetting: null,
            practiceAreas: [],
            filingContact: { name: "", address: "", phone: "", fax: "", email: "" },
        },
        updateProfile: mocks.updateProfile,
    }),
}));

describe("profile onboarding", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.location = { search: "", state: null };
        mocks.updateProfile.mockResolvedValue(true);
    });

    it("saves optional profile fields and completes onboarding", async () => {
        const user = userEvent.setup();
        mocks.location.search = "?next=/projects";
        render(<OnboardingPage />);

        await user.type(screen.getByLabelText("Name"), "  Ada  ");
        await user.type(screen.getByLabelText("Organisation"), " Example LLP ");
        await user.type(screen.getByLabelText("Professional title"), "Associate");
        await user.selectOptions(screen.getByLabelText("Practice setting"), "private_practice");
        await user.type(screen.getByLabelText(/^Practice areas/), "appeals, employment");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(mocks.updateProfile).toHaveBeenCalledWith({
            displayName: "Ada",
            organisation: "Example LLP",
            professionalTitle: "Associate",
            practiceSetting: "private_practice",
            practiceAreas: ["appeals", "employment"],
            onboardingCompleted: true,
        });
        expect(mocks.navigate).toHaveBeenCalledWith("/projects", { replace: true });
    });

    it("skips without inventing profile data or following an external redirect", async () => {
        const user = userEvent.setup();
        mocks.location.search = "?next=https://example.com";
        render(<OnboardingPage />);

        await user.click(screen.getByRole("button", { name: "Skip for now" }));

        expect(mocks.updateProfile).toHaveBeenCalledWith({ onboardingCompleted: true });
        expect(mocks.navigate).toHaveBeenCalledWith("/assistant", { replace: true });
    });

    it("stores reusable court filing details in settings", async () => {
        const user = userEvent.setup();
        render(<PersonalisationSettingsPage />);
        await user.type(screen.getByLabelText("Name on court documents"), "Ada Lawyer");
        await user.type(screen.getByLabelText("Email"), "ada@example.test");
        await user.type(screen.getByLabelText("Address for service"), "1 Court Street");
        await user.type(screen.getByLabelText("Telephone"), "555-0100");
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        expect(mocks.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
            filingContact: { name: "Ada Lawyer", address: "1 Court Street",
                phone: "555-0100", fax: "", email: "ada@example.test" },
        }));
    });
});
