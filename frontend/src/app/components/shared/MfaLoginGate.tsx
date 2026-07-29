import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

type GateState = "idle" | "checking" | "required" | "verified";

const MFA_VERIFIED_AT_KEY = "mike:mfa-verified-at";
const MFA_VERIFIED_GRACE_MS = 60_000;
const loadMfaVerification = () => import("../popups/MfaVerificationPopup");
const MfaVerificationPopup = lazy(async () => {
    const popup = await loadMfaVerification();
    return { default: popup.MfaVerificationPopup };
});

export function MfaLoginGate({ children }: { children: ReactNode }) {
    const router = useRouter();
    const { user, signOut } = useAuth();
    const { profile, loading } = useUserProfile();
    const [gateState, setGateState] = useState<GateState>("idle");

    useEffect(() => {
        if (!user?.id) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- sync fast path for signed-out and account-free sessions
            setGateState("idle");
            return;
        }
        if (loading) return;
        if (!profile?.mfaOnLogin) {
            setGateState("idle");
            return;
        }
        if (hasRecentMfaVerification()) {
            setGateState("verified");
            return;
        }

        let cancelled = false;
        setGateState((previous) =>
            previous === "verified" ? "verified" : "checking",
        );
        async function checkLoginMfa() {
            try {
                const { needsMfaVerification } = await loadMfaVerification();
                const required = await needsMfaVerification();
                if (!cancelled) {
                    setGateState(required ? "required" : "verified");
                }
            } catch {
                if (!cancelled) setGateState("required");
            }
        }
        void checkLoginMfa();
        return () => {
            cancelled = true;
        };
    }, [loading, profile?.mfaOnLogin, user?.id]);

    if (user && loading) {
        return gateState === "verified" ? <>{children}</> : <GateLoader />;
    }
    if (!user || !profile?.mfaOnLogin) return <>{children}</>;
    if (gateState === "verified") return <>{children}</>;
    if (gateState !== "required") return <GateLoader />;

    return (
        <>
            <GateLoader />
            <Suspense fallback={null}>
                <MfaVerificationPopup
                    open
                    title="Verify your identity"
                    message="Enter the six-digit code from your authenticator app to continue."
                    onCancel={() => {
                        void signOut().then(() => router.replace("/login"));
                    }}
                    onVerified={() => {
                        markMfaVerifiedForGate();
                        setGateState("verified");
                    }}
                />
            </Suspense>
        </>
    );
}

function GateLoader() {
    return (
        <div className="flex min-h-dvh items-center justify-center bg-gray-50/80">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
        </div>
    );
}

function markMfaVerifiedForGate() {
    window.sessionStorage.setItem(MFA_VERIFIED_AT_KEY, String(Date.now()));
}

function hasRecentMfaVerification() {
    const raw = window.sessionStorage.getItem(MFA_VERIFIED_AT_KEY);
    const verifiedAt = raw ? Number.parseInt(raw, 10) : 0;
    return (
        Number.isFinite(verifiedAt) &&
        Date.now() - verifiedAt < MFA_VERIFIED_GRACE_MS
    );
}
