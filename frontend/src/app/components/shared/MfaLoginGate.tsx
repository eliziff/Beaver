import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
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
    const navigate = useNavigate();
    const { user, signOut } = useAuth();
    const { profile, loading } = useUserProfile();
    const [gateState, setGateState] = useState<GateState>("idle");

    useEffect(() => {
        if (!user?.id) {
            setGateState("idle");
            return;
        }
        if (loading) return;
        if (!profile?.mfaOnLogin) {
            setGateState("idle");
            return;
        }
        const [verifiedUser, timestamp] =
            (window.sessionStorage.getItem(MFA_VERIFIED_AT_KEY) ?? "").split(":");
        const verifiedAt = Number.parseInt(timestamp ?? "", 10);
        if (verifiedUser === user.id && Number.isFinite(verifiedAt) &&
            Date.now() - verifiedAt < MFA_VERIFIED_GRACE_MS) {
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
                        void signOut().then(() => navigate("/login", { replace: true }));
                    }}
                    onVerified={() => {
                        window.sessionStorage.setItem(
                            MFA_VERIFIED_AT_KEY, `${user.id}:${Date.now()}`);
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
