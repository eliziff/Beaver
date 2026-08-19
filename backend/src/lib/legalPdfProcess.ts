import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LEGAL_PDF_REQUEST_SCHEMA = "legalpdf.document-request.v1";
export const LEGAL_PDF_RESULT_SCHEMA = "legalpdf.document-result.v1";

export type LegalPdfOcrProvider = "kraken-lite" | "tesseract";
export type LegalPdfProviderConfig<Provider extends string> = {
  provider: Provider;
  settings: Record<string, unknown>;
};
export type LegalPdfOcrConfig = LegalPdfProviderConfig<LegalPdfOcrProvider>;
export type LegalPdfLayoutConfig = LegalPdfProviderConfig<"ppdoc">;
export type LegalPdfProfile = {
  ocr?: LegalPdfOcrConfig;
  layout?: LegalPdfLayoutConfig;
};

type LegalPdfBaseRequest = LegalPdfProfile & {
  source_pdf: string;
  cache_dir?: string;
};
export type LegalPdfPrepareRequest = LegalPdfBaseRequest & {
  operation: "prepare";
  pages?: number[];
};
export type LegalPdfInspectRequest = Pick<LegalPdfBaseRequest, "source_pdf"> & {
  operation: "inspect";
};
export type LegalPdfSourceDocRequest = LegalPdfBaseRequest & {
  operation: "source_doc";
  id?: string;
  url?: string | null;
};
export type LegalPdfStructureLookupRequest = LegalPdfBaseRequest & {
  operation: "structure_lookup";
  pages?: number[];
  query: Record<string, unknown>;
};
export type LegalPdfDocumentRequest =
  | LegalPdfPrepareRequest
  | LegalPdfInspectRequest
  | LegalPdfSourceDocRequest
  | LegalPdfStructureLookupRequest;

export type LegalPdfDocumentSource = {
  sha256: string;
  parser_version: string;
  cache_key: string | null;
  cache_hit: boolean;
  page_count: number;
};
export type LegalPdfDocumentResult<Result = Record<string, unknown>> = {
  schema_version: typeof LEGAL_PDF_RESULT_SCHEMA;
  operation: LegalPdfDocumentRequest["operation"];
  source: LegalPdfDocumentSource;
  result: Result;
};

type RuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  engineRoot?: string;
  exists?: (candidate: string) => boolean;
};

function engineRoot(options: RuntimeOptions = {}) {
  const env = options.env ?? process.env;
  return path.resolve(
    options.engineRoot ||
      env.LEGALPDF_ENGINE_ROOT?.trim() ||
      path.join(__dirname, "../../../legal-pdf-parser"),
  );
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

function configuredPath(
  env: NodeJS.ProcessEnv,
  root: string,
  name: string,
  fallback: string,
  exists: (candidate: string) => boolean,
) {
  const candidate = path.resolve(root, env[name]?.trim() || fallback);
  if (!exists(candidate)) throw new Error(`${name} does not exist: ${candidate}`);
  return candidate;
}

function numericSetting(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

export function configuredLegalPdfOcrProvider(
  options: RuntimeOptions = {},
): LegalPdfOcrProvider | null {
  const env = options.env ?? process.env;
  const requested = env.MIKE_PDF_OCR_PROVIDER?.trim();
  if (requested) {
    if (requested === "none") return null;
    if (requested === "kraken-lite" || requested === "tesseract") return requested;
    throw new Error("MIKE_PDF_OCR_PROVIDER must be none, kraken-lite, or tesseract");
  }
  const root = engineRoot({ ...options, env });
  const exists = options.exists ?? existsSync;
  const [runtime, layout] = nativeLibraryNames(options.platform ?? process.platform);
  return [
    "runtime/kraken/model.onnx",
    "runtime/kraken/codec.json",
    `runtime/${runtime}`,
    `runtime/${layout}`,
  ].every((candidate) => exists(path.resolve(root, candidate)))
    ? "kraken-lite"
    : null;
}

export function configuredLegalPdfProfile(options: RuntimeOptions = {}): LegalPdfProfile {
  const env = options.env ?? process.env;
  const root = engineRoot({ ...options, env });
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const profile: LegalPdfProfile = {};
  const ocr = configuredLegalPdfOcrProvider({ ...options, env });
  if (ocr === "tesseract") {
    profile.ocr = {
      provider: ocr,
      settings: {
        language: env.LEGALPDF_OCR_LANGUAGE?.trim() || "eng",
        dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
        psm: numericSetting(env, "LEGALPDF_OCR_PSM") ?? 3,
      },
    };
  } else if (ocr === "kraken-lite") {
    const layout = env.LEGALPDF_KRAKEN_LAYOUT?.trim() || "tesseract";
    if (layout !== "tesseract" && layout !== "blla") {
      throw new Error("LEGALPDF_KRAKEN_LAYOUT must be tesseract or blla");
    }
    const [runtime, tesseractLibrary] = nativeLibraryNames(platform);
    profile.ocr = {
      provider: ocr,
      settings: {
        dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
        layout,
        backend: env.LEGALPDF_KRAKEN_BACKEND?.trim() || "cpu",
        tier: env.LEGALPDF_KRAKEN_TIER?.trim() || "quality",
        ...(layout === "tesseract"
          ? {
              model: configuredPath(env, root, "LEGALPDF_KRAKEN_MODEL", "runtime/kraken/model.onnx", exists),
              codec: configuredPath(env, root, "LEGALPDF_KRAKEN_CODEC", "runtime/kraken/codec.json", exists),
              runtime: configuredPath(env, root, "LEGALPDF_ONNX_RUNTIME", `runtime/${runtime}`, exists),
              tesseract_library: configuredPath(env, root, "LEGALPDF_KRAKEN_TESSERACT_LIBRARY", `runtime/${tesseractLibrary}`, exists),
            }
          : {
              runtime_wheel: configuredPath(env, root, "LEGALPDF_KRAKEN_RUNTIME_WHEEL", "runtime/kraken/runtime.whl", exists),
              blla_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_BLLA_PACK", "runtime/kraken/blla", exists),
              recognizer_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_RECOGNIZER_PACK", "runtime/kraken/recognizer", exists),
              ...(env.LEGALPDF_KRAKEN_PYTHON?.trim() ? { python: env.LEGALPDF_KRAKEN_PYTHON.trim() } : {}),
            }),
        ...Object.fromEntries(
          [
            ["threads", "LEGALPDF_KRAKEN_THREADS"],
            ["workers", "LEGALPDF_KRAKEN_WORKERS"],
            ["layout_workers", "LEGALPDF_KRAKEN_LAYOUT_WORKERS"],
            ["batch_size", "LEGALPDF_KRAKEN_BATCH_SIZE"],
            ["width_bucket", "LEGALPDF_KRAKEN_WIDTH_BUCKET"],
            ["width_scale", "LEGALPDF_KRAKEN_WIDTH_SCALE"],
          ].flatMap(([field, name]) => {
            const value = numericSetting(env, name);
            return value === undefined ? [] : [[field, value]];
          }),
        ),
        ...(env.LEGALPDF_KRAKEN_DEVICE?.trim() ? { device: env.LEGALPDF_KRAKEN_DEVICE.trim() } : {}),
        ...(env.LEGALPDF_KRAKEN_CPU_FALLBACK === "1" ? { cpu_fallback: true } : {}),
      },
    };
  }

  const requestedLayout = env.MIKE_PDF_LAYOUT_PROVIDER?.trim();
  if (requestedLayout && requestedLayout !== "none" && requestedLayout !== "ppdoc") {
    throw new Error("MIKE_PDF_LAYOUT_PROVIDER must be none or ppdoc");
  }
  const backend = env.LEGALPDF_PPDOC_BACKEND?.trim() || "openvino";
  const modelPack = path.resolve(root, env.LEGALPDF_PPDOC_MODEL_PACK?.trim() || "runtime/layout/heron-int8");
  const runtime = path.resolve(
    root,
    env.LEGALPDF_PPDOC_RUNTIME?.trim() ||
      `runtime/${backend === "openvino" ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`,
  );
  if (requestedLayout === "ppdoc" || (!requestedLayout && exists(path.join(modelPack, "manifest.json")) && exists(runtime))) {
    profile.layout = {
      provider: "ppdoc",
      settings: {
        model_pack: configuredPath(env, root, "LEGALPDF_PPDOC_MODEL_PACK", "runtime/layout/heron-int8", (candidate) => exists(path.join(candidate, "manifest.json"))),
        runtime: configuredPath(env, root, "LEGALPDF_PPDOC_RUNTIME", `runtime/${backend === "openvino" ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`, exists),
        backend,
        ...Object.fromEntries(
          [
            ["threads", "LEGALPDF_PPDOC_THREADS"],
            ["threshold", "LEGALPDF_PPDOC_THRESHOLD"],
            ["render_dpi", "LEGALPDF_PPDOC_DPI"],
          ].flatMap(([field, name]) => {
            const value = numericSetting(env, name);
            return value === undefined ? [] : [[field, value]];
          }),
        ),
        ...(env.LEGALPDF_PPDOC_DEVICE?.trim() ? { device: env.LEGALPDF_PPDOC_DEVICE.trim() } : {}),
        ...(env.LEGALPDF_PPDOC_CPU_FALLBACK === "1" ? { cpu_fallback: true } : {}),
      },
    };
  }
  return profile;
}

export function legalPdfBinary(options: RuntimeOptions = {}) {
  const env = options.env ?? process.env;
  if (env.LEGALPDF_BINARY?.trim()) return env.LEGALPDF_BINARY.trim();
  const root = engineRoot({ ...options, env });
  const managed = path.join(
    root,
    "target",
    "release",
    (options.platform ?? process.platform) === "win32" ? "legalpdf.exe" : "legalpdf",
  );
  return (options.exists ?? existsSync)(managed) ? managed : "legalpdf";
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateResponse(
  value: unknown,
  operation: LegalPdfDocumentRequest["operation"],
): LegalPdfDocumentResult {
  if (
    !record(value) ||
    !exactKeys(value, ["schema_version", "operation", "source", "result"]) ||
    value.schema_version !== LEGAL_PDF_RESULT_SCHEMA ||
    value.operation !== operation ||
    !record(value.source) ||
    !exactKeys(value.source, ["sha256", "parser_version", "cache_key", "cache_hit", "page_count"]) ||
    typeof value.source.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.source.sha256) ||
    typeof value.source.parser_version !== "string" ||
    !value.source.parser_version ||
    value.source.parser_version.length > 100 ||
    (operation === "inspect"
      ? value.source.cache_key !== null
      : typeof value.source.cache_key !== "string" ||
        !value.source.cache_key ||
        value.source.cache_key.length > 512) ||
    typeof value.source.cache_hit !== "boolean" ||
    !Number.isSafeInteger(value.source.page_count) ||
    Number(value.source.page_count) < 0 ||
    !record(value.result)
  ) {
    throw new Error("Legal PDF engine returned an invalid document result");
  }
  return value as LegalPdfDocumentResult;
}

export async function runLegalPdfDocument<Result = Record<string, unknown>>(
  request: LegalPdfDocumentRequest,
  options: { timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<LegalPdfDocumentResult<Result>> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "mike-legalpdf-contract-"));
  const input = path.join(temporary, "request.json");
  try {
    const wireRequest = {
      ...request,
      schema_version: LEGAL_PDF_REQUEST_SCHEMA,
      source_pdf: path.resolve(request.source_pdf),
      ...("cache_dir" in request && request.cache_dir
        ? { cache_dir: path.resolve(request.cache_dir) }
        : {}),
    };
    const encoded = JSON.stringify(wireRequest);
    if (Buffer.byteLength(encoded) > 64 * 1024) {
      throw new Error("Legal PDF document request is too large");
    }
    await writeFile(input, encoded, { signal: options.signal });
    const root = engineRoot();
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        legalPdfBinary({ engineRoot: root }),
        ["contract", input],
        {
          cwd: root,
          env: process.env,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          timeout: options.timeoutMs ?? 11 * 60 * 1000,
          signal: options.signal,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
    });
    let response: unknown;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw new Error("Legal PDF engine returned invalid JSON");
    }
    return validateResponse(response, request.operation) as LegalPdfDocumentResult<Result>;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
