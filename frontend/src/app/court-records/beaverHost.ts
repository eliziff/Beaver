import {
  type Document,
  downloadDocument,
  downloadDocumentPdf,
  getDocument,
  listDocumentVersions,
  retryLibraryPdfParse,
} from "@/app/lib/api/documents";
import {
  buildAuthorities,
  prepareAuthoritiesSources,
  refreshAuthoritiesInput,
} from "@/app/lib/api/authorities";
import {
  createWorkProduct,
  deleteWorkProduct,
  duplicateWorkProduct,
  getWorkProduct,
  getWorkProductResolution,
  listWorkProductMetadata,
  listWorkProducts,
  updateWorkProduct,
} from "@/app/lib/api/workProducts";

import {
  getCourtRecordPreparation,
  saveCourtRecordBuild,
  uploadCourtRecordDocument,
} from "@/app/lib/api/courtRecords";
import { getUserProfile, updateUserProfile } from "@/app/lib/api/account";
import { BeaverApiError } from "@/app/lib/api/client";
import { pdfProgress, waitForPdfPreparation } from "@/app/lib/pdfPreparation";
import type { ResolvedWorkProductInput, WorkProduct, WorkProductBuildReceipt,
  WorkProductInput, WorkProductResolution,
  WorkProductStore } from "@/app/lib/workProducts";
import type { BuildArtifact, BuildReceiptSource, CourtRecordDraft, CourtRecordReceipt,
  DocumentKind, RecordEntry, SourceDocumentFields } from "./types";
import { draftOutputChoice, filingContactCover, mergeFilingContact } from "./host";
import type { CourtRecordsHost, DraftOutputChoice, PreparedFile,
  PreparationProgress } from "./host";
import { acceptedSourceFormats, DOCX_MIME, needsPdfRendition, sourceFormat } from "./formats";
import { prepareDeviceFile, prepareDocxRendition } from "./prepareDeviceFile";
import { sourceDocumentFields } from "./sourceFields";
import { COURT_PROFILE_BY_ID } from "./profiles";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";
import { acceptsWorkProductOutput } from "../../../../shared/court-record-work-products.mjs";
import type { AuthoritiesProduct } from "../authorities/types";

const resolutionRequests = new Map<string, Promise<WorkProductResolution>>();
function currentResolution(id: string, progress?: PreparationProgress) {
  const pending = resolutionRequests.get(id);
  if (pending) return pending;
  const request = getWorkProductResolution(id).then(async (resolution) => {
    if (resolution.freshness === "current" || resolution.product.kind !== "authorities") {
      return resolution;
    }
    let product = resolution.product;
    try {
      const changed = Object.entries(resolution.inputs)
        .filter(([, input]) => input.status === "changed").map(([role]) => role);
      if (changed.length) {
        progress?.(`Refreshing ${resolution.product.title}`);
        for (const role of changed) {
          product = await refreshAuthoritiesInput(id, role, product.revision);
        }
      }
      product = await prepareAuthoritiesSources(id, product.revision);
      const draft = product.state as AuthoritiesProduct["state"];
      for (const authority of Object.values(draft.authorities)) {
        if (authority.excluded || authority.source.kind !== "attached") continue;
        for (const source of authority.source.sources) {
          const binding = draft.bindings[source.bindingRole];
          if (binding?.kind !== "document") continue;
          await waitForPdfPreparation(binding.documentId,
            (status) => progress?.(`${source.filename}: ${status}`));
        }
      }
      progress?.(`Building ${resolution.product.title}`);
      await buildAuthorities(id, product.revision);
      return getWorkProductResolution(id);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ".";
      throw new Error(
        `${resolution.product.title} could not be rebuilt. Open its Authorities draft${detail}`,
        { cause: error },
      );
    }
  })
    .finally(() => resolutionRequests.delete(id));
  resolutionRequests.set(id, request);
  return request;
}
const drafts: WorkProductStore = {
  list: listWorkProducts,
  listMetadata: listWorkProductMetadata,
  get: getWorkProduct,
  create: createWorkProduct,
  update: updateWorkProduct,
  duplicate: duplicateWorkProduct,
  remove: deleteWorkProduct,
};

export const beaverCourtRecordsHost: CourtRecordsHost = {
  mode: "beaver",
  drafts,
  async newDraftCover() {
    try {
      return filingContactCover((await getUserProfile()).filingContact);
    } catch { return {}; }
  },
  async saveFilingContact(cover) {
    const profile = await getUserProfile();
    await updateUserProfile({ filingContact: mergeFilingContact(profile.filingContact, cover) });
  },
  async prepareDeviceFile(file, progress, context) {
    let prepared: PreparedFile;
    let uploaded: Document;
    if (sourceFormat(file) === "docx" && needsPdfRendition(context?.destination)) {
      progress?.(`Adding ${file.name}`);
      uploaded = await uploadCourtRecordDocument(file, context?.workProductId);
      const rendition = await downloadDocumentPdf(uploaded.id, uploaded.current_version_id);
      prepared = await prepareDocxRendition(file, rendition.blob, progress);
    } else {
      [prepared, uploaded] = await Promise.all([
        prepareDeviceFile(file, progress),
        uploadCourtRecordDocument(file, context?.workProductId),
      ]);
    }
    prepared.origin = {
      kind: "library",
      documentId: uploaded.id,
      versionId: uploaded.current_version_id ?? undefined,
      sourceSha256: uploaded.source_sha256 ?? undefined,
    };
    prepared.binding = { kind: "document", documentId: uploaded.id, version: "latest" };
    return prepared;
  },
  async importLibraryDocument(document, progress, destination) {
    return prepareLibraryDocument(document, document.current_version_id, progress, destination);
  },
  async searchDraftOutputs(query, destination, draft, signal) {
    const formats = acceptedSourceFormats(destination);
    const projectId = draft.projectId;
    const products = (await Promise.all([
      listWorkProductMetadata("authorities", projectId ?? undefined, signal),
      listWorkProductMetadata("court-record", projectId ?? undefined, signal),
    ])).flat().filter((product) => product.id !== draft.id &&
      product.projectId === projectId);
    const needle = query.trim().toLowerCase();
    return products.flatMap((product) => Object.entries(product.outputs ?? {})
      .flatMap(([role, output]) => {
        const choice = draftOutputChoice(product, role, output);
        const format = sourceFormat({ name: output.filename, type: output.mimeType });
        const matches = !needle || `${product.title} ${role} ${output.filename}`
          .toLowerCase().includes(needle);
        return format && formats.includes(format) && matches &&
          acceptsWorkProductOutput(destination, choice) ? [choice] : [];
      }));
  },
  importDraftOutput: prepareDraftOutput,
  async resolveInput(input, progress, destination) {
    if (input.kind === "work-product-output") {
      if (!destination) return { status: "missing", reason: "unavailable" };
      try {
        const resolution = await currentResolution(input.workProductId, progress);
        const product = resolution.product;
        const output = product.outputs[input.role];
        if (!output) return { status: "missing", reason: "unavailable" };
        const choice = draftOutputChoice(product, input.role, output);
        if (!acceptsWorkProductOutput(destination, choice)) {
          return { status: "missing", reason: "unavailable" };
        }
        if (resolution.freshness !== "current") {
          throw new Error(`${product.title} is out of date. Open that draft and build it again.`);
        }
        const prepared = await prepareDraftOutput(choice, destination, progress);
        return { status: "ready", file: prepared.file, input, prepared };
      } catch (error) {
        if (error instanceof BeaverApiError && error.status === 404) {
          return { status: "missing", reason: "deleted" };
        }
        throw error;
      }
    }
    try {
      if (input.kind !== "document") return { status: "missing", reason: "unavailable" };
      const document = await getDocument(input.documentId);
      const versionId = input.version === "latest" ? document.current_version_id : input.version.versionId;
      const prepared = await prepareLibraryDocument(document, versionId, progress, destination);
      if (input.version !== "latest" && (prepared.origin?.versionId !== input.version.versionId ||
          prepared.origin.sourceSha256 !== input.version.sha256)) {
        return { status: "missing", reason: "unavailable" };
      }
      return { status: "ready", file: prepared.file, input, prepared };
    } catch (error) {
      if (error instanceof BeaverApiError && error.status === 404) {
        return { status: "missing", reason: "deleted" };
      }
      throw error;
    }
  },
  async runOcr(entry, progress, signal) {
    let documentId = entry.origin?.kind === "library" ? entry.origin.documentId : undefined;
    let versionId = entry.origin?.kind === "library" ? entry.origin.versionId : undefined;
    let sourceSha256 = entry.origin?.kind === "library" ? entry.origin.sourceSha256 : undefined;
    if (!documentId) {
      progress?.(`Adding ${entry.file.name}`);
      const uploaded = await uploadCourtRecordDocument(entry.file);
      documentId = uploaded.id;
      versionId = uploaded.current_version_id ?? undefined;
      sourceSha256 = uploaded.source_sha256 ?? undefined;
    }
    const [state] = await pdfProgress([documentId]);
    if (!state?.error) await waitForPdfPreparation(documentId, progress, signal);
    // No page text yet is the condition recognition exists to answer, not a reason
    // to stop before it has run.
    const read = () => getCourtRecordPreparation(documentId, versionId)
      .catch(() => undefined);
    let prepared = await read();
    const base: PreparedFile = {
      file: entry.file,
      pageCount: entry.pageCount,
      searchable: entry.searchable,
      encrypted: entry.encrypted,
      textlessPageCount: entry.textlessPageCount,
      textlessPages: entry.textlessPages,
      sourceBookmarks: entry.sourceBookmarks,
      ocrTextByPage: entry.ocrTextByPage,
      inspectionError: entry.inspectionError,
      origin: { kind: "library", documentId,
        versionId: prepared?.version_id ?? versionId,
        sourceSha256: prepared?.source_sha256 || sourceSha256 },
    };
    let merged = prepared ? withProjection(base, prepared) : base;
    if (!prepared || merged.textlessPageCount) {
      progress?.("Reading the scanned pages");
      await retryLibraryPdfParse("files", documentId, {
        ocr_provider: "kraken-lite",
        ...(versionId ? { version_id: versionId } : {}),
      });
      await waitForPdfPreparation(documentId, progress, signal);
      prepared = await getCourtRecordPreparation(documentId, versionId);
      merged = withProjection(merged, prepared);
    }
    return { ...merged, ocrAttemptedPages: entry.textlessPages ?? [] };
  },
  async saveArtifacts({ artifacts, product, entries, receipt }) {
    const receipts = await courtRecordOutputReceipts(product, entries, receipt, artifacts);
    const saved = await saveCourtRecordBuild<CourtRecordDraft>(artifacts.map((artifact) => ({
      file: new File([artifact.bytes.slice().buffer], artifact.filename,
        { type: artifact.mimeType }),
      receipt: receipts.get(artifact.role ?? "record")!,
    })));
    const outputs = Object.fromEntries(Object.entries(saved.outputs).map(([role, output]) =>
      [role, { documentId: output.documentId, versionId: output.versionId }]));
    return { documents: [], outputs, product: saved };
  },
};

async function prepareDraftOutput(choice: DraftOutputChoice, destination: DocumentKind,
  progress?: PreparationProgress) {
  if (!acceptsWorkProductOutput(destination, choice)) {
    throw new Error("This saved output cannot be added to this document slot.");
  }
  const document = await getDocument(choice.output.documentId);
  const prepared = await prepareLibraryDocument(document, choice.output.versionId, progress, destination);
  if (prepared.origin?.versionId !== choice.output.versionId ||
      prepared.origin.sourceSha256 !== choice.output.sha256) {
    throw new Error("The selected draft output changed while it was opening.");
  }
  return { ...prepared, binding: { kind: "work-product-output" as const,
    workProductId: choice.workProductId, role: choice.role } };
}

function resolvedSource(
  source: BuildReceiptSource, entry: RecordEntry, binding: WorkProductInput,
): ResolvedWorkProductInput {
  if (JSON.stringify(entry.binding) !== JSON.stringify(binding)) {
    throw new Error(`${source.filename} is no longer connected to its saved input.`);
  }
  if (binding.kind === "local-file") {
    if (source.origin.kind !== "device" || binding.lastSeen.size !== source.byteCount ||
        binding.lastSeen.sha256 && binding.lastSeen.sha256 !== source.sha256) {
      throw new Error(`${source.filename} no longer matches its selected file.`);
    }
    return { kind: binding.kind,
    handleId: binding.handleId, filename: source.filename, size: source.byteCount,
    modified: binding.lastSeen.modified, sha256: source.sha256 };
  }
  const origin = entry.origin;
  if (!origin || origin.kind !== "library" || !origin.documentId || !origin.versionId ||
      !origin.sourceSha256 || origin.sourceSha256 !== source.sha256 ||
      source.origin.kind !== "library" || source.origin.documentId !== origin.documentId ||
      source.origin.versionId !== origin.versionId ||
      source.origin.sourceSha256 !== origin.sourceSha256) {
    throw new Error(`${source.filename} no longer matches its prepared Library version.`);
  }
  if (binding.kind === "document") {
    if (binding.documentId !== origin.documentId || binding.version !== "latest" &&
        (binding.version.versionId !== origin.versionId ||
         binding.version.sha256 !== origin.sourceSha256)) {
      throw new Error(`${source.filename} no longer matches its saved document binding.`);
    }
    return { kind: binding.kind, documentId: origin.documentId, versionId: origin.versionId,
      filename: source.filename, sha256: origin.sourceSha256 };
  }
  return { kind: binding.kind, workProductId: binding.workProductId, role: binding.role,
    documentId: origin.documentId, versionId: origin.versionId,
    filename: source.filename, sha256: origin.sourceSha256 };
}

export async function courtRecordOutputReceipts(
  product: WorkProduct<CourtRecordDraft>,
  entries: RecordEntry[], receipt: CourtRecordReceipt, artifacts: BuildArtifact[],
) {
  if (product.kind !== "court-record" || receipt.profile.id !== product.state.profileId) {
    throw new Error("The built files no longer match this court record draft.");
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const inputs = receipt.sources.map((source) => {
    const entry = byId.get(source.entryId), binding = product.state.bindings[source.entryId];
    if (!entry || !binding) {
      throw new Error(`The source ${source.filename} is no longer in this draft.`);
    }
    return { role: source.entryId,
      resolved: resolvedSource(source, entry, binding) };
  });
  const profile = COURT_PROFILE_BY_ID.get(product.state.profileId);
  if (!profile) throw new Error("The court record format is no longer available.");
  const [stateSha256, settingsSha256] = await Promise.all([
    digest(canonicalJson(product.state)), digest(canonicalJson(profile)),
  ]);
  if (receipt.profile.sha256 !== settingsSha256) {
    throw new Error("The court record format changed after this build. Build it again.");
  }
  return new Map(artifacts.map((artifact) => {
    const role = artifact.role ?? "record";
    const output = receipt.outputs.find((item) => item.role === role &&
      item.filename === artifact.filename &&
      item.mime_type === artifact.mimeType && item.sha256 === artifact.sha256 &&
      item.page_count === (artifact.pageCount ?? null));
    if (!output) throw new Error(`The build receipt does not match ${artifact.filename}.`);
    const value: WorkProductBuildReceipt = {
      schemaVersion: "beaver.work-product-build.v2", builtAt: receipt.created_at,
      workProduct: { id: product.id, kind: "court-record", revision: product.revision },
      inputs, settings: { profileId: profile.id, outputMode: profile.outputMode,
        stateSha256, settingsSha256, sourceReceiptIds: [...profile.sourceIds],
        audit: { effective: { from: receipt.profile.effective.from,
          to: receipt.profile.effective.to ?? null }, valuesJson: canonicalJson({
          preparationDate: receipt.preparation_date,
          cover: receipt.cover,
          entries: product.state.entries,
        }) } },
      steps: [...receipt.automatic_steps], output: { role, filename: output.filename,
        mimeType: output.mime_type, pageCount: output.page_count, sha256: output.sha256 },
    };
    return [role, value] as const;
  }));
}

async function digest(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function prepareLibraryDocument(
  document: Document,
  versionId?: string | null,
  progress?: PreparationProgress,
  destination?: DocumentKind,
) {
  progress?.(`Loading ${document.filename}`);
  const format = document.file_type?.toLowerCase() === "docx" ? "docx" : "pdf";
  const [downloaded, rendition, exactVersion] = await Promise.all([
    downloadDocument(document.id, versionId),
    format === "docx" && needsPdfRendition(destination) ? downloadDocumentPdf(document.id, versionId) : undefined,
    versionId && versionId !== document.current_version_id
      ? listDocumentVersions(document.id).then(({ versions }) =>
        versions.find(({ id }) => id === versionId)) : undefined,
  ]);
  const file = new File([downloaded.blob], downloaded.filename || document.filename, {
    type: format === "docx" ? DOCX_MIME : "application/pdf",
  });
  if (versionId && versionId !== document.current_version_id && !exactVersion) {
    throw new Error("The selected Library version is no longer available.");
  }
  const prepared = rendition
    ? await prepareDocxRendition(file, rendition.blob, progress)
    : await prepareDeviceFile(file, progress);
  prepared.origin = {
    kind: "library",
    documentId: document.id,
    versionId: versionId ?? document.current_version_id ?? undefined,
    sourceSha256: exactVersion?.source_sha256 ?? document.source_sha256 ?? undefined,
  };
  prepared.binding = {
    kind: "document",
    documentId: document.id,
    version: versionId && versionId !== document.current_version_id
      ? { versionId, sha256: exactVersion?.source_sha256 ?? "" }
      : "latest",
  };
  if (format !== "pdf") return prepared;
  try {
    return withProjection(prepared, await getCourtRecordPreparation(document.id, versionId));
  } catch {
    return prepared;
  }
}

function withProjection(
  prepared: PreparedFile,
  projection: Awaited<ReturnType<typeof getCourtRecordPreparation>>,
): PreparedFile {
  const byPage = new Map(projection.pages.map((page) => [page.page_number, page.text]));
  const targets = prepared.textlessPages ?? [];
  const ocrTextByPage = Array.from({ length: prepared.pageCount ?? projection.page_count },
    (_, index) => targets.includes(index + 1) ? byPage.get(index + 1) ?? "" : prepared.ocrTextByPage?.[index] ?? "");
  const missing = targets.filter((page) => !ocrTextByPage[page - 1]?.trim());
  return {
    ...prepared,
    pageCount: projection.page_count,
    ocrTextByPage,
    searchable: missing.length ? prepared.searchable : true,
    textlessPageCount: missing.length,
    textlessPages: missing,
    ...(targets.length && !missing.length && { ocrAttemptedPages: targets }),
    sourceFields: mergeSourceFields(prepared.sourceFields,
      sourceDocumentFields(projection.pages.map((page) => page.text))),
    origin: {
      kind: "library",
      documentId: projection.document_id,
      versionId: projection.version_id,
      sourceSha256: projection.source_sha256,
    },
  };
}

function mergeSourceFields(...sources: (SourceDocumentFields | undefined)[]) {
  const values = sources.filter((source): source is SourceDocumentFields => Boolean(source));
  if (!values.length) return;
  const mentionLabels = [...new Set(values.flatMap(({ exhibitMentions }) =>
    Object.keys(exhibitMentions ?? {})))];
  const exhibitMentions = Object.fromEntries(mentionLabels.map((label) => [label,
    [...new Set(values.flatMap((source) => source.exhibitMentions?.[label] ?? []))],
  ]));
  return {
    cover: Object.assign({}, ...values.map(({ cover }) => cover)),
    exhibitLabels: [...new Set(values.flatMap(({ exhibitLabels }) => exhibitLabels))],
    ...(mentionLabels.length && { exhibitMentions }),
    explicitExhibitLabel: values.findLast(({ explicitExhibitLabel }) => explicitExhibitLabel)?.explicitExhibitLabel,
    entryTitle: values.findLast(({ entryTitle }) => entryTitle)?.entryTitle,
    entryDate: values.findLast(({ entryDate }) => entryDate)?.entryDate,
  } satisfies SourceDocumentFields;
}
