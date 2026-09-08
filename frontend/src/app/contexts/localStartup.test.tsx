import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getAuthSession: vi.fn(),
    getUserProfile: vi.fn(),
    saveApiKey: vi.fn(),
    clearLegalSourceRequests: vi.fn(),
    clearDocumentFileCache: vi.fn(),
}));


vi.mock("@/app/lib/api/auth", () => ({
    getAuthSession: mocks.getAuthSession,
    isMfaRequiredError: vi.fn(() => false),
    logout: vi.fn(),
    updateAuthEmail: vi.fn(),
}));

vi.mock("@/app/lib/api/legalSources", () => ({
  clearLegalSourceRequests: mocks.clearLegalSourceRequests
}));
vi.mock("@/app/lib/api/account", () => ({
  getUserProfile: mocks.getUserProfile,
  saveApiKey: mocks.saveApiKey,
  updateUserMfaOnLogin: vi.fn(),
  updateUserProfile: vi.fn()
}));

const apiKeyStatus = (openai: { configured: boolean; source: "user" | "env" | null } = {
    configured: false,
    source: null,
}) => ({
    claude: false,
    gemini: false,
    openai: openai.configured,
    deepseek: false,
    openrouter: false,
    "opencode-go": false,
    meta: false,
    courtlistener: false,
    sources: {
        claude: null,
        gemini: null,
        openai: openai.source,
        deepseek: null,
        openrouter: null,
        "opencode-go": null,
        meta: null,
        courtlistener: null,
    },
});

const profileResponse = (status = apiKeyStatus()) => ({
    displayName: "Local user",
    organisation: null,
    practiceSetting: null,
    professionalTitle: null,
    practiceAreas: [],
    jurisdictionPreference: { mode: "ask", jurisdictions: [] },
    onboardingCompleted: false,
    titleModel: "test",
    tabularModel: "test",
    lastSelectedChatModel: null,
    lastSelectedReasoningEffort: null,
    mfaOnLogin: false,
    legalResearchUs: true,
    features: { authorities: true },
    workflowFileTargets: { "court-records": null, authorities: null },
    draftingStyle: { version: 1, documents: {}, memoHeader: { to: "", from: "" } },
    apiKeyStatus: status,
});
vi.mock("@/app/hooks/useDocumentFile", () => ({
    clearDocumentFileCache: mocks.clearDocumentFileCache,
}));

async function configure(mode: "local" | "cloud") {
    const { initializeRuntimeConfig } = await import("@/app/lib/runtimeConfig");
    const config =
        mode === "local"
            ? { mode, capabilities: { connectors: false } }
            : { mode, capabilities: { connectors: true } };
    await initializeRuntimeConfig(async () =>
        new Response(JSON.stringify(config), {
            headers: { "Content-Type": "application/json" },
        }),
    );
}

describe("local startup", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        sessionStorage.clear();
        mocks.getUserProfile.mockReturnValue(new Promise(() => {}));
        mocks.getAuthSession.mockResolvedValue(null);
    });

    it("starts without Supabase and reports the local profile load", async () => {
        await configure("local");
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

        expect(screen.getByText("false:true")).toBeInTheDocument();
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.getAuthSession).not.toHaveBeenCalled();
    });

    it("restores cloud auth through the backend cookie and keeps MFA fail-closed while the profile loads", async () => {
        await configure("cloud");
        sessionStorage.setItem("beaver:new-chat-documents", '[{"owner_email":"prior@example.com"}]');
        mocks.getAuthSession.mockResolvedValue({
            id: "cloud-user",
            email: "cloud@example.com",
            pendingEmail: null,
            createdWithGoogle: false,
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
        expect(mocks.getAuthSession).toHaveBeenCalledOnce();
        expect(mocks.clearLegalSourceRequests).toHaveBeenCalledOnce();
        expect(mocks.clearDocumentFileCache).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem("beaver:new-chat-documents")).toBeNull();
        view.unmount();
    });

    it("does not fabricate a profile when the backend profile request fails", async () => {
        await configure("local");
        mocks.getUserProfile.mockRejectedValue(new Error("profile unavailable"));
        const { AuthProvider } = await import("./AuthContext");
        const { UserProfileProvider, useUserProfile } = await import(
            "./UserProfileContext"
        );

        function Probe() {
            return <output>{useUserProfile().profile ? "profile" : "no profile"}</output>;
        }

        render(
            <AuthProvider>
                <UserProfileProvider><Probe /></UserProfileProvider>
            </AuthProvider>,
        );

        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        await waitFor(() => expect(screen.getByText("no profile")).toBeInTheDocument());
    });

    it("uses the API-key status returned by the save operation", async () => {
        await configure("local");
        mocks.getUserProfile.mockResolvedValue(profileResponse());
        mocks.saveApiKey.mockResolvedValue(apiKeyStatus({
            configured: true,
            source: "env",
        }));
        const { AuthProvider } = await import("./AuthContext");
        const { UserProfileProvider, useUserProfile } = await import(
            "./UserProfileContext"
        );

        function Probe() {
            const { profile, updateApiKey } = useUserProfile();
            const key = profile?.apiKeys.openai;
            return (
                <button onClick={() => void updateApiKey("openai", "new-key")}>
                    {key ? `${key.configured}:${key.source}` : "loading"}
                </button>
            );
        }

        render(
            <AuthProvider>
                <UserProfileProvider><Probe /></UserProfileProvider>
            </AuthProvider>,
        );

        fireEvent.click(await screen.findByText("false:null"));
        expect(await screen.findByText("true:env")).toBeInTheDocument();
        expect(mocks.saveApiKey).toHaveBeenCalledWith("openai", "new-key");
    });
});
