import { existsSync } from "node:fs";
import path from "node:path";
import type { LegalPdfProfile, LegalPdfOcrProvider } from "./documentStore";

function pdfEngineRoot(env: NodeJS.ProcessEnv) {
  return path.resolve(env.LEGALPDF_ENGINE_ROOT?.trim() ||
    path.join(__dirname, "../../../legal-pdf-parser"));
}

function onnxRuntimeLibraryName(platform: NodeJS.Platform) {
  if (platform === "win32") return "onnxruntime.dll";
  return `libonnxruntime.${platform === "darwin" ? "dylib" : "so"}`;
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
    if (requested === "indra") return requested;
    throw new Error("MIKE_PDF_OCR_PROVIDER must be none or indra");
  }
  return existsSync(path.resolve(root, env.LEGALPDF_INDRA_MODEL_PACK?.trim() || "runtime/indra", "manifest.json")) &&
    existsSync(path.resolve(root, env.LEGALPDF_ONNX_RUNTIME?.trim() ||
      `runtime/onnx/${onnxRuntimeLibraryName(process.platform)}`)) ? "indra" : null;
}

function configuredLegalPdfProfile(env: NodeJS.ProcessEnv = process.env): LegalPdfProfile {
  const root = pdfEngineRoot(env), platform = process.platform;
  const profile: LegalPdfProfile = {};
  const ocr = configuredLegalPdfOcrProvider(env, root);
  if (ocr === "indra") {
    const backend = env.LEGALPDF_INDRA_BACKEND?.trim();
    profile.ocr = { provider: ocr, settings: {
      ...(backend && backend !== "auto" ? { backend } : {}),
      ...(env.LEGALPDF_INDRA_TIER?.trim() ? { tier: env.LEGALPDF_INDRA_TIER.trim() } : {}),
      model_pack: configuredPath(env, root, "LEGALPDF_INDRA_MODEL_PACK", "runtime/indra", "manifest.json"),
      runtime: configuredPath(env, root, "LEGALPDF_ONNX_RUNTIME", `runtime/onnx/${onnxRuntimeLibraryName(platform)}`),
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
  const modelPack = path.resolve(root,
    env.LEGALPDF_PPDOC_MODEL_PACK?.trim() || "runtime/layout/heron-int8");
  const runtime = path.resolve(root, env.LEGALPDF_PPDOC_RUNTIME?.trim() ||
    `runtime/${openVinoLibraryName(platform)}`);
  if (requestedLayout === "ppdoc" || (!requestedLayout &&
      existsSync(path.join(modelPack, "manifest.json")) && existsSync(runtime))) {
    profile.layout = { provider: "ppdoc", settings: {
      model_pack: configuredPath(env, root, "LEGALPDF_PPDOC_MODEL_PACK",
        "runtime/layout/heron-int8", "manifest.json"),
      runtime: configuredPath(env, root, "LEGALPDF_PPDOC_RUNTIME",
        `runtime/${openVinoLibraryName(platform)}`),
      ...numericSettings(env, [
        ["threads", "LEGALPDF_PPDOC_THREADS"], ["threshold", "LEGALPDF_PPDOC_THRESHOLD"],
        ["render_dpi", "LEGALPDF_PPDOC_DPI"],
      ]),
      ...(env.LEGALPDF_PPDOC_DEVICE?.trim()
        ? { device: env.LEGALPDF_PPDOC_DEVICE.trim() } : {}),
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
