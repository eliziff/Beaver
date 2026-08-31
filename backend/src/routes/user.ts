import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireMfaIfEnrolled } from "../middleware/auth";
import { asyncRoute } from "../lib/asyncRoute";
import { ApplicationError, applicationScope } from "../lib/applicationError";
import { sha256 } from "../lib/hash";
import { isSupportedModel } from "../lib/llm";
import { publicOrigin } from "../lib/publicOrigin";
import { safeErrorLog, safeErrorMessage, safePublicErrorMessage } from "../lib/safeError";
import { API_KEY_PROVIDERS } from "../lib/userCredentials";
import type { UserApplication } from "../lib/userApplication";
import type { UserPreferencesPatch } from "../lib/userPreferences";

const optionalModel = z.string().trim().min(1).max(160)
  .refine(isSupportedModel, "Unsupported model").nullable().optional();
const fileTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), folderId: z.string().trim().min(1).max(160) })
    .strict(),
  z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1).max(160),
    folderId: z.string().trim().min(1).max(160) }).strict(),
]);
const profileInput = z.object({
  displayName: z.string().trim().max(160).nullable().optional(),
  organisation: z.string().trim().max(240).nullable().optional(),
  practiceSetting: z.string().trim().max(80).nullable().optional(),
  professionalTitle: z.string().trim().max(120).nullable().optional(),
  practiceAreas: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  jurisdictionPreference: z.object({
    mode: z.enum(["ask", "presume"]),
    jurisdictions: z.array(z.string().trim().min(1).max(80)).max(100),
  }).strict().optional(),
  onboardingCompleted: z.boolean().optional(),
  titleModel: optionalModel,
  tabularModel: optionalModel,
  lastSelectedChatModel: optionalModel,
  lastSelectedReasoningEffort: z.string().trim()
    .regex(/^[a-z0-9_-]{1,32}$/iu).nullable().optional(),
  legalResearchUs: z.boolean().optional(),
  features: z.object({ authorities: z.boolean() }).strict().optional(),
  workflowFileTargets: z.object({
    "court-records": fileTarget.nullable(), authorities: fileTarget.nullable(),
  }).strict().optional(),
  filingContact: z.object({
    name: z.string().trim().max(240), address: z.string().trim().max(2_000),
    phone: z.string().trim().max(80), fax: z.string().trim().max(80),
    email: z.string().trim().max(320),
  }).strict().optional(),
  draftingStyle: z.record(z.unknown()).optional(),
}).strict();
const enabledInput = z.object({ enabled: z.boolean() }).strict();
const keyInput = z.object({
  api_key: z.string().trim().max(32_768).nullable().optional(),
}).strict();
const connectorCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  serverUrl: z.string().trim().url().max(2_048),
  bearerToken: z.string().max(32_768).nullable().optional(),
  headers: z.record(z.unknown()).optional(),
}).strict();
const connectorPatchInput = connectorCreateInput.partial()
  .extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export function createUserRouter(app: UserApplication) {
  const router = Router();
  type Connectors = Awaited<ReturnType<typeof app.connectors>>;
  const connector = (
    handler: (req: Request, res: Response, mcp: Connectors) => Promise<unknown>,
    errorStatus = 500,
  ) => asyncRoute(async (req, res) => {
    try { return await handler(req, res, await app.connectors()); }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        errorStatus, errorStatus >= 500 ? "Account operation failed"
          : safePublicErrorMessage(error, "Account operation failed"),
      );
    }
  });

  router.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = randomBytes(16).toString("base64");
    try {
      const mcp = await app.connectors();
      if (req.query.error) throw new Error("OAuth authorization was not completed");
      await mcp.completeUserMcpConnectorOAuth(
        z.string().min(1).max(4_096).parse(req.query.state),
        z.string().min(1).max(16_384).parse(req.query.code),
      );
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

  router.use(requireAuth);
  router.get("/profile", asyncRoute(async (_req, res) =>
    res.json(await app.profile(applicationScope(res)))));
  router.patch("/profile", asyncRoute(async (req, res) => res.json(
    await app.updateProfile(
      applicationScope(res),
      profileInput.parse(req.body) as UserPreferencesPatch,
    ),
  )));
  router.get("/lookup", asyncRoute(async (req, res) => res.json(
    await app.lookup(z.string().trim().email().max(320).parse(req.query.email)),
  )));
  router.patch("/security/mfa-login", requireMfaIfEnrolled, asyncRoute(async (req, res) =>
    res.json(await app.setMfaOnLogin(
      applicationScope(res),
      enabledInput.parse(req.body).enabled,
    ))));
  router.get("/api-keys", asyncRoute(async (_req, res) =>
    res.json(await app.apiKeys(applicationScope(res)))));
  router.put("/api-keys/:provider", requireMfaIfEnrolled, asyncRoute(async (req, res) =>
    res.json(await app.saveApiKey(
      applicationScope(res),
      z.enum(API_KEY_PROVIDERS).parse(req.params.provider),
      keyInput.parse(req.body).api_key ?? null,
    ))));

  router.get("/mcp-connectors", connector(async (_req, res, mcp) =>
    res.json(await mcp.listUserMcpConnectors(applicationScope(res).userId,
      { includeTools: false }))));
  router.get("/mcp-connectors/:connectorId", connector(async (req, res, mcp) =>
    res.json(await mcp.getUserMcpConnector(
      applicationScope(res).userId, req.params.connectorId,
    )), 404));
  router.post("/mcp-connectors", requireMfaIfEnrolled, connector(async (req, res, mcp) =>
    res.status(201).json(await mcp.createUserMcpConnector(
      applicationScope(res).userId, connectorCreateInput.parse(req.body),
    )), 400));
  router.patch("/mcp-connectors/:connectorId", requireMfaIfEnrolled,
    connector(async (req, res, mcp) => res.json(await mcp.updateUserMcpConnector(
      applicationScope(res).userId, req.params.connectorId,
      connectorPatchInput.parse(req.body),
    )), 400));
  router.delete("/mcp-connectors/:connectorId", requireMfaIfEnrolled,
    connector(async (req, res, mcp) => {
      await mcp.deleteUserMcpConnector(applicationScope(res).userId, req.params.connectorId);
      res.status(204).send();
    }));
  router.post("/mcp-connectors/:connectorId/oauth/start", requireMfaIfEnrolled,
    connector(async (req, res, mcp) => res.json(await mcp.startUserMcpConnectorOAuth(
      applicationScope(res).userId, req.params.connectorId,
    )), 400));
  router.post("/mcp-connectors/:connectorId/refresh-tools", requireMfaIfEnrolled,
    connector(async (req, res, mcp) => {
      try {
        res.json(await mcp.refreshUserMcpConnectorTools(
          applicationScope(res).userId, req.params.connectorId,
        ));
      } catch (error) {
        if (error instanceof mcp.McpOAuthRequiredError) throw new ApplicationError(
          401, safeErrorMessage(error), { code: "oauth_required" },
        );
        throw error;
      }
    }, 400));
  router.patch("/mcp-connectors/:connectorId/tools/:toolId", requireMfaIfEnrolled,
    connector(async (req, res, mcp) => res.json(await mcp.setUserMcpToolEnabled(
      applicationScope(res).userId, req.params.connectorId, req.params.toolId,
      enabledInput.parse(req.body).enabled,
    )), 400));

  router.delete("/account", requireMfaIfEnrolled, asyncRoute(async (_req, res) => {
    await app.deleteAccount(applicationScope(res));
    res.status(204).send();
  }));
  for (const [path, kind] of [
    ["/chats", "chats"], ["/projects", "projects"],
    ["/tabular-reviews", "tabular-reviews"],
  ] as const) router.delete(path, requireMfaIfEnrolled, asyncRoute(async (_req, res) => {
    await app.deleteResource(applicationScope(res), kind);
    res.status(204).send();
  }));
  for (const [path, kind] of [
    ["/export", "account"], ["/chats/export", "chats"],
    ["/tabular-reviews/export", "tabular-reviews"],
  ] as const) router.get(path, requireMfaIfEnrolled, asyncRoute(async (_req, res) => {
    const result = await app.exportData(applicationScope(res), kind);
    res.set("X-Content-Type-Options", "nosniff").attachment(result.filename)
      .type("application/json").json(result.data);
  }));
  return router;
}

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
