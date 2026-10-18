#!/usr/bin/env node
// A2AJ Law Web served locally as the real site is, so links to it are checked in Chrome without the live site:
// the reader's own files (github.com/a2aj-ca/a2aj-law-web checkout) at https://law.a2aj.ca, GitHub Pages' clean
// paths included (/document is document.html), and A2AJ's API at https://api.a2aj.ca answering /fetch from A2AJ's own
// store (a local a2aj.sqlite, read-only), sliced by code point as the API's Python does. Chrome reaches it under the
// real names with
//   --host-resolver-rules="MAP law.a2aj.ca 127.0.0.1:<port>,MAP api.a2aj.ca 127.0.0.1:<port>"
// and certificate errors ignored (the certificate is self-signed, made once with openssl).
// Usage: node law-web-server.mjs --root <law-web checkout> --store <a2aj.sqlite> [--port 8443] [--delay-ms N]
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const root = value("--root");
const storePath = value("--store");
const port = Number(value("--port", "8443"));
// --delay-ms N: /fetch answers after N ms, as a distant API does.
const delay = Number(value("--delay-ms", "0"));
if (!root || !storePath) throw new Error("usage: law-web-server.mjs --root <checkout> --store <a2aj.sqlite> [--port N]");

const certDir = path.join(os.tmpdir(), "law-web-server-cert");
const key = path.join(certDir, "key.pem"), cert = path.join(certDir, "cert.pem");
if (!fs.existsSync(cert)) {
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout", key, "-out", cert,
    "-subj", "/CN=law.a2aj.ca", "-addext", "subjectAltName=DNS:law.a2aj.ca,DNS:api.a2aj.ca"], { stdio: "ignore" });
}

const store = new DatabaseSync(storePath, { readOnly: true });
// Each document's row by its type and citation (the store indexes neither), its text read only when asked for.
const rowIds = new Map(store.prepare("select id, doc_type as docType, citation_en as citation from document")
  .all().map(({ id, docType, citation }) => [`${docType}|${citation}`, id]));
const byId = store.prepare(`select citation_en as citation, name_en as name, dataset, document_date_en as date,
  url_en as url, unofficial_text_en as text from document where id = ?`);
const fetchRow = (citation, docType) => {
  const id = rowIds.get(`${docType}|${citation}`);
  return id === undefined ? undefined : byId.get(id);
};
// A document's text as code points, made on its first request.
const points = new Map();
const codePoints = (id, text) => {
  if (!points.has(id)) points.set(id, Array.from(text));
  return points.get(id);
};

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const send = (response, status, type, body, headers = {}) => {
  response.writeHead(status, { "content-type": type, ...headers });
  response.end(body);
};

https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const host = (request.headers.host ?? "").split(":")[0];
  if (host === "api.a2aj.ca") {
    const cors = { "access-control-allow-origin": "*" };
    if (url.pathname !== "/fetch") return send(response, 200, "application/json", JSON.stringify({ results: [] }), cors);
    const docType = url.searchParams.get("doc_type") === "laws" ? "laws" : "cases";
    const id = `${docType}|${url.searchParams.get("citation")}`;
    const row = fetchRow(url.searchParams.get("citation"), docType);
    const start = Number(url.searchParams.get("start_char") ?? 0);
    const end = url.searchParams.has("end_char") ? Number(url.searchParams.get("end_char")) : undefined;
    const results = row ? [{ citation_en: row.citation, name_en: row.name ?? null, dataset: row.dataset,
      document_date_en: row.date ?? null, url_en: row.url ?? null, upstream_license: "",
      unofficial_text_en: codePoints(id, row.text).slice(start, end).join("") }] : [];
    return void setTimeout(() => send(response, 200, "application/json", JSON.stringify({ results }), cors), delay);
  }
  if (host !== "law.a2aj.ca") return send(response, 404, "text/plain", "");
  // GitHub Pages: "/" is index.html and "/document" is document.html.
  let file = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  if (!path.extname(file)) file += ".html";
  const full = path.join(root, file);
  if (!full.startsWith(path.resolve(root)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(response, 404, "text/plain", "");
  }
  send(response, 200, types[path.extname(full)] ?? "application/octet-stream", fs.readFileSync(full));
}).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ listening: port, store: storePath })));
