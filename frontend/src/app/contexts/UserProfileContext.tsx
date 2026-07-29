import {
    createContext,
    useContext,
    useEffect,
    useMemo,
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
type UserProfile = Omit<ApiUserProfile, "apiKeyStatus"> & {
    apiKeys: ApiKeyState;
};
interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateProfile: (
        profile: Pick<UserProfile, "displayName" | "organisation">,
    ) => Promise<boolean>;
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
function toApiKeys(status?: ApiUserProfile["apiKeyStatus"]): ApiKeyState {
    return Object.fromEntries(
        API_KEY_PROVIDERS.map((provider) => [
            provider,
            {
                configured: !!status?.[provider],
                source:
                    status?.sources?.[provider] ??
                    (status?.[provider] ? "user" : null),
            },
        ]),
    ) as ApiKeyState;
}
function toProfile(data: ApiUserProfile): UserProfile {
    const { apiKeyStatus, ...profile } = data;
    return {
        ...profile,
        mfaOnLogin: profile.mfaOnLogin === true,
        apiKeys: toApiKeys(apiKeyStatus),
    };
}
export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, authLoading } = useAuth();
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
        (authLoading || (!!userId && profileUserId !== userId));
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
                apiKeys: toApiKeys(),
            };
        }
        if (request !== profileRequest.current) return;
        setProfile(nextProfile);
        setProfileUserId(targetUserId);
    }, []);
    useEffect(() => {
        if (authLoading) return;
        if (
            userId &&
            profileUserId !== userId &&
            (!isAnonymousMode || needsLocalProfile)
        ) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- starts an async API-backed profile refresh
            void loadProfile(userId);
        } else if (!userId) {
            profileRequest.current += 1;
            setProfile(null);
            setProfileUserId(null);
        }
    }, [
        authLoading,
        loadProfile,
        needsLocalProfile,
        profileUserId,
        userId,
    ]);
    const actions = useMemo(() => {
        const mutateProfile = async (
            request: () => Promise<ApiUserProfile>,
            propagateMfa = false,
        ) => {
            if (!user) return false;
            try {
                setProfile(toProfile(await request()));
                return true;
            } catch (error) {
                if (propagateMfa && isMfaRequiredError(error)) throw error;
                return false;
            }
        };
        return {
            updateProfile: (
                profile: Pick<UserProfile, "displayName" | "organisation">,
            ) => mutateProfile(() => updateUserProfile(profile), true),
            updateModelPreference: (
                field: "titleModel" | "tabularModel",
                value: string,
            ) => mutateProfile(() => updateUserProfile({ [field]: value })),
            updateMfaOnLogin: (enabled: boolean) =>
                mutateProfile(() => updateUserMfaOnLogin(enabled), true),
            updateLegalResearchUs: (enabled: boolean) =>
                mutateProfile(() =>
                    updateUserProfile({ legalResearchUs: enabled }),
                ),
            updateApiKey: async (
                provider: ApiKeyProvider,
                value: string | null,
            ) => {
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
            reloadProfile: async () => {
                if (userId) await loadProfile(userId);
            },
        };
    }, [loadProfile, user, userId]);
    const value = useMemo(
        () => ({ profile, loading, ...actions }),
        [actions, loading, profile],
    );
    return (
        <UserProfileContext.Provider value={value}>
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
