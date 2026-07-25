import { createClient } from "@supabase/supabase-js";

export const isAnonymousMode =
    process.env.NEXT_PUBLIC_AUTH_MODE === "anonymous";

const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://anonymous.invalid";
const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    "anonymous-public-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
