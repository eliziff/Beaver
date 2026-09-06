import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import {
  getUserProfile,
  saveApiKey,
  updateUserMfaOnLogin,
  updateUserProfile,
  type ApiKeyProvider,
  type ApiKeyState,
  type UserProfile as ApiProfile,
} from "@/app/lib/api/account";
import { isMfaRequiredError } from "@/app/lib/api/auth";

type Profile = Omit<ApiProfile, "apiKeyStatus"> & { apiKeys: ApiKeyState };
type ProfilePatch = Parameters<typeof updateUserProfile>[0];
type Context = {
  profile: Profile | null;
  loading: boolean;
  updateProfile: (value: ProfilePatch) => Promise<boolean>;
  updateMfaOnLogin: (enabled: boolean) => Promise<boolean>;
  updateApiKey: (provider: ApiKeyProvider, value: string | null) => Promise<boolean>;
};

const UserProfileContext = createContext<Context | null>(null);

function normalizeApiKeys(status: ApiProfile["apiKeyStatus"]): ApiKeyState {
  return Object.fromEntries(Object.entries(status.sources).map(([provider, source]) => [
    provider,
    { configured: status[provider as ApiKeyProvider], source },
  ])) as ApiKeyState;
}

function normalize(data: ApiProfile): Profile {
  const { apiKeyStatus, ...profile } = data;
  return { ...profile, apiKeys: normalizeApiKeys(apiKeyStatus) };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user, authLoading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadedUser, setLoadedUser] = useState<string | null>(null);
  const request = useRef(0);
  const userId = user?.id ?? null;

  const load = useCallback(async (id: string) => {
    const sequence = ++request.current;
    const next = await getUserProfile().then(normalize).catch(() => null);
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
    } else if (userId !== loadedUser) {
      void load(userId);
    }
  }, [authLoading, load, loadedUser, userId]);

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
    loading: authLoading || (!!userId && userId !== loadedUser),
    updateProfile: (next) => mutate(() => updateUserProfile(next), true),
    updateMfaOnLogin: (enabled) => mutate(() => updateUserMfaOnLogin(enabled), true),
    updateApiKey: async (provider, value) => {
      if (!user) return false;
      const key = value?.trim() || null;
      try {
        const status = await saveApiKey(provider, key);
        setProfile((current) => current ? {
          ...current,
          apiKeys: normalizeApiKeys(status),
        } : null);
        return true;
      } catch (error) {
        if (isMfaRequiredError(error)) throw error;
        return false;
      }
    },
  };
  return <UserProfileContext.Provider value={value}>{children}</UserProfileContext.Provider>;
}

export function useUserProfile() {
  const value = useContext(UserProfileContext);
  if (!value) throw new Error("useUserProfile must be used within UserProfileProvider");
  return value;
}
