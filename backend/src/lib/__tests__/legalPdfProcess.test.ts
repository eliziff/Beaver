import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configuredLegalPdfLayout,
  configuredLegalPdfOcrProvider,
  legalPdfBinary,
  legalPdfLayoutArguments,
  legalPdfOcrArguments,
} from "../legalPdfProcess";

describe("legal PDF binary selection", () => {
  it("honours an explicit binary", () => {
    expect(
      legalPdfBinary({
        env: { LEGALPDF_BINARY: "D:\\legalpdf\\legalpdf.exe" },
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => false,
      }),
    ).toBe("D:\\legalpdf\\legalpdf.exe");
  });

  it("prefers the engine release build", () => {
    const root = path.resolve("C:\\engine");
    const expected = path.join(root, "target", "release", "legalpdf.exe");
    expect(
      legalPdfBinary({
        env: {},
        platform: "win32",
        engineRoot: root,
        exists: (candidate) => candidate === expected,
      }),
    ).toBe(expected);
  });

  it("falls back to an installed legalpdf command", () => {
    expect(
      legalPdfBinary({
        env: {},
        platform: "linux",
        engineRoot: "/engine",
        exists: () => false,
      }),
    ).toBe("legalpdf");
  });

  it("selects Kraken when the native runtime is complete", () => {
    expect(
      configuredLegalPdfOcrProvider({
        env: { NODE_ENV: "production" },
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => true,
      }),
    ).toBe("kraken-lite");
  });

  it("builds the complete native Kraken argument contract", () => {
    const args = legalPdfOcrArguments(
      "kraken-lite",
      { dpi: 144, expectedIdentity: "runtime-identity" },
      {
        env: {},
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => true,
      },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--ocr-provider",
        "kraken-lite",
        "--ocr-dpi",
        "144",
        "--kraken-tier",
        "quality",
        "--kraken-model",
        path.resolve("C:\\engine", "runtime/kraken/model.onnx"),
        "--onnx-runtime",
        path.resolve("C:\\engine", "runtime/onnxruntime.dll"),
        "--expected-ocr-identity",
        "runtime-identity",
      ]),
    );
  });

  it("keeps network layout opt-in and defaults it to the cheap vision model", () => {
    expect(
      configuredLegalPdfLayout({
        env: { MIKE_PDF_LAYOUT_PROVIDER: "mllm" },
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => false,
      }),
    ).toEqual({ provider: "mllm", model: "gpt-5.6-luna" });
  });

  it("builds CPU and GPU compatible local layout arguments", () => {
    const args = legalPdfLayoutArguments(
      { provider: "local" },
      "layout-identity",
      {
        env: { LEGALPDF_PPDOC_BACKEND: "directml" },
        platform: "win32",
        engineRoot: "C:\\engine",
        exists: () => true,
      },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--ppdoc-model-pack",
        path.resolve("C:\\engine", "runtime/layout/heron-int8"),
        "--ppdoc-runtime",
        path.resolve("C:\\engine", "runtime/onnxruntime.dll"),
        "--ppdoc-backend",
        "directml",
        "--ppdoc-expected-identity",
        "layout-identity",
      ]),
    );
  });
});
