import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<any, "public", any>;

export const normalizeEmail = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

export async function findProfileUserByEmail(db: Db, email: string) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const { data, error } = await db.from("user_profiles")
        .select("user_id, email, display_name").eq("email", normalized).maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const name = typeof data.display_name === "string" ? data.display_name.trim() : "";
    return { id: data.user_id as string, email: normalized, display_name: name || null };
}

export async function syncProfileIdentity(db: Db, userId: string,
    email: string | null | undefined) {
    const normalizedEmail = normalizeEmail(email);
    if (!userId || !normalizedEmail) return false;

    const { data: existing, error: loadError } = await db.from("user_profiles")
        .select("email, mfa_on_login").eq("user_id", userId).maybeSingle();
    if (loadError) throw loadError;

    if (!existing) {
        const { error } = await db.from("user_profiles")
            .insert({ user_id: userId, email: normalizedEmail });
        if (error) throw error;
    } else if (normalizeEmail(existing.email) !== normalizedEmail) {
        const { error } = await db.from("user_profiles").update({
            email: normalizedEmail, updated_at: new Date().toISOString(),
        }).eq("user_id", userId);
        if (error) throw error;
    }
    return (existing as { mfa_on_login?: boolean } | null)?.mfa_on_login === true;
}
