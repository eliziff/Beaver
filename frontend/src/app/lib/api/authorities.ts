import type { AuthoritiesBuildSettings, AuthoritiesProfileId, AuthoritiesOutputMode, AuthoritiesProduct, AuthoritiesAction, AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritySourceLanguage, AuthoritiesBuildReceipt } from "@/app/authorities/types";
import { post, multipartRequest, segment, apiRequest, mutationInit } from "@/app/lib/api/client";
import type { Document } from "@/app/lib/api/documents";

export const createAuthorities = (input: {
  source: { kind: "manual" } | { kind: "document"; documentId: string;
    version: "latest" | { versionId: string; sha256: string } };
  title?: string;
  projectId?: string | null;
  settings?: Partial<AuthoritiesBuildSettings> & { profileId?: AuthoritiesProfileId;
    outputMode?: AuthoritiesOutputMode; insertIntoDocument?: boolean };
}) => post<AuthoritiesProduct>("/authorities", input);
export const uploadAuthoritiesDocument = (file: File, projectId?: string) =>
  multipartRequest<Document>("/authorities/documents", file,
    projectId ? { fields: { projectId } } : undefined);
export const actOnAuthorities = (id: string, revision: number, action: AuthoritiesAction) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/actions`, { revision, action });
export const refreshAuthorities = (id: string, revision: number) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/refresh`, { revision });
export const prepareAuthoritiesSources = (id: string, revision: number, signal?: AbortSignal) =>
  apiRequest<AuthoritiesProduct>(`/authorities/${segment(id)}/sources`,
    { ...mutationInit("POST", { revision }), signal });
export const refreshAuthoritiesInput = (id: string, role: string, revision: number) =>
  post<AuthoritiesProduct>(
    `/authorities/${segment(id)}/inputs/${segment(role)}/refresh`, { revision });
export const reviewAuthorities = (id: string, signal?: AbortSignal) =>
  apiRequest<AuthoritiesDiscrepancy[]>(
    `/authorities/${segment(id)}/discrepancies`, { ...mutationInit("POST", {}), signal });
export const resolveAuthoritiesDiscrepancy = (id: string, input: {
  id: string; action: AuthoritiesDiscrepancyAction; revision: number;
}) => post<AuthoritiesProduct>(`/authorities/${segment(id)}/discrepancies/actions`, input);
export const attachAuthorityPdf = (
  id: string, authorityId: string, revision: number, file: File,
  language: AuthoritySourceLanguage,
) => multipartRequest<AuthoritiesProduct>(
  `/authorities/${segment(id)}/attachments/${segment(authorityId)}`, file,
  { fields: { revision: String(revision), language } },
);
export const attachAuthoritiesLibraryPdf = (id: string, revision: number,
  documentId: string, versionId: string, target:
    { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage } |
    { kind: "book"; slot: "cover" | "index" | "supplemental"; supplementId?: string }) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/library-pdfs`, {
    revision, documentId, versionId, target,
  });
export const attachAuthoritiesBookPdf = (id: string, revision: number,
  slot: "cover" | "index" | "supplemental", file: File, supplementId?: string) =>
  multipartRequest<AuthoritiesProduct>(
    `/authorities/${segment(id)}/book-parts/${slot}`, file,
    { fields: { revision: String(revision), ...(supplementId ? { supplement_id: supplementId } : {}) } },
  );
export const authoritiesSourceOcr = (id: string, roles: string[], cancel = false) =>
  post<Array<{ role: string; documentId?: string; citedPages?: number }>>(
    `/authorities/${segment(id)}/source-ocr`, { roles, cancel });
export const prepareAuthoritiesHighlights = (id: string, revision: number, signal?: AbortSignal) =>
  apiRequest<AuthoritiesProduct>(`/authorities/${segment(id)}/prepare-highlights`,
    { ...mutationInit("POST", { revision }), signal });
export const buildAuthorities = (id: string, revision: number, signal?: AbortSignal) =>
  apiRequest<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt }>(
    `/authorities/${segment(id)}/build`, { ...mutationInit("POST", { revision }), signal },
  );
