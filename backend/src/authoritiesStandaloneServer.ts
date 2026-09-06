import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ApplicationError } from "./lib/applicationError";
import { createAuthoritiesRuntimeRouter } from "./routes/authoritiesRuntime";

export type AuthoritiesStandaloneOptions = { port: number; buildId: string; frontend: string };

/** Shared runtime and workspace, with a loopback-only HTTP deployment adapter. */
export function createAuthoritiesStandaloneApp({ port, buildId, frontend }: AuthoritiesStandaloneOptions) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 to 65535");
  if (!/^[a-f\d]{64}$/u.test(buildId))
    throw new Error("AUTHORITIES_BUILD_ID must be a lowercase SHA-256 hash");
  const page = path.join(frontend, "authorities.html");
  const app = express(); app.disable("x-powered-by");
  const origin = `http://127.0.0.1:${port}`;
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${port}` ||
        req.headers.origin && req.headers.origin !== origin) {
      res.status(403).json({ detail: "This local Authorities request was refused" }); return;
    }
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({ status: "ok", app: "authorities", buildId }));
  app.use("/api/authorities-runtime", express.json({ limit: "100mb" }),
    createAuthoritiesRuntimeRouter((_req, res, next) => {
      res.locals.userId = "00000000-0000-0000-0000-000000000001"; next();
    }));
  const staticOptions = {
    immutable: true, maxAge: "1y", fallthrough: false,
  } as const;
  app.use("/assets", express.static(path.join(frontend, "assets"), staticOptions));
  app.use("/pdfjs-standard-fonts", express.static(
    path.join(frontend, "pdfjs-standard-fonts"), staticOptions));
  app.get(["/", "/authorities.html"], (_req, res) => res.sendFile(page));
  app.use(((error, _req, res, _next) => {
    const status = error instanceof ApplicationError ? error.status : 500;
    res.status(status).json({ detail: status === 500
      ? "Authorities could not complete that operation"
      : error.message });
  }) satisfies ErrorRequestHandler);

  return app;
}

export async function startAuthoritiesStandalone() {
  const port = Number(process.env.PORT ?? 3000);
  const buildId = process.env.AUTHORITIES_BUILD_ID?.trim() ?? "";
  const frontend = path.resolve(__dirname, "../../frontend/dist");
  if (!existsSync(path.join(frontend, "authorities.html")))
    throw new Error("Build the frontend before starting Authorities");
  const app = createAuthoritiesStandaloneApp({ port, buildId, frontend });
  const listener = app.listen(port, "127.0.0.1", () => {
    console.log(`Authorities running at http://127.0.0.1:${port}/authorities.html`);
    process.send?.({ type: "ready" });
  });
  const stop = () => { listener.close(); listener.closeAllConnections(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return listener;
}
