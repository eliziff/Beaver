import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Borrow the Codex CLI's ChatGPT OAuth credentials for direct calls to the
 * subscription backend (chatgpt.com/backend-api/codex). Same auth flow the
 * open-source CLI and simonw/llm-openai-via-codex use; OpenAI DevEx has
 * publicly endorsed using the subscription from third-party clients.
 */

const REFRESH_URL = "https://auth.openai.com/oauth/token";
/** OAuth client id of the Codex CLI itself (public, from openai/codex). */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_SKEW_MS = 30_000;

type AuthFile = {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

function authPath(): string {
  return path.join(
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
    "auth.json",
  );
}

function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        exp?: number;
      }
    ).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function borrowCodexKey(): Promise<{
  accessToken: string;
  accountId: string | null;
}> {
  const file = authPath();
  let auth: AuthFile;
  try {
    auth = JSON.parse(readFileSync(file, "utf8")) as AuthFile;
  } catch {
    throw new Error(`Codex auth file not readable at ${file}. Run codex login.`);
  }
  const tokens = auth.tokens;
  if (auth.auth_mode !== "chatgpt" || !tokens?.access_token) {
    throw new Error("Codex auth.json has no ChatGPT tokens. Run codex login.");
  }

  const expiry = jwtExpiryMs(tokens.access_token);
  if (expiry !== null && Date.now() < expiry - REFRESH_SKEW_MS) {
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id ?? null,
    };
  }
  if (!tokens.refresh_token) {
    throw new Error("Codex access token expired and no refresh token present.");
  }

  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed (${response.status}). Run codex login.`,
    );
  }
  const fresh = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!fresh.access_token) {
    throw new Error("Codex token refresh returned no access token.");
  }

  auth.tokens = {
    ...tokens,
    access_token: fresh.access_token,
    ...(fresh.refresh_token ? { refresh_token: fresh.refresh_token } : {}),
    ...(fresh.id_token ? { id_token: fresh.id_token } : {}),
  };
  auth.last_refresh = new Date().toISOString();
  // Atomic write-back so a concurrent Codex CLI never sees a torn file.
  writeFileSync(`${file}.tmp`, JSON.stringify(auth, null, 2));
  renameSync(`${file}.tmp`, file);

  return {
    accessToken: fresh.access_token,
    accountId: auth.tokens.account_id ?? null,
  };
}
