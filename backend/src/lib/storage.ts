import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const MAX_OBJECT_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_STORAGE_TIMEOUT_MS = 15_000;
export const SIGNED_GET_TTL_SECONDS = 90;
type StorageBody = Uint8Array | { path: string; sizeBytes: number };

type StorageOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type StorageListPage = {
  keys: string[];
  cursor: string | null;
};

type SignedGetOptions = StorageOptions & {
  filename: string;
  disposition?: "inline" | "attachment";
  expiresIn?: number;
};

export type ObjectStorage = {
  put(key: string, body: StorageBody, contentType: string,
    options?: StorageOptions): Promise<void>;
  get(key: string, options?: StorageOptions & { maxBytes?: number }): Promise<Buffer | null>;
  remove(key: string, options?: StorageOptions): Promise<void>;
  list(prefix?: string, options?: StorageOptions & {
    cursor?: string | null;
    limit?: number;
  }): Promise<StorageListPage>;
  signedGet?(key: string, options: SignedGetOptions): Promise<string>;
};

export type S3Configuration = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

const REQUIRED_S3_ENV = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

const configValue = (environment: NodeJS.ProcessEnv, name: string) =>
  environment[name]?.trim() ?? "";

export function readS3Configuration(
  environment: NodeJS.ProcessEnv = process.env,
): S3Configuration {
  const missing = REQUIRED_S3_ENV.filter((name) => !configValue(environment, name));
  if (missing.length) {
    throw new Error(`Missing S3 configuration: ${missing.join(", ")}`);
  }

  const endpoint = new URL(configValue(environment, "S3_ENDPOINT"));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment");
  }
  const loopback = endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]" ||
    endpoint.hostname === "::1";
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
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      bucket.includes("..")) {
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
  return {
    endpoint: endpoint.toString().replace(/\/$/u, ""),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: rawPathStyle === "true",
  };
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

function objectLimit(value = MAX_OBJECT_SIZE_BYTES) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_OBJECT_SIZE_BYTES) {
    throw new Error(`Object read limit must be between 1 and ${MAX_OBJECT_SIZE_BYTES} bytes`);
  }
  return value;
}

function listLimit(value = 1_000) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("List limit must be positive");
  return Math.min(value, 1_000);
}

export function validateObjectKey(key: string, allowEmpty = false): string {
  if (allowEmpty && key === "") return key;
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

function isNotFound(error: unknown) {
  const value = error as {
    name?: string; Code?: string; code?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return value?.$metadata?.httpStatusCode === 404 &&
    [value.name, value.Code, value.code].some((code) =>
      code === "NoSuchKey" || code === "NotFound");
}

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
        if (size > maximum) throw new Error(`Object exceeds the ${maximum}-byte read limit`);
        chunks.push(bytes);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      (body as { destroy?: (error?: Error) => void }).destroy?.(
        error instanceof Error ? error : undefined,
      );
      throw error;
    }
  }
  const transform = (body as { transformToByteArray?: () => Promise<Uint8Array> })
    .transformToByteArray;
  if (!transform) throw new Error("S3 GetObject returned an unsupported response body");
  const bytes = Buffer.from(await transform.call(body));
  signal.throwIfAborted();
  if (bytes.byteLength > maximum) throw new Error(`Object exceeds the ${maximum}-byte read limit`);
  return bytes;
}

type S3Command<Output = unknown> = object & { readonly __output?: Output };
type S3CommandConstructor<Input, Output = unknown> = new (input: Input) => S3Command<Output>;
type S3ObjectInput = { Bucket: string; Key: string };
type S3GetOutput = { ContentLength?: number; Body?: unknown };
type S3ListOutput = {
  IsTruncated?: boolean;
  NextContinuationToken?: string;
  Contents?: { Key?: string }[];
};
type S3Client = {
  send<Output>(command: S3Command<Output>, options: { abortSignal: AbortSignal }): Promise<Output>;
};
type S3Runtime = {
  S3Client: new (input: {
    region: string;
    endpoint: string;
    forcePathStyle: boolean;
    maxAttempts: number;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => S3Client;
  PutObjectCommand: S3CommandConstructor<S3ObjectInput & {
    Body: Buffer | ReturnType<typeof createReadStream>; ContentLength: number; ContentType: string;
  }>;
  GetObjectCommand: S3CommandConstructor<
    S3ObjectInput & { ResponseContentDisposition?: string }, S3GetOutput
  >;
  DeleteObjectCommand: S3CommandConstructor<S3ObjectInput>;
  ListObjectsV2Command: S3CommandConstructor<{
    Bucket: string; Prefix?: string; ContinuationToken?: string; MaxKeys: number;
  }, S3ListOutput>;
};
type S3Signer = (
  client: S3Client,
  command: S3Command,
  options: { expiresIn: number },
) => Promise<string>;

const runtimeImport = (specifier: string) =>
  import(specifier) as Promise<Record<string, unknown>>;

function checkedS3Runtime(value: Record<string, unknown>): S3Runtime {
  const exports = [
    "S3Client", "PutObjectCommand", "GetObjectCommand",
    "DeleteObjectCommand", "ListObjectsV2Command",
  ];
  if (exports.some((name) => typeof value[name] !== "function")) {
    throw new Error("Installed S3 runtime is missing required exports");
  }
  return value as S3Runtime;
}

export function createS3ObjectStorage(config: S3Configuration): ObjectStorage {
  let sdk: Promise<{
    client: S3Client;
    commands: S3Runtime;
    sign: S3Signer;
  }> | undefined;
  const load = () => sdk ??= Promise.all([
    runtimeImport("@aws-sdk/client-s3"),
    runtimeImport("@aws-sdk/s3-request-presigner"),
  ]).then(([commands, presigner]) => ({
    commands: checkedS3Runtime(commands),
    sign: (() => {
      if (typeof presigner.getSignedUrl !== "function") {
        throw new Error("Installed S3 signer is missing getSignedUrl");
      }
      return presigner.getSignedUrl as S3Signer;
    })(),
  })).then(({ commands, sign }) => ({
    client: new commands.S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      maxAttempts: 3,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }),
    commands,
    sign,
  }));

  return {
    async put(key, input, type, options) {
      validateObjectKey(key);
      const source = checkedBody(input);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      const body = source instanceof Uint8Array
        ? source : createReadStream(source.path, { signal });
      await client.send(new commands.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentLength: source instanceof Uint8Array ? source.byteLength : source.sizeBytes,
        ContentType: contentType(type),
      }), { abortSignal: signal });
    },
    async get(key, options) {
      validateObjectKey(key);
      const maximum = objectLimit(options?.maxBytes);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      try {
        const response = await client.send(new commands.GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }), { abortSignal: signal });
        if (response.ContentLength !== undefined && response.ContentLength > maximum) {
          (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
          throw new Error(`Object exceeds the ${maximum}-byte read limit`);
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
        await client.send(new commands.DeleteObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }), { abortSignal: signal });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async list(prefix = "", options) {
      validateObjectKey(prefix, true);
      const signal = storageSignal(options);
      signal.throwIfAborted();
      const { client, commands } = await load();
      const response = await client.send(new commands.ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix ? `${prefix}/` : undefined,
        ContinuationToken: options?.cursor || undefined,
        MaxKeys: listLimit(options?.limit),
      }), { abortSignal: signal });
      if (response.IsTruncated && !response.NextContinuationToken) {
        throw new Error("S3 ListObjectsV2 returned a truncated page without a cursor");
      }
      return {
        keys: (response.Contents ?? []).flatMap(({ Key }) => Key ? [Key] : []),
        cursor: response.NextContinuationToken ?? null,
      };
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
      const url = await sign(client, new commands.GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentDisposition: buildContentDisposition(
          options.disposition ?? "attachment",
          options.filename,
        ),
      }), { expiresIn });
      signal.throwIfAborted();
      return url;
    },
  };
}

export function createFilesystemObjectStorage(root: string): ObjectStorage {
  const absoluteRoot = path.resolve(root);
  const resolve = (key: string) => {
    validateObjectKey(key);
    const result = path.resolve(absoluteRoot, ...key.split("/"));
    if (!result.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("Invalid object path");
    return result;
  };
  return {
    async put(key, input, type, options) {
      contentType(type);
      const body = checkedBody(input);
      const signal = storageSignal(options);
      const target = resolve(key);
      signal.throwIfAborted();
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        if (body instanceof Uint8Array) {
          await writeFile(temporary, body, { flag: "wx", mode: 0o600, signal });
        } else {
          await pipeline(createReadStream(body.path, { signal }),
            createWriteStream(temporary, { flags: "wx", mode: 0o600, signal }));
          if ((await stat(temporary)).size !== body.sizeBytes)
            throw new Error("Staged object size changed while copying");
        }
        signal.throwIfAborted();
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch((cleanup) => {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup;
        });
        throw error;
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
        if (info.size > maximum) throw new Error(`Object exceeds the ${maximum}-byte read limit`);
        const bytes = await readFile(target, { signal });
        if (bytes.byteLength > maximum) throw new Error(`Object exceeds the ${maximum}-byte read limit`);
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
    async list(prefix = "", options) {
      validateObjectKey(prefix, true);
      const signal = storageSignal(options);
      const limit = listLimit(options?.limit);
      signal.throwIfAborted();
      let entries: Dirent<string>[];
      try {
        entries = await readdir(absoluteRoot, { recursive: true, withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { keys: [], cursor: null };
        throw error;
      }
      signal.throwIfAborted();
      const start = options?.cursor ?? "";
      const keys = entries.flatMap((entry) => entry.isFile()
        ? [path.relative(absoluteRoot, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")]
        : [])
        .filter((key) => (!prefix || key.startsWith(`${prefix}/`)) && key > start)
        .sort();
      const page = keys.slice(0, limit);
      return { keys: page, cursor: keys.length > limit ? page.at(-1)! : null };
    },
  };
}

export function scopeObjectStorage(
  base: ObjectStorage,
  prefix: string,
): ObjectStorage {
  validateObjectKey(prefix);
  const full = (key: string) => `${prefix}/${validateObjectKey(key)}`;
  return {
    put: (key, bytes, type, options) => base.put(full(key), bytes, type, options),
    get: (key, options) => base.get(full(key), options),
    remove: (key, options) => base.remove(full(key), options),
    async list(child = "", options) {
      validateObjectKey(child, true);
      const scopedPrefix = child ? `${prefix}/${child}` : prefix;
      const page = await base.list(scopedPrefix, options);
      const marker = `${prefix}/`;
      if (page.keys.some((key) => !key.startsWith(marker))) {
        throw new Error("Object provider returned a key outside the assigned prefix");
      }
      return { ...page, keys: page.keys.map((key) => key.slice(marker.length)) };
    },
    signedGet: base.signedGet
      ? (key, options) => base.signedGet!(full(key), options)
      : undefined,
  };
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return [...base.replace(/[\uD800-\uDFFF]/gu, "�")
    .replace(/[\x00-\x1F\x7F\\/]/gu, "_")]
    .slice(0, 200).join("");
}

function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  const ascii = normalized.replace(/["\\]/gu, "_").replace(/[^\x20-\x7E]/gu, "_");
  const encoded = encodeURIComponent(normalized).replace(/['()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const downloadHeaders = (
  contentType: string, filename: string,
  disposition: "inline" | "attachment" = "attachment",
) => ({
  "Cache-Control": "private, no-store",
  "Content-Disposition": buildContentDisposition(disposition, filename),
  "Content-Type": contentType,
  "X-Content-Type-Options": "nosniff",
} as const);

export function versionStorageKey(
  userId: string,
  documentId: string,
  versionId: string,
  sha256: string,
  filename: string,
): string {
  for (const segment of [userId, documentId, versionId]) {
    if (segment.includes("/")) throw new Error("Storage key segment cannot contain a slash");
    validateObjectKey(segment);
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid object SHA-256");
  return `${userId}/${documentId}/${versionId}-${sha256.slice(0, 16)}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const extension = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : fallback;
}
