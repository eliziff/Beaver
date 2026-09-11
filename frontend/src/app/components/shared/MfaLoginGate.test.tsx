import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    auth: {
        user: { id: "cloud-user" } as { id: string } | null,
    },
    profile: {
        loading: false,
        value: { mfaOnLogin: true } as { mfaOnLogin: boolean } | null,
    },
    getMfaAssurance: vi.fn(),
    listMfaFactors: vi.fn(),
    challengeAndVerifyMfa: vi.fn(),
    replace: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.replace,
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: mocks.auth.user, signOut: mocks.signOut }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        loading: mocks.profile.loading,
        profile: mocks.profile.value,
    }),
}));
vi.mock("@/app/lib/api/auth", () => ({
    getMfaAssurance: mocks.getMfaAssurance,
    listMfaFactors: mocks.listMfaFactors,
    challengeAndVerifyMfa: mocks.challengeAndVerifyMfa,
}));

import { MfaLoginGate } from "./MfaLoginGate";
const renderGate = () => render(<MfaLoginGate><p>Protected content</p></MfaLoginGate>);

describe("MfaLoginGate", () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        mocks.auth.user = { id: "cloud-user" };
        mocks.profile.loading = false;
        mocks.profile.value = { mfaOnLogin: true };
        mocks.getMfaAssurance.mockReset();
        mocks.listMfaFactors.mockResolvedValue({ totp: [{ id: "factor-1" }] });
        mocks.challengeAndVerifyMfa.mockReset().mockResolvedValue(undefined);
        mocks.replace.mockReset();
        mocks.signOut.mockReset();
    });

    it("stays fail-closed while the profile loads", () => {
        mocks.profile.loading = true;

        renderGate();

        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
        expect(mocks.getMfaAssurance).not.toHaveBeenCalled();
    });

    it("reveals protected content only after MFA verification", async () => {
        let finishCheck!: (assurance: { currentLevel: string; nextLevel: string }) => void;
        mocks.getMfaAssurance.mockReturnValue(new Promise(resolve => { finishCheck = resolve; }));

        renderGate();

        await waitFor(() => expect(mocks.getMfaAssurance).toHaveBeenCalledOnce());
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();

        await act(async () => finishCheck({ currentLevel: "aal1", nextLevel: "aal2" }));
        const input = await screen.findByRole("textbox", { name: "Six digit verification code" });
        fireEvent.change(input, { target: { value: "12x34567" } });
        expect(input).toHaveValue("123456");
        expect(input).toHaveAttribute("autocomplete", "one-time-code");
        let finishVerification!: () => void;
        mocks.challengeAndVerifyMfa.mockReturnValue(new Promise<void>(resolve => { finishVerification = resolve; }));
        fireEvent.click(screen.getByRole("button", { name: "Verify", exact: true }));
        expect(mocks.challengeAndVerifyMfa).toHaveBeenCalledWith("factor-1", "123456");
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
        await act(async () => finishVerification());
        expect(screen.getByText("Protected content")).toBeVisible();
    });

    it("does not reuse another account's recent MFA receipt", async () => {
        sessionStorage.setItem("mike:mfa-verified-at", `other-user:${Date.now()}`);
        mocks.getMfaAssurance.mockResolvedValue({ currentLevel: "aal1", nextLevel: "aal2" });
        renderGate();
        expect(await screen.findByRole("dialog", { name: "Verify your identity" }))
            .toBeInTheDocument();
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    });

    it("signs out before returning a cancelled login to the login page", async () => {
        mocks.getMfaAssurance.mockResolvedValue({ currentLevel: "aal1", nextLevel: "aal2" });
        mocks.signOut.mockResolvedValue(undefined);

        renderGate();

        fireEvent.click(
            await screen.findByRole("button", { name: "Close" }),
        );

        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
        await waitFor(() =>
            expect(mocks.replace).toHaveBeenCalledWith("/login", { replace: true }),
        );
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    });
});
