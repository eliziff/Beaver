// Account HTTP boundary. Public entrypoint: userRouter.
// Canonical operations live in userApiKeys, userDataExport/Cleanup, and
// mcp/servers; keep this file to validation and HTTP response mapping.
import { randomBytes } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import {
    createServerSupabase,
} from "../lib/supabase";
import { recordAudit } from "../lib/audit";
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
    getUserApiKeyStatus,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveUserApiKey,
} from "../lib/userApiKeys";
import * as userDataCleanup from "../lib/userDataCleanup";
import * as userDataExport from "../lib/userDataExport";
import { findProfileUserByEmail } from "../lib/userLookup";
import { normalizeDraftingStyleSettings } from "../lib/draftingStyle";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import * as mcpServers from "../lib/mcp/servers";
import { sha256 } from "../lib/hash";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

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
    drafting_style: unknown;
};

function respondUserError(res: Response, error: unknown, status: number) {
    console.error("[user] request failed", safeErrorLog(error));
    res.status(status).json({ detail: safeErrorMessage(error) });
}

type Db = ReturnType<typeof createServerSupabase>;

async function sendUserExport(
    res: Response,
    kind: Parameters<typeof userDataExport.userExportFilename>[0],
    action: string,
    build: (db: Db, userId: string, userEmail?: string) => Promise<unknown>,
) {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    try {
        const data = await build(db, userId, userEmail);
        res.attachment(userDataExport.userExportFilename(kind, userId));
        void recordAudit(db, { userId, userEmail, action, surface: "account" });
        res.json(data);
    } catch (error) {
        respondUserError(res, error, 500);
    }
}

async function deleteUserCollection(
    res: Response,
    remove: (db: Db, userId: string) => Promise<unknown>,
) {
    const userId = res.locals.userId as string;
    try {
        await remove(createServerSupabase(), userId);
        res.status(204).send();
    } catch (error) {
        respondUserError(res, error, 500);
    }
}

function frontendUrl(path = "/account/connectors") {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
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
    "display_name, organisation, message_credits_used, credits_reset_date, tier, title_model, tabular_model, mfa_on_login, legal_research_us, drafting_style";

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
        draftingStyle: normalizeDraftingStyleSettings(row.drafting_style),
        ...(apiKeyStatus ? { apiKeyStatus } : {}),
    };
}

const supportedModel = z.string().refine((value) => !!resolveModel(value, ""));
const profilePayload = z.object({
    displayName: z.string().nullable().optional(),
    organisation: z.string().nullable().optional(),
    titleModel: supportedModel.optional(),
    tabularModel: supportedModel.optional(),
    legalResearchUs: z.boolean().optional(),
    draftingStyle: z.record(z.unknown()).optional(),
}).strict();
const enabledPayload = z.object({ enabled: z.boolean() }).strict();
const connectorCreatePayload = z.object({
    name: z.preprocess((value) => typeof value === "string" ? value : "", z.string()),
    serverUrl: z.preprocess((value) => typeof value === "string" ? value : "", z.string()),
    bearerToken: z.preprocess((value) => typeof value === "string" ? value : null, z.string().nullable()).optional(),
    headers: z.preprocess(
        (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
        z.record(z.unknown()).optional(),
    ),
});
const connectorPatchPayload = z.object({
    name: z.preprocess((value) => typeof value === "string" ? value : undefined, z.string().optional()),
    serverUrl: z.preprocess((value) => typeof value === "string" ? value : undefined, z.string().optional()),
    enabled: z.preprocess((value) => typeof value === "boolean" ? value : undefined, z.boolean().optional()),
    bearerToken: z.preprocess((value) => typeof value === "string" ? value : null, z.string().nullable()).optional(),
    headers: z.preprocess(
        (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
        z.record(z.unknown()),
    ).optional(),
});

function validationDetail(error: z.ZodError, profile: boolean) {
    const issue = error.issues[0];
    if (issue?.code === "unrecognized_keys") {
        const field = issue.keys[0];
        return `${profile ? "Unsupported profile field" : "Unsupported field"}: ${field}`;
    }
    const field = String(issue?.path[0] ?? "");
    if (!field) return "Expected a JSON object";
    if (field === "titleModel" || field === "tabularModel") {
        return issue?.code === "custom"
            ? `Unsupported ${field}`
            : `${field} must be a string`;
    }
    if (field === "displayName" || field === "organisation") {
        return `${field} must be a string or null`;
    }
    if (field === "draftingStyle") return "draftingStyle must be an object";
    return `${field} must be a boolean`;
}

function validateProfilePayload(body: unknown) {
    const parsed = profilePayload.safeParse(body);
    if (!parsed.success) {
        return { ok: false as const, detail: validationDetail(parsed.error, true) };
    }
    const raw = parsed.data;
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("displayName" in raw) update.display_name = raw.displayName?.trim() || null;
    if ("organisation" in raw) update.organisation = raw.organisation?.trim() || null;
    if (raw.titleModel) update.title_model = raw.titleModel;
    if (raw.tabularModel) update.tabular_model = raw.tabularModel;
    if (raw.legalResearchUs !== undefined) update.legal_research_us = raw.legalResearchUs;
    if (raw.draftingStyle) {
        update.drafting_style = normalizeDraftingStyleSettings(raw.draftingStyle);
    }
    return { ok: true as const, update };
}

function readEnabled(body: unknown) {
    const parsed = enabledPayload.safeParse(body);
    return parsed.success
        ? { ok: true as const, value: parsed.data.enabled }
        : { ok: false as const, detail: validationDetail(parsed.error, false) };
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
        const parsed = readEnabled(req.body);
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
            respondUserError(res, err, 500);
        }
    },
);

userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        res.json(
            await mcpServers.listUserMcpConnectors(
                userId,
                db,
                { includeTools: false },
            ),
        );
    } catch (err) {
        respondUserError(res, err, 500);
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
                await mcpServers.getUserMcpConnector(
                    userId,
                    req.params.connectorId,
                    db,
                ),
            );
        } catch (err) {
            respondUserError(res, err, 404);
        }
    },
);

userRouter.post(
    "/mcp-connectors",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const input = connectorCreatePayload.parse(req.body);
            const connector = await mcpServers.createUserMcpConnector(
                userId,
                { ...input, bearerToken: input.bearerToken ?? null },
                db,
            );
            res.status(201).json(connector);
        } catch (err) {
            respondUserError(res, err, 400);
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
        try {
            const input = connectorPatchPayload.parse(req.body);
            const connector = await mcpServers.updateUserMcpConnector(
                userId,
                req.params.connectorId,
                input,
                db,
            );
            res.json(connector);
        } catch (err) {
            respondUserError(res, err, 400);
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
            await mcpServers.deleteUserMcpConnector(
                userId,
                req.params.connectorId,
                db,
            );
            res.status(204).send();
        } catch (err) {
            respondUserError(res, err, 500);
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
            const result = await mcpServers.startUserMcpConnectorOAuth(
                userId,
                req.params.connectorId,
                db,
            );
            res.json(result);
        } catch (err) {
            respondUserError(res, err, 400);
        }
    },
);

userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = randomBytes(16).toString("base64");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
    const db = createServerSupabase();
    try {
        if (error) throw new Error("OAuth authorization was not completed.");
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await mcpServers.completeUserMcpConnectorOAuth(state, code, db);
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
        const internalError = safeErrorMessage(err);
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: internalError,
            stateDigest: state ? sha256(state).slice(0, 12) : null,
            hasCode: !!code,
            hasError: !!error,
        });
        res.status(400)
            .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: false,
                        detail: "OAuth authorization failed.",
                    },
                    nonce,
                ),
            );
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
            const connector = await mcpServers.refreshUserMcpConnectorTools(
                userId,
                req.params.connectorId,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = safeErrorMessage(err);
            if (err instanceof Error && err.name === "McpOAuthRequiredError") {
                return void res.status(401).json({
                    code: "oauth_required",
                    detail,
                });
            }
            respondUserError(res, err, 400);
        }
    },
);

userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readEnabled(req.body);
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        try {
            const connector = await mcpServers.setUserMcpToolEnabled(
                userId,
                req.params.connectorId,
                req.params.toolId,
                parsed.value,
                db,
            );
            res.json(connector);
        } catch (err) {
            respondUserError(res, err, 400);
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
            await userDataCleanup.deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error)
                return void res.status(500).json({ detail: error.message });
            res.status(204).send();
        } catch (err) {
            respondUserError(res, err, 500);
        }
    },
);

userRouter.delete("/chats", requireAuth, requireMfaIfEnrolled, async (_req, res) => {
    await deleteUserCollection(res, userDataCleanup.deleteAllUserChats);
});

userRouter.delete("/projects", requireAuth, requireMfaIfEnrolled, async (_req, res) => {
    await deleteUserCollection(res, userDataCleanup.deleteUserProjects);
});

userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        await deleteUserCollection(res, userDataCleanup.deleteAllUserTabularReviews);
    },
);

userRouter.get("/export", requireAuth, requireMfaIfEnrolled, async (_req, res) => {
    await sendUserExport(res, "account", "export.account", userDataExport.buildUserAccountExport);
});

userRouter.get("/chats/export", requireAuth, requireMfaIfEnrolled, async (_req, res) => {
    await sendUserExport(res, "chats", "export.chats", userDataExport.buildUserChatsExport);
});

userRouter.get(
    "/tabular-reviews/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        await sendUserExport(
            res,
            "tabular-reviews",
            "export.tabular",
            userDataExport.buildUserTabularReviewsExport,
        );
    },
);
