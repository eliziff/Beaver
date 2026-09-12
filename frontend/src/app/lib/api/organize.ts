import { post, segment } from "@/app/lib/api/client";
import { proposalRequest, type ProposalProgress } from "./researchFiles";
import type { LibraryKind } from "./documents";

/** The folders a library or a project would be organized into, and the file each folder would hold. */
export type FolderDesign = { folders: { key: string; name: string; parentKey?: string | null }[];
  filings: { folderKey: string; documentIds: string[] }[] };
export type FolderProposal = { fingerprint: string; design: FolderDesign;
  folders: { key: string; name: string; parentKey: string | null;
    documents: { id: string; filename: string }[] }[];
  unfiled: { id: string; filename: string }[] };
export type OrganizeTarget = { library: LibraryKind } | { projectId: string };

const base = (target: OrganizeTarget) => "projectId" in target
  ? `/projects/${segment(target.projectId)}/organize` : `/library/${segment(target.library)}/organize`;
export const proposeFolders = (target: OrganizeTarget,
  input: { instruction: string; model?: string; reasoningEffort?: string },
  onProgress: (event: ProposalProgress) => void, signal?: AbortSignal) =>
  proposalRequest<FolderProposal>(`${base(target)}/preview`, input, onProgress, signal);
export const applyFolders = (target: OrganizeTarget, input: { fingerprint: string; design: FolderDesign }) =>
  post<{ folders: number; moved: number }>(`${base(target)}/apply`, input);
