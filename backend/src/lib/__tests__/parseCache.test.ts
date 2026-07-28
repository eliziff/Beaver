import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedParse, clearParseCache } from "../parseCache";

let temporaryDirectory: string | null = null;

async function setup() {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "parse-cache-"));
  process.env.MIKE_LOCAL_DATA_DIR = temporaryDirectory;
}

afterEach(async () => {
  delete process.env.MIKE_LOCAL_DATA_DIR;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("parseCache", () => {
  it("returns byte-identical text on hit without re-parsing", async () => {
    await setup();
    const bytes = Buffer.from("source bytes v1");
    const text = "Parsed é—🦫 text\nwith\tlines and \"quotes\"";
    const parse = vi.fn(async () => text);

    const miss = await cachedParse(
      { scope: "user:a", parser: "pdfjs-text", version: 1, bytes, parse },
    );
    const hit = await cachedParse(
      { scope: "user:a", parser: "pdfjs-text", version: 1, bytes, parse },
    );

    expect(parse).toHaveBeenCalledTimes(1);
    expect(miss).toBe(text);
    expect(Buffer.from(hit, "utf8").equals(Buffer.from(text, "utf8"))).toBe(
      true,
    );
    // Entries live under the app's local data home, not an ad-hoc location.
    const scopes = await readdir(
      path.join(temporaryDirectory!, "parse-cache"),
    );
    expect(scopes).toHaveLength(1);
  });

  it("misses when content, parser, version, or scope changes", async () => {
    await setup();
    const parse = vi.fn(async () => "text");
    const base = {
      scope: "user:a",
      parser: "docx-body-text",
      version: 1,
      bytes: Buffer.from("content-a"),
      parse,
    };

    await cachedParse(base);
    await cachedParse({ ...base, bytes: Buffer.from("content-b") });
    await cachedParse({ ...base, version: 2 });
    await cachedParse({ ...base, parser: "pdfjs-text" });
    await cachedParse({ ...base, scope: "user:b" });
    expect(parse).toHaveBeenCalledTimes(5);

    await cachedParse(base);
    expect(parse).toHaveBeenCalledTimes(5);
  });

  it("clears one scope without touching others, and clears everything", async () => {
    await setup();
    const parse = vi.fn(async () => "text");
    const entry = (scope: string) => ({
      scope,
      parser: "pdfjs-text",
      version: 1,
      bytes: Buffer.from("shared bytes"),
      parse,
    });
    await cachedParse(entry("user:a"));
    await cachedParse(entry("user:b"));
    expect(parse).toHaveBeenCalledTimes(2);

    await clearParseCache("user:a");
    await cachedParse(entry("user:a"));
    expect(parse).toHaveBeenCalledTimes(3);
    await cachedParse(entry("user:b"));
    expect(parse).toHaveBeenCalledTimes(3);

    await clearParseCache();
    await cachedParse(entry("user:b"));
    expect(parse).toHaveBeenCalledTimes(4);
  });
});
