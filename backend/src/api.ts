import "./lib/loadEnv";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { runtime } from "./runtime";
import { publicRuntimeConfig, trustedProxyHops } from "./runtimeConfig";
import { sha256 } from "./lib/hash";
import { concurrentRequests } from "./lib/requestConcurrency";
import { safeErrorLog } from "./lib/safeError";
import { publicOrigin } from "./lib/publicOrigin";

export const api = express();

function lazyRouter(load: () => Promise<Router>): RequestHandler {
  let router: Router | undefined;
  let pending: Promise<Router> | undefined;
  const start = () => {
    pending ??= load().then((loaded) => {
      router = loaded;
      return loaded;
    });
    return pending;
  };
  return (req, res, next) => {
    if (router) return void router(req, res, next);
    void start().then((loaded) => loaded(req, res, next)).catch(next);
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function makeLimiter(name: string, max: number, window: number,
  unit: "MINUTES" | "HOURS", message?: string, perSession = true) {
  return rateLimit({
    windowMs: envInt(`RATE_LIMIT_${name}_WINDOW_${unit}`, window) *
      (unit === "HOURS" ? 3_600_000 : 60_000),
    max: envInt(`RATE_LIMIT_${name}_MAX`, max),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      runtime.mode === "local" || req.method === "OPTIONS",
    ...(perSession ? { keyGenerator: (req) => {
      const token = req.get("authorization")
        ?.match(/^Bearer ([A-Za-z0-9._~+/-]{1,8192}=*)$/iu)?.[1];
      return token ? `session:${sha256(token)}`
        : ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
    } } : {}),
    message: {
      detail: message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter("GENERAL", 3_000, 15, "MINUTES", undefined, false);
const chatLimiter = makeLimiter("CHAT", 30, 15, "MINUTES",
  "Too many chat requests. Please try again later.");
const chatCreateLimiter = makeLimiter("CHAT_CREATE", 60, 15, "MINUTES");
const uploadLimiter = makeLimiter("UPLOAD", 200, 1, "HOURS",
  "Too many upload requests. Please try again later.");
const exportLimiter = makeLimiter("EXPORT", 10, 1, "HOURS",
  "Too many export requests. Please try again later.");
const dataDeleteLimiter = makeLimiter("DATA_DELETE", 20, 1, "HOURS",
  "Too many data deletion requests. Please try again later.");
const lookupLimiter = makeLimiter("LOOKUP", 60, 1, "HOURS");
const authLimiter = makeLimiter("AUTH", 60, 15, "MINUTES", undefined, false);
const workSlot = concurrentRequests(8, "The service is busy. Try again shortly.");
const jsonBody = express.json({ limit: "2mb" });

api.disable("x-powered-by");
api.set("trust proxy", trustedProxyHops());

api.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
api.use(generalLimiter);

for (const path of ["/chat", "/chat/:chatId/compact", "/chat/:chatId/generate-title",
  "/tabular-review/prompt", "/tabular-review/:reviewId/regenerate-cell",
  "/tabular-review/:reviewId/generate"])
  api.post(path, chatLimiter, workSlot);
api.post("/chat/create", chatCreateLimiter);
for (const path of ["/single-documents", "/library/:kind/documents",
  "/single-documents/:documentId/versions", "/projects/:projectId/documents",
  "/court-records/documents", "/court-records/documents/:documentId/versions",
  "/court-records/docx-rendition", "/court-records/pdf-preparation",
  "/authorities-runtime/import", "/authorities-runtime/refresh", "/authorities-runtime/build",
  "/authorities/documents", "/authorities/:id/attachments/:authorityId"])
  api.post(path, uploadLimiter);
for (const path of ["/court-records/docx-rendition", "/court-records/pdf-preparation"])
  api.post(path, workSlot);
for (const path of ["/user/export", "/user/chats/export",
  "/user/tabular-reviews/export", "/tabular-review/:reviewId/export",
  "/workflows/:workflowId/export"]) api.get(path, exportLimiter, workSlot);
api.post("/single-documents/download-zip", exportLimiter, workSlot);
api.get("/audit/export", exportLimiter, workSlot);
for (const path of ["/user/account", "/user/chats", "/user/projects",
  "/user/tabular-reviews"]) api.delete(path, dataDeleteLimiter);
api.get("/user/lookup", lookupLimiter);
for (const path of ["/user/mcp-connectors/:connectorId/oauth/start",
  "/user/mcp-connectors/:connectorId/refresh-tools", "/sources",
  "/work-products/:id/research-query",
  "/library/:kind/documents/:documentId/actions/retry-pdf-parse",
  "/authorities", "/authorities/:id/actions",
  "/authorities-runtime/import", "/authorities-runtime/refresh",
  "/authorities-runtime/action", "/authorities-runtime/build",
  "/authorities/:id/refresh", "/authorities/:id/build"])
  api.post(path, lookupLimiter, workSlot);
for (const path of ["/sources/coverage", "/sources/search", "/sources/document",
  "/sources/:referenceId/document", "/court-records/documents/:documentId/preparation"])
  api.get(path, lookupLimiter, workSlot);

if (runtime.mode === "local") api.use("/authorities-runtime/action",
  express.json({ limit: "100mb" }));
api.use(jsonBody);

if (runtime.mode === "cloud") api.use(
  "/auth",
  authLimiter,
  lazyRouter(() => import("./routes/auth").then((mod) =>
    mod.createAuthRouter(publicOrigin()))),
);

api.use(
  "/chat",
  lazyRouter(async () => {
    const { createChatRouter } = await import("./routes/chat");
    const [chats, chat] = await Promise.all([
      runtime.chats(), runtime.chat(),
    ]);
    const { durableChatTurns } = await import("./lib/chatTurnQueue");
    return createChatRouter(chats, chat, durableChatTurns);
  }),
);
api.use(
  "/projects",
  lazyRouter(async () => {
    const { createProjectsRouter } = await import("./routes/projects");
    const [projects, chats, documents] = await Promise.all([
      runtime.projects(), runtime.chats(), runtime.documents(),
    ]);
    return createProjectsRouter(projects, chats, documents);
  }),
);
api.use(
  "/single-documents",
  lazyRouter(async () => {
    const { createDocumentsRouter } = await import("./routes/documentRoutes");
    const [library, documents] = await Promise.all([
      runtime.library(), runtime.documents(),
    ]);
    return createDocumentsRouter(library, documents,
      (...events) => runtime.audit().then((store) => store.record(...events)));
  }),
);
api.use(
  "/sources",
  lazyRouter(async () => (await import("./routes/legalLibrary"))
    .createLegalLibraryRouter(await runtime.legalSources())),
);
api.use(
  "/library",
  lazyRouter(async () => {
    const { createLibraryRouter } = await import("./routes/library");
    const [library, documents] = await Promise.all([
      runtime.library(), runtime.documents(),
    ]);
    return createLibraryRouter(library, documents);
  }),
);
api.use(
  "/court-records",
  lazyRouter(async () => (await import("./routes/courtRecords"))
    .createCourtRecordsRouter(await runtime.courtRecords())),
);
if (runtime.mode === "local") api.use(
  "/authorities-runtime",
  lazyRouter(async () => (await import("./routes/authoritiesRuntime"))
    .createAuthoritiesRuntimeRouter()),
);
api.use("/quote-check", lazyRouter(async () => (await import("./routes/quoteCheck"))
  .createQuoteCheckRouter(await runtime.documents())));
api.use(
  "/authorities",
  lazyRouter(async () => (await import("./routes/authorities"))
    .createAuthoritiesRouter(await runtime.authoritiesWorkspace())),
);
api.use(
  "/tabular-review",
  lazyRouter(async () => {
    const { createTabularRouter } = await import("./routes/tabular");
    return createTabularRouter(await runtime.tabular());
  }),
);
api.use(
  "/workflows",
  lazyRouter(async () => {
    const [{ createWorkflowsRouter }, workflows] = await Promise.all([
      import("./routes/workflows"), runtime.workflows(),
    ]);
    return createWorkflowsRouter(workflows.repository, workflows.collaboration);
  }),
);
api.use(
  "/work-products",
  lazyRouter(async () => (await import("./routes/workProducts"))
    .createWorkProductsRouter(await runtime.workProducts())),
);
api.use("/audit", lazyRouter(async () => (await import("./routes/audit"))
  .createAuditRouter(await runtime.audit())));
api.use("/user", lazyRouter(async () =>
  (await import("./routes/user")).createUserRouter(await runtime.user())));
api.use(
  "/models",
  lazyRouter(async () =>
    (await import("./routes/models")).createModelsRouter(await runtime.user())),
);
api.get("/config", (_req, res) => {
  res.json(publicRuntimeConfig());
});

api.get("/health", (_req, res) => {
  res.json({
    ok: true,
    runtime: {
      mode: runtime.mode,
    },
  });
});

const apiError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error && typeof error === "object" && "status" in error
    ? error.status : undefined;
  if (status === 400 || status === 413) {
    res.status(status).json({ detail: "Invalid request" });
    return;
  }
  console.error("[api] request failed", safeErrorLog(error));
  res.status(500).json({ detail: "Internal server error" });
};
api.use(apiError);
