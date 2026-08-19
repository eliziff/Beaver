import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { isLocalMode } from "@/app/lib/authMode";
import {
  getUserProfile,
  isMfaRequiredError,
  saveApiKey,
  updateUserMfaOnLogin,
  updateUserProfile,
  type ApiKeyProvider,
  type ApiKeyState,
  type DraftingStyleSettings,
  type UserProfile as ApiProfile,
} from "@/app/lib/beaverApi";
import { DEFAULT_DRAFTING_STYLE } from "@/app/lib/draftingStyle";

type Profile = Omit<ApiProfile, "apiKeyStatus"> & { apiKeys: ApiKeyState };
type Context = {
  profile: Profile | null;
  loading: boolean;
  updateProfile: (value: Pick<Profile, "displayName" | "organisation">) => Promise<boolean>;
  updateModelPreference: (field: "titleModel" | "tabularModel", value: string) => Promise<boolean>;
  updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
  updateLegalResearchUs: (enabled: boolean) => Promise<boolean>;
  updateDraftingStyle: (settings: DraftingStyleSettings) => Promise<boolean>;
  updateApiKey: (provider: ApiKeyProvider, value: string | null) => Promise<boolean>;
  reloadProfile: () => Promise<void>;
};

const providers: ApiKeyProvider[] = [
  "claude", "gemini", "openai", "deepseek", "openrouter", "meta", "courtlistener",
];
const UserProfileContext = createContext<Context | null>(null);

function normalize(data: ApiProfile): Profile {
  const { apiKeyStatus, ...profile } = data;
  return {
    ...profile,
    mfaOnLogin: profile.mfaOnLogin === true,
    draftingStyle: profile.draftingStyle ?? DEFAULT_DRAFTING_STYLE,
    apiKeys: Object.fromEntries(providers.map((provider) => [provider, {
      configured: !!apiKeyStatus?.[provider],
      source: apiKeyStatus?.sources?.[provider] ?? (apiKeyStatus?.[provider] ? "user" : null),
    }])) as ApiKeyState,
  };
}

function fallback(): Profile {
  return normalize({
    displayName: null,
    organisation: null,
    tier: "Free",
    titleModel: "gemini-3.1-flash-lite-preview",
    tabularModel: "gemini-3-flash-preview",
    mfaOnLogin: false,
    legalResearchUs: true,
    draftingStyle: DEFAULT_DRAFTING_STYLE,
    apiKeyStatus: {} as ApiProfile["apiKeyStatus"],
  });
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user, authLoading } = useAuth();
  const { pathname } = useLocation();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadedUser, setLoadedUser] = useState<string | null>(null);
  const request = useRef(0);
  const userId = user?.id ?? null;
  const needed = !isLocalMode || /^(\/assistant|\/projects|\/account\/api-keys)/.test(pathname);

  const load = useCallback(async (id: string) => {
    const sequence = ++request.current;
    const next = await getUserProfile().then(normalize).catch(fallback);
    if (sequence === request.current) {
      setProfile(next);
      setLoadedUser(id);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      request.current += 1;
      setProfile(null);
      setLoadedUser(null);
    } else if (needed && userId !== loadedUser) {
      void load(userId);
    }
  }, [authLoading, load, loadedUser, needed, userId]);

  async function mutate(run: () => Promise<ApiProfile>, propagateMfa = false) {
    if (!user) return false;
    try {
      setProfile(normalize(await run()));
      return true;
    } catch (error) {
      if (propagateMfa && isMfaRequiredError(error)) throw error;
      return false;
    }
  }

  const value: Context = {
    profile,
    loading: !isLocalMode && (authLoading || (!!userId && userId !== loadedUser)),
    updateProfile: (next) => mutate(() => updateUserProfile(next), true),
    updateModelPreference: (field, value) => mutate(() => updateUserProfile({ [field]: value })),
    updateMfaOnLogin: (enabled) => mutate(() => updateUserMfaOnLogin(enabled), true),
    updateLegalResearchUs: (enabled) => mutate(() => updateUserProfile({ legalResearchUs: enabled })),
    updateDraftingStyle: (draftingStyle) => mutate(() => updateUserProfile({ draftingStyle })),
    updateApiKey: async (provider, value) => {
      if (!user) return false;
      const key = value?.trim() || null;
      try {
        await saveApiKey(provider, key);
        setProfile((current) => current ? {
          ...current,
          apiKeys: { ...current.apiKeys, [provider]: { configured: !!key, source: key ? "user" : null } },
        } : null);
        return true;
      } catch (error) {
        if (isMfaRequiredError(error)) throw error;
        return false;
      }
    },
    reloadProfile: async () => { if (userId) await load(userId); },
  };
  return <UserProfileContext.Provider value={value}>{children}</UserProfileContext.Provider>;
}

export function useUserProfile() {
  const value = useContext(UserProfileContext);
  if (!value) throw new Error("useUserProfile must be used within UserProfileProvider");
  return value;
}
