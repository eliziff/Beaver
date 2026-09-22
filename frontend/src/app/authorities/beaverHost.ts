import {
  actOnAuthorities,
  attachAuthoritiesBookPdf,
  attachAuthoritiesLibraryPdf,
  attachAuthorityPdf,
  buildAuthorities,
  createAuthorities,
  refreshAuthorities,
  prepareAuthoritiesSources,
  prepareAuthoritiesAnnotations,
  authoritiesSourceOcr,
  refreshAuthoritiesInput,
  reviewAuthorities,
  resolveAuthoritiesDiscrepancy,
  uploadAuthoritiesDocument,
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
import { directoryResource, downloadDocument, getDocument, readDocumentFile, getDocumentPdfTextLayer } from "@/app/lib/api/documents";
import { pdfProgress, waitForPdfPreparation } from "@/app/lib/pdfPreparation";
import type { WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import { decodeAnnotationSet } from "../../../../shared/pdf-annotations.mjs";

const drafts: WorkProductStore = {
  list: listWorkProducts, get: getWorkProduct, create: createWorkProduct,
  listMetadata: listWorkProductMetadata,
  update: updateWorkProduct, duplicate: duplicateWorkProduct, remove: deleteWorkProduct,
};

async function prepareSourcePdfs(draft: Parameters<AuthoritiesHost["build"]>[0],
  progress?: (message: string) => void, signal?: AbortSignal) {
    if (draft.state.outputMode !== "table") {
      const sources = new Map(draft.state.authorityOrder.flatMap((authorityId) => {
        const authority = draft.state.authorities[authorityId];
        if (!authority || authority.excluded || authority.source.kind !== "attached") return [];
        return authority.source.sources.flatMap((source) => {
          const binding = draft.state.bindings[source.bindingRole];
          return binding?.kind === "document"
            ? [[binding.documentId, source.filename] as const] : [];
        });
      }));
      await Promise.all([...sources].map(async ([documentId, filename]) => {
        progress?.(`Preparing ${filename}`);
        await waitForPdfPreparation(documentId,
          (status) => progress?.(`${filename}: ${status}`), signal);
      }));
    }
}

async function sourceVersion(draft: Parameters<NonNullable<AuthoritiesHost["readSource"]>>[0], role: string) {
  const binding = draft.state.bindings[role];
  if (binding?.kind !== "document") throw new Error("This source is unavailable.");
  if (binding.version !== "latest") return { documentId: binding.documentId, versionId: binding.version.versionId };
  const metadata = await getDocument(binding.documentId);
  const source = Object.values(draft.state.authorities).flatMap(authority => authority.source.kind === "attached"
    ? authority.source.sources : []).find(source => source.bindingRole === role);
  if (!metadata.current_version_id || source && metadata.source_sha256 !== source.sourceSha256)
    throw new Error("This PDF changed. Relink the source before editing highlights.");
  return { documentId: binding.documentId, versionId: metadata.current_version_id };
}

export const beaverAuthoritiesHost: AuthoritiesHost = {
  async prepareAnnotations(draft, authorityId, role, _file, signal) {
    const authority = draft.state.authorities[authorityId];
    const source = authority?.source.kind === "attached" ? authority.source.sources.find(source => source.bindingRole === role) : null;
    if (!source) throw new Error("This source is unavailable.");
    const prepared = await prepareAuthoritiesAnnotations(draft.id, authorityId, role, source.sourceSha256, signal);
    return { ...prepared, annotations: decodeAnnotationSet(prepared.annotations) };
  },
  mode: "beaver",
  drafts,
  async create({ source, title, projectId, settings }) {
    const imported = source.kind === "file"
      ? { kind: "document" as const,
        documentId: (await uploadAuthoritiesDocument(source.selected.file, projectId)).id,
        version: "latest" as const }
      : source.kind === "document"
        ? { kind: "document" as const, documentId: source.document.id,
          version: "latest" as const }
        : source;
    return createAuthorities({ source: imported, title, projectId, settings });
  },
  act: actOnAuthorities, refresh: refreshAuthorities, review: reviewAuthorities,
  resolveDiscrepancy: resolveAuthoritiesDiscrepancy,
  prepareSources: (draft, signal) =>
    prepareAuthoritiesSources(draft.id, draft.revision, signal),
  relinkSource: refreshAuthoritiesInput,
  attach: (id, authorityId, revision, selected, language = "en") =>
    attachAuthorityPdf(id, authorityId, revision, selected.file, language),
  attachBookPdf: (id, revision, slot, selected, supplementId) =>
    attachAuthoritiesBookPdf(id, revision, slot, selected.file, supplementId),
  attachLibraryPdf(id, revision, document, target) {
    if (!document.current_version_id) throw new Error("The selected Library file is unavailable.");
    return attachAuthoritiesLibraryPdf(id, revision, document.id,
      document.current_version_id, target);
  },
  async readSource(draft, role, signal) {
    const resolved = await sourceVersion(draft, role);
    signal?.throwIfAborted();
    const response = await readDocumentFile(resolved.documentId, resolved.versionId, true, signal);
    if (!response.ok) throw new Error(`This source is unavailable (${response.status}).`);
    return response.blob();
  },
  async readSourceText(draft, role, signal) {
    const resolved = await sourceVersion(draft, role);
    signal?.throwIfAborted();
    return getDocumentPdfTextLayer(resolved.documentId, resolved.versionId, signal);
  },
  sourceOcr: { progress: pdfProgress,
    start: (id, roles, pages) => authoritiesSourceOcr(id, roles, false, pages),
    cancel: (id, roles) => authoritiesSourceOcr(id, roles, true) },
  async build(draft, progress, signal) {
    await prepareSourcePdfs(draft, progress, signal);
    progress?.("Building outputs");
    return buildAuthorities(draft.id, draft.revision, signal);
  },
  download: (documentId, versionId) =>
    downloadDocument(documentId, versionId).then(({ blob }) => blob),
  async searchLibrary(query, context, signal) {
    const library = directoryResource(context?.projectId
      ? { projectId: context.projectId } : { library: "files" });
    const page = await library.list({ q: query.trim(), limit: 30 }, signal);
    const formats = context?.formats ?? ["pdf", "docx"];
    return page.items.flatMap((item) => item.kind === "document" ? [item.document] : [])
      .filter((item) => formats.includes(item.file_type?.toLowerCase() as "pdf" | "docx"));
  },
  async inspectDraft(draft) {
    const resolved = await getWorkProductResolution(draft.id);
    // A "changed" input only means the last build read an older Library version; the next
    // build reads the current one, so it is not an issue (Eli, 2026-09-09).
    const issues = Object.entries(resolved.inputs).flatMap<[string, AuthoritiesSourceIssue]>(([role, input]) =>
      input.status === "missing" ? [[role, { status: "missing" as const,
        reason: input.reason === "deleted" ? "deleted" as const : "unavailable" as const }]] : []);
    return { sourceIssues: Object.fromEntries(issues), outputFreshness: resolved.freshness };
  },
};
