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
import { isLocalMode } from "@/app/lib/authMode";
import { clearLegalSourceRequests } from "@/app/lib/api/legalSources";
import { getAuthSession, logout, updateAuthEmail, type AuthUser as User } from "@/app/lib/api/auth";
import { clearDocumentFileCache } from "@/app/hooks/useDocumentFile";
import { clearStagedChatDocuments } from "@/app/components/assistant/assistantLaunch";
import { CollectionProvider } from "./CollectionContext";
interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    refreshSession: () => Promise<User | null>;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
}
const AuthContext = createContext<AuthContextType | undefined>(undefined);
const LOCAL_USER: User = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "local@localhost",
    pendingEmail: null,
    createdWithGoogle: false,
};
export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(
        isLocalMode ? LOCAL_USER : null,
    );
    const [authLoading, setAuthLoading] = useState(!isLocalMode);
    const cachedUserId = useRef(user?.id ?? null);
    const setAuthenticatedUser = useCallback((next: User | null) => {
        if (cachedUserId.current !== next?.id) {
            clearLegalSourceRequests();
            clearDocumentFileCache();
            clearStagedChatDocuments();
            cachedUserId.current = next?.id ?? null;
        }
        setUser(next);
    }, []);
    const refreshSession = useCallback(async () => {
        if (isLocalMode) return LOCAL_USER;
        const next = await getAuthSession();
        setAuthenticatedUser(next);
        return next;
    }, [setAuthenticatedUser]);
    useEffect(() => {
        if (isLocalMode) return;
        let cancelled = false;
        async function startCloudAuth() {
            const next = await getAuthSession();
            if (!cancelled) setAuthenticatedUser(next);
        }
        void startCloudAuth().finally(() => {
            if (!cancelled) setAuthLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [setAuthenticatedUser]);
    const value = useMemo(() => ({
        user,
        isAuthenticated: !!user,
        authLoading,
        refreshSession,
        signOut: async () => {
            if (isLocalMode) return;
            await logout();
            setAuthenticatedUser(null);
        },
        updateEmail: async (email: string) => {
            if (isLocalMode) {
                throw new Error("Accounts are disabled in local mode");
            }
            const nextUser = (await updateAuthEmail(email)).user;
            setAuthenticatedUser(nextUser);
            return nextUser;
        },
    }), [authLoading, refreshSession, setAuthenticatedUser, user]);
    return (
        <AuthContext.Provider value={value}>
            <CollectionProvider key={user?.id ?? "anonymous"} owner={user?.id ?? null}>
                {children}
            </CollectionProvider>
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
