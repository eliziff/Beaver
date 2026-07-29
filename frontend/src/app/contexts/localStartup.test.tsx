import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    supabaseLoads: 0,
    onAuthStateChange: vi.fn(),
    unsubscribe: vi.fn(),
    getUserProfile: vi.fn(),
    pathname: "/assistant",
}));

vi.mock("next/navigation", () => ({
    usePathname: () => mocks.pathname,
}));

vi.mock("@/app/lib/supabase", () => {
    mocks.supabaseLoads += 1;
    return {
        supabase: {
            auth: {
                onAuthStateChange: mocks.onAuthStateChange,
                signOut: vi.fn(),
                updateUser: vi.fn(),
            },
        },
    };
});

vi.mock("@/app/lib/beaverApi", () => ({
    getUserProfile: mocks.getUserProfile,
    isMfaRequiredError: vi.fn(() => false),
    saveApiKey: vi.fn(),
    updateUserMfaOnLogin: vi.fn(),
    updateUserProfile: vi.fn(),
}));

describe("account-free startup", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.supabaseLoads = 0;
        mocks.pathname = "/assistant";
        mocks.getUserProfile.mockReturnValue(new Promise(() => {}));
        mocks.onAuthStateChange.mockReturnValue({
            data: {
                subscription: { unsubscribe: mocks.unsubscribe },
            },
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("renders immediately without loading Supabase or waiting for the profile", async () => {
        vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
        const { AuthProvider, useAuth } = await import("./AuthContext");
        const { UserProfileProvider, useUserProfile } = await import(
            "./UserProfileContext"
        );

        function Probe() {
            const auth = useAuth();
            const profile = useUserProfile();
            return (
                <output>
                    {String(auth.authLoading)}:{String(profile.loading)}
                </output>
            );
        }

        render(
            <AuthProvider>
                <UserProfileProvider>
                    <Probe />
                </UserProfileProvider>
            </AuthProvider>,
        );

        expect(screen.getByText("false:false")).toBeInTheDocument();
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.supabaseLoads).toBe(0);
    });

    it("restores cloud auth from one subscription and keeps MFA fail-closed while the profile loads", async () => {
        vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "cloud");
        mocks.onAuthStateChange.mockImplementation((callback) => {
            queueMicrotask(() =>
                callback("INITIAL_SESSION", {
                    user: {
                        id: "cloud-user",
                        email: "cloud@example.com",
                        new_email: null,
                    },
                }),
            );
            return {
                data: {
                    subscription: { unsubscribe: mocks.unsubscribe },
                },
            };
        });
        const { AuthProvider, useAuth } = await import("./AuthContext");
        const { UserProfileProvider, useUserProfile } = await import(
            "./UserProfileContext"
        );

        function Probe() {
            const { authLoading, user } = useAuth();
            const { loading } = useUserProfile();
            return (
                <output>
                    {String(authLoading)}:{user?.email}:{String(loading)}
                </output>
            );
        }

        const view = render(
            <AuthProvider>
                <UserProfileProvider>
                    <Probe />
                </UserProfileProvider>
            </AuthProvider>,
        );

        expect(
            await screen.findByText("false:cloud@example.com:true"),
        ).toBeInTheDocument();
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.supabaseLoads).toBe(1);
        expect(mocks.onAuthStateChange).toHaveBeenCalledOnce();
        view.unmount();
        expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    });

    it("reuses a loaded profile across route categories but still reloads explicitly", async () => {
        vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "anonymous");
        mocks.getUserProfile.mockResolvedValue({
            displayName: "Local user",
            organisation: null,
            messageCreditsUsed: 0,
            creditsResetDate: "2026-08-01T00:00:00.000Z",
            creditsRemaining: 999999,
            tier: "Free",
            titleModel: "test",
            tabularModel: "test",
            mfaOnLogin: false,
            legalResearchUs: true,
            apiKeyStatus: {},
        });
        const { AuthProvider } = await import("./AuthContext");
        const { UserProfileProvider, useUserProfile } = await import(
            "./UserProfileContext"
        );

        function Probe() {
            const { profile, reloadProfile } = useUserProfile();
            return (
                <button onClick={() => void reloadProfile()}>
                    {profile?.displayName ?? "loading"}
                </button>
            );
        }

        const app = () => (
            <AuthProvider>
                <UserProfileProvider>
                    <Probe />
                </UserProfileProvider>
            </AuthProvider>
        );
        const view = render(app());
        await screen.findByText("Local user");
        expect(mocks.getUserProfile).toHaveBeenCalledOnce();

        mocks.pathname = "/library";
        view.rerender(app());
        mocks.pathname = "/assistant";
        view.rerender(app());
        expect(mocks.getUserProfile).toHaveBeenCalledOnce();

        fireEvent.click(screen.getByRole("button"));
        await waitFor(() =>
            expect(mocks.getUserProfile).toHaveBeenCalledTimes(2),
        );
    });
});
