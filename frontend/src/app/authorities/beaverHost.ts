import {
  actOnAuthorities,
  attachAuthoritiesBookPdf,
  attachAuthoritiesLibraryPdf,
  attachAuthorityPdf,
  buildAuthorities,
  createAuthorities,
  refreshAuthorities,
  prepareAuthoritiesSources,
  authoritiesSourceOcr,
  prepareAuthoritiesHighlights,
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
import { directoryResource, downloadDocument } from "@/app/lib/api/documents";
import { pdfProgress, waitForPdfPreparation } from "@/app/lib/pdfPreparation";
import type { WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import { prepareAnnotations } from "./annotationPreparation";

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

export const beaverAuthoritiesHost: AuthoritiesHost = {
  prepareAnnotations,
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
  async readSource(draft, role) {
    const input = (await getWorkProductResolution(draft.id)).inputs[role];
    const resolved = input?.status === "ready" ? input.resolved
      : input?.status === "changed" ? input.current : null;
    if (!resolved || resolved.kind === "local-file") throw new Error("This source is unavailable.");
    return downloadDocument(resolved.documentId, resolved.versionId).then(({ blob }) => blob);
  },
  sourceOcr: { progress: pdfProgress,
    start: (id, roles) => authoritiesSourceOcr(id, roles),
    cancel: (id, roles) => authoritiesSourceOcr(id, roles, true) },
  async prepareHighlights(draft, progress, signal) {
    await prepareSourcePdfs(draft, progress, signal);
    progress?.("Preparing highlight review");
    await prepareAuthoritiesHighlights(draft.id, draft.revision, signal);
  },
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
    const issues = Object.entries(resolved.inputs).flatMap<[string, AuthoritiesSourceIssue]>(([role, input]) =>
      input.status === "changed" ? [[role, { status: "changed" as const }]]
        : input.status === "missing" ? [[role, { status: "missing" as const,
            reason: input.reason === "deleted" ? "deleted" as const : "unavailable" as const }]]
          : []);
    return { sourceIssues: Object.fromEntries(issues), outputFreshness: resolved.freshness };
  },
};
