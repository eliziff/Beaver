import { runtime } from "./runtime";

export type PublicRuntimeConfig =
  | { mode: "local" }
  | {
      mode: "cloud";
      supabaseUrl: string;
      supabasePublishableKey: string;
    };

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value || /^(?:your-|replace-|example)/iu.test(value))
    throw new Error(`${name} is required in cloud mode`);
  return value;
}

export function trustedProxyHops(): false | number {
  if (runtime.mode === "local") return false;
  const value = process.env.TRUST_PROXY_HOPS?.trim();
  if (!value) return false;
  if (!/^[1-9]\d?$/u.test(value)) {
    throw new Error("TRUST_PROXY_HOPS must be an integer from 1 to 99");
  }
  return Number(value);
}

export function publicRuntimeConfig(): PublicRuntimeConfig {
  if (runtime.mode === "local") return { mode: "local" };
  const supabaseUrl = required("SUPABASE_URL");
  const url = new URL(supabaseUrl);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(
    url.hostname.replace(/^\[|\]$/gu, ""),
  );
  if (url.origin !== supabaseUrl.replace(/\/$/u, "") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SUPABASE_URL must be an exact origin without credentials");
  }
  if (url.protocol !== "https:" && (process.env.NODE_ENV === "production" || !loopback)) {
    throw new Error("SUPABASE_URL must use HTTPS (HTTP is allowed only for local development)");
  }
  const publishable = required("SUPABASE_PUBLISHABLE_KEY");
  if (publishable === required("SUPABASE_SECRET_KEY"))
    throw new Error("Supabase publishable and secret keys must differ");
  return {
    mode: "cloud",
    supabaseUrl: url.origin,
    supabasePublishableKey: publishable,
  };
}
