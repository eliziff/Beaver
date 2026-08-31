import type { ComponentType, ReactNode } from "react";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";

export type LoginGate = ComponentType<{ children: ReactNode }>;

export function Providers({ children, LoginGate }: {
    children: ReactNode;
    LoginGate?: LoginGate;
}) {
    const content = LoginGate ? <LoginGate>{children}</LoginGate> : children;
    return (
        <AuthProvider>
            <UserProfileProvider>
                {content}
            </UserProfileProvider>
        </AuthProvider>
    );
}
