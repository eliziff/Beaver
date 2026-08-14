import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LEGAL_PDF_DOCUMENT_SCHEMA = "legalpdf.document.v2";
export const LEGAL_PDF_PARSER_VERSION = "0.3.0";
export type LegalPdfOcrProvider = "kraken-lite" | "tesseract";

type LegalPdfRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  engineRoot?: string;
  exists?: (candidate: string) => boolean;
};

function legalPdfEngineRoot(options?: LegalPdfRuntimeOptions) {
  const env = options?.env ?? process.env;
  return path.resolve(
    options?.engineRoot ||
      env.LEGALPDF_ENGINE_ROOT?.trim() ||
      path.join(__dirname, "../../../universal-legal-pdf-engine"),
  );
}

function nativeLibraryNames(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return ["onnxruntime.dll", "legalpdf_tesseract_layout.dll"] as const;
  }
  const extension = platform === "darwin" ? "dylib" : "so";
  return [
    `libonnxruntime.${extension}`,
    `liblegalpdf_tesseract_layout.${extension}`,
  ] as const;
}

export function configuredLegalPdfOcrProvider(
  options?: LegalPdfRuntimeOptions,
): LegalPdfOcrProvider | null {
  const env = options?.env ?? process.env;
  const value = env.MIKE_PDF_OCR_PROVIDER?.trim();
  if (value) {
    if (value === "kraken-lite" || value === "tesseract") return value;
    throw new Error("MIKE_PDF_OCR_PROVIDER must be kraken-lite or tesseract");
  }
  if (env.NODE_ENV === "test") return null;
  const root = legalPdfEngineRoot({ ...options, env });
  const platform = options?.platform ?? process.platform;
  const [runtime, layout] = nativeLibraryNames(platform);
  const exists = options?.exists ?? existsSync;
  return [
    "runtime/kraken/model.onnx",
    "runtime/kraken/codec.json",
    `runtime/${runtime}`,
    `runtime/${layout}`,
  ].every((candidate) => exists(path.resolve(root, candidate)))
    ? "kraken-lite"
    : null;
}

function configuredPath(
  env: NodeJS.ProcessEnv,
  root: string,
  name: string,
  fallback: string,
  exists: (candidate: string) => boolean,
) {
  const candidate = path.resolve(root, env[name]?.trim() || fallback);
  if (!exists(candidate)) {
    throw new Error(`${name} does not exist: ${candidate}`);
  }
  return candidate;
}

export function legalPdfOcrArguments(
  provider: LegalPdfOcrProvider,
  config: {
    language?: string;
    dpi?: number;
    psm?: number;
    expectedIdentity?: string;
  } = {},
  options?: LegalPdfRuntimeOptions,
) {
  const env = options?.env ?? process.env;
  const root = legalPdfEngineRoot({ ...options, env });
  const exists = options?.exists ?? existsSync;
  const args = ["--ocr-provider", provider];
  if (provider === "tesseract") {
    args.push(
      "--ocr-language",
      config.language || "eng",
      "--ocr-dpi",
      String(config.dpi ?? 180),
      "--ocr-psm",
      String(config.psm ?? 3),
    );
  } else {
    const layout = env.LEGALPDF_KRAKEN_LAYOUT?.trim() || "tesseract";
    if (layout !== "tesseract" && layout !== "blla") {
      throw new Error("LEGALPDF_KRAKEN_LAYOUT must be tesseract or blla");
    }
    const backend = env.LEGALPDF_KRAKEN_BACKEND?.trim() || "cpu";
    if (
      ![
        "cpu",
        "cuda",
        "tensorrt",
        "directml",
        "openvino",
        "onednn",
      ].includes(backend)
    ) {
      throw new Error("Invalid LEGALPDF_KRAKEN_BACKEND");
    }
    const tier = env.LEGALPDF_KRAKEN_TIER?.trim() || "quality";
    if (!["quality", "balanced", "turbo", "extreme"].includes(tier)) {
      throw new Error("Invalid LEGALPDF_KRAKEN_TIER");
    }
    args.push(
      "--ocr-dpi",
      String(config.dpi ?? 180),
      "--kraken-layout",
      layout,
      "--kraken-backend",
      backend,
      "--kraken-tier",
      tier,
    );
    if (layout === "tesseract") {
      const [runtimeName, libraryName] = nativeLibraryNames(
        options?.platform ?? process.platform,
      );
      args.push(
        "--kraken-model",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_MODEL",
          "runtime/kraken/model.onnx",
          exists,
        ),
        "--kraken-codec",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_CODEC",
          "runtime/kraken/codec.json",
          exists,
        ),
        "--onnx-runtime",
        configuredPath(
          env,
          root,
          "LEGALPDF_ONNX_RUNTIME",
          `runtime/${runtimeName}`,
          exists,
        ),
        "--kraken-tesseract-library",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_TESSERACT_LIBRARY",
          `runtime/${libraryName}`,
          exists,
        ),
      );
    } else {
      args.push(
        "--kraken-runtime-wheel",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_RUNTIME_WHEEL",
          "runtime/kraken/runtime.whl",
          exists,
        ),
        "--kraken-blla-pack",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_BLLA_PACK",
          "runtime/kraken/blla",
          exists,
        ),
        "--kraken-recognizer-pack",
        configuredPath(
          env,
          root,
          "LEGALPDF_KRAKEN_RECOGNIZER_PACK",
          "runtime/kraken/recognizer",
          exists,
        ),
      );
      if (env.LEGALPDF_KRAKEN_PYTHON?.trim()) {
        args.push("--kraken-python", env.LEGALPDF_KRAKEN_PYTHON.trim());
      }
    }
    if (env.LEGALPDF_KRAKEN_DEVICE?.trim()) {
      args.push("--kraken-device", env.LEGALPDF_KRAKEN_DEVICE.trim());
    }
    if (env.LEGALPDF_KRAKEN_CPU_FALLBACK === "1") {
      args.push("--kraken-cpu-fallback");
    }
    if (env.LEGALPDF_KRAKEN_LOW_MEMORY === "1") {
      args.push("--kraken-low-memory");
    }
    for (const [name, option] of [
      ["LEGALPDF_KRAKEN_WORKERS", "--kraken-workers"],
      ["LEGALPDF_KRAKEN_THREADS", "--kraken-threads"],
      ["LEGALPDF_KRAKEN_LAYOUT_WORKERS", "--kraken-layout-workers"],
      ["LEGALPDF_KRAKEN_BATCH_SIZE", "--kraken-batch-size"],
      ["LEGALPDF_KRAKEN_WIDTH_BUCKET", "--kraken-width-bucket"],
      ["LEGALPDF_KRAKEN_WIDTH_SCALE", "--kraken-width-scale"],
    ] as const) {
      const value = env[name]?.trim();
      if (value) args.push(option, value);
    }
  }
  if (config.expectedIdentity) {
    args.push("--expected-ocr-identity", config.expectedIdentity);
  }
  return args;
}

export function legalPdfBinary(options?: LegalPdfRuntimeOptions) {
  const env = options?.env ?? process.env;
  const configured = env.LEGALPDF_BINARY?.trim();
  if (configured) return configured;

  const platform = options?.platform ?? process.platform;
  const root = legalPdfEngineRoot({ ...options, env });
  const managed = path.join(
    root,
    "target",
    "release",
    platform === "win32" ? "legalpdf.exe" : "legalpdf",
  );
  if ((options?.exists ?? existsSync)(managed)) return managed;

  return "legalpdf";
}

export async function runLegalPdf(
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal },
) {
  const root = legalPdfEngineRoot();
  return execFileAsync(
    legalPdfBinary({ engineRoot: root }),
    args,
    {
      cwd: root,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: options?.timeoutMs ?? 11 * 60 * 1000,
      signal: options?.signal,
      windowsHide: true,
    },
  );
}
