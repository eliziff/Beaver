import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileFor } from "./pdfProfile";

describe("installed native OCR profiles", () => {
  let root: string;
  const runtime = process.platform === "win32" ? "onnxruntime.dll"
    : process.platform === "darwin" ? "libonnxruntime.dylib" : "libonnxruntime.so";
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "native-ocr-profile-"));
    mkdirSync(path.join(root, "runtime/indra"), { recursive: true });
    mkdirSync(path.join(root, "runtime/onnx"), { recursive: true });
    // Invented files exercise profile selection; inference validates the actual pack.
    writeFileSync(path.join(root, "runtime/indra/manifest.json"), "{}");
    writeFileSync(path.join(root, "runtime/onnx", runtime), "invented runtime placeholder");
    for (const name of Object.keys(process.env).filter(name => /^LEGALPDF_|^MIKE_PDF_/u.test(name)))
      vi.stubEnv(name, "");
    vi.stubEnv("LEGALPDF_ENGINE_ROOT", root);
    vi.stubEnv("MIKE_PDF_LAYOUT_PROVIDER", "none");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (root && root.startsWith(path.resolve(tmpdir()) + path.sep)) rmSync(root, { recursive: true, force: true });
  });
  it("selects installed Indra and leaves recognition defaults to the parser", () => {
    const profile = profileFor(undefined, false);
    expect(profile.ocr).toEqual({ provider: "indra", settings: {
      model_pack: path.join(root, "runtime/indra"),
      runtime: path.join(root, "runtime/onnx", runtime),
    } });
    expect(profileFor(null, false)).toEqual({});
  });
  it("preserves explicit execution overrides and requires assets for alternative layout", () => {
    vi.stubEnv("LEGALPDF_INDRA_BACKEND", "cpu");
    vi.stubEnv("LEGALPDF_INDRA_THREADS", "2");
    vi.stubEnv("LEGALPDF_INDRA_TIER", "quality");
    vi.stubEnv("LEGALPDF_OCR_DPI", "192");
    expect(profileFor("indra", false).ocr?.settings).toMatchObject({ backend: "cpu", threads: 2, tier: "quality", dpi: 192 });
    vi.stubEnv("LEGALPDF_INDRA_LAYOUT", "tesseract");
    expect(() => profileFor("indra", false)).toThrow(/TESSERACT_LIBRARY/u);
  });
});
