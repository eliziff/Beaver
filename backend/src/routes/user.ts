import crypto from "crypto";
import { Router } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import {
    createServerSupabase,
} from "../lib/supabase";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    CLAUDE_LOW_MODELS,
    DEEPSEEK_MAIN_MODELS,
    OPENAI_LOW_MODELS,
    resolveModel,
} from "../lib/llm";
import {
    type ApiKeyStatus,
    getEnvironmentApiKeyStatus,
    getUserApiKeyStatus,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveUserApiKey,
} from "../lib/userApiKeys";
import {
    completeUserMcpConnectorOAuth,
    createUserMcpConnector,
    deleteUserMcpConnector,
    getUserMcpConnector,
    listUserMcpConnectors,
    McpOAuthRequiredError,
    refreshUserMcpConnectorTools,
    setUserMcpToolEnabled,
    startUserMcpConnectorOAuth,
    updateUserMcpConnector,
} from "../lib/mcpConnectors";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
} from "../lib/userDataCleanup";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
    userExportFilename,
} from "../lib/userDataExport";
import { findProfileUserByEmail } from "../lib/userLookup";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

userRouter.use((req, res, next) => {
    if (!isAnonymousLocalMode()) return next();
    if (
        req.method === "GET" &&
        (req.path === "/profile" || req.path === "/api-keys")
    ) {
        return next();
    }
    res.status(501).json({
        detail: "This account feature is unavailable in account-free local mode.",
    });
});

type UserProfileRow = {
    display_name: string | null;
    organisation: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tier: string;
    title_model: string | null;
    tabular_model: string;
    mfa_on_login: boolean | null;
    legal_research_us: boolean | null;
};

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object") {
        const record = error as {
            message?: unknown;
            details?: unknown;
            hint?: unknown;
            code?: unknown;
        };
        return (
            [record.message, record.details, record.hint, record.code]
                .filter(
                    (value): value is string =>
                        typeof value === "string" && !!value,
                )
                .join(" ") || JSON.stringify(error)
        );
    }
    return String(error);
}

function backendPublicUrl(req: {
    protocol: string;
    get(name: string): string | undefined;
}) {
    return (
        process.env.API_PUBLIC_URL ||
        process.env.BACKEND_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");
}

function frontendUrl(path = "/account/connectors") {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
}

function shortHash(value: string) {
    return value
        ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
        : null;
}

function mcpOAuthPopupHtml(payload: {
    success: boolean;
    connectorId?: string;
    detail?: string;
}, nonce: string) {
    const targetOrigin = new URL(frontendUrl()).origin;
    const targetUrl = frontendUrl();
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    });
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP authorization</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Authorization complete" : "Authorization failed"}</h1>
      <p>${payload.success ? "You can return to Beaver." : "Return to Beaver and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      const targetUrl = ${JSON.stringify(targetUrl)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
      ${
          payload.success
              ? "setTimeout(() => window.location.assign(targetUrl), 1000);"
              : ""
      }
    </script>
  </body>
</html>`;
}

function mcpOAuthPopupCsp(nonce: string) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; ");
}

const PROFILE_SELECT =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us";

async function selectProfile(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
    mode: "maybe" | "single",
) {
    const query = db
        .from("user_profiles")
        .select(PROFILE_SELECT)
        .eq("user_id", userId);
    return mode === "single" ? query.single() : query.maybeSingle();
}

function serializeProfile(row: UserProfileRow, apiKeyStatus?: ApiKeyStatus) {
    const creditsUsed = row.message_credits_used ?? 0;
    const titleFallback = apiKeyStatus?.gemini
        ? DEFAULT_TITLE_MODEL
        : apiKeyStatus?.openai
          ? OPENAI_LOW_MODELS[0]
          : apiKeyStatus?.deepseek
            ? DEEPSEEK_MAIN_MODELS[0]
          : apiKeyStatus?.claude
            ? CLAUDE_LOW_MODELS[0]
            : DEFAULT_TITLE_MODEL;
    return {
        displayName: row.display_name,
        organisation: row.organisation,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: row.credits_reset_date,
        creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
        tier: row.tier || "Free",
        titleModel: resolveModel(row.title_model, titleFallback),
        tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
        mfaOnLogin: row.mfa_on_login === true,
        legalResearchUs: row.legal_research_us !== false,
        ...(apiKeyStatus ? { apiKeyStatus } : {}),
    };
}

function localAnonymousProfile(): ReturnType<typeof serializeProfile> {
    const reset = new Date();
    reset.setDate(reset.getDate() + 30);
    const apiKeyStatus = getEnvironmentApiKeyStatus();
    return serializeProfile(
        {
            display_name: null,
            organisation: null,
            message_credits_used: 0,
            credits_reset_date: reset.toISOString(),
            tier: "Free",
            title_model: null,
            tabular_model: DEFAULT_TABULAR_MODEL,
            mfa_on_login: false,
            legal_research_us: true,
        },
        apiKeyStatus,
    );
}

function validateProfilePayload(body: unknown):
    | {
          ok: true;
          update: {
              display_name?: string | null;
              organisation?: string | null;
              title_model?: string;
              tabular_model?: string;
              legal_research_us?: boolean;
              updated_at: string;
          };
      }
    | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }

    const raw = body as Record<string, unknown>;
    const allowedFields = new Set([
        "displayName",
        "organisation",
        "titleModel",
        "tabularModel",
        "legalResearchUs",
    ]);
    const invalidField = Object.keys(raw).find(
        (key) => !allowedFields.has(key),
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported profile field: ${invalidField}`,
        };
    }

    const update: {
        display_name?: string | null;
        organisation?: string | null;
        title_model?: string;
        tabular_model?: string;
        legal_research_us?: boolean;
        updated_at: string;
    } = { updated_at: new Date().toISOString() };

    if ("displayName" in raw) {
        if (raw.displayName !== null && typeof raw.displayName !== "string") {
            return {
                ok: false,
                detail: "displayName must be a string or null",
            };
        }
        update.display_name = raw.displayName?.trim() || null;
    }

    if ("organisation" in raw) {
        if (raw.organisation !== null && typeof raw.organisation !== "string") {
            return {
                ok: false,
                detail: "organisation must be a string or null",
            };
        }
        update.organisation = raw.organisation?.trim() || null;
    }

    if ("tabularModel" in raw) {
        if (typeof raw.tabularModel !== "string") {
            return { ok: false, detail: "tabularModel must be a string" };
        }
        const resolved = resolveModel(raw.tabularModel, "");
        if (!resolved) {
            return { ok: false, detail: "Unsupported tabularModel" };
        }
        update.tabular_model = resolved;
    }

    if ("titleModel" in raw) {
        if (typeof raw.titleModel !== "string") {
            return { ok: false, detail: "titleModel must be a string" };
        }
        const resolved = resolveModel(raw.titleModel, "");
        if (!resolved) {
            return { ok: false, detail: "Unsupported titleModel" };
        }
        update.title_model = resolved;
    }

    if ("legalResearchUs" in raw) {
        if (typeof raw.legalResearchUs !== "boolean") {
            return {
                ok: false,
                detail: "legalResearchUs must be a boolean",
            };
        }
        update.legal_research_us = raw.legalResearchUs;
    }

    return { ok: true, update };
}

function readBooleanBodyField(
    body: unknown,
    field: string,
): { ok: true; value: boolean } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }

    const raw = body as Record<string, unknown>;
    const invalidField = Object.keys(raw).find((key) => key !== field);
    if (invalidField) {
        return { ok: false, detail: `Unsupported field: ${invalidField}` };
    }
    if (typeof raw[field] !== "boolean") {
        return { ok: false, detail: `${field} must be a boolean` };
    }

    return { ok: true, value: raw[field] };
}

async function userHasVerifiedTotpFactor(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
) {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) return { ok: false as const, error };

    const factors = data.user?.factors ?? [];
    return {
        ok: true as const,
        hasVerifiedTotp: factors.some(
            (factor) =>
                factor.factor_type === "totp" && factor.status === "verified",
        ),
    };
}

async function ensureProfileRow(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
) {
    const { error } = await db
        .from("user_profiles")
        .upsert(
            { user_id: userId },
            { onConflict: "user_id", ignoreDuplicates: true },
        );
    return error;
}

async function loadProfile(
    db: ReturnType<typeof createServerSupabase>,
    userId: string,
    options: { repairMissing?: boolean; apiKeyStatus?: ApiKeyStatus } = {},
) {
    let { data, error } = await selectProfile(db, userId, "maybe");

    if (error) return { data: null, error };
    if (!data) {
        if (!options.repairMissing) {
            return { data: null, error: new Error("Profile not found") };
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError) return { data: null, error: ensureError };

        const created = await selectProfile(db, userId, "single");
        if (created.error) return { data: null, error: created.error };
        data = created.data;
    }

    let row = data as UserProfileRow;
    if (
        row.credits_reset_date &&
        new Date() > new Date(row.credits_reset_date)
    ) {
        const creditsResetDate = new Date();
        creditsResetDate.setDate(creditsResetDate.getDate() + 30);
        const { error: resetError } = await db
            .from("user_profiles")
            .update({
                message_credits_used: 0,
                credits_reset_date: creditsResetDate.toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

        if (resetError) return { data: null, error: resetError };
        const { data: resetData, error: resetLoadError } = await selectProfile(
            db,
            userId,
            "single",
        );
        if (resetLoadError) return { data: null, error: resetLoadError };
        row = resetData as UserProfileRow;
    }

    return { data: serializeProfile(row, options.apiKeyStatus), error: null };
}

userRouter.post("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const error = await ensureProfileRow(db, userId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ ok: true });
});

userRouter.get("/lookup", requireAuth, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email.trim()) {
        return void res.status(400).json({ detail: "email is required" });
    }

    const db = createServerSupabase();
    const user = await findProfileUserByEmail(db, email);
    res.json({
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    });
});

userRouter.get("/profile", requireAuth, async (_req, res) => {
    if (isAnonymousLocalMode()) {
        res.json(localAnonymousProfile());
        return;
    }
    try {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const apiKeyStatus = await getUserApiKeyStatus(userId, db);
        const { data, error } = await loadProfile(db, userId, {
            repairMissing: true,
            apiKeyStatus,
        });
        if (error) return void res.status(500).json({ detail: error.message });
        res.json({ ...data, apiKeyStatus });
    } catch (error) {
        console.error("[user/profile] failed to load profile", error);
        res.status(500).json({ detail: "Failed to load user profile" });
    }
});

userRouter.patch("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const parsed = validateProfilePayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const db = createServerSupabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return void res.status(500).json({ detail: ensureError.message });

    const { error: updateError } = await db
        .from("user_profiles")
        .update(parsed.update)
        .eq("user_id", userId);
    if (updateError)
        return void res.status(500).json({ detail: updateError.message });

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ ...data, apiKeyStatus });
});

userRouter.patch(
    "/security/mfa-login",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        if (parsed.value) {
            const factorCheck = await userHasVerifiedTotpFactor(db, userId);
            if (!factorCheck.ok) {
                return void res.status(500).json({
                    detail: factorCheck.error.message,
                });
            }
            if (!factorCheck.hasVerifiedTotp) {
                return void res.status(400).json({
                    detail: "Set up an authenticator app before requiring verification on login.",
                });
            }
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError)
            return void res.status(500).json({ detail: ensureError.message });

        const { error: updateError } = await db
            .from("user_profiles")
            .update({
                mfa_on_login: parsed.value,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (updateError)
            return void res.status(500).json({ detail: updateError.message });

        const apiKeyStatus = await getUserApiKeyStatus(userId, db);
        const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
        if (error) return void res.status(500).json({ detail: error.message });
        res.json({ ...data, apiKeyStatus });
    },
);

userRouter.get("/api-keys", requireAuth, async (_req, res) => {
    if (isAnonymousLocalMode()) {
        res.json(getEnvironmentApiKeyStatus());
        return;
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
});

userRouter.put(
    "/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res
                .status(400)
                .json({ detail: "Unsupported provider" });

        const apiKey =
            typeof req.body?.api_key === "string" ? req.body.api_key : null;
        const db = createServerSupabase();
        try {
            if (hasEnvApiKey(provider)) {
                return void res.status(409).json({
                    detail: "This provider is configured by the server environment and cannot be changed from the browser.",
                });
            }
            await saveUserApiKey(userId, provider, apiKey, db);
            const status = await getUserApiKeyStatus(userId, db);
            res.json(status);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/api-keys] save failed", {
                provider,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        res.json(
            await listUserMcpConnectors(userId, db, { includeTools: false }),
        );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] list failed", {
            userId,
            error: detail,
        });
        res.status(500).json({ detail });
    }
});

userRouter.get(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            res.json(
                await getUserMcpConnector(userId, req.params.connectorId, db),
            );
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] get failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(404).json({ detail });
        }
    },
);

userRouter.post(
    "/mcp-connectors",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const name = typeof req.body?.name === "string" ? req.body.name : "";
        const serverUrl =
            typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "";
        const bearerToken =
            typeof req.body?.bearerToken === "string"
                ? req.body.bearerToken
                : null;
        const headers =
            req.body?.headers &&
            typeof req.body.headers === "object" &&
            !Array.isArray(req.body.headers)
                ? (req.body.headers as Record<string, unknown>)
                : undefined;
        const db = createServerSupabase();
        try {
            const connector = await createUserMcpConnector(
                userId,
                { name, serverUrl, bearerToken, headers },
                db,
            );
            res.status(201).json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] create failed", {
                userId,
                error: detail,
            });
            res.status(400).json({ detail });
        }
    },
);

userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const body = req.body ?? {};
        try {
            const connector = await updateUserMcpConnector(
                userId,
                req.params.connectorId,
                {
                    ...(typeof body.name === "string"
                        ? { name: body.name }
                        : {}),
                    ...(typeof body.serverUrl === "string"
                        ? { serverUrl: body.serverUrl }
                        : {}),
                    ...(typeof body.enabled === "boolean"
                        ? { enabled: body.enabled }
                        : {}),
                    ...("bearerToken" in body
                        ? {
                              bearerToken:
                                  typeof body.bearerToken === "string"
                                      ? body.bearerToken
                                      : null,
                          }
                        : {}),
                    ...("headers" in body
                        ? {
                              headers:
                                  body.headers &&
                                  typeof body.headers === "object" &&
                                  !Array.isArray(body.headers)
                                      ? (body.headers as Record<
                                            string,
                                            unknown
                                        >)
                                      : {},
                          }
                        : {}),
                },
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] update failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({ detail });
        }
    },
);

userRouter.delete(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteUserMcpConnector(userId, req.params.connectorId, db);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] delete failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.post(
    "/mcp-connectors/:connectorId/oauth/start",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
            const result = await startUserMcpConnectorOAuth(
                userId,
                req.params.connectorId,
                redirectUri,
                db,
            );
            res.json(result);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] oauth start failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({ detail });
        }
    },
);

userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
    const db = createServerSupabase();
    try {
        if (error) throw new Error(error);
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await completeUserMcpConnectorOAuth(state, code, db);
        res.set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: true,
                        connectorId: result.connectorId,
                    },
                    nonce,
                ),
            );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: detail,
            stateHash: shortHash(state),
            hasCode: !!code,
            hasError: !!error,
            issuer:
                typeof req.query.iss === "string" ? req.query.iss : undefined,
            scope:
                typeof req.query.scope === "string"
                    ? req.query.scope
                    : undefined,
        });
        res.status(400)
            .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            .type("html")
            .send(mcpOAuthPopupHtml({ success: false, detail }, nonce));
    }
});

userRouter.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const connector = await refreshUserMcpConnectorTools(
                userId,
                req.params.connectorId,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] refresh failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            if (err instanceof McpOAuthRequiredError) {
                return void res.status(401).json({
                    code: err.code,
                    detail,
                });
            }
            res.status(400).json({ detail });
        }
    },
);

userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        try {
            const connector = await setUserMcpToolEnabled(
                userId,
                req.params.connectorId,
                req.params.toolId,
                parsed.value,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] tool toggle failed", {
                userId,
                connectorId: req.params.connectorId,
                toolId: req.params.toolId,
                error: detail,
            });
            res.status(400).json({ detail });
        }
    },
);

userRouter.delete(
    "/account",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error)
                return void res.status(500).json({ detail: error.message });
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/account] delete failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.delete(
    "/chats",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteAllUserChats(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats] delete failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.delete(
    "/projects",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteUserProjects(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/projects] delete failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteAllUserTabularReviews(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/tabular-reviews] delete failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.get(
    "/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserAccountExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("account", userId)}"`,
            );
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/export] failed", { userId, error: detail });
            res.status(500).json({ detail });
        }
    },
);

userRouter.get(
    "/chats/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserChatsExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("chats", userId)}"`,
            );
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats/export] failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);

userRouter.get(
    "/tabular-reviews/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();
        try {
            const data = await buildUserTabularReviewsExport(
                db,
                userId,
                userEmail,
            );
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("tabular-reviews", userId)}"`,
            );
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/tabular-reviews/export] failed", {
                userId,
                error: detail,
            });
            res.status(500).json({ detail });
        }
    },
);
