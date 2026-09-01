import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { isLocalMode } from "@/app/lib/authMode";
import {
  getUserProfile,
  saveApiKey,
  updateUserMfaOnLogin,
  updateUserProfile,
  type ApiKeyProvider,
  type ApiKeyState,
  type UserProfile as ApiProfile,
} from "@/app/lib/beaverApi";
import { isMfaRequiredError } from "@/app/lib/authApi";

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
  const { pathname } = useLocation();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadedUser, setLoadedUser] = useState<string | null>(null);
  const request = useRef(0);
  const userId = user?.id ?? null;
  const needed = !isLocalMode || /^(\/assistant|\/projects|\/workflows|\/table-of-authorities|\/court-records|\/account|\/onboarding|\/word)/.test(pathname);

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
    loading: authLoading || (!!userId && needed && userId !== loadedUser),
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
