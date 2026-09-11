import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { UserProfile } from "@/app/lib/api/account";
import { DEFAULT_USER_PREFERENCES } from "../../../../shared/user-preferences.mjs";
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
}));

vi.mock("@/app/lib/api/legalSources", () => ({
  clearLegalSourceRequests: mocks.clearLegalSourceRequests
}));
vi.mock("@/app/lib/api/account", () => ({
  getUserProfile: mocks.getUserProfile,
  saveApiKey: mocks.saveApiKey,
}));

const apiKeyStatus = (openai: { configured: boolean; source: "user" | "env" | null } = {
    configured: false,
    source: null,
}): UserProfile["apiKeyStatus"] => ({
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

vi.mock("@/app/hooks/useDocumentFile", () => ({
    clearDocumentFileCache: mocks.clearDocumentFileCache,
}));

async function renderStartup(mode: "local" | "cloud") {
    const { initializeRuntimeConfig } = await import("@/app/lib/runtimeConfig");
    await initializeRuntimeConfig(async () => Response.json({
        mode, capabilities: { connectors: mode === "cloud" },
    }));
    // AuthContext reads the mode at import time, after runtime configuration.
    const { AuthProvider, useAuth } = await import("./AuthContext");
    const { UserProfileProvider, useUserProfile } = await import("./UserProfileContext");
    return renderHook(() => ({ auth: useAuth(), profile: useUserProfile() }), {
        wrapper: ({ children }: { children: ReactNode }) => (
            <AuthProvider><UserProfileProvider>{children}</UserProfileProvider></AuthProvider>
        ),
    });
}

describe("local startup", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.resetAllMocks();
        sessionStorage.clear();
        mocks.getUserProfile.mockReturnValue(new Promise(() => {}));
    });

    it("starts without Supabase and reports the local profile load", async () => {
        const { result } = await renderStartup("local");
        expect(result.current.auth.authLoading).toBe(false);
        expect(result.current.profile.loading).toBe(true);
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.getAuthSession).not.toHaveBeenCalled();
    });

    it("restores cloud auth through the backend cookie and keeps MFA fail-closed while the profile loads", async () => {
        sessionStorage.setItem("beaver:new-chat-documents", '[{"owner_email":"prior@example.com"}]');
        mocks.getAuthSession.mockResolvedValue({
            id: "cloud-user",
            email: "cloud@example.com",
            pendingEmail: null,
            createdWithGoogle: false,
        });
        const { result, unmount } = await renderStartup("cloud");
        await waitFor(() => expect(result.current.auth.user?.email).toBe("cloud@example.com"));
        expect(result.current.auth.authLoading).toBe(false);
        expect(result.current.profile.loading).toBe(true);
        await waitFor(() => expect(mocks.getUserProfile).toHaveBeenCalledOnce());
        expect(mocks.getAuthSession).toHaveBeenCalledOnce();
        expect(mocks.clearLegalSourceRequests).toHaveBeenCalledOnce();
        expect(mocks.clearDocumentFileCache).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem("beaver:new-chat-documents")).toBeNull();
        unmount();
    });

    it("does not fabricate a profile when the backend profile request fails", async () => {
        mocks.getUserProfile.mockRejectedValue(new Error("profile unavailable"));
        const { result } = await renderStartup("local");
        await waitFor(() => expect(result.current.profile.loading).toBe(false));
        expect(result.current.profile.profile).toBeNull();
        expect(mocks.getUserProfile).toHaveBeenCalledOnce();
    });

    it("uses the API-key status returned by the save operation", async () => {
        mocks.getUserProfile.mockResolvedValue({
            ...DEFAULT_USER_PREFERENCES,
            displayName: "Local user",
            titleModel: "test",
            tabularModel: "test",
            mfaOnLogin: false,
            apiKeyStatus: apiKeyStatus(),
        } satisfies UserProfile);
        mocks.saveApiKey.mockResolvedValue(apiKeyStatus({ configured: true, source: "env" }));
        const { result } = await renderStartup("local");
        await waitFor(() => expect(result.current.profile.profile?.apiKeys.openai)
            .toEqual({ configured: false, source: null }));
        await act(() => result.current.profile.updateApiKey("openai", "new-key"));
        expect(result.current.profile.profile?.apiKeys.openai).toEqual({ configured: true, source: "env" });
        expect(mocks.saveApiKey).toHaveBeenCalledWith("openai", "new-key");
    });
});
