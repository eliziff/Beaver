import { existsSync } from "node:fs";
import path from "node:path";

import {
  validateStructureGraph,
  type StructureEvidenceV1,
  type StructureGraphV2,
} from "./structureWire";
import { tokenizeSourceText, type SourceDoc } from "./sourceDoc";
import type { NativeMarkupSourceInput } from "./sourceDocNativeMarkup";

type StructureAddon = {
  deriveStructures(documents: StructureEvidenceV1[]): unknown[];
  instrumentLineationHypotheses(text: string): unknown;
  deriveInstrumentStructure(
    text: string,
    documents: StructureEvidenceV1[],
    references: InstrumentReferenceEvidence[],
  ): unknown;
  sourceDocs(requests: unknown[]): NativeSourceDoc[];
  sourceDocVersion(): number;
};

export type NativeSourceDoc = {
  document: Omit<SourceDoc, "index" | "tokens" | "text"> & { text?: string };
  index: Array<[string, number]>;
};

let addon: StructureAddon | undefined;

function addonFilename() {
  if (process.platform === "win32") return "legal_structure_node.dll";
  if (process.platform === "darwin") return "liblegal_structure_node.dylib";
  return "liblegal_structure_node.so";
}

function structureNativeBinary() {
  const root = process.env.LEGALPDF_ENGINE_ROOT?.trim() ||
    path.join(__dirname, "../../../legal-pdf-parser");
  return process.env.LEGAL_STRUCTURE_NATIVE?.trim() ||
    path.join(root, "target", "release", addonFilename());
}

function loadAddon() {
  if (addon) return addon;
  const filename = structureNativeBinary();
  if (!existsSync(filename)) {
    throw new Error(`Missing legal structure native module: ${filename}`);
  }
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, filename);
  addon = module.exports as StructureAddon;
  if (typeof addon.deriveStructures !== "function" ||
      typeof addon.instrumentLineationHypotheses !== "function" ||
      typeof addon.deriveInstrumentStructure !== "function" ||
      typeof addon.sourceDocs !== "function" ||
      typeof addon.sourceDocVersion !== "function") {
    throw new Error("Legal structure native module has an invalid API");
  }
  return addon;
}

export function instrumentLineationHypothesesNative(text: string): string[] {
  const values = loadAddon().instrumentLineationHypotheses(text);
  if (!Array.isArray(values) || values.length < 1 || values.length > 4 ||
      values.some((value) => typeof value !== "string" || value.length !== text.length)) {
    throw new Error("Legal structure native module returned invalid instrument lineation hypotheses");
  }
  return values;
}

export type InstrumentReferenceEvidence = {
  key: string;
  start: number;
  end: number;
};

export type InstrumentContentsRefusal =
  | "no_contents_marker"
  | "no_contents_entries"
  | "too_few_contents_entries"
  | "contents_without_page_numbers";

export type InstrumentContentsReading = {
  outline: {
    entries: Array<{
      label: string;
      display: string;
      heading: string;
      depth: number;
      parentLabel?: string;
      page: number | null;
      contentsLineStart: number;
    }>;
    regionStart: number;
    regionEnd: number;
    pagesCited: number;
  } | null;
  refusal: InstrumentContentsRefusal | null;
};

export function deriveInstrumentStructureNative(
  text: string,
  evidence: StructureEvidenceV1[],
  scalarLengths: readonly number[],
  references: InstrumentReferenceEvidence[],
): { selected: number; graph: StructureGraphV2; contents: InstrumentContentsReading } {
  const value = loadAddon().deriveInstrumentStructure(text, evidence, references) as {
    selected?: unknown;
    graph?: unknown;
    contents?: unknown;
  };
  const selected = value?.selected;
  if (!Number.isSafeInteger(selected) || Number(selected) < 0 || Number(selected) >= evidence.length) {
    throw new Error("Legal structure native module returned an invalid instrument selection");
  }
  const index = Number(selected);
  const contents = value.contents as InstrumentContentsReading;
  if (!contents || typeof contents !== "object" ||
      (contents.outline === null) === (contents.refusal === null)) {
    throw new Error(
      `Legal structure native module returned invalid instrument contents: ${String(JSON.stringify(value.contents)).slice(0, 500)}`,
    );
  }
  return {
    selected: index,
    graph: validateStructureGraph(value.graph, {
      id: evidence[index].document_id,
      textHash: evidence[index].text_sha256,
      sourceHash: evidence[index].source_sha256,
      scalarLength: scalarLengths[index],
    }),
    contents,
  };
}

export function sourceDocEngineVersion() {
  return loadAddon().sourceDocVersion();
}

export type A2ajNativeInput = {
  citation: string;
  source_kind: "cases" | "laws";
  text: string;
  id?: string;
  url?: string | null;
  dataset?: string | null;
  name?: string | null;
  alternate_citation?: string | null;
  section_map?: Array<[string, string]>;
  excerpt_of?: string;
};

export type JournalPageRow = { page_label: unknown; pdf_page: unknown };

export function hydrateSourceDoc(raw: NativeSourceDoc, text?: string): SourceDoc {
  const source = raw.document;
  const value = source.text ?? text;
  if (value === undefined) throw new Error("Legal structure native module omitted SourceDoc text");
  const document = { provider: source.provider, id: source.id, url: source.url,
    revision: source.revision, docType: source.docType, status: source.status,
    text: value, blocks: source.blocks, index: new Map(raw.index), ranges: source.ranges,
  } as SourceDoc;
  let tokens: SourceDoc["tokens"] | null = null;
  Object.defineProperty(document, "tokens", { enumerable: false, configurable: false,
    get: () => tokens ??= tokenizeSourceText(document.text) });
  return document;
}

export function a2ajSourceDocNative(input: A2ajNativeInput) {
  return sourceDocsNative([{ kind: "a2aj", input }])[0];
}

export function journalSourceDocNative(
  articleId: number, url: string | null, filename: string,
  pageRows: JournalPageRow[],
) {
  return sourceDocsNative([{ kind: "journal", article_id: articleId, url, filename,
    page_rows: pageRows }])[0];
}

export function journalTextSourceDocNative(
  articleId: number, url: string | null, text: string,
  pageRows: JournalPageRow[],
) {
  return sourceDocsNative([{ kind: "journal", article_id: articleId, url, text,
    page_rows: pageRows }])[0];
}

export function nativeMarkupSourceDocNative(input: NativeMarkupSourceInput) {
  return sourceDocsNative([{ kind: "native_markup", input }])[0];
}

type SourceDocNativeRequest =
  | { kind: "a2aj"; input: A2ajNativeInput; source_id?: string }
  | { kind: "journal"; article_id: number; url: string | null; filename: string;
      page_rows: JournalPageRow[] }
  | { kind: "journal"; article_id: number; url: string | null; text: string;
      page_rows: JournalPageRow[] }
  | { kind: "native_markup"; input: NativeMarkupSourceInput; source_id?: string };

function sourceDocsNative(requests: SourceDocNativeRequest[]) {
  const values = loadAddon().sourceDocs(requests);
  if (!Array.isArray(values) || values.length !== requests.length) {
    throw new Error("Legal structure native module returned an invalid SourceDoc batch");
  }
  return values.map((value, index) => hydrateSourceDoc(
    value,
    "input" in requests[index] ? requests[index].input.text : undefined,
  ));
}

export function deriveStructureGraphsNative(
  evidence: StructureEvidenceV1[], scalarLengths: readonly number[],
): StructureGraphV2[] {
  const values = loadAddon().deriveStructures(evidence);
  if (!Array.isArray(values) || values.length !== evidence.length) {
    throw new Error("Legal structure native module returned an invalid batch");
  }
  return values.map((value, index) => validateStructureGraph(value, {
    id: evidence[index].document_id,
    textHash: evidence[index].text_sha256,
    sourceHash: evidence[index].source_sha256,
    scalarLength: scalarLengths[index],
  }));
}
