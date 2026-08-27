import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { normalizeDraftingStyleSettings } from "../lib/draftingStyle";
import { getDraftingStyleSettings, saveDraftingStyleSettings } from "../lib/draftingStyleStore";
import { sha256 } from "../lib/hash";
import { isSupportedModel, resolveModel } from "../lib/llm";
import { isLocalRuntime } from "../lib/localMode";
import { publicOrigin } from "../lib/publicOrigin";
import { safeErrorLog, safeErrorMessage, safePublicErrorMessage } from "../lib/safeError";
import { downloadHeaders } from "../lib/storage";
import { createServerSupabase } from "../lib/supabase";
import {
  API_KEY_PROVIDERS, getEnvironmentApiKeyStatus, getUserApiKeyStatus,
  hasEnvApiKey, saveUserApiKey, type ApiKeyStatus,
} from "../lib/userApiKeys";
import * as cleanup from "../lib/userDataCleanup";
import * as dataExport from "../lib/userDataExport";
import { findProfileUserByEmail } from "../lib/userLookup";
import { resolveAvailableModel } from "../lib/userSettings";
import { runtime } from "../runtime";

type Db = ReturnType<typeof createServerSupabase>;
type ProfileRow = {
  display_name: string | null; organisation: string | null;
  message_credits_used: number; credits_reset_date: string; tier: string;
  title_model: string | null; tabular_model: string | null;
  mfa_on_login: boolean | null; legal_research_us: boolean | null;
};
type Identity = { userId: string; userEmail?: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

const PROFILE_COLUMNS = "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us";
const MONTHLY_CREDITS = 999_999;
const nextReset = () => {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString();
};

const supportedModel = z.string().trim().min(1).max(160)
  .refine(isSupportedModel, "Unsupported model");
const profileInput = z.object({
  displayName: z.string().trim().max(160).nullable().optional(),
  organisation: z.string().trim().max(240).nullable().optional(),
  titleModel: supportedModel.optional(), tabularModel: supportedModel.optional(),
  legalResearchUs: z.boolean().optional(),
  draftingStyle: z.record(z.unknown()).optional(),
}).strict();
const enabledInput = z.object({ enabled: z.boolean() }).strict();
const keyInput = z.object({ api_key: z.string().trim().max(32_768).nullable().optional() }).strict();
const providerInput = z.enum(API_KEY_PROVIDERS);
const connectorCreateInput = z.object({
  name: z.string().trim().min(1).max(120), serverUrl: z.string().trim().url().max(2_048),
  bearerToken: z.string().max(32_768).nullable().optional(),
  headers: z.record(z.unknown()).optional(),
}).strict();
const connectorPatchInput = connectorCreateInput.partial().extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || "Invalid request");
  return result.data;
}

function identity(res: Response): Identity {
  return { userId: String(res.locals.userId), userEmail: res.locals.userEmail || undefined };
}

function serializeProfile(row: ProfileRow, apiKeyStatus: ApiKeyStatus, draftingStyle: unknown) {
  const used = row.message_credits_used ?? 0;
  return {
    displayName: row.display_name, organisation: row.organisation,
    messageCreditsUsed: used, creditsResetDate: row.credits_reset_date,
    creditsRemaining: Math.max(MONTHLY_CREDITS - used, 0), tier: row.tier || "Free",
    titleModel: resolveModel(row.title_model, resolveAvailableModel(apiKeyStatus)),
    tabularModel: resolveModel(row.tabular_model, resolveAvailableModel(apiKeyStatus, true)),
    mfaOnLogin: row.mfa_on_login === true, legalResearchUs: row.legal_research_us !== false,
    draftingStyle: normalizeDraftingStyleSettings(draftingStyle), apiKeyStatus,
  };
}

class AccountApplication {
  readonly local = isLocalRuntime();
  private client?: Db;

  db() {
    if (this.local) throw new HttpError(
      501, "This account feature is unavailable in account-free local mode.",
    );
    return this.client ??= createServerSupabase();
  }

  private async cloudProfile(userId: string) {
    const db = this.db();
    const { error: ensureError } = await db.from("user_profiles").upsert(
      { user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true },
    );
    if (ensureError) throw ensureError;
    const { data, error } = await db.from("user_profiles").select(PROFILE_COLUMNS)
      .eq("user_id", userId).single();
    if (error || !data) throw error ?? new Error("Profile not found");
    const row = data as ProfileRow;
    if (!row.credits_reset_date || Date.now() > Date.parse(row.credits_reset_date)) {
      row.message_credits_used = 0;
      row.credits_reset_date = nextReset();
      const { error: resetError } = await db.from("user_profiles").update({
        message_credits_used: 0, credits_reset_date: row.credits_reset_date,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
      if (resetError) throw resetError;
    }
    const [keys, draftingStyle] = await Promise.all([
      getUserApiKeyStatus(userId, db), getDraftingStyleSettings(userId),
    ]);
    return serializeProfile(row, keys, draftingStyle);
  }

  async profile({ userId }: Identity) {
    if (!this.local) return this.cloudProfile(userId);
    const apiKeyStatus = getEnvironmentApiKeyStatus();
    return serializeProfile({
      display_name: null, organisation: null, message_credits_used: 0,
      credits_reset_date: nextReset(), tier: "Free", title_model: null,
      tabular_model: null, mfa_on_login: false, legal_research_us: true,
    }, apiKeyStatus, await getDraftingStyleSettings(userId));
  }

  async updateProfile(account: Identity, body: unknown) {
    const input = parse(profileInput, body);
    if (this.local) {
      if (Object.keys(input).length !== 1 || !input.draftingStyle) {
        throw new HttpError(501, "Only drafting style is editable in account-free local mode.");
      }
      await saveDraftingStyleSettings(account.userId, input.draftingStyle);
      return this.profile(account);
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("displayName" in input) update.display_name = input.displayName || null;
    if ("organisation" in input) update.organisation = input.organisation || null;
    if (input.titleModel) update.title_model = input.titleModel;
    if (input.tabularModel) update.tabular_model = input.tabularModel;
    if (input.legalResearchUs !== undefined) update.legal_research_us = input.legalResearchUs;
    if (input.draftingStyle) await saveDraftingStyleSettings(account.userId, input.draftingStyle);
    const db = this.db();
    const { error } = await db.from("user_profiles").upsert(
      { user_id: account.userId, ...update }, { onConflict: "user_id" },
    );
    if (error) throw error;
    return this.cloudProfile(account.userId);
  }

  apiKeys({ userId }: Identity) {
    return this.local ? getEnvironmentApiKeyStatus() : getUserApiKeyStatus(userId, this.db());
  }

  async saveApiKey(account: Identity, provider: unknown, body: unknown) {
    if (this.local) this.db();
    const selected = parse(providerInput, provider);
    if (hasEnvApiKey(selected)) throw new HttpError(
      409, "This provider is configured by the server environment and cannot be changed from the browser.",
    );
    await saveUserApiKey(account.userId, selected, parse(keyInput, body).api_key ?? null, this.db());
    return this.apiKeys(account);
  }

  async setMfaOnLogin(account: Identity, body: unknown) {
    const enabled = parse(enabledInput, body).enabled, db = this.db();
    if (enabled) {
      const { data, error } = await db.auth.admin.getUserById(account.userId);
      if (error) throw error;
      if (!(data.user?.factors ?? []).some((factor) =>
        factor.factor_type === "totp" && factor.status === "verified")) {
        throw new HttpError(400, "Set up an authenticator app before requiring verification on login.");
      }
    }
    const { error } = await db.from("user_profiles").upsert({
      user_id: account.userId, mfa_on_login: enabled, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw error;
    return this.cloudProfile(account.userId);
  }
}

const account = new AccountApplication();
type Handler = (req: Request, res: Response, db?: Db) => Promise<unknown>;
function endpoint(handler: Handler, errorStatus = 500) {
  return async (req: Request, res: Response) => {
    try { await handler(req, res); }
    catch (error) {
      const status = error instanceof HttpError ? error.status : errorStatus;
      const detail = error instanceof HttpError ? error.message
        : errorStatus >= 500 ? "Account operation failed"
          : safePublicErrorMessage(error, "Account operation failed");
      console.error("[account] request failed", safeErrorLog(error));
      res.status(status).json({ ...(error instanceof HttpError && error.code ? { code: error.code } : {}), detail });
    }
  };
}
function cloud(handler: Handler, errorStatus = 500) {
  return endpoint((req, res) => handler(req, res, account.db()), errorStatus);
}
type ConnectorHandler = (
  req: Request, res: Response, operations: Awaited<ReturnType<typeof runtime.connectors>>,
) => Promise<unknown>;
function connector(handler: ConnectorHandler, errorStatus = 500) {
  return endpoint(async (req, res) => {
    if (!runtime.capabilities.connectors) throw new HttpError(404, "Not found");
    return handler(req, res, await runtime.connectors());
  }, errorStatus);
}

export const userRouter = Router();
userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
  if (!runtime.capabilities.connectors) {
    res.status(404).type("text").send("Not found");
    return;
  }
  const nonce = randomBytes(16).toString("base64");
  try {
    const mcp = await runtime.connectors();
    const state = parse(z.string().min(1).max(4_096), req.query.state);
    const code = parse(z.string().min(1).max(16_384), req.query.code);
    if (req.query.error) throw new Error("OAuth authorization was not completed");
    await mcp.completeUserMcpConnectorOAuth(state, code);
    res.set("Content-Security-Policy", oauthCsp(nonce)).type("html")
      .send(oauthHtml(true, nonce));
  } catch (error) {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    console.error("[account/oauth] callback failed", {
      ...safeErrorLog(error), stateDigest: state ? sha256(state).slice(0, 12) : null,
    });
    try {
      res.status(400).set("Content-Security-Policy", oauthCsp(nonce)).type("html")
        .send(oauthHtml(false, nonce));
    } catch {
      res.status(500).type("text").send("OAuth callback configuration is invalid");
    }
  }
});
userRouter.use(requireAuth);
userRouter.get("/profile", endpoint(async (_req, res) => {
  res.json(await account.profile(identity(res)));
}));
userRouter.patch("/profile", endpoint(async (req, res) => {
  res.json(await account.updateProfile(identity(res), req.body));
}));
userRouter.get("/lookup", cloud(async (req, res, db) => {
  const email = parse(z.string().trim().email().max(320), req.query.email);
  const user = await findProfileUserByEmail(db!, email);
  res.json({ exists: !!user, email: user?.email ?? email.toLowerCase(),
    display_name: user?.display_name ?? null });
}, 400));
userRouter.patch("/security/mfa-login", requireMfaIfEnrolled,
  endpoint(async (req, res) => res.json(await account.setMfaOnLogin(identity(res), req.body))));
userRouter.get("/api-keys", endpoint(async (_req, res) => {
  res.json(await account.apiKeys(identity(res)));
}));
userRouter.put("/api-keys/:provider", requireMfaIfEnrolled,
  endpoint(async (req, res) => res.json(
    await account.saveApiKey(identity(res), req.params.provider, req.body),
  )));

userRouter.get("/mcp-connectors", connector(async (_req, res, mcp) => {
  res.json(await mcp.listUserMcpConnectors(identity(res).userId, { includeTools: false }));
}));
userRouter.get("/mcp-connectors/:connectorId", connector(async (req, res, mcp) => {
  res.json(await mcp.getUserMcpConnector(identity(res).userId, req.params.connectorId));
}, 404));
userRouter.post("/mcp-connectors", requireMfaIfEnrolled,
  connector(async (req, res, mcp) => res.status(201).json(await mcp.createUserMcpConnector(
    identity(res).userId, parse(connectorCreateInput, req.body),
  )), 400));
userRouter.patch("/mcp-connectors/:connectorId", requireMfaIfEnrolled,
  connector(async (req, res, mcp) => res.json(await mcp.updateUserMcpConnector(
    identity(res).userId, req.params.connectorId, parse(connectorPatchInput, req.body),
  )), 400));
userRouter.delete("/mcp-connectors/:connectorId", requireMfaIfEnrolled,
  connector(async (req, res, mcp) => {
    await mcp.deleteUserMcpConnector(identity(res).userId, req.params.connectorId);
    res.status(204).send();
  }));
userRouter.post("/mcp-connectors/:connectorId/oauth/start", requireMfaIfEnrolled,
  connector(async (req, res, mcp) => res.json(await mcp.startUserMcpConnectorOAuth(
    identity(res).userId, req.params.connectorId,
  )), 400));
userRouter.post("/mcp-connectors/:connectorId/refresh-tools", requireMfaIfEnrolled,
  connector(async (req, res, mcp) => {
    try {
      res.json(await mcp.refreshUserMcpConnectorTools(
        identity(res).userId, req.params.connectorId,
      ));
    } catch (error) {
      if (error instanceof mcp.McpOAuthRequiredError) {
        throw new HttpError(401, safeErrorMessage(error), "oauth_required");
      }
      throw error;
    }
  }, 400));
userRouter.patch("/mcp-connectors/:connectorId/tools/:toolId",
  requireMfaIfEnrolled, connector(async (req, res, mcp) => res.json(
    await mcp.setUserMcpToolEnabled(identity(res).userId, req.params.connectorId,
      req.params.toolId, parse(enabledInput, req.body).enabled),
  ), 400));

function oauthHtml(success: boolean, nonce: string) {
  const target = JSON.stringify(`${publicOrigin()}/account/connectors?mcp_oauth=${
    success ? "success" : "failure"}`);
  return `<!doctype html><meta charset="utf-8"><title>MCP authorization</title><h1>${
    success ? "Authorization complete" : "Authorization failed"
  }</h1><p>Returning to Beaver.</p><script nonce="${nonce}">setTimeout(()=>location.replace(${target}),600)</script>`;
}
const oauthCsp = (nonce: string) => [
  "default-src 'none'", `script-src 'nonce-${nonce}'`, "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
userRouter.delete("/account", requireMfaIfEnrolled, cloud(async (_req, res, db) => {
  const id = identity(res);
  await cleanup.deleteUserAccountData(db!, await runtime.documents(), id.userId, id.userEmail);
  const { error } = await db!.auth.admin.deleteUser(id.userId);
  if (error) throw error;
  res.status(204).send();
}));
for (const [path, remove] of [
  ["/chats", async (id: Identity) => (await runtime.chats()).deleteAll(id)],
  ["/projects", async (id: Identity) => (await runtime.projects()).deleteAll(id)],
  ["/tabular-reviews", async (id: Identity) => (await runtime.tabular()).deleteAll(id)],
] as const) userRouter.delete(path, requireMfaIfEnrolled, endpoint(async (_req, res) => {
  await remove(identity(res));
  res.status(204).send();
}));

function exportRoute(
  kind: Parameters<typeof dataExport.userExportFilename>[0], action: string,
  build: (db: Db, userId: string, email?: string) => Promise<unknown>,
) {
  return endpoint(async (_req, res) => {
    const id = identity(res), db = account.db();
    const data = await build(db, id.userId, id.userEmail);
    res.set(downloadHeaders("application/json; charset=utf-8",
      dataExport.userExportFilename(kind, id.userId))).json(data);
    runtime.background(runtime.audit().then((audit) => audit.record({ userId: id.userId,
      userEmail: id.userEmail, action, surface: "account" })), "[audit] unavailable");
  });
}
for (const [path, kind, action, build] of [
  ["/export", "account", "export.account", dataExport.buildUserAccountExport],
  ["/chats/export", "chats", "export.chats", dataExport.buildUserChatsExport],
  ["/tabular-reviews/export", "tabular-reviews", "export.tabular", dataExport.buildUserTabularReviewsExport],
] as const) userRouter.get(path, requireMfaIfEnrolled, exportRoute(kind, action, build));
