import { apiRequest, patch, post, segment } from "./client";
export type MemoryFile = { scope: "app" | "project"; ownerId: string; enabled: boolean;
  content: string; revision: number; epoch: number; canEdit: boolean };
const path = (projectId?: string) => projectId ? `/memory/projects/${segment(projectId)}` : "/memory/app";
export const getMemory = (projectId?: string) => apiRequest<MemoryFile>(path(projectId));
export const saveMemory = (projectId: string | undefined, input: { revision: number; content: string; enabled: boolean }) =>
  patch<MemoryFile>(path(projectId), input);
export const clearMemory = (projectId: string | undefined, revision: number) => post<MemoryFile>(`${path(projectId)}/clear`, { revision });
