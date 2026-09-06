import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { precompressedAssets } from "./precompressedAssets";

let directory: string, server: Server, port: number;
const source = Buffer.from('globalThis.fixture = "same bytes";\n'.repeat(200));
const encoded = { br: brotliCompressSync(source), gzip: gzipSync(source) };
function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "beaver-static-"));
  await mkdir(path.join(directory, "assets"));
  for (const [name, bytes] of Object.entries({ "fixture.js": source, "fixture.js.br": encoded.br,
    "fixture.js.gz": encoded.gzip, "gzip-only.css": source, "gzip-only.css.gz": encoded.gzip,
    "identity.svg": source, "worker.mjs": source, "worker.mjs.br": encoded.br, "orphan.js.br": encoded.br }))
    await writeFile(path.join(directory, "assets", name), bytes);
  await writeFile(path.join(directory, "index.html"), "configuration-bearing html");
  const app = express();
  app.use((_req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); next(); });
  app.use(precompressedAssets(directory));
  app.get("/api/fixture", (_req, res) => res.json({ private: true }));
  app.use(express.static(directory));
  app.use((_req, res) => { res.status(404).send("missing"); });
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("public asset representations", () => {
  it.each([
    ["br, gzip", "br"], ["gzip, br;q=0.5", "gzip"], ["br;q=0, gzip", "gzip"],
    ["identity", undefined], ["gzip;q=0, br;q=0", undefined], ["identity;q=1, br;q=0.1", undefined],
  ])("negotiates %s without changing decoded bytes", async (accept, expected) => {
    const result = await get("/assets/fixture.js?version=fixture", { "Accept-Encoding": accept! });
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBe(expected);
    expect(result.headers.vary).toContain("Accept-Encoding");
    expect(result.headers["content-type"]).toMatch(/javascript/);
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    const decode = expected === "br" ? brotliDecompressSync : expected === "gzip" ? gunzipSync : (b: Buffer) => b;
    expect(decode(result.body)).toEqual(source);
    expect(Number(result.headers["content-length"])).toBe(result.body.length);
    if (expected) expect(result.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
  it("serves compressed module workers with a JavaScript MIME type", async () => {
    const result = await get("/assets/worker.mjs", { "Accept-Encoding": "br" });
    expect(result.status).toBe(200);
    expect(result.headers["content-encoding"]).toBe("br");
    expect(result.headers["content-type"]).toContain("text/javascript");
    expect(brotliDecompressSync(result.body)).toEqual(source);
  });
  it("uses identity when Accept-Encoding is absent", async () => {
    const result = await get("/assets/fixture.js");
    expect(result.headers["content-encoding"]).toBeUndefined(); expect(result.body).toEqual(source);
  });
  it("falls back to an available representation, never an orphan sidecar", async () => {
    const gzip = await get("/assets/gzip-only.css", { "Accept-Encoding": "br, gzip" });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers["content-type"]).toContain("text/css");
    const identity = await get("/assets/identity.svg", { "Accept-Encoding": "br, gzip" });
    expect(identity.body).toEqual(source); expect(identity.headers["content-encoding"]).toBeUndefined();
    expect((await get("/assets/orphan.js", { "Accept-Encoding": "br" })).status).toBe(404);
    expect((await get("/assets/missing.js", { "Accept-Encoding": "br" })).status).toBe(404);
  });
  it("does not send a representation excluded by the client", async () => {
    expect((await get("/assets/fixture.js", { "Accept-Encoding": "*;q=0, identity;q=0" })).status).toBe(406);
    expect((await get("/assets/identity.svg", { "Accept-Encoding": "br, identity;q=0" })).status).toBe(406);
  });
  it("preserves HEAD, conditional requests, representation validators, and unencoded ranges", async () => {
    const headers = { "Accept-Encoding": "br" };
    const first = await get("/assets/fixture.js", headers);
    const head = await get("/assets/fixture.js", headers, "HEAD");
    expect(head.status).toBe(200); expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(first.headers["content-length"]);
    const cached = await get("/assets/fixture.js", { ...headers, "If-None-Match": String(first.headers.etag) });
    expect(cached.status).toBe(304); expect(cached.body.length).toBe(0);
    expect(cached.headers.vary).toContain("Accept-Encoding");
    const different = await get("/assets/fixture.js", { "Accept-Encoding": "gzip", "If-None-Match": String(first.headers.etag) });
    expect(different.status).toBe(200); expect(different.headers.etag).not.toBe(first.headers.etag);
    const range = await get("/assets/fixture.js", { ...headers, Range: "bytes=0-9" });
    expect(range.status).toBe(206); expect(range.headers["content-encoding"]).toBeUndefined();
    expect(range.body).toEqual(source.subarray(0, 10));
  });
  it("does not touch HTML/configuration or API responses", async () => {
    for (const url of ["/index.html", "/api/fixture"]) {
      const result = await get(url, { "Accept-Encoding": "br, gzip" });
      expect(result.status).toBe(200); expect(result.headers["content-encoding"]).toBeUndefined();
      expect(result.headers.vary).toBeUndefined();
    }
  });
});
