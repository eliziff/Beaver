import { apiRequest, mutationInit as json, BeaverApiError } from "./client";

export type AuthUser = {
    id: string;
    email: string;
    pendingEmail: string | null;
    createdWithGoogle: boolean;
};

type AuthResult = { user: AuthUser };

const request = <T>(path: string, init?: RequestInit) =>
    apiRequest<T>(`/auth${path}`, init, "Authentication could not be completed.");

export async function getAuthSession(): Promise<AuthUser | null> {
    try {
        return (await request<AuthResult>("/session")).user;
    } catch (error) {
        if (error instanceof BeaverApiError && error.status === 401) return null;
        throw error;
    }
}

export const login = (email: string, password: string) =>
    request<AuthResult>("/login", json("POST", { email, password }));

export const signup = (input: {
    email: string;
    password: string;
    displayName?: string;
    organisation?: string;
}, next = "/onboarding") => request<AuthResult & { requiresEmailConfirmation: boolean }>(
    "/signup", json("POST", { ...input, next }),
);

export async function googleSignIn(next = "/onboarding") {
    return (await request<{ url: string }>(
        "/oauth", json("POST", { provider: "google", next }),
    )).url;
}

export const exchangeAuthCode = (code: string) =>
    request<AuthResult>("/exchange", json("POST", { code }));

export const requestPasswordReset = (email: string, next?: string) =>
    request<void>("/password-reset", json("POST", { email, ...(next && { next }) }));

export const logout = (global = false) =>
    request<void>("/logout", json("POST", { scope: global ? "global" : "local" }));

export const updateAuthEmail = (email: string) =>
    request<AuthResult>("/email", json("PATCH", { email, next: "/account" }));

export const updateAuthPassword = (password: string, signOut = false) =>
    request<AuthResult>("/password", json("PATCH", { password, signOut }));

export type MfaFactor = { id: string; friendly_name?: string | null };
export const listMfaFactors = () =>
    request<{ totp: MfaFactor[] }>("/mfa/factors");
export const getMfaAssurance = () =>
    request<{ currentLevel: string | null; nextLevel: string | null }>("/mfa/assurance");
export const enrollMfa = (friendlyName: string) => request<{
    id: string;
    totp: { qr_code: string; secret: string };
}>("/mfa/enroll", json("POST", { friendlyName }));
export const challengeMfa = (factorId: string) =>
    request<{ id: string }>("/mfa/challenge", json("POST", { factorId }));
export const verifyMfa = (factorId: string, challengeId: string, code: string) =>
    request<void>("/mfa/verify", json("POST", { factorId, challengeId, code }));
export const challengeAndVerifyMfa = (factorId: string, code: string) =>
    request<void>("/mfa/challenge-and-verify", json("POST", { factorId, code }));
export const unenrollMfa = (factorId: string) =>
    request<void>(`/mfa/factors/${encodeURIComponent(factorId)}`, json("DELETE"));
export const isMfaRequiredError = (error: unknown) => error instanceof BeaverApiError &&
    error.status === 403 && error.code === "mfa_verification_required";
