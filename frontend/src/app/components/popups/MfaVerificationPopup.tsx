import {
    useEffect,
    useState,
} from "react";
import { Loader2 } from "lucide-react";
import { getSupabase } from "@/app/lib/supabase";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
type MfaFactor = {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
};
export async function needsMfaVerification() {
    const { data, error } =
        await getSupabase().auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) throw error;
    return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}
interface MfaVerificationPopupProps {
    open: boolean;
    onCancel: () => void;
    onVerified: () => void;
    title?: string;
    message?: string;
}
export function MfaVerificationPopup({
    open,
    onCancel,
    onVerified,
    title = "Two-factor verification required",
    message = "Enter a code from your authenticator app to continue.",
}: MfaVerificationPopupProps) {
    const [factors, setFactors] = useState<MfaFactor[]>([]);
    const [selectedFactorId, setSelectedFactorId] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canVerify =
        !verifying &&
        !loading &&
        !!selectedFactorId &&
        code.trim().length === 6;
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        async function loadFactors() {
            setLoading(true);
            setError(null);
            setCode("");
            const { data, error: listError } =
                await getSupabase().auth.mfa.listFactors();
            if (cancelled) return;
            if (listError) {
                setError(listError.message);
                setFactors([]);
                setSelectedFactorId("");
            } else {
                const verified = (data.totp ?? []) as MfaFactor[];
                setFactors(verified);
                setSelectedFactorId(verified[0]?.id ?? "");
            }
            setLoading(false);
        }
        void loadFactors();
        return () => {
            cancelled = true;
        };
    }, [open]);
    async function verify() {
        if (!canVerify) return;
        setVerifying(true);
        setError(null);
        const { error: verifyError } =
            await getSupabase().auth.mfa.challengeAndVerify({
                factorId: selectedFactorId,
                code: code.trim(),
            });
        setVerifying(false);
        if (verifyError) {
            setError(verifyError.message);
            return;
        }
        setCode("");
        onVerified();
    }
    if (!open) return null;
    return (
        <Modal
            open={open}
            onClose={onCancel}
            breadcrumbs={[title]}
            size="sm"
            className="h-auto min-h-[310px] max-h-[min(92vh,400px)]"
            cancelAction={{
                label: "Cancel",
                onClick: onCancel,
                disabled: verifying,
            }}
            primaryAction={{
                label: verifying ? (
                    <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Verifying...
                    </span>
                ) : (
                    "Verify"
                ),
                onClick: () => void verify(),
                disabled: !canVerify,
            }}
        >
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-2 pt-0">
                <p className="text-sm text-gray-500 pb-6">{message}</p>
                {loading ? (
                    <div className="flex h-13 items-center justify-center text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading authenticator...
                    </div>
                ) : factors.length === 0 ? (
                    <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                        No verified authenticator factor is available for this
                        session.
                    </p>
                ) : (
                    <div className="space-y-4">
                        {factors.length > 1 && (
                            <ModalSelect
                                id="mfa-popup-factor"
                                value={selectedFactorId}
                                onChange={setSelectedFactorId}
                                ariaLabel="Authenticator"
                                options={factors.map((factor) => ({
                                    value: factor.id,
                                    label:
                                        factor.friendly_name ||
                                        "Authenticator app",
                                }))}
                                className="!h-9 rounded-lg bg-gray-100"
                            />
                        )}
                        <VerificationCodeInput
                            value={code}
                            onChange={setCode}
                            disabled={verifying}
                            autoFocus={open && !loading}
                            onSubmit={() => void verify()}
                            canSubmit={canVerify}
                        />
                    </div>
                )}
                {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
        </Modal>
    );
}
export function VerificationCodeInput({
    value,
    onChange,
    disabled,
    autoFocus,
    onSubmit,
    canSubmit,
}: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    autoFocus?: boolean;
    onSubmit?: () => void;
    canSubmit?: boolean;
}) {
    return (
        <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={value}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(event) =>
                onChange(event.currentTarget.value.replace(/\D/gu, "").slice(0, 6))
            }
            onKeyDown={(event) => {
                if (event.key !== "Enter" || !canSubmit) return;
                event.preventDefault();
                onSubmit?.();
            }}
            className="mx-auto block h-13 w-48 rounded-lg border border-gray-300 bg-gray-50 px-3 text-center font-serif text-2xl font-medium tracking-[0.35em] text-gray-950 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="Six digit verification code"
            maxLength={6}
            pattern="[0-9]{6}"
        />
    );
}
