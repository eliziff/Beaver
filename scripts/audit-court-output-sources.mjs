import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { relative, resolve } from "node:path";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";

if (typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function") {
  tls.setDefaultCACertificates([...new Set([
    ...tls.getCACertificates("default"), ...tls.getCACertificates("system"),
  ])]);
}

const DEFAULT_MANIFEST = "docs/decisions/court-output-preset-receipts.json";
const DEFAULT_OUTPUT = "docs/decisions/court-output-source-audit.json";
const MAX_BYTES = 64 * 1024 * 1024;

function download(url, headers, redirects = 5) {
  return new Promise((resolveDownload, reject) => {
    const request = get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (!redirects) return reject(new Error("too many redirects"));
        let next;
        try { next = auditRedirectUrl(location, url); }
        catch (error) { return reject(error); }
        return resolveDownload(download(next, headers, redirects - 1));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new Error(`response is larger than ${MAX_BYTES} bytes`));
        else chunks.push(chunk);
      });
      response.once("end", () => resolveDownload({
        status,
        statusText: response.statusMessage ?? "",
        url: String(url),
        bytes: Buffer.concat(chunks),
        header: (name) => {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : value ?? null;
        },
      }));
    });
    const timeout = setTimeout(() => request.destroy(new Error("request timed out")), 30_000);
    request.once("close", () => clearTimeout(timeout));
    request.once("error", reject);
  });
}

function argumentsFrom(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    manifest: resolve(value("--manifest", DEFAULT_MANIFEST)),
    output: resolve(value("--output", DEFAULT_OUTPUT)),
    ids: new Set((value("--ids", "") ?? "").split(",").map((id) => id.trim()).filter(Boolean)),
    maxAgeDays: Number(value("--max-age-days", "30")),
    check: argv.includes("--check"),
    refreshAll: argv.includes("--refresh-all"),
  };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function isCanlii(url) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.+$/u, "");
  return ["canlii.ca", "canlii.org"].some((domain) =>
    hostname === domain || hostname.endsWith(`.${domain}`));
}

export function auditRedirectUrl(location, current) {
  const next = new URL(location, current);
  if (next.protocol !== "https:") throw new Error("redirect is not HTTPS");
  if (isCanlii(next)) throw new Error("redirect to CanLII is forbidden");
  return next;
}

const broadProfiles = new Set([
  "abkb", "abca", "fc", "fca", "alberta-affidavit", "federal-affidavit",
]);

export function validateManifest(manifest) {
  if (manifest?.schema_version !== 2 || !Array.isArray(manifest.sources))
    throw new Error("court-output source manifest must use schema_version 2");
  const ids = new Set();
  for (const source of manifest.sources) {
    if (!source || typeof source !== "object" || typeof source.id !== "string" ||
        !source.id || ids.has(source.id)) throw new Error("source IDs must be unique non-empty strings");
    ids.add(source.id);
    if (typeof source.kind !== "string" || !source.kind ||
        typeof source.locator !== "string" || !source.locator) {
      throw new Error(`${source.id} must retain its source kind and locator`);
    }
    if (typeof source.url !== "string" || !source.url) {
      throw new Error(`${source.id} must retain a stable HTTPS URL`);
    }
    for (const field of ["url", "stable_parent_url"]) {
      if (source[field] !== undefined && new URL(source[field]).protocol !== "https:")
        throw new Error(`${source.id} ${field} must use HTTPS`);
    }
    if (!Array.isArray(source.profiles) || !source.profiles.length ||
        source.profiles.some((profile) => typeof profile !== "string" || !profile ||
          broadProfiles.has(profile))) {
      throw new Error(`${source.id} must name exact supported profiles`);
    }
    if (!Array.isArray(source.expected_markers))
      throw new Error(`${source.id} expected_markers must be an array`);
    if ((source.automated_access === "manual_only" || isCanlii(source.url)) &&
        source.automated_access !== "manual_only") {
      throw new Error(`${source.id} must mark CanLII access manual_only`);
    }
  }
}

export function validateAuditCoverage(manifest, audit) {
  if (!Array.isArray(audit?.results)) throw new Error("source audit results must be an array");
  const expected = new Set(manifest.sources.map(({ id }) => id));
  const seen = new Set();
  for (const result of audit.results) {
    if (!result || typeof result.id !== "string" || !expected.has(result.id) ||
        seen.has(result.id)) throw new Error("source audit results do not match the manifest");
    seen.add(result.id);
  }
  if (seen.size !== expected.size) throw new Error("source audit results do not cover the manifest");
}

export function needsAudit(source, previous, options, now = Date.now()) {
  if (options.refreshAll || options.ids?.has(source.id) || !previous) return true;
  if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays < 0)
    throw new Error("--max-age-days must be a non-negative number");
  const checked = Date.parse(previous.checked_at ?? "");
  return !Number.isFinite(checked) || now - checked >= options.maxAgeDays * 86_400_000;
}

function markerResult(source, contentType, bytes) {
  if (!contentType.includes("html")) return { status: "hash_only", found: [], missing: [] };
  const text = new TextDecoder().decode(bytes)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-CA");
  const found = source.expected_markers.filter((marker) =>
    text.includes(marker.toLocaleLowerCase("en-CA")));
  const missing = source.expected_markers.filter((marker) => !found.includes(marker));
  return { status: missing.length ? "review" : "matched", found, missing };
}

export async function auditSource(source, previous, refreshAll, requestSource = download) {
  const checkedAt = new Date().toISOString();
  if (source.automated_access === "manual_only" || isCanlii(source.url)) {
    return {
      id: source.id,
      url: source.url,
      checked_at: checkedAt,
      status: "manual_only",
      detail: "No automated request was made.",
    };
  }
  const headers = {
    Accept: "text/html,application/pdf,application/octet-stream;q=0.8,*/*;q=0.5",
    "User-Agent": "BeaverCourtPresetAudit/1.0 (listed official sources only)",
  };
  if (!refreshAll && previous?.etag) headers["If-None-Match"] = previous.etag;
  if (!refreshAll && previous?.last_modified) headers["If-Modified-Since"] = previous.last_modified;
  const response = await requestSource(new URL(source.url), headers);
  if (response.status === 304 && previous) {
    const result = { ...previous, checked_at: checkedAt, status: "not_modified" };
    delete result.last_attempt_at;
    delete result.last_attempt_status;
    delete result.last_attempt_detail;
    return result;
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const contentLength = Number(response.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    throw new Error(`response is larger than ${MAX_BYTES} bytes`);
  }
  const bytes = response.bytes;
  if (bytes.byteLength > MAX_BYTES) throw new Error(`response is larger than ${MAX_BYTES} bytes`);
  const contentType = response.header("content-type")?.toLowerCase() ?? "";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    id: source.id,
    url: source.url,
    final_url: response.url,
    checked_at: checkedAt,
    status: "fetched",
    http_status: response.status,
    content_type: contentType,
    byte_count: bytes.byteLength,
    sha256,
    ...(source.reference_sha256 ? {
      reference_sha256: source.reference_sha256,
      reference_status: sha256 === source.reference_sha256 ? "matched" : "changed",
    } : {}),
    etag: response.header("etag"),
    last_modified: response.header("last-modified"),
    markers: markerResult(source, contentType, bytes),
  };
}

function save(path, manifestPath, manifest, results) {
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1,
    manifest: relative(process.cwd(), manifestPath).replaceAll("\\", "/"),
    manifest_verified_on: manifest.verified_on,
    updated_at: new Date().toISOString(),
    results,
  }, null, 2)}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFrom(argv);
  const manifest = readJson(options.manifest);
  validateManifest(manifest);
  if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays < 0) {
    throw new Error("--max-age-days must be a non-negative number");
  }
  const manifestIds = new Set(manifest.sources.map(({ id }) => id));
  if ([...options.ids].some((id) => !manifestIds.has(id))) {
    throw new Error("--ids contains a source not present in the manifest");
  }
  const previous = readJson(options.output, { results: [] });
  if (!Array.isArray(previous.results)) throw new Error("source audit results must be an array");
  if (options.check) {
    validateAuditCoverage(manifest, previous);
    process.stdout.write(`Validated ${manifest.sources.length} source receipts; no requests made.\n`);
    return;
  }
  const previousById = new Map(previous.results.map((result) => [result.id, result]));
  const selected = manifest.sources.filter((source) =>
    (!options.ids.size || options.ids.has(source.id)) &&
    needsAudit(source, previousById.get(source.id), options));
  const currentIds = new Set(manifest.sources.map((source) => source.id));
  const selectedIds = new Set(selected.map((source) => source.id));
  const results = previous.results.filter((result) =>
    currentIds.has(result.id) && !selectedIds.has(result.id));
  let failures = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const source = selected[index];
    process.stdout.write(`[${index + 1}/${selected.length}] ${source.id} ... `);
    try {
      const result = await auditSource(source, previousById.get(source.id), options.refreshAll);
      results.push(result);
      process.stdout.write(`${result.status}\n`);
    } catch (error) {
      failures += 1;
      const checkedAt = new Date().toISOString();
      const detail = error instanceof Error
        ? [error.message, error.cause?.message ?? error.cause?.code].filter(Boolean).join(": ")
        : String(error);
      const prior = previousById.get(source.id);
      const kept = prior && ["fetched", "not_modified"].includes(prior.status);
      results.push(kept ? {
        ...prior,
        last_attempt_at: checkedAt,
        last_attempt_status: "error",
        last_attempt_detail: detail,
      } : { id: source.id, url: source.url, checked_at: checkedAt, status: "error", detail });
      process.stdout.write(`${kept ? "unavailable (kept receipt)" : "error"}\n`);
    }
    results.sort((left, right) => left.id.localeCompare(right.id, "en-CA"));
    save(options.output, options.manifest, manifest, results);
  }
  process.stdout.write(`Wrote ${results.length} receipts to ${options.output}\n`);
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
