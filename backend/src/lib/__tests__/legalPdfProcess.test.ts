import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import {
  configuredLegalPdfProfile,
  legalPdfBinary,
  runLegalPdfDocument,
} from "../legalPdfProcess";

const result = {
  schema_version: "legalpdf.document-result.v1",
  operation: "prepare",
  source: {
    sha256: "a".repeat(64),
    parser_version: "0.4.0",
    cache_key: "cache-key",
    cache_hit: false,
    page_count: 2,
  },
  result: { page_count: 2 },
};

beforeEach(() => {
  execFile.mockReset();
});

describe("legal PDF document process", () => {
  it("selects an explicit, managed, or installed binary", () => {
    expect(legalPdfBinary({ env: { LEGALPDF_BINARY: "D:\\legalpdf.exe" } }))
      .toBe("D:\\legalpdf.exe");
    const root = path.resolve("C:\\engine");
    const managed = path.join(root, "target", "release", "legalpdf.exe");
    expect(legalPdfBinary({
      env: {}, platform: "win32", engineRoot: root,
      exists: (candidate) => candidate === managed,
    })).toBe(managed);
    expect(legalPdfBinary({
      env: {}, platform: "linux", engineRoot: "/engine", exists: () => false,
    })).toBe("legalpdf");
  });

  it("builds one native OCR and layout profile", () => {
    const profile = configuredLegalPdfProfile({
      env: {}, platform: "win32", engineRoot: "C:\\engine", exists: () => true,
    });
    expect(profile.ocr).toMatchObject({
      provider: "kraken-lite",
      settings: { layout: "tesseract", tier: "quality", dpi: 180 },
    });
    expect(profile.layout).toMatchObject({
      provider: "ppdoc",
      settings: { backend: "openvino" },
    });
  });

  it("uses only the versioned contract and returns its validated envelope", async () => {
    let request: Record<string, unknown> | undefined;
    execFile.mockImplementation((...args: unknown[]) => {
      const commandArgs = args[1] as string[];
      const done = args.at(-1) as Function;
      request = JSON.parse(readFileSync(commandArgs[1], "utf8"));
      done(null, JSON.stringify(result));
    });

    const response = await runLegalPdfDocument({
      operation: "prepare",
      source_pdf: "article.pdf",
      pages: [2],
    });

    expect(request).toMatchObject({
      schema_version: "legalpdf.document-request.v1",
      operation: "prepare",
      pages: [2],
    });
    expect(execFile.mock.calls[0][1][0]).toBe("contract");
    expect(response.source.cache_key).toBe("cache-key");
  });

  it("rejects an engine response that exposes undeclared source fields", async () => {
    execFile.mockImplementation((...args: unknown[]) => {
      const done = args.at(-1) as Function;
      done(null, JSON.stringify({
        ...result,
        source: { ...result.source, source_pdf: "C:\\private\\article.pdf" },
      }));
    });
    await expect(runLegalPdfDocument({
      operation: "prepare",
      source_pdf: "article.pdf",
    })).rejects.toThrow("invalid document result");
  });
});
