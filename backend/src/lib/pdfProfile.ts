import { existsSync } from "node:fs";
import path from "node:path";
import type { LegalPdfProfile, LegalPdfOcrProvider } from "./documentStore";

function pdfEngineRoot(env: NodeJS.ProcessEnv) {
  return path.resolve(env.LEGALPDF_ENGINE_ROOT?.trim() ||
    path.join(__dirname, "../../../legal-pdf-parser"));
}

function nativeLibraryNames(platform: NodeJS.Platform) {
  if (platform === "win32") return ["onnxruntime.dll", "legalpdf_tesseract_layout.dll"];
  const extension = platform === "darwin" ? "dylib" : "so";
  return [`libonnxruntime.${extension}`, `liblegalpdf_tesseract_layout.${extension}`];
}

function openVinoLibraryName(platform: NodeJS.Platform) {
  if (platform === "win32") return "openvino_c.dll";
  return platform === "darwin" ? "libopenvino_c.dylib" : "libopenvino_c.so";
}

function configuredPath(env: NodeJS.ProcessEnv, root: string, name: string,
  fallback: string, requiredFile?: string) {
  const candidate = path.resolve(root, env[name]?.trim() || fallback);
  if (!existsSync(requiredFile ? path.join(candidate, requiredFile) : candidate))
    throw new Error(`${name} does not exist: ${candidate}`);
  return candidate;
}

function numericSetting(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function numericSettings(env: NodeJS.ProcessEnv, fields: ReadonlyArray<readonly [string, string]>) {
  return Object.fromEntries(fields.flatMap(([field, name]) => {
    const value = numericSetting(env, name);
    return value === undefined ? [] : [[field, value]];
  }));
}

function configuredLegalPdfOcrProvider(env: NodeJS.ProcessEnv, root: string) {
  const requested = env.MIKE_PDF_OCR_PROVIDER?.trim();
  if (requested) {
    if (requested === "none") return null;
    if (requested === "indra" || requested === "tesseract") return requested;
    throw new Error("MIKE_PDF_OCR_PROVIDER must be none, indra, or tesseract");
  }
  const [runtime] = nativeLibraryNames(process.platform);
  return existsSync(path.resolve(root, env.LEGALPDF_INDRA_MODEL_PACK?.trim() || "runtime/indra", "manifest.json")) &&
    existsSync(path.resolve(root, env.LEGALPDF_ONNX_RUNTIME?.trim() || `runtime/onnx/${runtime}`)) ? "indra" : null;
}

function configuredLegalPdfProfile(env: NodeJS.ProcessEnv = process.env): LegalPdfProfile {
  const root = pdfEngineRoot(env), platform = process.platform;
  const profile: LegalPdfProfile = {};
  const ocr = configuredLegalPdfOcrProvider(env, root);
  if (ocr === "tesseract") {
    profile.ocr = { provider: ocr, settings: {
      ...(env.LEGALPDF_OCR_LANGUAGE?.trim() ? { language: env.LEGALPDF_OCR_LANGUAGE.trim() } : {}),
      ...numericSettings(env, [["dpi", "LEGALPDF_OCR_DPI"], ["psm", "LEGALPDF_OCR_PSM"]]),
    } };
  } else if (ocr === "indra") {
    const layout = env.LEGALPDF_INDRA_LAYOUT?.trim();
    if (layout && layout !== "indra" && layout !== "tesseract")
      throw new Error("LEGALPDF_INDRA_LAYOUT must be indra or tesseract");
    const [runtime, tesseractLibrary] = nativeLibraryNames(platform);
    const backend = env.LEGALPDF_INDRA_BACKEND?.trim();
    profile.ocr = { provider: ocr, settings: {
      ...(layout ? { layout } : {}),
      ...(backend && backend !== "auto" ? { backend } : {}),
      ...(env.LEGALPDF_INDRA_TIER?.trim() ? { tier: env.LEGALPDF_INDRA_TIER.trim() } : {}),
      model_pack: configuredPath(env, root, "LEGALPDF_INDRA_MODEL_PACK", "runtime/indra", "manifest.json"),
      runtime: configuredPath(env, root, "LEGALPDF_ONNX_RUNTIME", `runtime/onnx/${runtime}`),
      ...(layout === "tesseract" ? {tesseract_library: configuredPath(env, root, "LEGALPDF_INDRA_TESSERACT_LIBRARY", `runtime/${tesseractLibrary}`)} : {}),
      ...numericSettings(env, [
        ["dpi", "LEGALPDF_OCR_DPI"],
        ["threads", "LEGALPDF_INDRA_THREADS"], ["workers", "LEGALPDF_INDRA_WORKERS"],
        ["layout_workers", "LEGALPDF_INDRA_LAYOUT_WORKERS"],
        ["batch_size", "LEGALPDF_INDRA_BATCH_SIZE"],
        ["width_bucket", "LEGALPDF_INDRA_WIDTH_BUCKET"],
      ]),
      ...(env.LEGALPDF_INDRA_DEVICE?.trim()
        ? { device: env.LEGALPDF_INDRA_DEVICE.trim() } : {}),
    } };
  }

  const requestedLayout = env.MIKE_PDF_LAYOUT_PROVIDER?.trim();
  if (requestedLayout && requestedLayout !== "none" && requestedLayout !== "ppdoc")
    throw new Error("MIKE_PDF_LAYOUT_PROVIDER must be none or ppdoc");
  const backend = env.LEGALPDF_PPDOC_BACKEND?.trim() || "openvino";
  const modelPack = path.resolve(root,
    env.LEGALPDF_PPDOC_MODEL_PACK?.trim() || "runtime/layout/heron-int8");
  const runtime = path.resolve(root, env.LEGALPDF_PPDOC_RUNTIME?.trim() ||
    `runtime/${backend === "openvino"
      ? openVinoLibraryName(platform) : `onnx/${nativeLibraryNames(platform)[0]}`}`);
  if (requestedLayout === "ppdoc" || (!requestedLayout &&
      existsSync(path.join(modelPack, "manifest.json")) && existsSync(runtime))) {
    profile.layout = { provider: "ppdoc", settings: {
      model_pack: configuredPath(env, root, "LEGALPDF_PPDOC_MODEL_PACK",
        "runtime/layout/heron-int8", "manifest.json"),
      runtime: configuredPath(env, root, "LEGALPDF_PPDOC_RUNTIME",
        `runtime/${backend === "openvino"
          ? openVinoLibraryName(platform) : `onnx/${nativeLibraryNames(platform)[0]}`}`),
      backend,
      ...numericSettings(env, [
        ["threads", "LEGALPDF_PPDOC_THREADS"], ["threshold", "LEGALPDF_PPDOC_THRESHOLD"],
        ["render_dpi", "LEGALPDF_PPDOC_DPI"],
      ]),
      ...(env.LEGALPDF_PPDOC_DEVICE?.trim()
        ? { device: env.LEGALPDF_PPDOC_DEVICE.trim() } : {}),
      ...(env.LEGALPDF_PPDOC_CPU_FALLBACK === "1" ? { cpu_fallback: true } : {}),
    } };
  }
  return profile;
}

export function profileFor(
  ocrProvider: LegalPdfOcrProvider | null | undefined,
  layout: boolean | null | undefined,
) {
  const env = ocrProvider === undefined
    ? process.env
    : { ...process.env, MIKE_PDF_OCR_PROVIDER: ocrProvider ?? "none" };
  const profile = configuredLegalPdfProfile(env);
  if (layout === false || layout === null) delete profile.layout;
  if (layout === true && !profile.layout)
    throw new Error("Local PDF layout assets are unavailable");
  return profile;
}
