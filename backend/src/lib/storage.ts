import type { S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const MAX_OBJECT_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_STORAGE_TIMEOUT_MS = 15_000;
export const SIGNED_GET_TTL_SECONDS = 90;
type StorageBody = Uint8Array | Readonly<{ path: string; sizeBytes: number }>;

type StorageOptions = { signal?: AbortSignal; timeoutMs?: number };
type PutOptions = StorageOptions & { expectedSha256: string };

type SignedGetOptions = StorageOptions & {
  filename: string; contentType: string; expectedSha256: string; sizeBytes: number;
  disposition?: "inline" | "attachment"; expiresIn?: number;
};

export type ObjectStorage = {
  put(key: string, body: StorageBody, contentType: string,
    options: PutOptions): Promise<"created" | "exists">;
  get(key: string, options?: StorageOptions & { maxBytes?: number }): Promise<Buffer | null>;
  remove(key: string, options?: StorageOptions): Promise<void>;
  signedGet?(key: string, options: SignedGetOptions): Promise<string | null>;
};

export type S3Configuration = {
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
};

const REQUIRED_S3_ENV = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET",
  "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;

const configValue = (environment: NodeJS.ProcessEnv, name: string) =>
  environment[name]?.trim() ?? "";

export function readS3Configuration(
  environment: NodeJS.ProcessEnv = process.env): S3Configuration {
  const missing = REQUIRED_S3_ENV.filter((name) => !configValue(environment, name));
  if (missing.length) {
    throw new Error(`Missing S3 configuration: ${missing.join(", ")}`);
  }

  const endpoint = new URL(configValue(environment, "S3_ENDPOINT"));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" &&
      (environment.NODE_ENV === "production" || !loopback)) {
    throw new Error("S3_ENDPOINT must use HTTPS (HTTP is allowed only for local development)");
  }

  const region = configValue(environment, "S3_REGION");
  const bucket = configValue(environment, "S3_BUCKET");
  const accessKeyId = configValue(environment, "S3_ACCESS_KEY_ID");
  const secretAccessKey = configValue(environment, "S3_SECRET_ACCESS_KEY");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/iu.test(region)) {
    throw new Error("S3_REGION is malformed");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes("..")) {
    throw new Error("S3_BUCKET must be a DNS-compatible bucket name");
  }
  if (accessKeyId.length < 3 || accessKeyId.length > 256 ||
      secretAccessKey.length < 8 || secretAccessKey.length > 1_024 ||
      /\s/u.test(accessKeyId) || /\s/u.test(secretAccessKey) ||
      /^(?:your-|replace-|example)/iu.test(accessKeyId) ||
      /^(?:your-|replace-|example)/iu.test(secretAccessKey)) {
    throw new Error("S3 credentials are malformed or placeholders");
  }

  const rawPathStyle = configValue(environment, "S3_FORCE_PATH_STYLE");
  if (rawPathStyle && rawPathStyle !== "true" && rawPathStyle !== "false") {
    throw new Error("S3_FORCE_PATH_STYLE must be true or false");
  }
  return { endpoint: endpoint.toString().replace(/\/$/u, ""), region, bucket,
    accessKeyId, secretAccessKey, forcePathStyle: rawPathStyle === "true" };
}

function storageSignal(options: StorageOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Storage timeout must be between 1 and 120000 milliseconds");
  }
  return options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

const overLimit = (maximum: number) =>
  new Error(`Object exceeds the ${maximum}-byte read limit`);

function objectLimit(value = MAX_OBJECT_SIZE_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_OBJECT_SIZE_BYTES) {
    throw new Error(`Object read limit must be between 1 and ${MAX_OBJECT_SIZE_BYTES} bytes`);
  }
  return value;
}

export function validateObjectKey(key: string): string {
  if (!key || Buffer.byteLength(key, "utf8") > 1_024 || key.includes("\\") ||
      /[\x00-\x1F\x7F]/u.test(key)) {
    throw new Error("Invalid object key");
  }
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Object keys cannot contain empty or traversal segments");
  }
  return key;
}

function contentType(value: string) {
  if (!value || /[^\x20-\x7E]/u.test(value)) throw new Error("Invalid object content type");
  return value;
}

function checkedBytes(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_OBJECT_SIZE_BYTES) {
    throw new Error(`Object exceeds the ${MAX_OBJECT_SIZE_BYTES}-byte limit`);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function checkedBody(body: StorageBody) {
  if (!(body instanceof Uint8Array)) {
    if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 0 ||
        body.sizeBytes > MAX_OBJECT_SIZE_BYTES) {
      throw new Error(`Object exceeds the ${MAX_OBJECT_SIZE_BYTES}-byte limit`);
    }
    return body;
  }
  return checkedBytes(body);
}

const storageError = (error: unknown, status: number, codes: string[]) => {
  const value = error as { name?: string; Code?: string; code?: string;
    $metadata?: { httpStatusCode?: number } } | null;
  const code = [value?.name, value?.Code, value?.code].find(Boolean);
  return code ? codes.includes(code) : value?.$metadata?.httpStatusCode === status;
};
const isNotFound = (error: unknown) => storageError(error, 404, ["NoSuchKey", "NotFound"]);
const isPreconditionFailed = (error: unknown) =>
  storageError(error, 412, ["PreconditionFailed"]);
const isConditionalConflict = (error: unknown) =>
  storageError(error, 409, ["ConditionalRequestConflict"]);

async function boundedBody(body: unknown, maximum: number, signal: AbortSignal) {
  if (!body) throw new Error("S3 GetObject returned no response body");
  const chunks: Buffer[] = [];
  let size = 0;
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maximum) throw overLimit(maximum);
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      (body as { destroy?: (error?: Error) => void })
        .destroy?.(error instanceof Error ? error : undefined);
      throw error;
    }
  }
  const transform = (body as { transformToByteArray?: () => Promise<Uint8Array> })
    .transformToByteArray;
  if (!transform) throw new Error("S3 GetObject returned an unsupported response body");
  const bytes = Buffer.from(await transform.call(body));
  signal.throwIfAborted();
  if (bytes.byteLength > maximum) throw overLimit(maximum);
  return bytes;
}

export function createS3ObjectStorage(config: S3Configuration): ObjectStorage {
  async function initialize() {
    const [commands, { getSignedUrl: sign }] = await Promise.all([
      import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner"),
    ]);
    const client = new commands.S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      maxAttempts: 3,
      credentials: { accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey },
    });
    return { client, commands, sign };
  }
  let sdk: ReturnType<typeof initialize> | undefined;
  const load = () => sdk ??= initialize();
  const verify = async (client: S3Client, commands: typeof import("@aws-sdk/client-s3"), key: string,
    sizeBytes: number, digest: string, signal: AbortSignal) => {
    const head = await client.send(new commands.HeadObjectCommand(
      { Bucket: config.bucket, Key: key, ChecksumMode: "ENABLED" }), { abortSignal: signal });
    if (head.ContentLength !== sizeBytes || head.ChecksumSHA256 !==
        Buffer.from(digest, "hex").toString("base64"))
      throw new Error("Content-addressed object failed its integrity check");
  };

  return {
    async put(key, input, type, options) {
      validateObjectKey(key);
      const source = checkedBody(input);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      const sizeBytes = source instanceof Uint8Array ? source.byteLength : source.sizeBytes;
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = source instanceof Uint8Array
          ? source : createReadStream(source.path, { signal });
        try {
          await client.send(new commands.PutObjectCommand({
            Bucket: config.bucket, Key: key, Body: body,
            ContentLength: sizeBytes,
            ContentType: contentType(type), IfNoneMatch: "*", ChecksumSHA256:
              Buffer.from(options.expectedSha256, "hex").toString("base64"),
          }), { abortSignal: signal });
          return "created";
        } catch (error) {
          if (isPreconditionFailed(error)) {
            if (!(source instanceof Uint8Array))
              (body as ReturnType<typeof createReadStream>).destroy();
            await verify(client, commands, key, sizeBytes, options.expectedSha256, signal);
            return "exists";
          }
          if (attempt === 0 && isConditionalConflict(error)) {
            if (!(source instanceof Uint8Array))
              (body as ReturnType<typeof createReadStream>).destroy();
            continue;
          }
          throw error;
        }
      }
      throw new Error("Conditional object write failed");
    },
    async get(key, options) {
      validateObjectKey(key);
      const maximum = objectLimit(options?.maxBytes);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      try {
        const response = await client.send(
          new commands.GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal: signal });
        if (response.ContentLength !== undefined && response.ContentLength > maximum) {
          (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
          throw overLimit(maximum);
        }
        return await boundedBody(response.Body, maximum, signal);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async remove(key, options) {
      validateObjectKey(key);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      try {
        await client.send(new commands.DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
          { abortSignal: signal });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async signedGet(key, options) {
      validateObjectKey(key);
      const expiresIn = options.expiresIn ?? SIGNED_GET_TTL_SECONDS;
      if (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 120) {
        throw new Error("Signed GET lifetime must be between 60 and 120 seconds");
      }
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands, sign } = await load();
      try {
        await verify(client, commands, key, options.sizeBytes, options.expectedSha256, signal);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const url = await sign(client, new commands.GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentDisposition:
          buildContentDisposition(options.disposition ?? "attachment", options.filename),
        ResponseContentType: contentType(options.contentType),
        ResponseCacheControl: "private, no-store",
      }), { expiresIn });
      signal.throwIfAborted();
      return url;
    },
  };
}

export function createFilesystemObjectStorage(root: string): ObjectStorage {
  const absoluteRoot = path.resolve(root);
  const staging = path.join(absoluteRoot, ".staging");
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= rm(staging, { recursive: true, force: true })
    .then(() => mkdir(staging, { recursive: true, mode: 0o700 })).then(() => undefined);
  const resolve = (key: string) => {
    validateObjectKey(key);
    const result = path.resolve(absoluteRoot, ...key.split("/"));
    if (!result.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Invalid object path");
    return result;
  };
  const verifyExisting = async (target: string, size: number, digest: string,
    signal: AbortSignal) => {
    let existing;
    try {
      existing = await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const hash = createHash("sha256");
    if (!existing.isFile() || existing.size !== size)
      throw new Error("Content-addressed object failed its integrity check");
    for await (const chunk of createReadStream(target, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== digest)
      throw new Error("Content-addressed object failed its integrity check");
    return true;
  };
  return {
    async put(key, input, type, options) {
      contentType(type);
      const body = checkedBody(input);
      const signal = storageSignal(options);
      const target = resolve(key);
      const size = body instanceof Uint8Array ? body.byteLength : body.sizeBytes;
      signal.throwIfAborted();
      if (await verifyExisting(target, size, options.expectedSha256, signal)) return "exists";
      await prepare();
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = path.join(staging, randomUUID());
      try {
        const digest = createHash("sha256");
        if (body instanceof Uint8Array) {
          await writeFile(temporary, body, { flag: "wx", mode: 0o600, signal });
          digest.update(body);
        } else {
          const source = createReadStream(body.path, { signal });
          source.on("data", (chunk) => digest.update(chunk));
          await pipeline(source,
            createWriteStream(temporary, { flags: "wx", mode: 0o600, signal }));
          if ((await stat(temporary)).size !== body.sizeBytes)
            throw new Error("Staged object size changed while copying");
        }
        if (digest.digest("hex") !== options.expectedSha256)
          throw new Error("Object source changed while storing");
        signal.throwIfAborted();
        try {
          await link(temporary, target);
          return "created";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!await verifyExisting(target, size, options.expectedSha256, signal)) throw error;
          return "exists";
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    },
    async get(key, options) {
      const target = resolve(key);
      const maximum = objectLimit(options?.maxBytes);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      try {
        const info = await stat(target);
        if (!info.isFile()) throw new Error("Object path is not a file");
        if (info.size > maximum) throw overLimit(maximum);
        const bytes = await readFile(target, { signal });
        if (bytes.byteLength > maximum) throw overLimit(maximum);
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key, options) {
      const signal = storageSignal(options);
      signal.throwIfAborted();
      try {
        await unlink(resolve(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      signal.throwIfAborted();
    },
  };
}

export function scopeObjectStorage(base: ObjectStorage, prefix: string): ObjectStorage {
  validateObjectKey(prefix);
  const full = (key: string) => `${prefix}/${validateObjectKey(key)}`;
  return {
    put: (key, bytes, type, options) => base.put(full(key), bytes, type, options),
    get: (key, options) => base.get(full(key), options),
    remove: (key, options) => base.remove(full(key), options),
    signedGet: base.signedGet ? (key, options) => base.signedGet!(full(key), options) : undefined,
  };
}

export function normalizeDownloadFilename(name: string): string {
  return [...(name.trim() || "download").replace(/[\uD800-\uDFFF]/gu, "�")
    .replace(/[\x00-\x1F\x7F\\/]/gu, "_")].slice(0, 200).join("");
}

function buildContentDisposition(kind: "inline" | "attachment", filename: string): string {
  const normalized = normalizeDownloadFilename(filename);
  const ascii = normalized.replace(/["\\]/gu, "_").replace(/[^\x20-\x7E]/gu, "_");
  const encoded = encodeURIComponent(normalized).replace(/['()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const downloadHeaders = (contentType: string, filename: string,
  disposition: "inline" | "attachment" = "attachment") => ({
  "Cache-Control": "private, no-store",
  "Content-Disposition": buildContentDisposition(disposition, filename),
  "Content-Type": contentType,
  "X-Content-Type-Options": "nosniff",
} as const);

export function documentBlobKey(
  scope: Readonly<{ userId: string; projectId: string | null }>, sha256: string): string {
  const [kind, id] = scope.projectId === null
    ? ["users", scope.userId] : ["projects", scope.projectId];
  if (validateObjectKey(id).includes("/")) throw new Error("Scope ID must be one path segment");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid object SHA-256");
  return `${kind}/${id}/blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
}

export const documentBlobDigest = (key: string) => {
  const match = key.match(/\/sha256\/([a-f0-9]{2})\/([a-f0-9]{62})$/u);
  return match ? `${match[1]}${match[2]}` : null;
};
