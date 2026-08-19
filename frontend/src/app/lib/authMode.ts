import { getRuntimeConfig } from "@/app/lib/runtimeConfig";

export const isLocalMode = getRuntimeConfig().mode === "local";
export function requiresAccount(pathname: string): boolean {
    const segments = pathname.split("/");
    return segments[1] === "account" &&
        pathname !== "/account/api-keys" &&
        pathname !== "/account/features";
}
