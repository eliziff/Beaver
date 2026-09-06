import type { Document, Folder } from "@/app/lib/api/documents";
import {
  type PageQuery,
  type Page,
  apiRequest,
  pagePath,
  post,
  segment,
  patch,
  remove,
} from "@/app/lib/api/client";


export interface Project {
  id: string;
  user_id: string;
  is_owner?: boolean;
  owner_display_name?: string | null;
  owner_email?: string | null;
  name: string;
  cm_number: string | null;
  practice: string | null;
  shared_with: string[];
  created_at: string;
  documents?: Document[];
  folders?: Folder[];
  metadata?: { labelsResearchFileId?: string | null };
}
export const listProjects = (options: PageQuery & {
  scope?: "all" | "mine" | "shared-with-me";
} = {}, signal?: AbortSignal) => apiRequest<Page<Project>>(
  pagePath("/projects", options), { signal },
);
export const createProject = (
  name: string, cm_number?: string, practice?: string, shared_with?: string[],
) => post<Project>("/projects", {
  name, cm_number, practice, shared_with,
});
export const getProject = (projectId: string) => apiRequest<Project>(`/projects/${segment(projectId)}`);
export const updateProject = (
  projectId: string,
  payload: Partial<Pick<
    Project,
    "name" | "cm_number" | "practice" | "shared_with"
  >>,
) => patch<Project>(`/projects/${segment(projectId)}`, payload);
export const deleteProject = (projectId: string) =>
  remove<void>(`/projects/${segment(projectId)}`);
export interface ProjectPeople {
  owner: { email: string | null; display_name: string | null };
  members: { email: string; display_name: string | null }[];
}
export const getProjectPeople = (projectId: string) =>
  apiRequest<ProjectPeople>(`/projects/${segment(projectId)}/people`);
