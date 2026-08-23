import { existsSync } from "node:fs";
import path from "node:path";

export type LegalPdfOcrProvider = "kraken-lite" | "tesseract";
type LegalPdfProfile = {
  ocr?: { provider: LegalPdfOcrProvider; settings: Record<string, unknown> };
  layout?: { provider: "ppdoc"; settings: Record<string, unknown> };
};
type RuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  engineRoot?: string;
  exists?: (candidate: string) => boolean;
};

function engineRoot(options: RuntimeOptions = {}) {
  const env = options.env ?? process.env;
  return path.resolve(options.engineRoot || env.LEGALPDF_ENGINE_ROOT?.trim() ||
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
  fallback: string, exists: (candidate: string) => boolean) {
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

function configuredLegalPdfOcrProvider(options: RuntimeOptions = {}): LegalPdfOcrProvider | null {
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
  return ["runtime/kraken/model.onnx", "runtime/kraken/codec.json",
    `runtime/${runtime}`, `runtime/${layout}`]
    .every((candidate) => exists(path.resolve(root, candidate))) ? "kraken-lite" : null;
}

export function configuredLegalPdfProfile(options: RuntimeOptions = {}): LegalPdfProfile {
  const env = options.env ?? process.env;
  const root = engineRoot({ ...options, env });
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const profile: LegalPdfProfile = {};
  const ocr = configuredLegalPdfOcrProvider({ ...options, env });
  if (ocr === "tesseract") {
    profile.ocr = { provider: ocr, settings: {
      language: env.LEGALPDF_OCR_LANGUAGE?.trim() || "eng",
      dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
      psm: numericSetting(env, "LEGALPDF_OCR_PSM") ?? 3,
    } };
  } else if (ocr === "kraken-lite") {
    const layout = env.LEGALPDF_KRAKEN_LAYOUT?.trim() || "tesseract";
    if (layout !== "tesseract" && layout !== "blla")
      throw new Error("LEGALPDF_KRAKEN_LAYOUT must be tesseract or blla");
    const [runtime, tesseractLibrary] = nativeLibraryNames(platform);
    profile.ocr = { provider: ocr, settings: {
      dpi: numericSetting(env, "LEGALPDF_OCR_DPI") ?? 180,
      layout,
      backend: env.LEGALPDF_KRAKEN_BACKEND?.trim() || "cpu",
      tier: env.LEGALPDF_KRAKEN_TIER?.trim() || "quality",
      ...(layout === "tesseract" ? {
        model: configuredPath(env, root, "LEGALPDF_KRAKEN_MODEL", "runtime/kraken/model.onnx", exists),
        codec: configuredPath(env, root, "LEGALPDF_KRAKEN_CODEC", "runtime/kraken/codec.json", exists),
        runtime: configuredPath(env, root, "LEGALPDF_ONNX_RUNTIME", `runtime/${runtime}`, exists),
        tesseract_library: configuredPath(env, root, "LEGALPDF_KRAKEN_TESSERACT_LIBRARY", `runtime/${tesseractLibrary}`, exists),
      } : {
        runtime_wheel: configuredPath(env, root, "LEGALPDF_KRAKEN_RUNTIME_WHEEL", "runtime/kraken/runtime.whl", exists),
        blla_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_BLLA_PACK", "runtime/kraken/blla", exists),
        recognizer_pack: configuredPath(env, root, "LEGALPDF_KRAKEN_RECOGNIZER_PACK", "runtime/kraken/recognizer", exists),
        ...(env.LEGALPDF_KRAKEN_PYTHON?.trim() ? { python: env.LEGALPDF_KRAKEN_PYTHON.trim() } : {}),
      }),
      ...Object.fromEntries([
        ["threads", "LEGALPDF_KRAKEN_THREADS"], ["workers", "LEGALPDF_KRAKEN_WORKERS"],
        ["layout_workers", "LEGALPDF_KRAKEN_LAYOUT_WORKERS"],
        ["batch_size", "LEGALPDF_KRAKEN_BATCH_SIZE"],
        ["width_bucket", "LEGALPDF_KRAKEN_WIDTH_BUCKET"],
        ["width_scale", "LEGALPDF_KRAKEN_WIDTH_SCALE"],
      ].flatMap(([field, name]) => {
        const value = numericSetting(env, name);
        return value === undefined ? [] : [[field, value]];
      })),
      ...(env.LEGALPDF_KRAKEN_DEVICE?.trim() ? { device: env.LEGALPDF_KRAKEN_DEVICE.trim() } : {}),
    } };
  }

  const requestedLayout = env.MIKE_PDF_LAYOUT_PROVIDER?.trim();
  if (requestedLayout && requestedLayout !== "none" && requestedLayout !== "ppdoc")
    throw new Error("MIKE_PDF_LAYOUT_PROVIDER must be none or ppdoc");
  const backend = env.LEGALPDF_PPDOC_BACKEND?.trim() || "openvino";
  const modelPack = path.resolve(root,
    env.LEGALPDF_PPDOC_MODEL_PACK?.trim() || "runtime/layout/heron-int8");
  const runtime = path.resolve(root, env.LEGALPDF_PPDOC_RUNTIME?.trim() ||
    `runtime/${backend === "openvino" ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`);
  if (requestedLayout === "ppdoc" || (!requestedLayout &&
      exists(path.join(modelPack, "manifest.json")) && exists(runtime))) {
    profile.layout = { provider: "ppdoc", settings: {
      model_pack: configuredPath(env, root, "LEGALPDF_PPDOC_MODEL_PACK",
        "runtime/layout/heron-int8", (candidate) => exists(path.join(candidate, "manifest.json"))),
      runtime: configuredPath(env, root, "LEGALPDF_PPDOC_RUNTIME",
        `runtime/${backend === "openvino" ? openVinoLibraryName(platform) : nativeLibraryNames(platform)[0]}`,
        exists),
      backend,
      ...Object.fromEntries([
        ["threads", "LEGALPDF_PPDOC_THREADS"], ["threshold", "LEGALPDF_PPDOC_THRESHOLD"],
        ["render_dpi", "LEGALPDF_PPDOC_DPI"],
      ].flatMap(([field, name]) => {
        const value = numericSetting(env, name);
        return value === undefined ? [] : [[field, value]];
      })),
      ...(env.LEGALPDF_PPDOC_DEVICE?.trim() ? { device: env.LEGALPDF_PPDOC_DEVICE.trim() } : {}),
      ...(env.LEGALPDF_PPDOC_CPU_FALLBACK === "1" ? { cpu_fallback: true } : {}),
    } };
  }
  return profile;
}
import type { SourceDoc } from "./sourceDoc";

type StructureAddon = {
  deriveDocumentStructure(request: unknown): Promise<Buffer>;
  derivePdfDocument(request: unknown): Promise<NativePdfDocument>;
  pdfDocumentSnapshot(document: NativePdfDocument): Buffer;
  queryPdfDocument(document: NativePdfDocument, query: unknown): Buffer;
  joinAmendmentLocator(head: string, sub?: string): string;
  parseAmendmentInstructions(text: string): Buffer;
  applyAmendOps(source: string, ops: AmendOp[], reconstructLineation?: boolean): Promise<Buffer>;
  deleteProvisionAndRenumberSiblings(source: string, target: string,
    reconstructLineation?: boolean): Promise<Buffer>;
  consolidateAmendment(source: string, amendment: string,
    reconstructLineation?: boolean): Promise<Buffer>;
};

export type NativePdfDocument = object;
export type AmendOpKind = "strike_text" | "insert_text" | "substitute_text" |
  "append_text" | "strike_provision" | "replace_provision" | "add_provision" |
  "add_at_end" | "repeal_provision" | "redesignate";
export type AmendOp = {
  kind: AmendOpKind;
  target: string;
  oldText?: string;
  newText?: string;
  position?: "after" | "before";
  anchorText?: string;
  afterChild?: string;
  newLabel?: string;
  everyOccurrence?: boolean;
  anchorLast?: boolean;
  wholeWord?: boolean;
  raw: string;
};
export type AmendParseResult = {
  ops: AmendOp[];
  unparsed: Array<{ excerpt: string; reason: string }>;
};
export type AmendReceipt = {
  op: AmendOp;
  start: number;
  end: number;
  removed: string;
  inserted: string;
  occurrences?: number;
};
export type AmendFailure = {
  op: AmendOp;
  code: "target_not_found" | "old_text_not_found" | "old_text_ambiguous" |
    "anchor_not_found" | "anchor_ambiguous" | "missing_new_text" |
    "overlapping_ops" | "unsupported_apply";
  detail: string;
};
export type ApplyAmendmentsResult = {
  text: string;
  applied: AmendReceipt[];
  failures: AmendFailure[];
  verification: {
    newTextPresent: number;
    newTextMissing: number;
    oldTextGone: number;
    oldTextLingers: number;
    ladderViolationsBefore: number;
    ladderViolationsAfter: number;
  };
};
export type ApplyAmendOptions = { reconstructLineation?: boolean };
export type DeleteAndRenumberFailureCode = "target_not_found" | "target_ambiguous" |
  "unsupported_target" | "sibling_ambiguous" | "sibling_sequence_unsupported" |
  "heading_not_found" | "reference_to_deleted_target" | "unresolved_reference" |
  "ambiguous_reference" | "external_reference" | "overlapping_ops" |
  "verification_failed";
export type DeleteAndRenumberFailure = {
  code: DeleteAndRenumberFailureCode;
  detail: string;
  start?: number;
  end?: number;
};
export type DeleteAndRenumberReceipt = {
  kind: "delete_provision" | "renumber_heading" | "update_cross_reference";
  start: number;
  end: number;
  removed: string;
  inserted: string;
  from: string;
  to: string | null;
};
export type DeleteAndRenumberResult = {
  text: string;
  mapping: Array<{ from: string; to: string }>;
  applied: DeleteAndRenumberReceipt[];
  failures: DeleteAndRenumberFailure[];
  verification: { headingsRenumbered: number; referencesUpdated: number };
};

let addon: StructureAddon | undefined;

function addonFilename() {
  if (process.platform === "win32") return "legal_structure_node.dll";
  if (process.platform === "darwin") return "liblegal_structure_node.dylib";
  return "liblegal_structure_node.so";
}

function loadAddon() {
  if (addon) return addon;
  const root = engineRoot();
  const filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() ||
    path.join(root, "target", "release", addonFilename());
  if (!existsSync(filename)) {
    throw new Error(`Missing legal structure native module: ${filename}`);
  }
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, filename);
  addon = module.exports as StructureAddon;
  if (typeof addon.deriveDocumentStructure !== "function" ||
      typeof addon.derivePdfDocument !== "function" ||
      typeof addon.pdfDocumentSnapshot !== "function" ||
      typeof addon.queryPdfDocument !== "function") {
    throw new Error("Legal structure native module has an invalid API");
  }
  return addon;
}

export async function analyzeDocumentNative<Structure = unknown>(
  request: { source_doc: true } & Record<string, unknown>,
): Promise<{ structure: Structure; source_doc: SourceDoc }>;
export async function analyzeDocumentNative<Structure = unknown>(
  request: unknown,
): Promise<{ structure: Structure; source_doc?: SourceDoc }>;
export async function analyzeDocumentNative<Structure = unknown>(
  request: unknown,
) {
  const bytes = await loadAddon().deriveDocumentStructure(request);
  const result = JSON.parse(bytes.toString("utf8")) as {
    structure: Structure;
    source_doc?: SourceDoc;
  };
  return result;
}

export async function analyzePdfNative<T>(request: unknown) {
  const native = await loadAddon().derivePdfDocument(request);
  const snapshot = loadAddon().pdfDocumentSnapshot(native);
  return { native, result: JSON.parse(snapshot.toString("utf8")) as T };
}

export async function queryPdfNative<T>(document: NativePdfDocument, query: unknown): Promise<T> {
  const bytes = loadAddon().queryPdfDocument(document, query);
  return JSON.parse(bytes.toString("utf8")) as T;
}
export const joinLocator = (head: string, sub?: string) =>
  loadAddon().joinAmendmentLocator(head, sub);
const amendmentParsed = <T>(bytes: Buffer) => JSON.parse(bytes.toString("utf8")) as T;
export const parseAmendmentInstructions = (text: string) =>
  amendmentParsed<AmendParseResult>(loadAddon().parseAmendmentInstructions(text));
export async function applyAmendOps(source: string, ops: AmendOp[],
  options: ApplyAmendOptions = {}) {
  return amendmentParsed<ApplyAmendmentsResult>(await loadAddon().applyAmendOps(
    source, ops, options.reconstructLineation));
}
export async function deleteProvisionAndRenumberSiblings(source: string, target: string,
  options: ApplyAmendOptions = {}) {
  return amendmentParsed<DeleteAndRenumberResult>(
    await loadAddon().deleteProvisionAndRenumberSiblings(
      source, target, options.reconstructLineation));
}
export async function consolidateAmendment(source: string, amendment: string,
  options: ApplyAmendOptions = {}) {
  return amendmentParsed<ApplyAmendmentsResult & { parse: AmendParseResult }>(
    await loadAddon().consolidateAmendment(
      source, amendment, options.reconstructLineation));
}
