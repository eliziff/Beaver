"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SiteLogo } from "@/app/components/site-logo";
import { PillButton } from "@/app/components/ui/pill-button";
import { useAuth } from "@/app/contexts/AuthContext";
import { supabase } from "@/app/lib/supabase";
import {
    needsMfaVerification,
    VerificationCodeInput,
} from "@/app/components/popups/MfaVerificationPopup";
import { markMfaVerifiedForGate } from "@/app/components/shared/MfaLoginGate";
import { ModalSelect } from "@/app/components/modals/ModalSelect";

type MfaFactor = {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
};

const authGlassCardClassName =
    "rounded-2xl border border-gray-200 bg-white px-8 py-8 shadow-sm";

export default function VerifyMfaPage() {
    return (
        <Suspense
            fallback={
                <MfaPageFrame>
                    <div className="h-48" aria-label="Loading verification" />
                </MfaPageFrame>
            }
        >
            <VerifyMfaContent />
        </Suspense>
    );
}

function VerifyMfaContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user, authLoading, signOut } = useAuth();
    const [factors, setFactors] = useState<MfaFactor[]>([]);
    const [selectedFactorId, setSelectedFactorId] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(true);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const nextPath = safeNextPath(searchParams.get("next"));
    const canVerify =
        !loading && !verifying && !!selectedFactorId && code.trim().length === 6;

    useEffect(() => {
        if (authLoading) return;
        if (!user) {
            router.replace("/login");
            return;
        }

        let cancelled = false;

        async function loadMfaState() {
            setLoading(true);
            setError(null);
            setCode("");
            try {
                const required = await needsMfaVerification();
                if (cancelled) return;
                if (!required) {
                    router.replace(nextPath);
                    return;
                }

                const { data, error: factorError } =
                    await supabase.auth.mfa.listFactors();
                if (cancelled) return;
                if (factorError) throw factorError;

                const verified = (data.totp ?? []) as MfaFactor[];
                setFactors(verified);
                setSelectedFactorId(verified[0]?.id ?? "");
                if (verified.length === 0) {
                    setError(
                        "No verified authenticator factor is available for this account.",
                    );
                }
            } catch (loadError) {
                if (cancelled) return;
                setError(
                    loadError instanceof Error
                        ? loadError.message
                        : "Unable to load authenticator verification.",
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void loadMfaState();

        return () => {
            cancelled = true;
        };
    }, [authLoading, nextPath, router, user]);

    async function verify() {
        if (!canVerify) return;

        setVerifying(true);
        setError(null);
        const { error: verifyError } =
            await supabase.auth.mfa.challengeAndVerify({
                factorId: selectedFactorId,
                code: code.trim(),
            });
        setVerifying(false);

        if (verifyError) {
            setError(verifyError.message);
            return;
        }

        setCode("");
        markMfaVerifiedForGate();
        router.replace(nextPath);
    }

    async function cancel() {
        await signOut();
        router.replace("/login");
    }

    return (
        <MfaPageFrame>
                <div className="mb-8 space-y-2">
                    <h1 className="text-2xl font-serif">
                        Verify your identity
                    </h1>
                    <p className="text-sm text-gray-500">
                        Enter the six-digit code from your authenticator app to
                        continue.
                    </p>
                </div>

                <div className="space-y-6">
                    {loading ? (
                        <div className="flex h-13 items-center justify-center text-sm text-gray-500">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading authenticator...
                        </div>
                    ) : factors.length === 0 ? (
                        <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                            No verified authenticator factor is available for
                            this session.
                        </p>
                    ) : (
                        <>
                            {factors.length > 1 && (
                                <ModalSelect
                                    id="mfa-factor"
                                    value={selectedFactorId}
                                    onChange={setSelectedFactorId}
                                    searchable
                                    ariaLabel="Authenticator"
                                    options={factors.map((factor) => ({
                                        value: factor.id,
                                        label:
                                            factor.friendly_name ||
                                            "Authenticator app",
                                    }))}
                                    className="!h-9 rounded-lg border-transparent bg-gray-100"
                                />
                            )}
                            <VerificationCodeInput
                                value={code}
                                onChange={setCode}
                                disabled={verifying}
                                autoFocus={!loading}
                                canSubmit={canVerify}
                                onSubmit={() => void verify()}
                            />
                        </>
                    )}

                    {error && <p className="text-sm text-red-600">{error}</p>}

                    <div className="flex items-center justify-end gap-2 pt-4">
                        <button
                            type="button"
                            onClick={() => void cancel()}
                            disabled={verifying}
                            className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            Cancel
                        </button>
                        <PillButton
                            tone="black"
                            size="normal"
                            type="button"
                            onClick={() => void verify()}
                            disabled={!canVerify}
                        >
                            {verifying ? (
                                <span className="inline-flex items-center gap-1.5">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    Verifying...
                                </span>
                            ) : (
                                "Verify"
                            )}
                        </PillButton>
                    </div>
                </div>
        </MfaPageFrame>
    );
}

function MfaPageFrame({ children }: { children: ReactNode }) {
    return (
        <div className="relative flex min-h-dvh items-start justify-center bg-gray-50/80 px-6 pb-10 pt-32 md:pt-40">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className={`w-full max-w-md ${authGlassCardClassName}`}>
                {children}
            </div>
        </div>
    );
}

function safeNextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/assistant";
    }
    if (value.startsWith("/verify-mfa")) return "/assistant";
    return value;
}
