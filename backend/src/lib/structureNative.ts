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
type StructureAddon = {
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  deriveDocxDocument(bytes: Buffer, id: string): Promise<NativeDocument>;
  derivePdfDocument(request: unknown): Promise<NativeDocument>;
  pdfDocumentSummary(document: NativeDocument): Buffer;
  documentCitedAuthorities(document: NativeDocument): Buffer;
  docxStructureLint(document: NativeDocument): Buffer;
  docxTableCells(document: NativeDocument): Buffer;
  sourceDocText(document: NativeDocument): string;
  sourceDocTextBytes(document: NativeDocument): number;
  sourceDocRevision(document: NativeDocument): string;
  normalizeSourceDocLocator(kind: string, locator: string): string;
  tokenizeSourceText(text: string): Buffer;
  sourceDocQuoteText(text: string): string;
  sourceDocQuoteWords(text: string): string[];
  sourceDocTokens(document: NativeDocument): Buffer;
  lookupSourceDoc(document: NativeDocument, kind: string, locator: string,
    contextBlocks: number): Buffer;
  readSourceDocRange(document: NativeDocument, kind: string, from: string,
    to: string, contextBlocks: number): Buffer;
  sourceDocContainedLeafUnits(document: NativeDocument, kind: string,
    start: number, end: number): Buffer;
  sourceDocSmallestContainingBlock(document: NativeDocument, start: number,
    end: number): Buffer;
  sourceDocHasOrigin(document: NativeDocument, origin: string): boolean;
  sourceDocAnchors(document: NativeDocument): Buffer;
  sourceDocPhraseSpans(document: NativeDocument, words: string[], start?: number,
    end?: number, sameLine?: boolean, limit?: number): Buffer;
  textPhraseSpans(text: string, words: string[], start?: number,
    end?: number, sameLine?: boolean, limit?: number): Buffer;
  sourceDocPageMap(document: NativeDocument): Buffer;
  resolveSourceDocPage(document: NativeDocument, requested: string): Buffer;
  lookupStructureBlock(document: NativeDocument, locator: string,
    contextBlocks: number): Buffer;
  parseDocumentAddress(spec: string): Buffer;
  graphScope(document: NativeDocument, seed: string, follow: string,
    depth: number, includeDescendants: boolean): Buffer;
  queryPdfDocument(document: NativeDocument, query: unknown): Buffer;
  deleteProvisionAndRenumberSiblings(source: string, target: string,
    reconstructLineation?: boolean): Promise<Buffer>;
  consolidateAmendment(source: string, amendment: string,
    reconstructLineation?: boolean): Promise<Buffer>;
};

export type NativeDocument = object;

export type NativeTableCell = {
  table: number;
  tableName?: string;
  row: number;
  column: number;
  rowSpan?: number;
  columnSpan?: number;
  address?: string;
  start: number;
  end: number;
};

type NativeDocxLintReport = {
  paragraphs: number;
  checks: {
    cross_references: { references: number; resolved: number; skipped_external: number };
    attachments: { references: number; resolved: number };
    numbering: { anchors: number };
    defined_terms: { definitions: number };
  };
  findings: Array<{
    code: "cross_reference_missing" | "attachment_reference_missing" |
      "numbering_gap" | "numbering_duplicate" | "defined_term_duplicate" |
      "defined_term_unused";
    severity: "error" | "warning";
    subject: string;
    message: string;
    paragraph_index: number;
    excerpt: string;
  }>;
  notes: string[];
};

export type NativeDocumentBlock = {
  kind: "paragraph" | "page" | "section" | "footnote" | "table" | "row" | "cell";
  label: string;
  start: number;
  end: number;
  origin: "native" | "heuristic";
  text: string;
  anchor?: string;
  aliases?: string[];
  parentLabel?: string;
};

type NativeDocumentLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  requestedLabel: string;
  matches: string[];
  block: NativeDocumentBlock | null;
  before: NativeDocumentBlock[];
  after: NativeDocumentBlock[];
};

type AmendOpKind = "strike_text" | "insert_text" | "substitute_text" |
  "append_text" | "strike_provision" | "replace_provision" | "add_provision" |
  "add_at_end" | "repeal_provision" | "redesignate";
type AmendOp = {
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
type AmendParseResult = {
  ops: AmendOp[];
  unparsed: Array<{ excerpt: string; reason: string }>;
};
type AmendReceipt = {
  op: AmendOp;
  start: number;
  end: number;
  removed: string;
  inserted: string;
  occurrences?: number;
};
type AmendFailure = {
  op: AmendOp;
  code: "target_not_found" | "old_text_not_found" | "old_text_ambiguous" |
    "anchor_not_found" | "anchor_ambiguous" | "missing_new_text" |
    "overlapping_ops" | "unsupported_apply";
  detail: string;
};
type ApplyAmendmentsResult = {
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
type ApplyAmendOptions = { reconstructLineation?: boolean };
type DeleteAndRenumberFailureCode = "target_not_found" | "target_ambiguous" |
  "unsupported_target" | "sibling_ambiguous" | "sibling_sequence_unsupported" |
  "heading_not_found" | "reference_to_deleted_target" | "unresolved_reference" |
  "ambiguous_reference" | "external_reference" | "overlapping_ops" |
  "verification_failed";
type DeleteAndRenumberFailure = {
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
type DeleteAndRenumberResult = {
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
  return addon;
}

export const deriveDocumentNative = (request: unknown) =>
  loadAddon().deriveDocumentStructure(request);
export const deriveDocxNative = (bytes: Buffer, id: string) =>
  loadAddon().deriveDocxDocument(bytes, id);
export const derivePdfNative = (request: unknown) => loadAddon().derivePdfDocument(request);

export function queryPdfNative<T>(document: NativeDocument, query: unknown): T {
  return parsed<T>(loadAddon().queryPdfDocument(document, query));
}

const parsed = <T>(bytes: Buffer) => JSON.parse(bytes.toString("utf8")) as T;

export const pdfDocumentSummaryNative = <T = unknown>(document: NativeDocument) =>
  parsed<T>(loadAddon().pdfDocumentSummary(document));
export const documentCitedAuthoritiesNative = (document: NativeDocument) =>
  parsed<Array<{ citation: string; canonical?: string; type?: string }>>(
    loadAddon().documentCitedAuthorities(document));
export const docxStructureLintNative = (document: NativeDocument) =>
  parsed<NativeDocxLintReport>(loadAddon().docxStructureLint(document));
export const docxTableCellsNative = (document: NativeDocument) =>
  parsed<NativeTableCell[]>(loadAddon().docxTableCells(document));

export const documentTextNative = (document: NativeDocument) =>
  loadAddon().sourceDocText(document);
export const documentTextBytesNative = (document: NativeDocument) =>
  loadAddon().sourceDocTextBytes(document);

export const documentRevisionNative = (document: NativeDocument) =>
  loadAddon().sourceDocRevision(document);

export const normalizeDocumentLocatorNative = (kind: "paragraph" | "page" |
  "section" | "footnote", locator: string) =>
  loadAddon().normalizeSourceDocLocator(kind, locator);

export const lookupDocumentNative = (document: NativeDocument,
  kind: "paragraph" | "page" | "section" | "footnote", locator: string,
  contextBlocks = 0) => parsed<NativeDocumentLookup>(
    loadAddon().lookupSourceDoc(document, kind, locator, contextBlocks));

export const readDocumentRangeNative = (document: NativeDocument,
  kind: "paragraph" | "page" | "section" | "footnote", from: string,
  to: string, contextBlocks = 0) => parsed<{
    selected: NativeDocumentBlock[];
    before: NativeDocumentBlock[];
    after: NativeDocumentBlock[];
  } | null>(loadAddon().readSourceDocRange(document, kind, from, to, contextBlocks));

export const documentLeafUnitsNative = (document: NativeDocument,
  kind: NativeDocumentBlock["kind"], start: number, end: number) =>
  parsed<NativeDocumentBlock[]>(
    loadAddon().sourceDocContainedLeafUnits(document, kind, start, end));

export const smallestContainingDocumentBlockNative = (document: NativeDocument,
  start: number, end: number) => parsed<NativeDocumentBlock | null>(
    loadAddon().sourceDocSmallestContainingBlock(document, start, end));

export const documentHasOriginNative = (document: NativeDocument,
  origin: "native" | "heuristic") => loadAddon().sourceDocHasOrigin(document, origin);

export const documentAnchorsNative = (document: NativeDocument) =>
  parsed<Array<Pick<NativeDocumentBlock,
    "kind" | "label" | "start" | "end" | "parentLabel">>>(
    loadAddon().sourceDocAnchors(document));

export type NativeWordSpan = { word: string; start: number; end: number };
export type NativeQuoteSpan = {
  start: number; end: number; firstWord: number; lastWord: number;
};
export type NativePageMap = {
  pages: Array<{ ordinal: number; pdfPage: number | null;
    printedLabel: string | null; start: number; end: number }>;
  source: "artifact" | "markers" | "unpaginated" | "unindexed";
};
type NativePageLookup =
  | { status: "found"; page: NativePageMap["pages"][number];
      matchedOn: "pdf" | "printed"; text: string }
  | { status: "no_pages" }
  | { status: "not_found"; requested: string; sense: "pdf" | "printed";
      count: number; first: string | null; last: string | null };
type NativeDocumentAddress =
  | { kind: "section"; locator: string }
  | { kind: "page"; spec: string }
  | { kind: "offset"; start: number };
type NativeGraphScope = {
  seed: NativeDocumentBlock;
  nodes: NativeDocumentBlock[];
  depth: number;
};

export const tokenizeTextNative = (text: string) =>
  parsed<NativeWordSpan[]>(loadAddon().tokenizeSourceText(text));
export const quoteTextNative = (text: string) => loadAddon().sourceDocQuoteText(text);
export const quoteWordsNative = (text: string) => loadAddon().sourceDocQuoteWords(text);
export const documentTokensNative = (document: NativeDocument) =>
  parsed<NativeWordSpan[]>(loadAddon().sourceDocTokens(document));
export const documentPhraseSpansNative = (document: NativeDocument, words: string[],
  start?: number, end?: number, sameLine?: boolean, limit?: number) =>
  parsed<NativeQuoteSpan[]>(loadAddon().sourceDocPhraseSpans(
    document, words, start, end, sameLine, limit));
export const textPhraseSpansNative = (text: string, words: string[], start?: number,
  end?: number, sameLine?: boolean, limit?: number) =>
  parsed<NativeQuoteSpan[]>(loadAddon().textPhraseSpans(
    text, words, start, end, sameLine, limit));
export const documentPageMapNative = (document: NativeDocument) =>
  parsed<NativePageMap>(loadAddon().sourceDocPageMap(document));
export const resolveDocumentPageNative = (document: NativeDocument, requested: string) =>
  parsed<NativePageLookup>(loadAddon().resolveSourceDocPage(document, requested));
export const lookupStructureBlockNative = (document: NativeDocument, locator: string,
  contextBlocks = 0) => parsed<NativeDocumentLookup>(
    loadAddon().lookupStructureBlock(document, locator, contextBlocks));
export const parseDocumentAddressNative = (spec: string) =>
  parsed<NativeDocumentAddress | null>(loadAddon().parseDocumentAddress(spec));
export const graphScopeNative = (document: NativeDocument, seed: string,
  follow: "none" | "out" | "in" | "both" = "none", depth = 1,
  includeDescendants = false) => parsed<NativeGraphScope | null>(
    loadAddon().graphScope(document, seed, follow, depth, includeDescendants));
export async function deleteProvisionAndRenumberSiblings(source: string, target: string,
  options: ApplyAmendOptions = {}) {
  return parsed<DeleteAndRenumberResult>(
    await loadAddon().deleteProvisionAndRenumberSiblings(
      source, target, options.reconstructLineation));
}
export async function consolidateAmendment(source: string, amendment: string,
  options: ApplyAmendOptions = {}) {
  return parsed<ApplyAmendmentsResult & { parse: AmendParseResult }>(
    await loadAddon().consolidateAmendment(
      source, amendment, options.reconstructLineation));
}
