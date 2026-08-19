import "./lib/loadEnv";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Router,
} from "express";
import rateLimit from "express-rate-limit";
import { runtime } from "./runtime";
import { publicRuntimeConfig, trustedProxyHops } from "./runtimeConfig";
import { safeErrorLog } from "./lib/safeError";

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
      runtime.mode === "local" || req.method === "OPTIONS",
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

api.disable("x-powered-by");
api.set("trust proxy", trustedProxyHops());

api.use(generalLimiter);

api.post("/chat", chatLimiter);
api.post("/tabular-review/:reviewId/chat", chatLimiter);
api.post("/tabular-review/:reviewId/generate", chatLimiter);
api.post("/chat/create", chatCreateLimiter);
api.post("/chat/:chatId/generate-title", chatCreateLimiter);
api.post("/single-documents", uploadLimiter);
api.post("/library/:kind/documents", uploadLimiter);
api.post("/single-documents/:documentId/versions", uploadLimiter);
api.put(
  "/single-documents/:documentId/versions/:versionId/file",
  uploadLimiter,
);
api.post("/projects/:projectId/documents", uploadLimiter);
api.get("/user/export", exportLimiter);
api.get("/user/chats/export", exportLimiter);
api.get("/user/tabular-reviews/export", exportLimiter);
if (runtime.mode === "cloud") api.get("/audit/export", exportLimiter);
api.delete("/user/account", dataDeleteLimiter);
api.delete("/user/chats", dataDeleteLimiter);
api.delete("/user/projects", dataDeleteLimiter);
api.delete("/user/tabular-reviews", dataDeleteLimiter);

api.use(express.json({ limit: "5mb" }));

api.use(
  "/chat",
  lazyRouter(async () => {
    const { createChatRouter } = await import("./routes/chat");
    const [chats, chat] = await Promise.all([
      runtime.chats(), runtime.chat(),
    ]);
    return createChatRouter(chats, chat);
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
    return createDocumentsRouter(library, documents);
  }),
);
api.use(
  "/sources",
  lazyRouter(() =>
    import("./routes/legalLibrary").then((mod) => mod.legalLibraryRouter),
  ),
);
api.use(
  "/library",
  lazyRouter(async () => {
    const { createLibraryRouter } = await import("./routes/library");
    const [library, documents] = await Promise.all([
      runtime.library(), runtime.documents(),
    ]);
    return createLibraryRouter(library, documents, runtime.modelApiKeys);
  }),
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
if (runtime.mode === "cloud") {
  api.use(
    "/audit",
    lazyRouter(() => import("./routes/audit").then((mod) => mod.auditRouter)),
  );
}
const userRouter = lazyRouter(() =>
  import("./routes/user").then((mod) => mod.userRouter),
);
api.use("/user", userRouter);
api.use(
  "/models",
  lazyRouter(() => import("./routes/models").then((mod) => mod.modelRouter)),
);
api.use(
  "/table-of-authorities",
  lazyRouter(async () => (await import("./routes/tableOfAuthorities"))
    .createTableOfAuthoritiesRouter(await runtime.documents())),
);

api.get("/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
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
  if (
    error && typeof error === "object" &&
    "status" in error && error.status === 413
  ) {
    res.status(413).json({ detail: "Invalid request" });
    return;
  }
  console.error("[api] request failed", safeErrorLog(error));
  res.status(500).json({ detail: "Internal server error" });
};
api.use(apiError);
