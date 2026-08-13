import "./lib/loadEnv";
import express, { type RequestHandler, type Router } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { isAnonymousLocalMode } from "./lib/localMode";

export const app = express();
const isProduction = process.env.NODE_ENV === "production";
const configuredFrontendUrl =
  process.env.FRONTEND_URL ?? "http://localhost:3000";
const allowedDevelopmentFrontendUrls = new Set([
  configuredFrontendUrl,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function lazyRouter(load: () => Promise<Router>, warm = false): RequestHandler {
  let router: Router | undefined;
  let pending: Promise<Router> | undefined;
  const start = () => {
    pending ??= load().then((loaded) => {
      router = loaded;
      return loaded;
    });
    return pending;
  };
  if (warm) void start().catch(() => {});
  return (req, res, next) => {
    if (router) return void router(req, res, next);
    void start().then((loaded) => loaded(req, res, next)).catch(next);
  };
}

const localOrCloudRouter = (
  local: () => Promise<Router>,
  cloud: () => Promise<Router>,
) => lazyRouter(() => (isAnonymousLocalMode() ? local() : cloud()), isAnonymousLocalMode());

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail: options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
});

const chatLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const uploadLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

const exportLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_EXPORT_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_EXPORT_MAX", 10),
  message: "Too many export requests. Please try again later.",
});

const dataDeleteLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_DATA_DELETE_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_DATA_DELETE_MAX", 20),
  message: "Too many data deletion requests. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        (!isProduction && allowedDevelopmentFrontendUrls.has(origin)) ||
        (isProduction && origin === configuredFrontendUrl)
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(generalLimiter);

app.post("/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/single-documents", uploadLimiter);
app.post("/library/:kind/documents", uploadLimiter);
app.post("/single-documents/:documentId/versions", uploadLimiter);
app.put(
  "/single-documents/:documentId/versions/:versionId/file",
  uploadLimiter,
);
app.post("/projects/:projectId/documents", uploadLimiter);
app.get("/user/export", exportLimiter);
app.get("/user/chats/export", exportLimiter);
app.get("/user/tabular-reviews/export", exportLimiter);
if (!isAnonymousLocalMode()) app.get("/audit/export", exportLimiter);
app.delete("/user/account", dataDeleteLimiter);
app.delete("/user/chats", dataDeleteLimiter);
app.delete("/user/projects", dataDeleteLimiter);
app.delete("/user/tabular-reviews", dataDeleteLimiter);

app.use(express.json({ limit: "50mb" }));

app.use(
  "/chat",
  lazyRouter(() => import("./routes/chat").then((mod) => mod.chatRouter), isAnonymousLocalMode()),
);
app.use(
  "/projects",
  lazyRouter(
    () => import("./routes/projects").then((mod) => mod.projectsRouter),
    isAnonymousLocalMode(),
  ),
);
app.use(
  "/single-documents",
  localOrCloudRouter(
    () => import("./routes/localDocuments").then((mod) => mod.localDocumentsRouter),
    () => import("./routes/documents").then((mod) => mod.documentsRouter),
  ),
);
app.use(
  "/library/legal",
  lazyRouter(() =>
    import("./routes/legalLibrary").then((mod) => mod.legalLibraryRouter),
  ),
);
app.use(
  "/legal-knowledge",
  lazyRouter(() =>
    import("./routes/legalKnowledge").then((mod) => mod.legalKnowledgeRouter),
  ),
);
app.use(
  "/library",
  localOrCloudRouter(
    () => import("./routes/localLibrary").then((mod) => mod.localLibraryRouter),
    () => import("./routes/library").then((mod) => mod.libraryRouter),
  ),
);
app.use(
  "/tabular-review",
  lazyRouter(() => import("./routes/tabular").then((mod) => mod.tabularRouter)),
);
app.use(
  "/workflows",
  lazyRouter(() =>
    import("./routes/workflows").then((mod) => mod.workflowsRouter),
  ),
);
if (!isAnonymousLocalMode()) {
  app.use(
    "/audit",
    lazyRouter(() => import("./routes/audit").then((mod) => mod.auditRouter)),
  );
}
const localUserRouter = lazyRouter(() =>
  import("./routes/localUser").then((mod) => mod.localUserRouter),
  isAnonymousLocalMode(),
);
const cloudUserRouter = lazyRouter(() =>
  import("./routes/user").then((mod) => mod.userRouter),
);
app.use(
  "/user",
  (req, res, next) =>
    (isAnonymousLocalMode() ? localUserRouter : cloudUserRouter)(
      req,
      res,
      next,
    ),
);
app.use(
  "/download",
  lazyRouter(() => import("./routes/downloads").then((mod) => mod.downloadsRouter)),
);
app.use(
  "/case-law",
  lazyRouter(() => import("./routes/caseLaw").then((mod) => mod.caseLawRouter)),
);
app.use(
  "/models",
  lazyRouter(() => import("./routes/models").then((mod) => mod.modelRouter), isAnonymousLocalMode()),
);
app.use(
  "/table-of-authorities",
  lazyRouter(() =>
    import("./routes/tableOfAuthorities").then(
      (mod) => mod.tableOfAuthoritiesRouter,
    ),
    isAnonymousLocalMode(),
  ),
);

app.get("/health", (_req, res) => {
  if (isAnonymousLocalMode() && app.locals.localReady === false) {
    return void res.status(503).json({ ok: false });
  }
  res.json({
    ok: true,
    runtime: {
      mode: isAnonymousLocalMode() ? "anonymous-local" : "cloud",
    },
  });
});
