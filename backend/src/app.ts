import "./lib/loadEnv";
import express, { type RequestHandler, type Router } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { runtime } from "./runtime";

export const app = express();
const isProduction = process.env.NODE_ENV === "production";
const configuredFrontendUrl =
  process.env.FRONTEND_URL ?? "http://localhost:3000";
const allowedDevelopmentFrontendUrls = new Set([
  configuredFrontendUrl,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

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
    skip: (req) =>
      runtime.mode === "anonymous-local" || req.method === "OPTIONS",
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
if (runtime.mode === "cloud") app.get("/audit/export", exportLimiter);
app.delete("/user/account", dataDeleteLimiter);
app.delete("/user/chats", dataDeleteLimiter);
app.delete("/user/projects", dataDeleteLimiter);
app.delete("/user/tabular-reviews", dataDeleteLimiter);

app.use(express.json({ limit: "50mb" }));

app.use(
  "/chat",
  lazyRouter(async () => {
    const { createChatRouter } = await import("./routes/chat");
    const [chats, chat] = await Promise.all([
      runtime.chats(), runtime.chat(),
    ]);
    return createChatRouter(chats, chat);
  }),
);
app.use(
  "/projects",
  lazyRouter(async () => {
    const { createProjectsRouter } = await import("./routes/projects");
    const [projects, chats, documents] = await Promise.all([
      runtime.projects(), runtime.chats(), runtime.documents(),
    ]);
    return createProjectsRouter(projects, chats, documents);
  }),
);
app.use(
  "/single-documents",
  lazyRouter(async () => {
    const { createDocumentsRouter } = await import("./routes/documentRoutes");
    const [library, documents, extensions] = await Promise.all([
      runtime.library(), runtime.documents(), runtime.documentExtensions(),
    ]);
    const router = createDocumentsRouter(library, documents);
    return extensions?.use(router) ?? router;
  }),
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
  lazyRouter(async () => {
    const { createLibraryRouter } = await import("./routes/library");
    const [library, documents, extensions] = await Promise.all([
      runtime.library(), runtime.documents(), runtime.libraryExtensions(),
    ]);
    const router = createLibraryRouter(library, documents);
    return extensions ? router.use(extensions) : router;
  }),
);
app.use(
  "/tabular-review",
  lazyRouter(async () => {
    const { createTabularRouter } = await import("./routes/tabular");
    const [tabular, documents] = await Promise.all([
      runtime.tabular(), runtime.documents(),
    ]);
    return createTabularRouter(tabular, documents);
  }),
);
app.use(
  "/workflows",
  lazyRouter(() =>
    import("./routes/workflows").then((mod) => mod.workflowsRouter),
  ),
);
if (runtime.mode === "cloud") {
  app.use(
    "/audit",
    lazyRouter(() => import("./routes/audit").then((mod) => mod.auditRouter)),
  );
}
const localUserRouter = lazyRouter(() =>
  import("./routes/localUser").then((mod) => mod.localUserRouter),
);
const cloudUserRouter = lazyRouter(() =>
  import("./routes/user").then((mod) => mod.userRouter),
);
app.use(
  "/user",
  (req, res, next) =>
    (runtime.mode === "anonymous-local" ? localUserRouter : cloudUserRouter)(
      req,
      res,
      next,
    ),
);
app.use(
  "/case-law",
  lazyRouter(() => import("./routes/caseLaw").then((mod) => mod.caseLawRouter)),
);
app.use(
  "/models",
  lazyRouter(() => import("./routes/models").then((mod) => mod.modelRouter)),
);
app.use(
  "/table-of-authorities",
  lazyRouter(() =>
    import("./routes/tableOfAuthorities").then(
      (mod) => mod.tableOfAuthoritiesRouter,
    ),
  ),
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    runtime: {
      mode: runtime.mode,
    },
  });
});
