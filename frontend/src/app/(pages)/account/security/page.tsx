import { useCallback, useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { Modal } from "@/app/components/modals/Modal";
import { VerificationCodeInput } from "@/app/components/popups/MfaVerificationPopup";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import {
    accountGlassPrimaryButtonClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { Switch } from "@/app/components/ui/switch";
import { errorMessage } from "@/app/lib/utils";
import {
  challengeMfa,
  enrollMfa,
  getMfaAssurance,
  listMfaFactors,
  unenrollMfa,
  verifyMfa,
  updateAuthPassword,
} from "@/app/lib/api/auth";
type Enrollment = {
    factorId: string;
    challengeId: string;
    qrCode: string;
    secret: string;
};
type MfaState = {
    factorId: string | null;
    sessionVerified: boolean;
};
type SetupState = {
    enrollment: Enrollment | null;
    verificationCode: string;
    keyCopied: boolean;
};
const emptySetup: SetupState = {
    enrollment: null,
    verificationCode: "",
    keyCopied: false,
};
export default function SecurityPage() {
    const { user } = useAuth();
    const { profile, updateMfaOnLogin } = useUserProfile();
    const [mfa, setMfa] = useState<MfaState | null>(null);
    const [setup, setSetup] = useState<SetupState | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState<
        "setup" | "verify" | "unenroll" | "login" | null
    >(null);
    const { runMfa, mfaPopup } = useMfaAction();
    const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
    const [savingPassword, setSavingPassword] = useState(false);
    const factorId = mfa?.factorId ?? null;
    const enrollment = setup?.enrollment ?? null;
    const verificationCode = setup?.verificationCode ?? "";
    const setupKeyCopied = setup?.keyCopied ?? false;
    const busy = busyAction !== null;
    const savingLoginPreference = busyAction === "login";
    const updateSetup = (patch: Partial<SetupState>) =>
        setSetup((current) =>
            current ? { ...current, ...patch } : current,
        );
    const refreshMfaState = useCallback(async () => {
        setStatus(null);
        try {
            const [factors, assurance] = await Promise.all([
                listMfaFactors(), getMfaAssurance(),
            ]);
            setMfa({
                factorId: factors.totp?.[0]?.id ?? null,
                sessionVerified: assurance.currentLevel === "aal2",
            });
        } catch (caught) {
            setStatus(errorMessage(caught, "Authenticator status could not be loaded."));
            setMfa({ factorId: null, sessionVerified: false });
        }
    }, []);
    useEffect(() => {
        void refreshMfaState();
    }, [refreshMfaState]);
    async function startEnrollment() {
        setBusyAction("setup");
        setStatus(null);
        try {
            let data;
            try {
                data = await enrollMfa("Beaver");
            } catch (caught) {
                if (!(caught instanceof Error) ||
                    !caught.message.toLowerCase().includes("friendly name")) throw caught;
                data = await enrollMfa(`Beaver ${Date.now()}`);
            }
            const challenge = await challengeMfa(data.id);
            updateSetup({
                enrollment: {
                    factorId: data.id,
                    challengeId: challenge.id,
                    qrCode: data.totp.qr_code,
                    secret: data.totp.secret,
                },
                verificationCode: "",
                keyCopied: false,
            });
        } catch (error) {
            setStatus(errorMessage(error, "Failed to start MFA setup."));
        } finally {
            setBusyAction(null);
        }
    }
    async function cancelSetup(next: SetupState | null) {
        if (busy) return;
        setSetup(next);
        if (!enrollment) return;
        await unenrollMfa(enrollment.factorId).catch(() => null);
        await refreshMfaState();
    }
    async function verifyEnrollment() {
        if (!enrollment || verificationCode.trim().length !== 6) return;
        setBusyAction("verify");
        setStatus(null);
        try {
            await verifyMfa(
                enrollment.factorId,
                enrollment.challengeId,
                verificationCode.trim(),
            );
            setSetup(null);
            setStatus("MFA enabled.");
            await refreshMfaState();
        } catch (error) {
            setStatus(errorMessage(error, "Failed to verify MFA code."));
        } finally {
            setBusyAction(null);
        }
    }
    async function copySetupKey() {
        if (!enrollment?.secret) return;
        await navigator.clipboard.writeText(enrollment.secret);
        updateSetup({ keyCopied: true });
        window.setTimeout(() => updateSetup({ keyCopied: false }), 1600);
    }
    async function requestUnenroll(factorId: string) {
        setStatus(null);
        await runMfa(
            async () => {
                setBusyAction("unenroll");
                await unenrollMfa(factorId);
                setBusyAction(null);
                if (profile?.mfaOnLogin) void updateMfaOnLogin(false);
                await refreshMfaState();
            },
            {
                onError: (error) =>
                    setStatus(
                        errorMessage(
                            error,
                            "Failed to remove authenticator.",
                        ),
                    ),
            },
        );
    }
    async function saveLoginPreference() {
        if (!hasVerifiedFactor || savingLoginPreference) return;
        const enabled = !(profile?.mfaOnLogin === true);
        setStatus(null);
        await runMfa(
            async () => {
                setBusyAction("login");
                try {
                    if (!(await updateMfaOnLogin(enabled)))
                        throw new Error(
                            "Failed to update login authentication preference.",
                        );
                } finally {
                    setBusyAction(null);
                }
            },
            {
                title: "Authenticator required",
                message:
                    "Enter a code from your authenticator app to change login verification.",
                onError: (error) =>
                    setStatus(
                        errorMessage(
                            error,
                            "Failed to update login authentication preference.",
                        ),
                    ),
            },
        );
    }
    const hasVerifiedFactor = !!factorId;
    const sessionVerified = mfa?.sessionVerified ?? false;
    const loginMfaEnabled = profile?.mfaOnLogin === true;
    async function savePassword(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const selected = String(values.get("password") ?? "");
        if (selected !== values.get("confirmPassword")) {
            setPasswordStatus("Passwords do not match.");
            return;
        }
        setPasswordStatus(null);
        await runMfa(async () => {
            setSavingPassword(true);
            try {
                await updateAuthPassword(selected);
                form.reset();
                setPasswordStatus(user?.createdWithGoogle
                    ? "Password set. You can now use Google or email to sign in."
                    : "Password updated.");
            } finally {
                setSavingPassword(false);
            }
        }, {
            onError: (caught) => setPasswordStatus(errorMessage(
                caught, "Password could not be updated.",
            )),
        });
    }
    return (
        <div className="space-y-8">
            <AccountSection heading={user?.createdWithGoogle ? "Set a password" : "Password"} className="p-4">
                <form className="space-y-4" onSubmit={(event) => void savePassword(event)}>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <label htmlFor="security-password" className="text-sm font-medium text-gray-700">
                            New password
                            <input id="security-password" name="password" type="password"
                                autoComplete="new-password" minLength={12} required
                                className="mt-2 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" />
                        </label>
                        <label htmlFor="security-password-confirm" className="text-sm font-medium text-gray-700">
                            Confirm password
                            <input id="security-password-confirm" name="confirmPassword" type="password"
                                autoComplete="new-password" minLength={12} required
                                className="mt-2 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" />
                        </label>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <p className={`text-xs ${passwordStatus?.includes("could not") || passwordStatus?.includes("match") ? "text-red-700" : "text-gray-500"}`} aria-live="polite">
                            {passwordStatus || "Use at least 12 characters."}
                        </p>
                        <Button type="submit" disabled={savingPassword}>
                            {savingPassword ? "Saving…" : "Save password"}
                        </Button>
                    </div>
                </form>
            </AccountSection>
            <AccountSection heading="Multi-Factor Authentication">
                    {mfa === null ? (
                        <div className="h-36 p-4" aria-hidden>
                            <div className="h-full rounded-lg bg-gray-100" />
                        </div>
                    ) : (
                        <>
                            <div className="px-4 py-5">
                                <div className="space-y-1">
                                    <div className="flex items-start justify-between gap-3">
                                        <p className="text-sm font-medium text-gray-900">
                                            Verification method
                                        </p>
                                        <span
                                            className={`shrink-0 text-xs font-medium ${
                                                hasVerifiedFactor
                                                    ? "text-green-700"
                                                    : "text-gray-500"
                                            }`}
                                        >
                                            {hasVerifiedFactor
                                                ? "Enabled"
                                                : "Not set up"}
                                        </span>
                                    </div>
                                    <p className="text-sm text-gray-500">
                                        {hasVerifiedFactor
                                            ? sessionVerified
                                                ? "Sensitive actions are unlocked for this session."
                                                : "Sensitive actions require an authenticator code."
                                            : "Protect sensitive actions such as deleting data and changing API keys."}
                                    </p>
                                </div>
                                {!hasVerifiedFactor && !enrollment ? (
                                    <div className="mt-3 flex justify-end">
                                        <Button
                                            variant="outline"
                                            onClick={() => setSetup(emptySetup)}
                                            disabled={busy}
                                            className={`h-9 w-full gap-1.5 sm:w-auto ${accountGlassPrimaryButtonClassName}`}
                                        >
                                            Set up
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                            {hasVerifiedFactor && (
                                <>
                                    <div className="mx-4 h-px bg-gray-200" />
                                    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="space-y-1">
                                            <p className="text-sm font-medium text-gray-900">
                                                Login verification
                                            </p>
                                            <p className="text-sm text-gray-500">
                                                Require a code after each new
                                                login.
                                            </p>
                                        </div>
                                        <Switch
                                            checked={loginMfaEnabled}
                                            ariaLabel="Require login verification"
                                            disabled={savingLoginPreference}
                                            loading={savingLoginPreference}
                                            size="md"
                                            onChange={() =>
                                                void saveLoginPreference()
                                            }
                                        />
                                    </div>
                                    <div className="flex justify-end px-4 pb-4 pt-1">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void requestUnenroll(factorId!)
                                            }
                                            disabled={busy || !factorId}
                                            className="text-xs font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                                        >
                                            Remove authenticator app
                                        </button>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                    {status && (
                        <p className="border-t border-gray-200 px-4 py-3 text-xs text-gray-500">
                            {status}
                        </p>
                    )}
            </AccountSection>
            <Modal
                open={setup !== null}
                onClose={() => void cancelSetup(null)}
                breadcrumbs={["Security", "Set up authenticator app"]}
                secondaryAction={enrollment
                    ? { label: "Back", onClick: () => void cancelSetup(emptySetup), disabled: busy }
                    : undefined}
                primaryAction={
                    enrollment
                        ? {
                              label: busy ? "Verifying..." : "Verify",
                              onClick: () => void verifyEnrollment(),
                              disabled:
                                  busy || verificationCode.trim().length !== 6,
                          }
                        : {
                              label: busy ? "Starting..." : "Continue",
                              onClick: () => void startEnrollment(),
                              disabled: busy,
                          }
                }
            >
                <div
                    className={
                        enrollment
                            ? "min-h-0 flex-1 space-y-3 overflow-y-auto pt-2"
                            : "min-h-0 flex-1 space-y-5 overflow-y-auto pt-3"
                    }
                >
                    {!enrollment ? (
                        <>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-900">
                                    Open an authenticator app
                                </p>
                                <p className="text-sm text-gray-500">
                                    Install one if needed, then choose the
                                    option to add an account.
                                </p>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-gray-900">
                                    Scan this code
                                </p>
                                <p className="text-sm text-gray-500">
                                    In your authenticator app, add a new account
                                    and scan the QR code. If you cannot scan it,
                                    enter the setup key below manually.
                                </p>
                            </div>
                            <div className="min-w-0">
                                <div className="mb-1 flex items-center justify-between gap-3">
                                    <p className="text-xs font-medium text-gray-500">
                                        Setup key
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => void copySetupKey()}
                                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-950"
                                    >
                                        <Copy className="h-3 w-3" />
                                        {setupKeyCopied ? "Copied" : "Copy"}
                                    </button>
                                </div>
                                <p className="overflow-x-auto whitespace-nowrap font-mono text-xs text-gray-700">
                                    {enrollment.secret}
                                </p>
                            </div>
                            <div className="mx-auto flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2">
                                <img
                                    src={enrollment.qrCode}
                                    alt="MFA QR code"
                                    className="h-full w-full"
                                />
                            </div>
                            <VerificationCodeInput
                                value={verificationCode}
                                onChange={(value) =>
                                    updateSetup({ verificationCode: value })
                                }
                                disabled={busy}
                            />
                        </>
                    )}
                </div>
            </Modal>
            {mfaPopup}
        </div>
    );
}
