"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { isAnonymousMode, supabase } from "@/app/lib/supabase";

interface User {
    id: string;
    email: string;
    pendingEmail?: string | null;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const ANONYMOUS_USER: User = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "anonymous@localhost",
};

function toUser(user: SupabaseUser): User {
    return {
        id: user.id,
        email: user.email || "",
        pendingEmail: user.new_email ?? null,
    };
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(
        isAnonymousMode ? ANONYMOUS_USER : null,
    );
    const [authLoading, setAuthLoading] = useState(!isAnonymousMode);

    useEffect(() => {
        if (isAnonymousMode) return;

        const checkUser = async () => {
            const {
                data: { session },
            } = await supabase.auth.getSession();

            if (session?.user) {
                setUser(toUser(session.user));
            }
            setAuthLoading(false);
        };

        checkUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange(async (_event, session) => {
            if (session?.user) {
                setUser(toUser(session.user));
            } else {
                setUser(null);
            }
            setAuthLoading(false);
        });

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    const signOut = async () => {
        if (isAnonymousMode) return;
        await supabase.auth.signOut({ scope: "local" });
        setUser(null);
    };

    const updateEmail = async (email: string) => {
        if (isAnonymousMode) {
            throw new Error("Accounts are disabled in anonymous mode");
        }
        const redirectTo =
            typeof window === "undefined"
                ? undefined
                : `${window.location.origin}/account`;
        const { data, error } = await supabase.auth.updateUser(
            { email },
            redirectTo ? { emailRedirectTo: redirectTo } : undefined,
        );

        if (error) throw error;
        if (!data.user) throw new Error("Unable to update email");

        const nextUser = toUser(data.user);
        setUser(nextUser);
        return nextUser;
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signOut,
                updateEmail,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
