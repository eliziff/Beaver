import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  copyFile, link, mkdir, open, readFile, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import { sha256 } from "./hash";
import { LEGAL_PDF_DOCUMENT_SCHEMA } from "./legalPdfProcess";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = Record<string, unknown>;

export const MAX_PROJECTION_PDF_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const PROJECTION_SCHEMA = "mike.document_projection.v1";
const REQUIRED_ARTIFACTS = [
  "pages", "paragraphs", "sections", "footnotes", "tables", "images",
  "diagnostics", "repairs",
] as const;

export type PdfProjectionIdentity = {
  documentId: string;
  versionId: string;
  sourceSha256: string;
  compiler: { name: "legalpdf"; version: string };
  options: JsonObject;
};

type ProjectionReceipt = {
  schema_version: typeof PROJECTION_SCHEMA;
  key: string;
  identity: PdfProjectionIdentity;
  manifest_sha256: string;
  artifacts: Record<string, { path: string; size: number; sha256: string }>;
};

const writes = new Map<string, Promise<void>>();
const dataRoot = () => path.resolve(mikeLocalDataHome());
const projectionRoot = () => path.join(dataRoot(), "projections", "v1");

function boundedText(value: string, label: string, maximum = 500) {
  if (!value || value !== value.trim() || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function canonical(value: unknown, depth = 0): Json {
  if (depth > 12) throw new Error("Projection options are too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error("Projection options are too large");
    return value.map((item) => canonical(item, depth + 1));
  }
  if (!value || typeof value !== "object") throw new Error("Projection options are not JSON");
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length > 500) throw new Error("Projection options are too large");
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [boundedText(key, "Projection option name", 200),
      canonical(item, depth + 1)]));
}

function canonicalJson(value: unknown) {
  const encoded = JSON.stringify(canonical(value));
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("Projection identity is too large");
  return encoded;
}

export function pdfProjectionIdentity(identity: PdfProjectionIdentity): PdfProjectionIdentity {
  const checked = {
    documentId: boundedText(identity.documentId, "Projection document id"),
    versionId: boundedText(identity.versionId, "Projection version id"),
    sourceSha256: identity.sourceSha256,
    compiler: {
      name: identity.compiler.name,
      version: boundedText(identity.compiler.version, "Projection compiler version", 200),
    },
    options: canonical(identity.options) as JsonObject,
  } satisfies PdfProjectionIdentity;
  if (!/^[a-f0-9]{64}$/u.test(checked.sourceSha256) || checked.compiler.name !== "legalpdf") {
    throw new Error("Projection identity is invalid");
  }
  return checked;
}

export function pdfProjectionKey(identity: PdfProjectionIdentity) {
  return sha256(canonicalJson([PROJECTION_SCHEMA, pdfProjectionIdentity(identity)]));
}

export function localDataPath(candidate: string) {
  const root = dataRoot(), resolved = path.resolve(candidate), relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) throw new Error("Document projection path is outside local data");
  return resolved;
}

export function relativeLocalDataPath(candidate: string) {
  return path.relative(dataRoot(), localDataPath(candidate));
}

export function resolveLocalDataPath(relative: string) {
  if (!relative || path.isAbsolute(relative)) throw new Error("Document projection path is invalid");
  return localDataPath(path.join(dataRoot(), relative));
}

export function projectionDirectory(format: string, key: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(format) || !/^[a-f0-9]{64}$/u.test(key))
    throw new Error("Document projection key is invalid");
  return path.join(projectionRoot(), format, key.slice(0, 2), key);
}

export function pdfProjectionDirectory(identity: PdfProjectionIdentity) {
  return projectionDirectory("pdf", pdfProjectionKey(identity));
}

export function pdfContentPath(sourceSha256: string) {
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256)) throw new Error("PDF content SHA is invalid");
  return path.join(projectionRoot(), "content", "pdf", sourceSha256.slice(0, 2),
    `${sourceSha256}.pdf`);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function inspectPdf(filename: string, options?: {
  expectedSha256?: string; signal?: AbortSignal; maximumBytes?: number;
}) {
  const source = localDataPath(filename), maximum = options?.maximumBytes ?? MAX_PROJECTION_PDF_BYTES;
  throwIfAborted(options?.signal);
  const details = await stat(source);
  if (!details.isFile() || details.size <= 0 || details.size > maximum) {
    throw new Error("PDF input is empty or exceeds the size limit");
  }
  const handle = await open(source, "r");
  try {
    const header = Buffer.alloc(Math.min(1_024, details.size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (header.subarray(0, bytesRead).indexOf("%PDF-") < 0)
      throw new Error("Document projection input is not a PDF");
  } finally {
    await handle.close();
  }
  const digest = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(source, { signal: options?.signal })) {
    size += (chunk as Buffer).byteLength;
    if (size > maximum) throw new Error("PDF input exceeds the size limit");
    digest.update(chunk as Buffer);
  }
  const sourceSha256 = digest.digest("hex");
  if (options?.expectedSha256 && sourceSha256 !== options.expectedSha256)
    throw new Error("PDF source bytes no longer match their version");
  return { path: source, sourceSha256, size };
}

async function atomicWriteNow(filename: string, value: string | Buffer, signal?: AbortSignal) {
  const destination = localDataPath(filename);
  throwIfAborted(signal);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { signal });
    let delay = 10, deadline = Date.now() + 5_000;
    for (;;) {
      try { await rename(temporary, destination); break; } catch (error) {
        const code = String((error as NodeJS.ErrnoException).code);
        if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(code) ||
            Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 100); throwIfAborted(signal);
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function atomicWriteProjection(filename: string, value: string | Buffer,
  signal?: AbortSignal) {
  const key = localDataPath(filename), previous = writes.get(key);
  let release = () => {};
  const turn = new Promise<void>((resolve) => { release = resolve; });
  writes.set(key, turn); if (previous) await previous;
  try { await atomicWriteNow(key, value, signal); } finally {
    release(); if (writes.get(key) === turn) writes.delete(key);
  }
}

async function sameFile(filename: string, expectedSha256: string) {
  try { await inspectPdf(filename, { expectedSha256 }); return true; } catch { return false; }
}

async function lockOwner(lock: string) {
  try { return JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as
    { token?: string; touched_at?: number }; } catch { return null; }
}

export async function withProjectionLock<T>(key: string, operation: () => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  const lock = path.join(projectionRoot(), "locks", sha256(key)), token = crypto.randomUUID();
  const deadline = Date.now() + 35_000;
  await mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    throwIfAborted(signal);
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ token, touched_at: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await lockOwner(lock);
      const touchedAt = owner?.touched_at ?? await stat(lock)
        .then(({ mtimeMs }) => mtimeMs, () => Date.now());
      if (Date.now() - touchedAt > 120_000) {
        const stale = `${lock}.${crypto.randomUUID()}.stale`;
        try { await rename(lock, stale); await rm(stale, { recursive: true, force: true }); continue; }
        catch { /* Another process won the stale-lock race. */ }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for document projection lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => { void (async () => {
    const owner = await lockOwner(lock);
    if (owner?.token === token) await writeFile(path.join(lock, "owner.json"),
      JSON.stringify({ token, touched_at: Date.now() })).catch(() => undefined);
  })(); }, 30_000);
  heartbeat.unref();
  try { return await operation(); } finally {
    clearInterval(heartbeat);
    if ((await lockOwner(lock))?.token === token) await rm(lock, { recursive: true, force: true });
  }
}

export async function publishPdfContent(source: string, expectedSha256: string,
  signal?: AbortSignal) {
  await inspectPdf(source, { expectedSha256, signal });
  const destination = pdfContentPath(expectedSha256);
  return withProjectionLock(`pdf-content:${expectedSha256}`, async () => {
    if (await sameFile(destination, expectedSha256)) return destination;
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary); throwIfAborted(signal);
      await inspectPdf(temporary, { expectedSha256, signal });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    await inspectPdf(destination, { expectedSha256, signal });
    return destination;
  }, signal);
}

export async function publishPdfBytes(bytes: Buffer, expectedSha256: string,
  signal?: AbortSignal) {
  if (bytes.length <= 0 || bytes.length > MAX_PROJECTION_PDF_BYTES ||
      sha256(bytes) !== expectedSha256 || !bytes.subarray(0, 1_024).includes("%PDF-"))
    throw new Error("PDF source bytes are invalid");
  const destination = pdfContentPath(expectedSha256);
  return withProjectionLock(`pdf-content:${expectedSha256}`, async () => {
    if (!(await sameFile(destination, expectedSha256)))
      await atomicWriteProjection(destination, bytes, signal);
    await inspectPdf(destination, { expectedSha256, signal });
    return destination;
  }, signal);
}

export async function publishPdfStream(stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal) {
  const staging = path.join(projectionRoot(), "staging");
  await mkdir(staging, { recursive: true });
  const temporary = path.join(staging, `${crypto.randomUUID()}.pdf.tmp`);
  const output = await open(temporary, "wx"), reader = stream.getReader();
  const digest = crypto.createHash("sha256"), header = Buffer.alloc(1_024);
  let size = 0, headerSize = 0, complete = false;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > MAX_PROJECTION_PDF_BYTES) throw new Error("PDF input exceeds the size limit");
      if (headerSize < header.length) {
        const copied = Math.min(header.length - headerSize, value.byteLength);
        header.set(value.subarray(0, copied), headerSize); headerSize += copied;
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = await output.write(value, offset, value.byteLength - offset);
        if (!written.bytesWritten) throw new Error("PDF stream write made no progress");
        offset += written.bytesWritten;
      }
    }
    await output.close();
    if (!size || header.subarray(0, headerSize).indexOf("%PDF-") < 0)
      throw new Error("Document projection input is not a PDF");
    const sourceSha256 = digest.digest("hex");
    return { path: await publishPdfContent(temporary, sourceSha256, signal), sourceSha256 };
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function hashArtifact(filename: string) {
  const details = await stat(filename);
  if (!details.isFile() || details.size > MAX_ARTIFACT_BYTES)
    throw new Error("PDF projection artifact is invalid or too large");
  const digest = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk as Buffer);
  return { size: details.size, sha256: digest.digest("hex") };
}

async function validateRows(filename: string) {
  const raw = await readFile(filename, "utf8");
  let count = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("PDF projection JSONL artifact is invalid");
    }
    count += 1;
  }
  return count;
}

function artifactPath(directory: string, relative: unknown) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw new Error("PDF projection artifact path is invalid");
  const resolved = path.resolve(directory, relative), nested = path.relative(directory, resolved);
  if (!nested || nested === ".." || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested))
    throw new Error("PDF projection artifact path escapes its projection");
  return resolved;
}

export async function publishPdfProjection(identity_: PdfProjectionIdentity) {
  const identity = pdfProjectionIdentity(identity_), directory = pdfProjectionDirectory(identity);
  const manifestPath = path.join(directory, "document.json");
  const manifestRaw = await readFile(manifestPath, "utf8"), manifest = JSON.parse(manifestRaw) as JsonObject;
  if (manifest.schema_version !== LEGAL_PDF_DOCUMENT_SCHEMA ||
      manifest.artifact_profile !== "compact-source" ||
      manifest.source_sha256 !== identity.sourceSha256 ||
      manifest.parser_version !== identity.compiler.version)
    throw new Error("PDF projection manifest does not match its identity");
  const names = manifest.artifacts as JsonObject | null;
  if (!names || typeof names !== "object") throw new Error("PDF projection artifact map is missing");
  const artifacts: ProjectionReceipt["artifacts"] = {};
  const rowCounts: Record<string, number> = {};
  let totalSize = 0;
  for (const name of REQUIRED_ARTIFACTS) {
    const filename = artifactPath(directory, names[name]);
    artifacts[name] = { path: path.relative(directory, filename), ...await hashArtifact(filename) };
    rowCounts[name] = await validateRows(filename);
    totalSize += artifacts[name].size;
    if (totalSize > MAX_ARTIFACT_BYTES)
      throw new Error("PDF projection artifacts exceed the size limit");
  }
  const expectedCounts = manifest.counts as JsonObject | null;
  if (!expectedCounts || Object.entries(rowCounts).some(
    ([name, count]) => expectedCounts[name] !== count,
  ) || manifest.page_count !== rowCounts.pages) {
    throw new Error("PDF projection artifact counts do not match its manifest");
  }
  const receipt = { schema_version: PROJECTION_SCHEMA, key: pdfProjectionKey(identity), identity,
    manifest_sha256: sha256(manifestRaw), artifacts } satisfies ProjectionReceipt;
  await atomicWriteProjection(path.join(directory, "projection.json"),
    `${JSON.stringify(receipt, null, 2)}\n`);
  return openPdfProjection(identity);
}

function parsedReceipt(value: unknown, identity: PdfProjectionIdentity): ProjectionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PDF projection receipt is invalid");
  const receipt = value as Partial<ProjectionReceipt>, key = pdfProjectionKey(identity);
  if (receipt.schema_version !== PROJECTION_SCHEMA || receipt.key !== key ||
      canonicalJson(receipt.identity) !== canonicalJson(identity) ||
      !receipt.artifacts || typeof receipt.manifest_sha256 !== "string")
    throw new Error("PDF projection receipt does not match its identity");
  return receipt as ProjectionReceipt;
}

export async function openPdfProjection(identity_: PdfProjectionIdentity) {
  const identity = pdfProjectionIdentity(identity_), directory = pdfProjectionDirectory(identity);
  const receipt = parsedReceipt(JSON.parse(await readFile(path.join(directory, "projection.json"), "utf8")),
    identity);
  const manifestRaw = await readFile(path.join(directory, "document.json"), "utf8");
  if (sha256(manifestRaw) !== receipt.manifest_sha256)
    throw new Error("PDF projection manifest failed integrity validation");
  for (const [name, expected] of Object.entries(receipt.artifacts)) {
    const filename = artifactPath(directory, expected.path), actual = await hashArtifact(filename);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error(`PDF projection ${name} artifact failed integrity validation`);
  }
  const manifest = JSON.parse(manifestRaw) as JsonObject;
  return { key: receipt.key, identity, directory, manifest };
}

export async function removePdfProjection(identity: PdfProjectionIdentity) {
  await rm(pdfProjectionDirectory(identity), { recursive: true, force: true });
}

export function immutableReceiptPath(namespace: string, digest: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(namespace) || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("Projection receipt identity is invalid");
  return path.join(projectionRoot(), "receipts", namespace, digest.slice(0, 2), `${digest}.json`);
}

export async function writeImmutableReceipt(filename: string, value: unknown) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`, digest = sha256(encoded);
  await withProjectionLock(`receipt:${filename}`, async () => {
    try {
      const existing = await readFile(localDataPath(filename), "utf8");
      if (sha256(existing) !== digest) throw new Error("Conflicting immutable projection receipt");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encoded, { flag: "wx" });
      try { await link(temporary, filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await rm(temporary, { force: true }); }
    if (sha256(await readFile(filename, "utf8")) !== digest)
      throw new Error("Conflicting immutable projection receipt");
  });
}
