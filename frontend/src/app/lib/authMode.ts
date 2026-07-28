export const isAnonymousMode =
    process.env.NEXT_PUBLIC_AUTH_MODE === "anonymous";

export function requiresAccount(pathname: string): boolean {
    const segments = pathname.split("/");
    return (
        segments[1] === "account" && pathname !== "/account/api-keys"
    );
}
