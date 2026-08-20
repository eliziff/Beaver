import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import { api } from "./api";
import { publicRuntimeConfig, trustedProxyHops } from "./runtimeConfig";
import { publicOrigin } from "./lib/publicOrigin";
import { tableOfAuthoritiesUrl } from "./lib/tableOfAuthorities";

const frontend = path.resolve(__dirname, "../../frontend/dist");
const config = publicRuntimeConfig();
const cloudOrigin = config.mode === "cloud" ? publicOrigin() : null;
const connectSrc = ["'self'"];
if (config.mode === "cloud") {
  const supabase = new URL(config.supabaseUrl);
  connectSrc.push(supabase.origin);
  supabase.protocol = supabase.protocol === "https:" ? "wss:" : "ws:";
  connectSrc.push(supabase.origin);
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
      frameSrc: config.mode === "local"
        ? ["'self'", tableOfAuthoritiesUrl()]
        : ["'none'"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
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
  if (!oauthCallback && req.get("sec-fetch-site") === "cross-site") {
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
server.use(express.static(frontend, {
  dotfiles: "deny",
  index: false,
  setHeaders: (res, file) => res.setHeader(
    "Cache-Control",
    file.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  ),
}));
server.get("*", (req, res, next) => {
  if (
    ["/assets/", "/icons/", "/pdfjs-standard-fonts/"].some((prefix) =>
      req.path.startsWith(prefix)
    ) ||
    !req.accepts("html")
  ) return next();
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(frontend, "index.html"));
});

export function assertFrontendBuild() {
  if (!existsSync(path.join(frontend, "index.html"))) {
    throw new Error(`Frontend build is missing: ${frontend}`);
  }
}
