"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { updateUserProfile } from "@/app/lib/beaverApi";
import { supabase } from "@/app/lib/supabase";

const card = "rounded-2xl border border-gray-200 bg-white p-8 shadow-sm";
const input =
    "w-full rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";
const fields = {
    login: [
        ["email", "Email", "email", "Enter your email"],
        ["password", "Password", "password", "Enter your password"],
    ],
    signup: [
        ["name", "Name", "text", "Your name", "optional"],
        ["organisation", "Organisation", "text", "Your organisation", "optional"],
        ["email", "Email", "email", "Enter your email"],
        ["password", "Password", "password", "Create a password (min. 6 characters)"],
        ["confirmPassword", "Confirm Password", "password", "Confirm your password"],
    ],
} as const;

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
    const [error, setError] = useState<string | null>(null);
    const signup = mode === "signup";

    useEffect(() => {
        if (!authLoading && isAuthenticated && status !== "success")
            router.replace("/assistant");
    }, [authLoading, isAuthenticated, router, status]);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get("email") ?? "");
        const password = String(form.get("password") ?? "");
        setStatus("loading");
        setError(null);
        try {
            if (!signup) {
                const { error } = await supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) throw error;
                router.push("/assistant");
                return;
            }
            if (password !== form.get("confirmPassword"))
                throw new Error("Passwords do not match");
            if (password.length < 6)
                throw new Error("Password must be at least 6 characters");
            const { data, error } = await supabase.auth.signUp({
                email,
                password,
            });
            if (error) throw error;
            if (data.session) {
                const displayName = String(form.get("name") ?? "").trim();
                const organisation = String(
                    form.get("organisation") ?? "",
                ).trim();
                if (displayName || organisation)
                    await updateUserProfile({
                        ...(displayName && { displayName }),
                        ...(organisation && { organisation }),
                    }).catch((error) =>
                        console.error("[signup] failed to persist profile", error),
                    );
            }
            setStatus("success");
            window.setTimeout(() => router.push("/assistant"), 2000);
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : `An error occurred during ${signup ? "signup" : "login"}`,
            );
            setStatus("idle");
        } finally {
            if (!signup) setStatus("idle");
        }
    }

    return (
        <main className="relative flex min-h-dvh items-start justify-center bg-gray-50/80 px-6 pb-10 pt-32 md:pt-40">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {status === "success" ? (
                    <section className={`${card} p-10 text-center`}>
                        <CheckCircle2 className="mx-auto mb-6 h-12 w-12 text-green-600" />
                        <h1 className="mb-3 text-2xl font-bold text-gray-950">
                            Account created!
                        </h1>
                        <p className="text-gray-600">Redirecting…</p>
                    </section>
                ) : (
                    <section className={card}>
                        <header className="mb-6 flex items-center justify-between">
                            <h1 className="font-serif text-2xl font-medium text-gray-950">
                                {signup ? "Create Account" : "Log In"}
                            </h1>
                            <nav className="flex gap-1 rounded-full bg-gray-200 p-1 text-xs font-medium">
                                {(["login", "signup"] as const).map((item) =>
                                    item === mode ? (
                                        <span
                                            key={item}
                                            className="inline-flex h-6 items-center rounded-full border border-gray-200 bg-white px-3 text-gray-900"
                                        >
                                            {item === "login" ? "Log in" : "Sign up"}
                                        </span>
                                    ) : (
                                        <Link
                                            key={item}
                                            href={`/${item}`}
                                            className="inline-flex h-6 items-center rounded-full border border-transparent px-3 text-gray-500 hover:bg-white/40 hover:text-gray-900"
                                        >
                                            {item === "login" ? "Log in" : "Sign up"}
                                        </Link>
                                    ),
                                )}
                            </nav>
                        </header>
                        <form onSubmit={submit} className="space-y-4">
                            {fields[mode].map(
                                ([name, label, type, placeholder, qualifier]) => (
                                    <label
                                        key={name}
                                        htmlFor={name}
                                        className="block text-sm font-medium text-gray-700"
                                    >
                                        {label}
                                        {qualifier && (
                                            <span className="font-normal text-gray-400">
                                                {" "}
                                                ({qualifier})
                                            </span>
                                        )}
                                        <Input
                                            id={name}
                                            name={name}
                                            type={type}
                                            placeholder={placeholder}
                                            required={!qualifier}
                                            className={`mt-2 ${input}`}
                                        />
                                    </label>
                                ),
                            )}
                            {error && (
                                <p className="rounded bg-red-50 p-3 text-sm text-red-600">
                                    {error}
                                </p>
                            )}
                            <Button
                                type="submit"
                                disabled={status === "loading"}
                                className="w-full bg-black text-white hover:bg-gray-900"
                            >
                                {status === "loading"
                                    ? signup
                                        ? "Creating account..."
                                        : "Logging in..."
                                    : signup
                                      ? "Sign up"
                                      : "Log in"}
                            </Button>
                        </form>
                        {signup && (
                            <p className="mt-4 text-center text-xs text-gray-500">
                                By signing up, you agree to our{" "}
                                <ExternalLink href="https://mikeoss.com/terms">
                                    Terms of Use
                                </ExternalLink>{" "}
                                and{" "}
                                <ExternalLink href="https://mikeoss.com/privacy">
                                    Privacy Policy
                                </ExternalLink>
                            </p>
                        )}
                    </section>
                )}
            </div>
        </main>
    );
}

function ExternalLink({
    href,
    children,
}: {
    href: string;
    children: React.ReactNode;
}) {
    return (
        <Link
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
        >
            {children}
        </Link>
    );
}
