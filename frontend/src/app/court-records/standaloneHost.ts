import { draftOutputChoice, filingContactCover, mergeFilingContact,
  outputDocument } from "./host";
import type { CourtRecordsHost, PreparationProgress } from "./host";
import {
  bindStandaloneFile,
  canRetainLocalFiles,
  chooseStandaloneOutputFolder,
  clearStandaloneOutputFolder,
  getStandaloneFilingContact,
  getStandaloneOutputFolder,
  listStandaloneOutputs,
  pickRetainedFiles,
  readStandaloneOutput,
  relinkStandaloneFile,
  resolveStandaloneFile,
  saveStandaloneArtifacts,
  setStandaloneFilingContact,
  standaloneWorkProducts,
  writeStandaloneArtifactsToOutputFolder,
} from "@/app/lib/standaloneWorkProducts";
import { apiBlobRequest, apiRequest } from "@/app/lib/apiTransport";
import { acceptedSourceFormats, sourceFormat } from "./formats";
import { prepareDeviceFile, prepareDocxRendition } from "./prepareDeviceFile";
import { sourceDocumentFields } from "./sourceFields";
import type { CourtRecordDraft, DocumentKind } from "./types";
import { acceptsWorkProductOutput } from "../../../../shared/court-record-work-products.mjs";

type PdfPreparation = { page_count: number; ocr_pages: number[];
  pages: Array<{ page_number: number; text: string }> };
async function prepareStandaloneFile(file: File, progress?: PreparationProgress) {
  if (sourceFormat(file) !== "docx") return prepareDeviceFile(file, progress);
  progress?.(`Preparing ${file.name}`);
  const body = new FormData(); body.append("file", file);
  const { blob } = await apiBlobRequest("/court-records/docx-rendition", {
    method: "POST", headers: { Accept: "application/pdf" }, body,
  });
  return prepareDocxRendition(file, blob, progress);
}

async function prepareOutput(workProductId: string, role: string, progress?: PreparationProgress,
  versionId?: string, destination?: DocumentKind) {
  const saved = await readStandaloneOutput(workProductId, role, versionId);
  if (!destination || !acceptsWorkProductOutput(destination,
      draftOutputChoice(saved.product, role, saved.output))) {
    throw new Error("This saved output cannot be added to this document slot.");
  }
  if (saved.stale && versionId) {
    throw new Error(`Rebuild ${saved.product.title} before adding its output.`);
  }
  const file = new File([saved.bytes], saved.output.filename, { type: saved.output.mimeType });
  return { ...await prepareStandaloneFile(file, progress),
    origin: { kind: "library" as const, documentId: saved.output.documentId,
      versionId: saved.output.versionId, sourceSha256: saved.output.sha256 },
    binding: { kind: "work-product-output" as const, workProductId, role },
    stale: saved.stale };
}

export const standaloneCourtRecordsHost: CourtRecordsHost = {
  mode: "standalone",
  drafts: standaloneWorkProducts,
  async newDraftCover() {
    try { return filingContactCover(await getStandaloneFilingContact()); }
    catch { return {}; }
  },
  async saveFilingContact(cover) {
    const current = await getStandaloneFilingContact();
    await setStandaloneFilingContact(mergeFilingContact(current, cover));
  },
  async prepareDeviceFile(file, progress) {
    return { ...await prepareStandaloneFile(file, progress),
      binding: await bindStandaloneFile(file) };
  },
  async runOcr(entry, progress) {
    const pages = [...new Set(entry.textlessPages ?? [])].sort((left, right) => left - right);
    if (!pages.length) return {};
    progress?.("Running OCR");
    const file = entry.pdfRendition ?? entry.file;
    const body = new FormData(); body.append("file", file, file.name);
    body.append("pages", JSON.stringify(pages));
    const prepared = await apiRequest<PdfPreparation>("/court-records/pdf-preparation", {
      method: "POST", body,
    });
    const text = new Map(prepared.pages.map((page) => [page.page_number, page.text]));
    const ocrTextByPage = Array.from({ length: prepared.page_count }, (_, index) =>
      pages.includes(index + 1) ? text.get(index + 1) ?? "" : entry.ocrTextByPage?.[index] ?? "");
    const missing = pages.filter((page) => !ocrTextByPage[page - 1]?.trim());
    progress?.(missing.length ? "OCR needs attention" : "OCR complete",
      pages.length - missing.length, pages.length);
    return { pageCount: prepared.page_count, ocrTextByPage,
      ocrAttemptedPages: pages,
      searchable: !missing.length, textlessPageCount: missing.length, textlessPages: missing,
      sourceFields: sourceDocumentFields(prepared.pages.map((page) => page.text)) };
  },
  pickDeviceFiles: canRetainLocalFiles() ? pickRetainedFiles : undefined,
  async searchDraftOutputs(query, destination, excludeId) {
    const current = excludeId ? await standaloneWorkProducts.get(excludeId) : null;
    const formats = acceptedSourceFormats(destination);
    const needle = query.trim().toLowerCase();
    return (await listStandaloneOutputs(excludeId)).flatMap(({ product, role, output }) => {
      const format = sourceFormat({ name: output.filename, type: output.mimeType });
      const matches = !needle || `${product.title} ${role} ${output.filename}`
        .toLowerCase().includes(needle);
      const choice = draftOutputChoice(product, role, output);
      return (!current || product.projectId === current.projectId) &&
        format && formats.includes(format) && matches &&
        acceptsWorkProductOutput(destination, choice) ? [choice] : [];
    });
  },
  importDraftOutput: (choice, destination, progress) => prepareOutput(choice.workProductId,
    choice.role, progress, choice.output.versionId, destination),
  async resolveInput(input, progress, destination) {
    if (input.kind !== "work-product-output") return resolveStandaloneFile(input, true);
    if (!destination) return { status: "missing", reason: "unavailable" };
    try {
      const prepared = await prepareOutput(input.workProductId, input.role, progress,
        undefined, destination);
      return { status: prepared.stale ? "stale" : "ready", file: prepared.file, input, prepared };
    } catch (error) {
      return { status: "missing", reason: error instanceof Error &&
        error.message === "This saved output cannot be added to this document slot."
        ? "unavailable" : "deleted" };
    }
  },
  relinkInput: relinkStandaloneFile,
  async saveArtifacts({ artifacts, product, receipt }) {
    if (receipt.profile.id !== product.state.profileId ||
        receipt.outputs.length !== artifacts.length) {
      throw new Error("The built files no longer match this court record draft.");
    }
    const stored = artifacts.map((artifact) => {
      const role = artifact.role ?? "record";
      const output = receipt.outputs.find((item) => item.role === role &&
        item.filename === artifact.filename && item.mime_type === artifact.mimeType &&
        item.byte_count === artifact.bytes.byteLength && item.sha256 === artifact.sha256 &&
        item.page_count === (artifact.pageCount ?? null));
      if (!output) throw new Error(`The build receipt does not match ${artifact.filename}.`);
      return { role, filename: artifact.filename, mimeType: artifact.mimeType,
        sha256: artifact.sha256, pageCount: artifact.pageCount ?? null,
        bytes: artifact.bytes, receipt };
    });
    const saved = await saveStandaloneArtifacts<CourtRecordDraft>(product, stored);
    let notice: string | null;
    try { notice = await writeStandaloneArtifactsToOutputFolder(stored); }
    catch { notice = "Built files are ready to download; the output folder could not be used."; }
    const outputs = Object.fromEntries(Object.entries(saved.outputs).map(([role, output]) =>
      [role, { documentId: output.documentId, versionId: output.versionId }]));
    return { documents: Object.values(saved.outputs).map((output) => outputDocument(saved, output)),
      outputs, product: saved, ...(notice ? { notice } : {}) };
  },
  outputFolder: {
    get: getStandaloneOutputFolder,
    choose: chooseStandaloneOutputFolder,
    clear: clearStandaloneOutputFolder,
  },
};
