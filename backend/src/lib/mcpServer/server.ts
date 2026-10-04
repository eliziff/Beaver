import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mikeLocalDataHome } from "../legalDataPath";
import { callTool, evidenceLink, tools, UI_RESOURCE, type BeaverApi } from "./tools";

export type McpServerOptions = { port: number; beaverOrigin: string; app: string };

const DOWNLOAD_MS = 15 * 60_000;
const UI_MIME = "text/html;profile=mcp-app";
// The page fetches nothing, so its policy allows no origins; it opens inline and goes full screen.
const resource = { uri: UI_RESOURCE, name: "Beaver", mimeType: UI_MIME, _meta: {
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
  "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } } };

/** The connector's secret, made once: it is the path of the MCP endpoint. */
function connectorSecret() {
  const file = path.join(path.dirname(mikeLocalDataHome()), "mcp-server.json");
  if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf8")) as { secret: string }).secret;
  const secret = randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ secret }), { mode: 0o600 });
  return secret;
}

/** The public origin a request arrived at, through Tailscale Funnel or directly. */
function publicOrigin(req: Request) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  const proto = String(req.headers["x-forwarded-proto"] ?? (host.endsWith(".ts.net") ? "https" : req.protocol));
  return `${proto}://${host}`;
}

/** The app page with its module and styles inlined: a host's sandbox may reach no server, so the
 *  page fetches nothing and reaches Beaver only through the host's tool calls. */
function inlinePage(directory: string) {
  const html = readFileSync(path.join(directory, "mcp-app.html"), "utf8");
  const asset = (file: string) => readFileSync(path.join(directory, file), "utf8");
  return html
    .replace(/<script type="module" crossorigin src="\/([^"]+)"><\/script>/gu, (_tag, file: string) =>
      `<script type="module">${asset(file).replace(/<\/script/giu, "<\\/script")}</script>`)
    .replace(/<link rel="stylesheet" crossorigin href="\/([^"]+)">/gu, (_tag, file: string) =>
      `<style>${asset(file).replace(/<\/style/giu, "<\\/style")}</style>`);
}

export function createMcpServerApp({ beaverOrigin, app: appDirectory }: McpServerOptions) {
  const secret = connectorSecret();
  const beaverFetch = (route: string, init?: RequestInit) => fetch(`${beaverOrigin}/api${route}`, init);
  const api: BeaverApi = async (route, init = {}) => {
    const response = await beaverFetch(route, { method: init.method ?? "GET",
      headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const body = await response.text();
    const value: unknown = body ? JSON.parse(body) : null;
    if (!response.ok) throw new Error((value as { detail?: string } | null)?.detail ?? `Beaver returned ${response.status}`);
    return value;
  };
  let page: { built: number; html: string } | undefined;
  const appPage = () => {
    const built = statSync(path.join(appDirectory, "mcp-app.html")).mtimeMs;
    if (page?.built !== built) page = { built, html: inlinePage(appDirectory) };
    return page.html;
  };

  // A file the app saves where its host has no download of its own: the browser opens a short-lived link.
  const downloads = new Map<string, { bytes: Buffer; type: string; name: string }>();
  const download = (origin: string) => (name: string, type: string, bytes: Buffer) => {
    const id = randomBytes(24).toString("base64url"), safe = name.replace(/[\\/"\r\n]/gu, "_");
    downloads.set(id, { bytes, type, name: safe });
    setTimeout(() => downloads.delete(id), DOWNLOAD_MS).unref();
    return `${origin}/downloads/${id}/${encodeURIComponent(safe)}`;
  };

  function mcp(origin: string, signal: AbortSignal) {
    const server = new Server({ name: "beaver", title: "Beaver", version: "1.0.0" }, {
      capabilities: { tools: {}, resources: {} },
      instructions: "Beaver answers legal questions from exact passages of Canadian and US cases, statutes and journals, and builds Books of Authorities. Search, read the exact passages, and finish a grounded answer with submit_grounded_answer.",
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>, { api, beaverFetch, download: download(origin), origin, signal }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [resource] }));
    server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ ...resource, text: appPage() }] }));
    return server;
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  // Browser-based MCP clients call the endpoint from other origins; it uses no cookies.
  app.use((req, res, next) => {
    res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
      "Access-Control-Expose-Headers": "mcp-session-id" });
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });
  // Each request in one line, without the secret: what a host called and how it was answered.
  app.use((req, res, next) => {
    const started = Date.now();
    res.once("finish", () => {
      const body = req.body as { method?: string; params?: { name?: string; arguments?: { path?: string } } } | undefined;
      console.log(new Date().toISOString(), req.method, req.path.replace(secret, "…"), body?.method ?? "",
        body?.params?.name ?? "", body?.params?.arguments?.path ?? "", res.statusCode, `${Date.now() - started}ms`);
    });
    next();
  });
  app.get("/health", (_req, res) => void res.json({ ok: true }));
  app.all("/mcp/:secret", express.json({ limit: "200mb" }), async (req: Request, res: Response) => {
    const given = Buffer.from(req.params.secret ?? ""), expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void res.sendStatus(404);
    if (req.method !== "POST") return void res.status(405).set("Allow", "POST").end();
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const server = mcp(publicOrigin(req), abort.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // A citation the model wrote as an evidence_id opens the passage where Beaver's link puts it.
  app.get("/cite/:evidenceIds", async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    const url = await evidenceLink(req.params.evidenceIds.split("+"), abort.signal).catch(() => null);
    if (!url) return void res.status(404).send("Beaver has no passage with this citation.");
    res.redirect(302, url);
  });
  app.get("/downloads/:id/:name", (req, res) => {
    const file = downloads.get(req.params.id);
    if (!file) return void res.status(404).send("This download has expired. Download it again from Beaver.");
    res.attachment(file.name).type(file.type).send(file.bytes);
  });
  return { app, secret };
}
