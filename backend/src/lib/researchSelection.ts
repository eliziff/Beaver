import { ApplicationError, type ApplicationScope } from "./applicationError";
import type { DocumentStore } from "./documentStore";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readResearchFile, visitResearchEvidenceParts, researchSourceResource,
  type ResearchFile, type ResearchFileState, type ResearchEvidence, type ResearchSourceReference } from "./researchFile";

export type ResearchSelection = { sourceIds?: string[]; labelIds?: string[];
  evidenceIds?: string[]; target: "sources" | "passages"; unlabelled?: boolean };
export function researchSelectionLabels(state: ResearchFileState, ids: string[]) {
  if (ids.some((id) => !state.labels[id])) throw new ApplicationError(400, "Label not found");
  const selected = new Set(ids), children = new Map<string, string[]>();
  for (const label of Object.values(state.labels)) if (label.parentId) {
    const siblings = children.get(label.parentId) ?? []; siblings.push(label.id); children.set(label.parentId, siblings);
  }
  for (const id of selected) children.get(id)?.forEach((child) => selected.add(child));
  return selected;
}

export async function resolveResearchSelection(documents: DocumentStore, scope: ApplicationScope,
  input: ResearchSelection & { researchFileId: string }, current?: ResearchFile) {
  const file = current ?? await readResearchFile(documents, scope, input.researchFileId);
  if (!file) throw new ApplicationError(404, "Research workspace not found");
  const labels = researchSelectionLabels(file.state, input.labelIds ?? []),
    requested = input.sourceIds ?? Object.keys(file.state.sources),
    selectedEvidence = input.evidenceIds && new Set(input.evidenceIds),
    sources = [...new Set(requested)].map((id) => {
      const source = file.state.sources[id]; if (!source) throw new ApplicationError(400, "Research source not found");
      return source;
    }),
    matches = (ids: string[]) => !labels.size && !input.unlabelled ||
      !!input.unlabelled && !ids.length || ids.some((id) => labels.has(id)),
    parts = new Map<string, Record<string, ResearchEvidence>>(),
    found = new Set<string>();
  if (input.target === "passages" || selectedEvidence) await visitResearchEvidenceParts(documents, scope,
    file, sources.map(({ id }) => id), (batch) => { batch.forEach((value, key) => parts.set(key, value)); });
  const subjects: { sourceId: string; resource: string; reference: ResearchSourceReference;
    evidence?: LegalEvidenceReceipt[]; sourceSha256?: string; sourceSha256s?: string[] }[] = [];
  for (const source of sources) {
    const evidence = Object.values(parts.get(source.id) ?? {}).filter((item) => {
      if (selectedEvidence && !selectedEvidence.has(item.receipt.evidence_id)) return false;
      if (input.target === "passages" && !matches(item.labelIds) && !source.labelIds.some((id) => labels.has(id))) return false;
      found.add(item.receipt.evidence_id); return true;
    }).map(({ receipt }) => receipt);
    if (input.target === "passages" || selectedEvidence) {
      if (!evidence.length) continue;
    } else if (!matches(source.labelIds)) continue;
    const projection = source.reference.kind === "document" ?
      await documents.projectionSource(scope, source.reference.id, source.reference.versionId) : null;
    if (source.reference.kind === "document" && !projection)
      throw new ApplicationError(404, "Selected document version is unavailable");
    subjects.push({ sourceId: source.id, resource: researchSourceResource(source.reference), reference: source.reference,
      ...(projection ? { sourceSha256: projection.sourceSha256 } : {}),
      ...(input.target === "passages" ? { evidence } : {}) });
  }
  if (selectedEvidence && [...selectedEvidence].some((id) => !found.has(id)))
    throw new ApplicationError(400, "Selected passage is outside this research scope");
  return { research_file_id: file.document.id, versionId: file.versionId,
    workingRevision: file.workingRevision, subjects };
}
