import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { isLocalMode } from "@/app/lib/authMode";
import { clearApiCaches } from "@/app/lib/beaverApi";
import { clearDocumentFileCache } from "@/app/hooks/useDocumentFile";
import { clearStagedChatDocuments } from "@/app/components/assistant/assistantLaunch";
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
const LOCAL_USER: User = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "local@localhost",
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
        isLocalMode ? LOCAL_USER : null,
    );
    const [authLoading, setAuthLoading] = useState(!isLocalMode);
    const cachedUserId = useRef(user?.id ?? null);
    const setAuthenticatedUser = useCallback((next: User | null) => {
        if (cachedUserId.current !== next?.id) {
            clearApiCaches();
            clearDocumentFileCache();
            clearStagedChatDocuments();
            cachedUserId.current = next?.id ?? null;
        }
        setUser(next);
    }, []);
    useEffect(() => {
        if (isLocalMode) return;
        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        async function startCloudAuth() {
            const { getSupabase } = await import("@/app/lib/supabase");
            const supabase = getSupabase();
            if (cancelled) return;
            const {
                data: { subscription },
            } = supabase.auth.onAuthStateChange((_event, session) => {
                if (cancelled) return;
                setAuthenticatedUser(session?.user ? toUser(session.user) : null);
                setAuthLoading(false);
            });
            unsubscribe = () => subscription.unsubscribe();
        }
        void startCloudAuth().catch(() => {
            if (!cancelled) setAuthLoading(false);
        });
        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [setAuthenticatedUser]);
    const value = useMemo(() => ({
        user,
        isAuthenticated: !!user,
        authLoading,
        signOut: async () => {
            if (isLocalMode) return;
            const { getSupabase } = await import("@/app/lib/supabase");
            await getSupabase().auth.signOut({ scope: "local" });
            setAuthenticatedUser(null);
        },
        updateEmail: async (email: string) => {
            if (isLocalMode) {
                throw new Error("Accounts are disabled in local mode");
            }
            const { getSupabase } = await import("@/app/lib/supabase");
            const emailRedirectTo =
                typeof window === "undefined"
                    ? undefined
                    : `${window.location.origin}/account`;
            const { data, error } = await getSupabase().auth.updateUser(
                { email },
                emailRedirectTo ? { emailRedirectTo } : undefined,
            );
            if (error) throw error;
            if (!data.user) throw new Error("Unable to update email");
            const nextUser = toUser(data.user);
            setAuthenticatedUser(nextUser);
            return nextUser;
        },
    }), [authLoading, setAuthenticatedUser, user]);
    return (
        <AuthContext.Provider value={value}>
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
