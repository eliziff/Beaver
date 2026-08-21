import { existsSync } from "node:fs";
import path from "node:path";

import {
  validateStructureGraph,
  type StructureEvidenceV1,
  type StructureGraphV1,
} from "./structureWire";
import { tokenizeSourceText, type SourceDoc, type SourceDocBlock } from "./sourceDoc";
import type { NativeMarkupSourceInput } from "./sourceDocNativeMarkup";

type StructureAddon = {
  deriveStructures(documents: StructureEvidenceV1[]): unknown[];
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

export function structureNativeBinary() {
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
  if (typeof addon.deriveStructures !== "function" || typeof addon.sourceDocs !== "function" ||
      typeof addon.sourceDocVersion !== "function") {
    throw new Error("Legal structure native module has an invalid API");
  }
  return addon;
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

export function a2ajSourceDocsNative(inputs: A2ajNativeInput[]) {
  return sourceDocsNative(inputs.map((input) => ({ kind: "a2aj", input })));
}

export function journalSourceDocNative(
  articleId: number, url: string | null, filename: string,
  pageRows: Array<{ page_label: unknown; pdf_page: unknown }>,
) {
  return sourceDocsNative([{ kind: "journal", article_id: articleId, url, filename,
    page_rows: pageRows }])[0];
}

export function journalJsonlSourceDocNative(
  articleId: number, url: string | null, jsonl: string,
  pageRows: Array<{ page_label: unknown; pdf_page: unknown }>,
) {
  return sourceDocsNative([{ kind: "journal", article_id: articleId, url, jsonl,
    page_rows: pageRows }])[0];
}

export function journalTextSourceDocNative(
  articleId: number, url: string | null, text: string,
  pageRows: Array<{ page_label: unknown; pdf_page: unknown }>,
) {
  return sourceDocsNative([{ kind: "journal", article_id: articleId, url, text,
    page_rows: pageRows }])[0];
}

export function nativeMarkupSourceDocNative(input: NativeMarkupSourceInput) {
  return sourceDocsNative([{ kind: "native_markup", input }])[0];
}

export type SourceDocNativeRequest =
  | { kind: "a2aj"; input: A2ajNativeInput; source_id?: string }
  | { kind: "journal"; article_id: number; url: string | null; filename: string;
      page_rows: Array<{ page_label: unknown; pdf_page: unknown }> }
  | { kind: "journal"; article_id: number; url: string | null; jsonl: string;
      page_rows: Array<{ page_label: unknown; pdf_page: unknown }> }
  | { kind: "journal"; article_id: number; url: string | null; text: string;
      page_rows: Array<{ page_label: unknown; pdf_page: unknown }> }
  | { kind: "native_markup"; input: NativeMarkupSourceInput; source_id?: string }
  | { kind: "evidence"; input: StructureEvidenceV1; source_id?: string;
      original_claims?: Record<string, SourceDocBlock>;
      original_claim_orders?: Record<string, string[]> };

export function sourceDocsNative(requests: SourceDocNativeRequest[]) {
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
): StructureGraphV1[] {
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
