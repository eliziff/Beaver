import { ApplicationError, type ApplicationScope } from "./applicationError";
import { z } from "zod";
import type { DocumentStore } from "./documentStore";
import type { LegalEvidenceReceipt } from "./chat/legalEvidence";
import { readResearchFile, visitResearchEvidenceParts, researchSourceResource,
  type ResearchFile, type ResearchFileState, type ResearchEvidence, type ResearchSourceReference } from "./researchFile";

import { researchFindingReferenceSchema } from "./researchFindingReference";

const selectionIds = z.array(z.string().min(1).max(200)).max(100_000)
  .transform((values) => [...new Set(values)]);
export const researchSelectionSchema = z.object({ findingRefs: z.array(researchFindingReferenceSchema).max(10_000).optional(), sourceIds: selectionIds.optional(), labelIds: selectionIds.optional(),
  evidenceIds: selectionIds.optional(), target: z.enum(["sources", "passages"]), unlabelled: z.boolean().optional(),
  members: z.array(z.object({ sourceId: z.string().min(1).max(200), evidenceIds: selectionIds.optional() }).strict())
    .max(100_000).optional() }).strict();
export type ResearchSelection = z.infer<typeof researchSelectionSchema>;
export type ResearchSubject = { rowId?: string; sourceId: string; resource: string;
  reference: ResearchSourceReference; evidence?: LegalEvidenceReceipt[]; sourceSha256?: string;
  sourceSha256s?: string[] };
export function intersectResearchSubjects(subjects: ResearchSubject[], boundary: ResearchSubject[]): ResearchSubject[] {
  const allowed = new Map<string, Map<string, LegalEvidenceReceipt> | null>();
  for (const subject of boundary) {
    const previous = allowed.get(subject.resource);
    if (!subject.evidence || previous === null) allowed.set(subject.resource, null);
    else allowed.set(subject.resource, new Map([...previous ?? [], ...subject.evidence.map((receipt) =>
      [receipt.evidence_id, receipt] as const)]));
  }
  return subjects.flatMap((subject) => {
    const permitted = allowed.get(subject.resource);
    if (permitted === undefined) return [];
    if (permitted === null) return subject.evidence?.length === 0 ? [] : [subject];
    const evidence = subject.evidence ? subject.evidence.filter(({ evidence_id }) => permitted.has(evidence_id)) : [...permitted.values()];
    return evidence.length ? [{ ...subject, evidence }] : [];
  });
}
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
  input: ResearchSelection & { researchFileId: string }, current?: ResearchFile,
  options: { availableOnly?: boolean; allowUnmatchedEvidenceIds?: boolean } = {}): Promise<{
    research_file_id: string; versionId: string; workingRevision: number; subjects: ResearchSubject[];
  }> {
  const availableOnly = options.availableOnly ?? false;
  const file = current ?? await readResearchFile(documents, scope, input.researchFileId);
  if (!file) throw new ApplicationError(404, "Research workspace not found");
  if (input.members) {
    const { researchFileId: _researchFileId, ...selected } = input;
    researchSelectionSchema.parse(selected);
    const members = new Map<string, Set<string> | null>();
    for (const member of input.members) {
      if (input.sourceIds && !input.sourceIds.includes(member.sourceId)) continue;
      const existing = members.get(member.sourceId);
      if (!member.evidenceIds || existing === null) members.set(member.sourceId, null);
      else members.set(member.sourceId, new Set([...(existing ?? []), ...member.evidenceIds]));
    }
    const subjects: ResearchSubject[] = [];
    for (const [sourceId, evidenceIds] of members) {
      const resolved = await resolveResearchSelection(documents, scope, { researchFileId: input.researchFileId,
        sourceIds: [sourceId], target: evidenceIds === null ? "sources" : "passages",
        ...(evidenceIds === null ? {} : { evidenceIds: [...evidenceIds] }) }, file, options);
      subjects.push(...resolved.subjects);
    }
    if (!input.labelIds?.length && input.evidenceIds === undefined && !input.unlabelled)
      return { research_file_id: file.document.id, versionId: file.versionId,
        workingRevision: file.workingRevision, subjects };
    if (!availableOnly) researchSelectionLabels(file.state, input.labelIds ?? []);
    const narrowed = await resolveResearchSelection(documents, scope, { researchFileId: input.researchFileId,
      target: input.target, sourceIds: [...members.keys()], labelIds: input.labelIds,
      evidenceIds: input.evidenceIds, unlabelled: input.unlabelled }, file,
    { ...options, allowUnmatchedEvidenceIds: true });
    return { research_file_id: file.document.id, versionId: file.versionId,
      workingRevision: file.workingRevision, subjects: intersectResearchSubjects(narrowed.subjects, subjects) };
  }
  const selectedLabels = availableOnly ? input.labelIds?.filter((id) => file.state.labels[id]) : input.labelIds;
  if (availableOnly && input.labelIds?.length && !selectedLabels?.length)
    return { research_file_id: file.document.id, versionId: file.versionId, workingRevision: file.workingRevision, subjects: [] };
  const labels = researchSelectionLabels(file.state, selectedLabels ?? []),
    requested = input.sourceIds ?? Object.values(file.state.sources)
      .filter((source) => source.collected || input.evidenceIds !== undefined).map(({ id }) => id),
    selectedEvidence = input.evidenceIds && new Set(input.evidenceIds),
    sources = [...new Set(requested)].flatMap((id) => {
      const source = file.state.sources[id];
      if (!source && !availableOnly) throw new ApplicationError(400, "Research source not found");
      return source ? [source] : [];
    }),
    matches = (ids: string[]) => !labels.size && !input.unlabelled ||
      !!input.unlabelled && !ids.length || ids.some((id) => labels.has(id)),
    parts = new Map<string, Record<string, ResearchEvidence>>(),
    found = new Set<string>();
  if (input.target === "passages" || selectedEvidence) await visitResearchEvidenceParts(documents, scope,
    file, sources.map(({ id }) => id), (batch) => { batch.forEach((value, key) => parts.set(key, value)); });
  const subjects: ResearchSubject[] = [];
  for (const source of sources) {
    if (input.target === "sources" && !matches(source.labelIds)) continue;
    const evidence = Object.values(parts.get(source.id) ?? {}).filter((item) => {
      if (selectedEvidence && !selectedEvidence.has(item.receipt.evidence_id)) return false;
      if (!selectedEvidence && !item.labelIds.length) return false;
      if (input.target === "passages" && !matches(item.labelIds) && !source.labelIds.some((id) => labels.has(id))) return false;
      found.add(item.receipt.evidence_id); return true;
    }).map(({ receipt }) => receipt);
    if (input.target === "passages" || selectedEvidence) {
      if (!evidence.length) continue;
    } else if (!matches(source.labelIds)) continue;
    const projection = source.reference.kind === "document" ?
      await documents.projectionSource(scope, source.reference.id, source.reference.versionId) : null;
    if (source.reference.kind === "document" && !projection) {
      if (availableOnly) continue;
      throw new ApplicationError(404, "Selected document version is unavailable");
    }
    subjects.push({ sourceId: source.id, resource: researchSourceResource(source.reference), reference: source.reference,
      ...(projection ? { sourceSha256: projection.sourceSha256 } : {}),
      ...(input.target === "passages" || selectedEvidence ? { evidence } : {}) });
  }
  if (!availableOnly && !options.allowUnmatchedEvidenceIds && selectedEvidence && [...selectedEvidence].some((id) => !found.has(id)))
    throw new ApplicationError(400, "Selected passage is outside this research scope");
  return { research_file_id: file.document.id, versionId: file.versionId,
    workingRevision: file.workingRevision, subjects };
}
