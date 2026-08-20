import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { mikeLocalDataHome } from "./legalDataPath";
import { sha256 } from "./hash";

const MAX_PROJECTION_PDF_BYTES = 100 * 1024 * 1024;

const writes = new Map<string, Promise<void>>();
const dataRoot = () => path.resolve(mikeLocalDataHome());
const projectionRoot = () => path.join(dataRoot(), "projections", "v1");

export function localDataPath(candidate: string) {
  const root = dataRoot();
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw new Error("Document projection path is outside local data");
  }
  return resolved;
}

export function projectionDirectory(format: string, key: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(format) || !/^[a-f0-9]{64}$/u.test(key))
    throw new Error("Document projection key is invalid");
  return path.join(projectionRoot(), format, key.slice(0, 2), key);
}

export function pdfContentPath(sourceSha256: string) {
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256))
    throw new Error("PDF content SHA is invalid");
  return path.join(
    projectionRoot(),
    "content",
    "pdf",
    sourceSha256.slice(0, 2),
    `${sourceSha256}.pdf`,
  );
}

export async function inspectPdf(filename: string, options?: {
  expectedSha256?: string;
  signal?: AbortSignal;
  maximumBytes?: number;
}) {
  const source = localDataPath(filename);
  const maximum = options?.maximumBytes ?? MAX_PROJECTION_PDF_BYTES;
  options?.signal?.throwIfAborted();
  const details = await stat(source);
  if (!details.isFile() || details.size <= 0 || details.size > maximum)
    throw new Error("PDF input is empty or exceeds the size limit");
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
  signal?.throwIfAborted();
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { signal });
    let delay = 10;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await rename(temporary, destination);
        break;
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException).code);
        if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(code) ||
            Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 100);
        signal?.throwIfAborted();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function atomicWriteProjection(
  filename: string,
  value: string | Buffer,
  signal?: AbortSignal,
) {
  const key = localDataPath(filename);
  const previous = writes.get(key);
  let release = () => {};
  const turn = new Promise<void>((resolve) => { release = resolve; });
  writes.set(key, turn);
  if (previous) await previous;
  try {
    await atomicWriteNow(key, value, signal);
  } finally {
    release();
    if (writes.get(key) === turn) writes.delete(key);
  }
}

async function sameFile(filename: string, expectedSha256: string) {
  try {
    await inspectPdf(filename, { expectedSha256 });
    return true;
  } catch {
    return false;
  }
}

async function lockOwner(lock: string) {
  try {
    return JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")) as {
      token?: string;
      touched_at?: number;
    };
  } catch {
    return null;
  }
}

export async function withProjectionLock<T>(
  key: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lock = path.join(projectionRoot(), "locks", sha256(key));
  const token = crypto.randomUUID();
  const deadline = Date.now() + 35_000;
  await mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ token, touched_at: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await lockOwner(lock);
      const touchedAt = owner?.touched_at ??
        await stat(lock).then(({ mtimeMs }) => mtimeMs, () => Date.now());
      if (Date.now() - touchedAt > 120_000) {
        const stale = `${lock}.${crypto.randomUUID()}.stale`;
        try {
          await rename(lock, stale);
          await rm(stale, { recursive: true, force: true });
          continue;
        } catch {
          // Another process won the stale-lock race.
        }
      }
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for document projection lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => { void (async () => {
    const owner = await lockOwner(lock);
    if (owner?.token === token) {
      await writeFile(path.join(lock, "owner.json"),
        JSON.stringify({ token, touched_at: Date.now() })).catch(() => undefined);
    }
  })(); }, 30_000);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    if ((await lockOwner(lock))?.token === token)
      await rm(lock, { recursive: true, force: true });
  }
}

async function publishPdfContent(
  source: string,
  expectedSha256: string,
  signal?: AbortSignal,
) {
  await inspectPdf(source, { expectedSha256, signal });
  const destination = pdfContentPath(expectedSha256);
  return withProjectionLock(`pdf-content:${expectedSha256}`, async () => {
    if (await sameFile(destination, expectedSha256)) return destination;
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary);
      signal?.throwIfAborted();
      await inspectPdf(temporary, { expectedSha256, signal });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    await inspectPdf(destination, { expectedSha256, signal });
    return destination;
  }, signal);
}

export async function publishPdfBytes(
  bytes: Buffer,
  expectedSha256: string,
  signal?: AbortSignal,
) {
  if (bytes.length <= 0 || bytes.length > MAX_PROJECTION_PDF_BYTES ||
      sha256(bytes) !== expectedSha256 || !bytes.subarray(0, 1_024).includes("%PDF-")) {
    throw new Error("PDF source bytes are invalid");
  }
  const destination = pdfContentPath(expectedSha256);
  return withProjectionLock(`pdf-content:${expectedSha256}`, async () => {
    if (!(await sameFile(destination, expectedSha256)))
      await atomicWriteProjection(destination, bytes, signal);
    await inspectPdf(destination, { expectedSha256, signal });
    return destination;
  }, signal);
}

export async function publishPdfStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const staging = path.join(projectionRoot(), "staging");
  await mkdir(staging, { recursive: true });
  const temporary = path.join(staging, `${crypto.randomUUID()}.pdf.tmp`);
  const output = await open(temporary, "wx");
  const reader = stream.getReader();
  const digest = crypto.createHash("sha256");
  const header = Buffer.alloc(1_024);
  let size = 0;
  let headerSize = 0;
  let complete = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > MAX_PROJECTION_PDF_BYTES)
        throw new Error("PDF input exceeds the size limit");
      if (headerSize < header.length) {
        const copied = Math.min(header.length - headerSize, value.byteLength);
        header.set(value.subarray(0, copied), headerSize);
        headerSize += copied;
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
    return {
      path: await publishPdfContent(temporary, sourceSha256, signal),
      sourceSha256,
    };
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export function immutableReceiptPath(namespace: string, digest: string) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(namespace) || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("Projection receipt identity is invalid");
  return path.join(
    projectionRoot(),
    "receipts",
    namespace,
    digest.slice(0, 2),
    `${digest}.json`,
  );
}

export async function writeImmutableReceipt(filename: string, value: unknown) {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  const digest = sha256(encoded);
  await withProjectionLock(`receipt:${filename}`, async () => {
    try {
      const existing = await readFile(localDataPath(filename), "utf8");
      if (sha256(existing) !== digest)
        throw new Error("Conflicting immutable projection receipt");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encoded, { flag: "wx" });
      try {
        await link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    if (sha256(await readFile(filename, "utf8")) !== digest)
      throw new Error("Conflicting immutable projection receipt");
  });
}
