import { draftOutputChoice, outputDocument } from "./host";
import type { CourtRecordsHost, PreparationProgress } from "./host";
import {
  canRetainLocalFiles,
  listStandaloneOutputs,
  pickRetainedFiles,
  readStandaloneOutput,
  relinkLocalFile,
  resolveLocalFile,
  saveStandaloneArtifacts,
  standaloneWorkProducts,
} from "@/app/lib/standaloneWorkProducts";
import { apiBlobRequest } from "@/app/lib/apiTransport";
import { sourceFormat } from "./formats";
import { prepareDeviceFile, prepareDocxRendition } from "./prepareDeviceFile";
import type { CourtRecordDraft } from "./types";

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
  versionId?: string) {
  const saved = await readStandaloneOutput(workProductId, role, versionId);
  const file = new File([saved.bytes], saved.output.filename, { type: saved.output.mimeType });
  return { ...await prepareStandaloneFile(file, progress),
    origin: { kind: "library" as const, documentId: saved.output.documentId,
      versionId: saved.output.versionId, sourceSha256: saved.output.sha256 },
    binding: { kind: "work-product-output" as const, workProductId, role } };
}

export const standaloneCourtRecordsHost: CourtRecordsHost = {
  mode: "standalone",
  drafts: standaloneWorkProducts,
  prepareDeviceFile: prepareStandaloneFile,
  pickDeviceFiles: canRetainLocalFiles() ? pickRetainedFiles : undefined,
  async searchDraftOutputs(query, formats, excludeId) {
    const current = excludeId ? await standaloneWorkProducts.get(excludeId) : null;
    const needle = query.trim().toLowerCase();
    return (await listStandaloneOutputs(excludeId)).flatMap(({ product, role, output }) => {
      const format = sourceFormat({ name: output.filename, type: output.mimeType });
      const matches = !needle || `${product.title} ${role} ${output.filename}`
        .toLowerCase().includes(needle);
      return (!current || product.projectId === current.projectId) &&
        format && formats.includes(format) && matches
        ? [draftOutputChoice(product, role, output)] : [];
    });
  },
  importDraftOutput: (choice, progress) => prepareOutput(choice.workProductId, choice.role,
    progress, choice.output.versionId),
  async resolveInput(input, progress) {
    if (input.kind !== "work-product-output") return resolveLocalFile(input);
    try {
      const prepared = await prepareOutput(input.workProductId, input.role, progress);
      return { status: "ready", file: prepared.file, input, prepared };
    } catch {
      return { status: "missing", reason: "deleted" };
    }
  },
  relinkInput: relinkLocalFile,
  async saveArtifacts({ artifacts, product, receipt }) {
    if (receipt.profile.id !== product.state.profileId ||
        receipt.outputs.length !== artifacts.length) {
      throw new Error("The built files no longer match this court record draft.");
    }
    const saved = await saveStandaloneArtifacts<CourtRecordDraft>(product, artifacts.map((artifact) => {
      const role = artifact.role ?? "record";
      const output = receipt.outputs.find((item) => item.role === role &&
        item.filename === artifact.filename && item.mime_type === artifact.mimeType &&
        item.byte_count === artifact.bytes.byteLength && item.sha256 === artifact.sha256 &&
        item.page_count === (artifact.pageCount ?? null));
      if (!output) throw new Error(`The build receipt does not match ${artifact.filename}.`);
      return { role, filename: artifact.filename, mimeType: artifact.mimeType,
        sha256: artifact.sha256, pageCount: artifact.pageCount ?? null,
        bytes: artifact.bytes, receipt };
    }));
    const outputs = Object.fromEntries(Object.entries(saved.outputs).map(([role, output]) =>
      [role, { documentId: output.documentId, versionId: output.versionId }]));
    return { documents: Object.values(saved.outputs).map((output) => outputDocument(saved, output)),
      outputs, product: saved };
  },
};
