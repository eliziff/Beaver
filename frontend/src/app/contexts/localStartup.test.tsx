import { act, renderHook, waitFor } from "@testing-library/react";
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

async function startup(mode: "local" | "cloud") {
    const { initializeRuntimeConfig } = await import("@/app/lib/runtimeConfig");
    await initializeRuntimeConfig(async () => Response.json({
        mode, capabilities: { connectors: mode === "cloud" },
    }));
    const { AuthProvider, useAuth } = await import("./AuthContext");
    const { UserProfileProvider, useUserProfile } = await import("./UserProfileContext");
    return renderHook(() => ({ auth: useAuth(), ...useUserProfile() }), {
        wrapper: ({ children }) => <AuthProvider><UserProfileProvider>{children}</UserProfileProvider></AuthProvider>,
    });
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
        const { result } = await startup("local");
        expect(result.current.auth.authLoading).toBe(false);
        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.getAuthSession).not.toHaveBeenCalled();
    });

    it("restores cloud auth through the backend cookie and keeps MFA fail-closed while the profile loads", async () => {
        sessionStorage.setItem("beaver:new-chat-documents", '[{"owner_email":"prior@example.com"}]');
        mocks.getAuthSession.mockResolvedValue({ id: "cloud-user", email: "cloud@example.com",
            pendingEmail: null, createdWithGoogle: false });
        const { result } = await startup("cloud");
        await waitFor(() => expect(result.current.auth.user?.email).toBe("cloud@example.com"));
        expect(result.current.auth.authLoading).toBe(false);
        expect(result.current.loading).toBe(true);
        expect(mocks.getUserProfile).toHaveBeenCalledOnce();
        expect(mocks.getAuthSession).toHaveBeenCalledOnce();
        expect(mocks.clearLegalSourceRequests).toHaveBeenCalledOnce();
        expect(mocks.clearDocumentFileCache).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem("beaver:new-chat-documents")).toBeNull();
    });

    it("does not fabricate a profile when the backend profile request fails", async () => {
        mocks.getUserProfile.mockRejectedValue(new Error("profile unavailable"));
        const { result } = await startup("local");
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(mocks.getUserProfile).toHaveBeenCalledOnce();
        expect(result.current.profile).toBeNull();
    });

    it("uses the API-key status returned by the save operation", async () => {
        mocks.getUserProfile.mockResolvedValue(profileResponse());
        mocks.saveApiKey.mockResolvedValue(apiKeyStatus({ configured: true, source: "env" }));
        const { result } = await startup("local");
        await waitFor(() => expect(result.current.profile?.apiKeys.openai).toEqual({ configured: false, source: null }));
        await act(() => result.current.updateApiKey("openai", "new-key"));
        expect(result.current.profile?.apiKeys.openai).toEqual({ configured: true, source: "env" });
        expect(mocks.saveApiKey).toHaveBeenCalledWith("openai", "new-key");
    });
});
