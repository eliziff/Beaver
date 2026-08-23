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

function pdfEngineRoot(options: RuntimeOptions = {}) {
  const env = options.env ?? process.env;
  return path.resolve(options.engineRoot || env.LEGALPDF_ENGINE_ROOT?.trim() ||
    path.join(__dirname, "../../../legal-pdf-parser"));
}

function structureAddonRoot() {
  return path.resolve(__dirname, "../../../native/legal-structure-node");
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
  const root = pdfEngineRoot({ ...options, env });
  const exists = options.exists ?? existsSync;
  const [runtime, layout] = nativeLibraryNames(options.platform ?? process.platform);
  return ["runtime/kraken/model.onnx", "runtime/kraken/codec.json",
    `runtime/${runtime}`, `runtime/${layout}`]
    .every((candidate) => exists(path.resolve(root, candidate))) ? "kraken-lite" : null;
}

export function configuredLegalPdfProfile(options: RuntimeOptions = {}): LegalPdfProfile {
  const env = options.env ?? process.env;
  const root = pdfEngineRoot({ ...options, env });
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
  fixDocxSupraCrossReferences(bytes: Buffer): Promise<DocxSupraCleanupResult>;
  hasDocxSupraReferences(bytes: Buffer): Promise<boolean>;
  derivePdfDocument(request: unknown): Promise<NativeDocument>;
  pdfPageCount(bytes: Buffer): Promise<number>;
  pdfDocumentSummary(document: NativeDocument): unknown;
  docxStructureLint(document: NativeDocument): NativeDocxLintReport;
  documentText(document: NativeDocument, limit?: number): string;
  documentTextBytes(document: NativeDocument): number;
  documentRevision(document: NativeDocument): string;
  normalizeDocumentLocator(kind: string, locator: string): string;
  citationLookupKey(text: string): string;
  providerCitationsInText(text: string): Array<{
    text: string; start: number; end: number;
    family: "neutral" | "reporter" | "statute";
    jurisdiction?: "ca" | "uk" | "us";
    year?: string; court?: string; number?: string;
    volume?: string; reporter?: string; page?: string;
  }>;
  caselawCitationLookupKey(text: string): string;
  hasCitationInText(text: string): boolean;
  classifyCitatorExcerpt(text: string): {
    kind: "prose" | "mixed" | "authority_list" | "insufficient";
    citeTokens: number; citeRuns: number; citeCharCoverage: number;
    functionWords: number; proseWindow: string | null; rule: string;
  };
  groundedProseErrors(text: string, citedEvidenceIds: readonly string[],
    visibleEvidence: unknown): string[];
  quoteRepairSuggestion(claim: string, spans: string[]): string | null;
  readDocumentRange(document: NativeDocument, kind: string, from: string,
    to: string, contextBlocks: number): NativeDocumentRange | null;
  smallestContainingDocumentBlock(document: NativeDocument, start: number,
    end: number): NativeDocumentBlock | null;
  documentHasOrigin(document: NativeDocument, origin: string): boolean;
  documentAnchors(document: NativeDocument, end?: number): Array<Pick<NativeDocumentBlock,
    "kind" | "label" | "start" | "end" | "parentLabel">>;
  textFragmentDirectives(blockText: string, quotes: string[], pageScoped: boolean,
    documentText?: string, document?: NativeDocument): string[];
  documentParagraphRangeDirective(document: NativeDocument, start: string,
    end: string): string | null;
  documentPageMap(document: NativeDocument): NativePageMap;
  resolveDocumentPage(document: NativeDocument, requested: string): NativePageLookup;
  lookupStructureBlock(document: NativeDocument, locator: string,
    contextBlocks: number): NativeDocumentLookup;
  parseDocumentAddress(spec: string): NativeDocumentAddress | null;
  graphScope(document: NativeDocument, seed: string, follow: string,
    depth: number, includeDescendants: boolean, includeUnits: boolean): NativeGraphScope | null;
  queryPdfDocument(document: NativeDocument, query: unknown): unknown;
  deleteProvisionAndRenumberSiblings(document: NativeDocument, target: string,
    reconstructLineation?: boolean): Promise<DeleteAndRenumberResult>;
};

export type NativeDocument = object;

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

type DocxSupraCleanupResult = {
  bytes: Buffer;
  detected: number;
  converted: number;
  already_linked: number;
  review_required: number;
  bookmarks_added: number;
  reasons: {
    restarted_numbering: boolean;
    unsafe_or_split_fields: number;
  };
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

type NativeDocumentRange = {
  selected: NativeDocumentBlock[];
  before: NativeDocumentBlock[];
  after: NativeDocumentBlock[];
};

type NativeDocumentLookup = {
  status: "found" | "not_found" | "unavailable" | "ambiguous";
  requestedLabel: string;
  matches: string[];
  block: NativeDocumentBlock | null;
  before: NativeDocumentBlock[];
  after: NativeDocumentBlock[];
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
  failures: Array<{
    code: "target_not_found" | "target_ambiguous" | "unsupported_target" |
      "sibling_ambiguous" | "sibling_sequence_unsupported" | "heading_not_found" |
      "reference_to_deleted_target" | "unresolved_reference" | "ambiguous_reference" |
      "external_reference" | "overlapping_ops" | "verification_failed";
    detail: string;
    start?: number;
    end?: number;
  }>;
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
  const root = structureAddonRoot();
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
export const fixDocxSupraCrossReferencesNative = (bytes: Buffer) =>
  loadAddon().fixDocxSupraCrossReferences(bytes);
export const hasDocxSupraReferencesNative = (bytes: Buffer) =>
  loadAddon().hasDocxSupraReferences(bytes);
export const derivePdfNative = (request: unknown) => loadAddon().derivePdfDocument(request);
export const pdfPageCountNative = (bytes: Buffer) => loadAddon().pdfPageCount(bytes);

export function queryPdfNative<T>(document: NativeDocument, query: unknown): T {
  return loadAddon().queryPdfDocument(document, query) as T;
}

export const pdfDocumentSummaryNative = <T = unknown>(document: NativeDocument) =>
  loadAddon().pdfDocumentSummary(document) as T;
export const docxStructureLintNative = (document: NativeDocument) =>
  loadAddon().docxStructureLint(document);

export const documentTextNative = (document: NativeDocument, limit?: number) =>
  loadAddon().documentText(document, limit);
export const documentTextBytesNative = (document: NativeDocument) =>
  loadAddon().documentTextBytes(document);

export const documentRevisionNative = (document: NativeDocument) =>
  loadAddon().documentRevision(document);

export const normalizeDocumentLocatorNative = (kind: "paragraph" | "page" |
  "section" | "footnote", locator: string) =>
  loadAddon().normalizeDocumentLocator(kind, locator);

export const readDocumentRangeNative = (document: NativeDocument,
  kind: "paragraph" | "page" | "section" | "footnote", from: string,
  to: string, contextBlocks = 0) =>
  loadAddon().readDocumentRange(document, kind, from, to, contextBlocks);

export const smallestContainingDocumentBlockNative = (document: NativeDocument,
  start: number, end: number) =>
  loadAddon().smallestContainingDocumentBlock(document, start, end);

export const documentHasOriginNative = (document: NativeDocument,
  origin: "native" | "heuristic") => loadAddon().documentHasOrigin(document, origin);

export const documentAnchorsNative = (document: NativeDocument, end?: number) =>
  loadAddon().documentAnchors(document, end);

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
  nodes: Array<NativeDocumentBlock & { units?: NativeDocumentBlock[] }>;
  depth: number;
};

export const citationLookupKeyNative = (text: string) =>
  loadAddon().citationLookupKey(text);
export const providerCitationsInTextNative = (text: string) =>
  loadAddon().providerCitationsInText(text);
export const caselawCitationLookupKeyNative = (text: string) =>
  loadAddon().caselawCitationLookupKey(text);
export const hasCitationInTextNative = (text: string) =>
  loadAddon().hasCitationInText(text);
export const classifyCitatorExcerptNative = (text: string) =>
  loadAddon().classifyCitatorExcerpt(text);
export const groundedProseErrorsNative = (text: string,
  citedEvidenceIds: readonly string[], visibleEvidence: ReadonlyArray<{
    evidenceId: string; text: string; labels?: string[];
  }>) => loadAddon().groundedProseErrors(text, citedEvidenceIds, visibleEvidence);
export const quoteRepairSuggestionNative = (claim: string, spans: string[]) =>
  loadAddon().quoteRepairSuggestion(claim, spans);
export const textFragmentDirectivesNative = (blockText: string, quotes: string[],
  document?: string | NativeDocument, pageScoped = false) =>
  loadAddon().textFragmentDirectives(blockText, quotes, pageScoped,
    typeof document === "string" ? document : undefined,
    typeof document === "string" ? undefined : document);
export const paragraphRangeDirectiveNative = (document: NativeDocument,
  start: string, end: string) =>
  loadAddon().documentParagraphRangeDirective(document, start, end);
export const documentPageMapNative = (document: NativeDocument) =>
  loadAddon().documentPageMap(document);
export const resolveDocumentPageNative = (document: NativeDocument, requested: string) =>
  loadAddon().resolveDocumentPage(document, requested);
export const lookupStructureBlockNative = (document: NativeDocument, locator: string,
  contextBlocks = 0) => loadAddon().lookupStructureBlock(document, locator, contextBlocks);
export const parseDocumentAddressNative = (spec: string) =>
  loadAddon().parseDocumentAddress(spec);
export const graphScopeNative = (document: NativeDocument, seed: string,
  follow: "none" | "out" | "in" | "both" = "none", depth = 1,
  includeDescendants = false, includeUnits = false) =>
  loadAddon().graphScope(document, seed, follow, depth, includeDescendants, includeUnits);
export function deleteProvisionAndRenumberSiblings(document: NativeDocument, target: string,
  options: { reconstructLineation?: boolean } = {}) {
  return loadAddon().deleteProvisionAndRenumberSiblings(
    document, target, options.reconstructLineation);
}
