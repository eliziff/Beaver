import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  downloadHeaders,
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  documentBlobKey,
  normalizeDownloadFilename,
  readS3Configuration,
  scopeObjectStorage,
  type ObjectStorage,
  validateObjectKey,
} from "../storage";
import { sha256 } from "../hash";

let temporaryRoot: string;
let stores: { name: string; value: ObjectStorage }[];

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "beaver-storage-"));
  stores = [{ name: "filesystem", value: createFilesystemObjectStorage(temporaryRoot) }];
  if (process.env.S3_CONTRACT_TEST === "true") {
    stores.push({ name: "minio", value: createS3ObjectStorage(readS3Configuration()) });
  }
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("object storage contract", () => {
  it("cleans interrupted filesystem staging on restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "beaver-storage-restart-"));
    try {
      const staging = path.join(root, ".staging");
      await mkdir(staging); await writeFile(path.join(staging, "partial"), "partial");
      const objects = createFilesystemObjectStorage(root), bytes = Buffer.from("complete");
      await objects.put("complete.bin", bytes, "application/octet-stream",
        { expectedSha256: sha256(bytes) });
      expect(await readdir(staging)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs the common contract against filesystem and configured MinIO", async () => {
    for (const store of stores) {
      const objects = scopeObjectStorage(store.value, `contract-${randomUUID()}`);
      await objects.remove("missing.bin");
      await objects.put("pages/a.txt", Buffer.from("alpha"), "text/plain",
        { expectedSha256: sha256(Buffer.from("alpha")) });
      const immutable = Buffer.from("first"), immutableDigest = sha256(immutable);
      await expect(objects.put("immutable.txt", immutable, "text/plain",
        { expectedSha256: immutableDigest })).resolves.toBe("created");
      await expect(objects.put("immutable.txt", immutable, "text/plain",
        { expectedSha256: immutableDigest })).resolves.toBe("exists");
      if (store.name === "filesystem") {
        await expect(objects.put("immutable.txt", {
          path: path.join(temporaryRoot, "missing"), sizeBytes: immutable.byteLength,
        }, "text/plain", { expectedSha256: immutableDigest })).resolves.toBe("exists");
      }
      await expect(objects.put("immutable.txt", Buffer.from("other"), "text/plain",
        { expectedSha256: sha256(Buffer.from("other")) })).rejects.toThrow(/integrity/u);
      expect((await objects.get("immutable.txt"))?.toString()).toBe("first");
      const shared = Buffer.alloc(16 * 1024 * 1024, 7), sharedDigest = sha256(shared);
      const concurrent = await Promise.all([1, 2].map(async () => {
        const result = await objects.put("shared.bin", shared, "application/octet-stream",
          { expectedSha256: sharedDigest });
        return [result, result === "exists" ? sha256((await objects.get("shared.bin"))!) : null];
      }));
      expect(concurrent.map(([result]) => result).sort()).toEqual(["created", "exists"]);
      expect(concurrent.find(([result]) => result === "exists")?.[1]).toBe(sharedDigest);
      expect((await objects.get("pages/a.txt"))?.toString()).toBe("alpha");
      const changed = path.join(temporaryRoot, `${randomUUID()}.txt`);
      await writeFile(changed, "bravo");
      await expect(objects.put("changed.txt", { path: changed, sizeBytes: 5 }, "text/plain",
        { expectedSha256: sha256(Buffer.from("alpha")) })).rejects.toThrow();
      expect(await objects.get("changed.txt")).toBeNull();
      await expect(objects.get("pages/a.txt", { maxBytes: 4 })).rejects.toThrow(/limit/u);
      const aborted = new AbortController();
      aborted.abort();
      await expect(objects.get("pages/a.txt", { signal: aborted.signal })).rejects.toThrow();
      await expect(objects.put(
        "timeout.bin", Buffer.alloc(16 * 1024 * 1024), "application/octet-stream",
        { timeoutMs: 1, expectedSha256: sha256(Buffer.alloc(16 * 1024 * 1024)) },
      )).rejects.toThrow();
      await objects.remove("timeout.bin");
      await objects.remove("pages/a.txt");
      await objects.remove("shared.bin");
      await objects.remove("immutable.txt");
      expect(await objects.get("pages/a.txt")).toBeNull();
    }
  });

  it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
    "signs a short authenticated GET and propagates provider failures",
    async () => {
      const config = readS3Configuration();
      const objects = scopeObjectStorage(createS3ObjectStorage(config), `signed-${randomUUID()}`);
      const bytes = Buffer.from("private"), digest = sha256(bytes);
      await objects.put("brief.txt", bytes, "text/plain", { expectedSha256: digest });
      const url = await objects.signedGet!("brief.txt", {
        filename: "Résumé final.txt", contentType: "text/plain",
        expectedSha256: digest, sizeBytes: bytes.byteLength,
        disposition: "attachment", expiresIn: 60,
      });
      const response = await fetch(url!);
      expect([response.status, await response.text()]).toEqual([200, "private"]);
      expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const changed = Buffer.from("changed"), changedDigest = sha256(changed);
      await objects.put("changed.txt", changed, "text/plain", {
        expectedSha256: changedDigest,
      });
      await expect(objects.signedGet!("changed.txt", {
        filename: "changed.txt", contentType: "text/plain",
        expectedSha256: digest, sizeBytes: bytes.byteLength,
      })).rejects.toThrow(/integrity/u);
      await objects.remove("changed.txt");
      await objects.remove("brief.txt");
      await expect(objects.signedGet!("brief.txt", {
        filename: "brief.txt", contentType: "text/plain",
        expectedSha256: digest, sizeBytes: bytes.byteLength,
      })).resolves.toBeNull();
      const broken = createS3ObjectStorage({ ...config, bucket: `${config.bucket}-missing` });
      await expect(broken.get("anything")).rejects.toBeTruthy();
    },
  );
});

describe("storage boundary", () => {
  it("rejects incomplete, malformed, and insecure cloud configuration", () => {
    expect(() => readS3Configuration({ S3_ENDPOINT: "https://s3.test" }))
      .toThrow(/S3_REGION/u);
    expect(() => readS3Configuration({
      NODE_ENV: "production", S3_ENDPOINT: "http://s3.example.com", S3_REGION: "auto",
      S3_BUCKET: "private", S3_ACCESS_KEY_ID: "access", S3_SECRET_ACCESS_KEY: "secret",
    })).toThrow(/HTTPS/u);
    expect(() => readS3Configuration({
      S3_ENDPOINT: "https://user:pass@s3.test/path?leak=1", S3_REGION: "auto",
      S3_BUCKET: "private", S3_ACCESS_KEY_ID: "access", S3_SECRET_ACCESS_KEY: "secret",
    })).toThrow(/without credentials/u);
  });

  it("rejects prefix escapes and builds safe names and keys", () => {
    for (const key of ["", "../secret", "/root", "a//b", "a\\b", "a/./b", "a\u0000b"]) {
      expect(() => validateObjectKey(key)).toThrow();
    }
    const digest = "a".repeat(64);
    expect(documentBlobKey({ userId: "user", projectId: null }, digest))
      .toBe(`users/user/blobs/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`);
    expect(documentBlobKey({ userId: "user", projectId: "project" }, digest))
      .toBe(`projects/project/blobs/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`);
    for (const scope of [
      { userId: "user/other", projectId: null },
      { userId: "user", projectId: "project/other" },
      { userId: "user\\other", projectId: null },
    ]) expect(() => documentBlobKey(scope, digest)).toThrow();
    expect(normalizeDownloadFilename("../Résumé\u0000.pdf")).toBe(".._Résumé_.pdf");
    expect(downloadHeaders("application/pdf", "Résumé.pdf")["Content-Disposition"])
      .toContain("filename*=UTF-8''R%C3%A9sum%C3%A9.pdf");
  });
});
