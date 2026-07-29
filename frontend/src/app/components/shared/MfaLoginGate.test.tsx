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
    needsMfa: vi.fn(),
    replace: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: mocks.replace }),
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
vi.mock("../popups/MfaVerificationPopup", () => ({
    needsMfaVerification: mocks.needsMfa,
    MfaVerificationPopup: ({
        open,
        onCancel,
        onVerified,
    }: {
        open: boolean;
        onCancel: () => void;
        onVerified: () => void;
    }) =>
        open ? (
            <div role="dialog" aria-label="MFA verification">
                <button onClick={onVerified}>Verify MFA</button>
                <button onClick={onCancel}>Cancel MFA</button>
            </div>
        ) : null,
}));

import { MfaLoginGate } from "./MfaLoginGate";

describe("MfaLoginGate", () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        mocks.auth.user = { id: "cloud-user" };
        mocks.profile.loading = false;
        mocks.profile.value = { mfaOnLogin: true };
        mocks.needsMfa.mockReset();
        mocks.replace.mockReset();
        mocks.signOut.mockReset();
    });

    it("bypasses MFA in account-free mode without loading the cloud check", () => {
        mocks.auth.user = { id: "00000000-0000-0000-0000-000000000001" };
        mocks.profile.value = { mfaOnLogin: false };

        render(
            <MfaLoginGate>
                <p>Protected content</p>
            </MfaLoginGate>,
        );

        expect(screen.getByText("Protected content")).toBeInTheDocument();
        expect(mocks.needsMfa).not.toHaveBeenCalled();
    });

    it("stays fail-closed while the profile loads", () => {
        mocks.profile.loading = true;

        render(
            <MfaLoginGate>
                <p>Protected content</p>
            </MfaLoginGate>,
        );

        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
        expect(mocks.needsMfa).not.toHaveBeenCalled();
    });

    it("reveals protected content only after MFA verification", async () => {
        let finishCheck: ((required: boolean) => void) | undefined;
        mocks.needsMfa.mockReturnValue(
            new Promise<boolean>((resolve) => {
                finishCheck = resolve;
            }),
        );

        render(
            <MfaLoginGate>
                <p>Protected content</p>
            </MfaLoginGate>,
        );

        await waitFor(() => expect(mocks.needsMfa).toHaveBeenCalledOnce());
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();

        await act(async () => finishCheck?.(true));
        fireEvent.click(
            await screen.findByRole("button", { name: "Verify MFA" }),
        );

        expect(screen.getByText("Protected content")).toBeInTheDocument();
        expect(
            window.sessionStorage.getItem("mike:mfa-verified-at"),
        ).not.toBeNull();
    });

    it("signs out before returning a cancelled login to the login page", async () => {
        mocks.needsMfa.mockResolvedValue(true);
        mocks.signOut.mockResolvedValue(undefined);

        render(
            <MfaLoginGate>
                <p>Protected content</p>
            </MfaLoginGate>,
        );

        fireEvent.click(
            await screen.findByRole("button", { name: "Cancel MFA" }),
        );

        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
        await waitFor(() =>
            expect(mocks.replace).toHaveBeenCalledWith("/login"),
        );
        expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    });
});
