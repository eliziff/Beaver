import { createClient } from "@supabase/supabase-js";
export { isAnonymousMode } from "./authMode";
const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://anonymous.invalid";
const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    "anonymous-public-key";
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
