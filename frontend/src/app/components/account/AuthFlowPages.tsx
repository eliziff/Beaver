import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { exchangeAuthCode, requestPasswordReset, updateAuthPassword } from "@/app/lib/api/auth";
import { errorMessage, safeNext } from "@/app/lib/utils";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <main className="relative flex min-h-dvh items-start justify-center bg-gray-50/80 px-6 pb-10 pt-32 md:pt-40">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <section className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
                <h1 className="font-serif text-2xl font-medium text-gray-950">{title}</h1>
                {children}
            </section>
        </main>
    );
}

function PasswordField({ id, name, label }: { id: string; name: string; label: string }) {
    return <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
        <Input id={id} name={name} type="password" autoComplete="new-password" minLength={12} required className="mt-2" />
    </label>;
}

export function AuthCallbackPage() {
    const navigate = useNavigate();
    const { refreshSession } = useAuth();
    const started = useRef(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        const query = new URLSearchParams(window.location.search);
        const providerError = query.get("error_description") || query.get("error");
        const code = query.get("code");
        if (providerError || !code) {
            setError(providerError || "The sign-in link is invalid or has expired.");
            return;
        }
        void exchangeAuthCode(code).then(refreshSession).then(() => {
            navigate(safeNext(query.get("next"), "/assistant"), { replace: true });
        }).catch((caught) => setError(errorMessage(caught, "Sign-in could not be completed.")));
    }, [navigate, refreshSession]);

    return (
        <Shell title={error ? "Sign-in failed" : "Signing you in"}>
            <p className={`mt-3 text-sm ${error ? "text-red-700" : "text-gray-600"}`} role="status">
                {error || "Completing the secure sign-in…"}
            </p>
            {error && <Link to="/login" className="mt-6 inline-block text-sm font-medium text-blue-700 hover:underline">Return to login</Link>}
        </Shell>
    );
}

export function ForgotPasswordPage() {
    const query = new URLSearchParams(useLocation().search);
    const next = safeNext(query.get("next"), "/assistant");
    const wordQuery = query.get("surface") === "word"
        ? `?next=${encodeURIComponent(next)}&surface=word` : "";
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await requestPasswordReset(
                String(new FormData(event.currentTarget).get("email") ?? ""), next,
            );
            setSent(true);
        } catch (caught) {
            setError(errorMessage(caught, "The reset email could not be sent."));
        } finally {
            setBusy(false);
        }
    }
    return (
        <Shell title="Reset your password">
            {sent ? (
                <p className="mt-3 text-sm text-gray-600" role="status">
                    If that address belongs to an account, a reset link is on its way.
                </p>
            ) : (
                <form className="mt-6 space-y-4" onSubmit={submit}>
                    <label htmlFor="recovery-email" className="block text-sm font-medium text-gray-700">
                        Email
                        <Input id="recovery-email" name="email" type="email" autoComplete="email" required className="mt-2" />
                    </label>
                    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                    <Button type="submit" disabled={busy} className="w-full">
                        {busy ? "Sending…" : "Send reset link"}
                    </Button>
                </form>
            )}
            <Link to={`/login${wordQuery}`} className="mt-6 inline-block text-sm text-blue-700 hover:underline">Back to login</Link>
        </Shell>
    );
}

export function ResetPasswordPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const next = safeNext(new URLSearchParams(location.search).get("next"), "/assistant");
    const { runMfa, mfaPopup } = useMfaAction();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "");
        if (password !== form.get("confirmPassword")) {
            setError("Passwords do not match.");
            return;
        }
        setError(null);
        await runMfa(async () => {
            setBusy(true);
            try {
                await updateAuthPassword(password);
                navigate(next, { replace: true });
            } finally {
                setBusy(false);
            }
        }, {
            onError: (caught) => setError(errorMessage(caught, "The password could not be changed.")),
        });
    }
    return (
        <><Shell title="Choose a new password">
            <form className="mt-6 space-y-4" onSubmit={submit}>
                <PasswordField id="new-password" name="password" label="New password" />
                <PasswordField id="confirm-new-password" name="confirmPassword" label="Confirm password" />
                <p className="text-xs text-gray-500">Use at least 12 characters.</p>
                {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                <Button type="submit" disabled={busy} className="w-full">
                    {busy ? "Saving…" : "Save password"}
                </Button>
            </form>
        </Shell>{mfaPopup}</>
    );
}

export function CheckEmailPage() {
    const state = useLocation().state as { email?: string } | null;
    return (
        <Shell title="Check your email">
            <p className="mt-3 text-sm leading-6 text-gray-600" role="status">
                We sent a confirmation link{state?.email ? <> to <strong>{state.email}</strong></> : ""}.
                Open it to finish creating your account.
            </p>
            <Link to="/login" className="mt-6 inline-block text-sm text-blue-700 hover:underline">Back to login</Link>
        </Shell>
    );
}
