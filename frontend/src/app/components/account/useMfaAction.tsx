import { useState } from "react";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { isMfaRequiredError } from "@/app/lib/beaverApi";

type MfaActionOptions = {
    title?: string;
    message?: string;
    onPending?: () => void;
    onError: (error: unknown) => void;
};

type PendingAction = {
    action: () => Promise<void>;
    options: MfaActionOptions;
};

function requiresMfa(error: unknown) {
    if (isMfaRequiredError(error)) return true;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String(error.code) : "";
    const message = "message" in error ? String(error.message) : "";
    return code === "insufficient_aal" || /\baal\b/iu.test(message);
}

export function useMfaAction() {
    const [pending, setPending] = useState<PendingAction | null>(null);

    async function runMfa(
        action: () => Promise<void>,
        options: MfaActionOptions,
    ) {
        try {
            if (await needsMfaVerification()) {
                options.onPending?.();
                setPending({ action, options });
                return;
            }
            await action();
        } catch (error) {
            if (requiresMfa(error)) {
                options.onPending?.();
                setPending({ action, options });
            } else {
                options.onError(error);
            }
        }
    }

    const mfaPopup = (
        <MfaVerificationPopup
            open={!!pending}
            onCancel={() => setPending(null)}
            onVerified={() => {
                const next = pending;
                setPending(null);
                if (next) void runMfa(next.action, next.options);
            }}
            title={pending?.options.title}
            message={pending?.options.message}
        />
    );
    return { runMfa, mfaPopup };
}
