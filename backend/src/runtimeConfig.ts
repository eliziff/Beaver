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
  if (!value) throw new Error(`${name} is required in cloud mode`);
  return value;
}

export function trustedProxyHops(): false | number {
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
  if (
    process.env.NODE_ENV === "production" &&
    url.protocol !== "https:"
  ) {
    throw new Error("SUPABASE_URL must use HTTPS in production");
  }
  return {
    mode: "cloud",
    supabaseUrl: url.origin,
    supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
  };
}
