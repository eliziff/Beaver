import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildContentDisposition,
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  normalizeDownloadFilename,
  readS3Configuration,
  scopeObjectStorage,
  type ObjectStorage,
  validateObjectKey,
  versionStorageKey,
} from "../storage";

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
  it("runs the common contract against filesystem and configured MinIO", async () => {
    for (const store of stores) {
      const objects = scopeObjectStorage(store.value, `contract-${randomUUID()}`);
      await objects.remove("missing.bin");
      await objects.put("pages/a.txt", Buffer.from("alpha"), "text/plain");
      await objects.put("pages/b.txt", Buffer.from("bravo"), "text/plain");
      await objects.put("pages/c.txt", Buffer.from("charlie"), "text/plain");
      expect((await objects.get("pages/a.txt"))?.toString()).toBe("alpha");
      await expect(objects.get("pages/a.txt", { maxBytes: 4 })).rejects.toThrow(/limit/u);
      const first = await objects.list("pages", { limit: 2 });
      const second = await objects.list("pages", { limit: 2, cursor: first.cursor });
      expect([...first.keys, ...second.keys]).toEqual([
        "pages/a.txt", "pages/b.txt", "pages/c.txt",
      ]);
      const aborted = new AbortController();
      aborted.abort();
      await expect(objects.get("pages/a.txt", { signal: aborted.signal })).rejects.toThrow();
      await expect(objects.put(
        "timeout.bin", Buffer.alloc(16 * 1024 * 1024), "application/octet-stream",
        { timeoutMs: 1 },
      )).rejects.toThrow();
      await objects.remove("timeout.bin");
      await Promise.all([...first.keys, ...second.keys].map((key) => objects.remove(key)));
      expect(await objects.get("pages/a.txt")).toBeNull();
    }
  });

  it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
    "signs a short authenticated GET and propagates provider failures",
    async () => {
      const config = readS3Configuration();
      const objects = scopeObjectStorage(createS3ObjectStorage(config), `signed-${randomUUID()}`);
      await objects.put("brief.txt", Buffer.from("private"), "text/plain");
      const url = await objects.signedGet!("brief.txt", {
        filename: "Résumé final.txt", disposition: "attachment", expiresIn: 60,
      });
      const response = await fetch(url);
      expect([response.status, await response.text()]).toEqual([200, "private"]);
      expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
      await objects.remove("brief.txt");
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
    expect(versionStorageKey("user", "document", "version", digest, "brief.docx"))
      .toBe(`user/document/version-${digest.slice(0, 16)}.docx`);
    expect(() => versionStorageKey("../user", "document", "version", digest, "x"))
      .toThrow();
    expect(normalizeDownloadFilename("../Résumé\u0000.pdf")).toBe(".._Résumé_.pdf");
    expect(buildContentDisposition("attachment", "Résumé.pdf"))
      .toContain("filename*=UTF-8''R%C3%A9sum%C3%A9.pdf");
  });
});
