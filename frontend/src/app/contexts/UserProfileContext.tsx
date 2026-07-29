"use client";
import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
    useCallback,
} from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { isAnonymousMode } from "@/app/lib/authMode";
import {
    type ApiKeyState,
    type ApiKeyProvider,
    type UserProfile as ApiUserProfile,
    getUserProfile,
    isMfaRequiredError,
    saveApiKey,
    updateUserMfaOnLogin,
    updateUserProfile,
} from "@/app/lib/beaverApi";
interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    apiKeys: ApiKeyState;
}
interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "titleModel" | "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
    updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
    updateApiKey: (
        provider: ApiKeyProvider,
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
}
const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);
const API_KEY_PROVIDERS: ApiKeyProvider[] = [
    "claude",
    "gemini",
    "openai",
    "deepseek",
    "openrouter",
    "courtlistener",
];
function emptyApiKeys(): ApiKeyState {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        deepseek: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    };
}
function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    const apiKeys = emptyApiKeys();
    for (const provider of API_KEY_PROVIDERS) {
        apiKeys[provider] = {
            configured: !!apiKeyStatus[provider],
            source:
                apiKeyStatus.sources?.[provider] ??
                (apiKeyStatus[provider] ? "user" : null),
        };
    }
    return {
        ...profile,
        mfaOnLogin: profile.mfaOnLogin === true,
        apiKeys,
    };
}
export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated, authLoading } = useAuth();
    const pathname = usePathname();
    const needsLocalProfile =
        pathname === null ||
        pathname.startsWith("/assistant") ||
        pathname.startsWith("/projects") ||
        pathname === "/account/api-keys";
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const userId = user?.id ?? null;
    const [profileUserId, setProfileUserId] = useState<string | null>(null);
    const profileRequest = useRef(0);
    const loading =
        !isAnonymousMode &&
        (authLoading || (isAuthenticated && profileUserId !== userId));
    const loadProfile = useCallback(async (targetUserId: string) => {
        const request = ++profileRequest.current;
        let nextProfile: UserProfile;
        try {
            const profileData = await getUserProfile();
            nextProfile = toProfile(profileData);
        } catch {
            const futureResetDate = new Date();
            futureResetDate.setDate(futureResetDate.getDate() + 30);
            nextProfile = {
                displayName: null,
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: futureResetDate.toISOString(),
                creditsRemaining: 999999, // temporarily unlimited
                tier: "Free",
                titleModel: "gemini-3.1-flash-lite-preview",
                tabularModel: "gemini-3-flash-preview",
                mfaOnLogin: false,
                legalResearchUs: true,
                apiKeys: emptyApiKeys(),
            };
        }
        if (request !== profileRequest.current) return;
        setProfile(nextProfile);
        setProfileUserId(targetUserId);
    }, []);
    useEffect(() => {
        if (authLoading) return;
        if (isAuthenticated && userId && (!isAnonymousMode || needsLocalProfile)) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- starts an async API-backed profile refresh
            void loadProfile(userId);
        } else if (!isAuthenticated) {
            profileRequest.current += 1;
            setProfile(null);
            setProfileUserId(null);
        }
    }, [
        authLoading,
        isAuthenticated,
        loadProfile,
        needsLocalProfile,
        userId,
    ]);
    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) {
                return false;
            }
            try {
                const updated = await updateUserProfile({ displayName });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );
    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({ organisation });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );
    const updateModelPreference = useCallback(
        async (
            field: "titleModel" | "tabularModel",
            value: string,
        ): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    [field]: value,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );
    const updateMfaOnLogin = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserMfaOnLogin(enabled);
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );
    const updateLegalResearchUs = useCallback(
        async (enabled: boolean): Promise<boolean> => {
            if (!user) return false;
            try {
                const updated = await updateUserProfile({
                    legalResearchUs: enabled,
                });
                setProfile((prev) =>
                    prev ? { ...prev, ...toProfile(updated) } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );
    const updateApiKey = useCallback(
        async (
            provider: ApiKeyProvider,
            value: string | null,
        ): Promise<boolean> => {
            if (!user) return false;
            const normalized = value?.trim() ? value.trim() : null;
            try {
                await saveApiKey(provider, normalized);
                setProfile((prev) =>
                    prev
                        ? {
                              ...prev,
                              apiKeys: {
                                  ...prev.apiKeys,
                                  [provider]: {
                                      configured: !!normalized,
                                      source: normalized ? "user" : null,
                                  },
                              },
                          }
                        : null,
                );
                return true;
            } catch (error) {
                if (isMfaRequiredError(error)) throw error;
                return false;
            }
        },
        [user],
    );
    const reloadProfile = useCallback(async () => {
        if (userId) {
            await loadProfile(userId);
        }
    }, [userId, loadProfile]);
    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateMfaOnLogin,
                updateLegalResearchUs,
                updateApiKey,
                reloadProfile,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}
export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
