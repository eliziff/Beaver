import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getRuntimeConfig } from "@/app/lib/runtimeConfig";

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
    const config = getRuntimeConfig();
    if (config.mode !== "cloud") {
        throw new Error("Supabase is unavailable in local mode");
    }
    return (client ??= createClient(
        config.supabaseUrl,
        config.supabasePublishableKey,
    ));
}
