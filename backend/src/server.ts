import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { api } from "./api";
import { publicRuntimeConfig, trustedProxyHops } from "./runtimeConfig";
import { publicOrigin } from "./lib/publicOrigin";
import { wordManifest } from "./lib/wordManifest";

const frontend = path.resolve(__dirname, "../../frontend/dist");
const config = publicRuntimeConfig();
const cloudOrigin = config.mode === "cloud" ? publicOrigin() : null;
const connectSrc = ["'self'"];
let appHtml: string | undefined;

function sendApp(_req: express.Request, res: express.Response) {
  appHtml ??= readFileSync(path.join(frontend, "index.html"), "utf8").replace(
    "__BEAVER_RUNTIME_CONFIG__",
    encodeURIComponent(JSON.stringify(config)),
  );
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(appHtml);
}

export const server = express();
server.disable("x-powered-by");
server.set("trust proxy", trustedProxyHops());
server.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  next();
});
server.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      connectSrc,
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ["'self'", "blob:"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "https://appsforoffice.microsoft.com"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      // DOCX documents define their own paragraph, numbering, and page styles.
      // The vendored renderer emits CSS only; scripts remain restricted to self.
      styleSrcElem: ["'self'", "'unsafe-inline'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
      workerSrc: ["'self'", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 15_552_000, includeSubDomains: true }
    : false,
  referrerPolicy: { policy: "no-referrer" },
}));
server.use((req, res, next) => {
  if (
    config.mode === "local" &&
    !["127.0.0.1", "::1", "localhost"].includes(req.hostname)
  ) {
    res.status(421).send("Local Beaver accepts loopback hosts only");
    return;
  }
  const oauthCallback = req.method === "GET" &&
    config.capabilities.connectors && req.path === "/api/user/mcp-connectors/oauth/callback";
  const allowedCrossSitePage = req.method === "GET" &&
    ["/auth/callback", "/word.html", "/word-manifest.xml"].includes(req.path);
  if (!oauthCallback && !allowedCrossSitePage &&
      req.get("sec-fetch-site") === "cross-site") {
    res.status(403).send("Cross-site requests are not allowed");
    return;
  }
  const origin = req.get("origin");
  if (origin && !oauthCallback) {
    try {
      const expected = cloudOrigin ??
        new URL(`${req.protocol}://${req.get("host")}`).origin;
      if (new URL(origin).origin.toLowerCase() !== expected.toLowerCase()) throw new Error();
    } catch {
      res.status(403).send("Cross-origin requests are not allowed");
      return;
    }
  }
  next();
});
server.use("/api", api);
server.use("/api", (_req, res) => res.status(404).json({ detail: "Not found" }));
server.get("/word-manifest.xml", (req, res) => {
  try {
    const configured = process.env.PUBLIC_ORIGIN?.trim();
    const origin = cloudOrigin ?? (configured?.startsWith("https://")
      ? publicOrigin() : new URL(`${req.protocol}://${req.get("host")}`).origin);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'attachment; filename="beaver-word.xml"');
    res.type("application/xml").send(wordManifest(origin));
  } catch (error) {
    res.status(400).type("text/plain").send(
      error instanceof Error ? error.message : "Word manifest unavailable",
    );
  }
});
server.get(["/", "/index.html"], sendApp);
server.use(express.static(frontend, {
  dotfiles: "deny",
  index: false,
  setHeaders: (res, file) => {
    res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable" : "no-cache");
    if (path.basename(file) === "word.html") {
      const csp = String(res.getHeader("Content-Security-Policy") ?? "");
      res.setHeader("Content-Security-Policy", csp.replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self' https://*.office.com https://*.officeapps.live.com https://*.microsoft365.com",
      ));
      res.removeHeader("X-Frame-Options");
    }
  },
}));
server.get("*", (req, res, next) => {
  if (
    ["/assets/", "/icons/", "/pdfjs-standard-fonts/"].some((prefix) =>
      req.path.startsWith(prefix)
    ) ||
    !req.accepts("html")
  ) return next();
  sendApp(req, res);
});

export function assertFrontendBuild() {
  if (!existsSync(path.join(frontend, "index.html"))) {
    throw new Error(`Frontend build is missing: ${frontend}`);
  }
}
