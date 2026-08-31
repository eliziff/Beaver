import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    googleSignIn,
    login,
    signup as createAccount,
} from "@/app/lib/authApi";

const card = "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm";
const input =
    "mt-2 w-full rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";
const fields = {
    login: [
        ["email", "Email", "email", "Enter your email"],
        ["password", "Password", "password", "Enter your password"],
    ],
    signup: [
        ["name", "Name", "text", "Your name", "optional"],
        ["organisation", "Organisation", "text", "Your organisation", "optional"],
        ["email", "Email", "email", "Enter your email"],
        ["password", "Password", "password", "Create a password (at least 12 characters)"],
        ["confirmPassword", "Confirm password", "password", "Confirm your password"],
    ],
} as const;

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
    const navigate = useNavigate();
    const { search } = useLocation();
    const { isAuthenticated, authLoading, refreshSession } = useAuth();
    const [status, setStatus] = useState<"idle" | "password" | "google">("idle");
    const [error, setError] = useState<string | null>(null);
    const creating = mode === "signup";
    const query = new URLSearchParams(search);
    const requested = query.get("next");
    const next = requested?.startsWith("/") && !requested.startsWith("//") &&
        !requested.includes("\\") ? requested : "/assistant";
    const word = query.get("surface") === "word" || next.startsWith("/word");
    const onboardingNext = word
        ? `/onboarding?next=${encodeURIComponent(next)}&surface=word`
        : "/onboarding";
    const accessQuery = word
        ? `?next=${encodeURIComponent(next)}&surface=word` : "";

    useEffect(() => {
        if (!authLoading && isAuthenticated) navigate(next, { replace: true });
    }, [authLoading, isAuthenticated, navigate, next]);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get("email") ?? "").trim();
        const password = String(form.get("password") ?? "");
        setStatus("password");
        setError(null);
        try {
            if (!creating) {
                await login(email, password);
                await refreshSession();
                navigate(next);
                return;
            }
            if (password !== form.get("confirmPassword")) {
                throw new Error("Passwords do not match.");
            }
            if (password.length < 12) {
                throw new Error("Password must be at least 12 characters.");
            }
            const result = await createAccount({
                email,
                password,
                displayName: String(form.get("name") ?? "").trim() || undefined,
                organisation: String(form.get("organisation") ?? "").trim() || undefined,
            }, onboardingNext);
            if (result.requiresEmailConfirmation) {
                navigate("/signup/check-email", { state: { email } });
            } else {
                await refreshSession();
                navigate(onboardingNext);
            }
        } catch (caught) {
            setError(caught instanceof Error
                ? caught.message
                : `${creating ? "Sign-up" : "Login"} could not be completed.`);
            setStatus("idle");
        }
    }

    async function startGoogle() {
        setStatus("google");
        setError(null);
        try {
            window.location.assign(await googleSignIn(onboardingNext));
        } catch (caught) {
            setError(caught instanceof Error
                ? caught.message : "Google sign-in could not be started.");
            setStatus("idle");
        }
    }

    return (
        <main className="relative flex min-h-dvh items-start justify-center bg-gray-50/80 px-6 pb-10 pt-32 md:pt-40">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <section className={`${card} w-full max-w-md`} aria-busy={status !== "idle"}>
                <header className="mb-6 flex items-center justify-between">
                    <h1 className="font-serif text-2xl font-medium text-gray-950">
                        {creating ? "Create account" : "Log in"}
                    </h1>
                    <nav aria-label="Account access" className="flex gap-1 rounded-full bg-gray-200 p-1 text-xs font-medium">
                        {(["login", "signup"] as const).map((item) =>
                            item === mode ? (
                                <span key={item} aria-current="page" className="inline-flex h-6 items-center rounded-full border border-gray-200 bg-white px-3 text-gray-900">
                                    {item === "login" ? "Log in" : "Sign up"}
                                </span>
                            ) : (
                                <Link key={item} to={`/${item}${accessQuery}`} className="inline-flex h-6 items-center rounded-full border border-transparent px-3 text-gray-500 hover:bg-white/40 hover:text-gray-900">
                                    {item === "login" ? "Log in" : "Sign up"}
                                </Link>
                            ),
                        )}
                    </nav>
                </header>
                <Button type="button" variant="outline" disabled={status !== "idle"}
                    onClick={() => void startGoogle()} className="mb-5 w-full">
                    {status === "google" ? "Connecting…" : "Continue with Google"}
                </Button>
                <div className="mb-5 flex items-center gap-3 text-xs text-gray-400" aria-hidden>
                    <span className="h-px flex-1 bg-gray-200" /><span>or</span>
                    <span className="h-px flex-1 bg-gray-200" />
                </div>
                <form onSubmit={submit} className="space-y-4">
                    {fields[mode].map(([name, label, type, placeholder, qualifier]) => (
                        <label key={name} htmlFor={name} className="block text-sm font-medium text-gray-700">
                            {label}{qualifier && <span className="font-normal text-gray-400"> ({qualifier})</span>}
                            <Input id={name} name={name} type={type} placeholder={placeholder}
                                required={!qualifier}
                                minLength={creating && (name === "password" || name === "confirmPassword") ? 12 : undefined}
                                autoComplete={{ email: "email", password: creating ? "new-password" : "current-password", confirmPassword: "new-password", name: "name", organisation: "organization" }[name]}
                                className={input} />
                        </label>
                    ))}
                    {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
                    <Button type="submit" disabled={status !== "idle"}
                        className="w-full bg-black text-white hover:bg-gray-900">
                        {status === "password"
                            ? creating ? "Creating account…" : "Logging in…"
                            : creating ? "Sign up" : "Log in"}
                    </Button>
                </form>
                {!creating && (
                    <p className="mt-4 text-center text-sm">
                        <Link to={`/forgot-password${accessQuery}`} className="text-blue-700 hover:underline">
                            Forgot your password?
                        </Link>
                    </p>
                )}
            </section>
        </main>
    );
}
