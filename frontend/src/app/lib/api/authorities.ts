import type { AuthoritiesBuildSettings, AuthoritiesProfileId, AuthoritiesOutputMode, AuthoritiesProduct, AuthoritiesAction, AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritySourceLanguage, AuthoritiesBuildReceipt } from "@/app/authorities/types";
import { post, multipartRequest, segment, apiRequest, mutationInit, followedRequest } from "@/app/lib/api/client";
import type { Document } from "@/app/lib/api/documents";
import type { AuthoritiesBookSlot } from "../../../../../shared/authorities-sources.mjs";

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
/** Whether Beaver turns a Word brief into PDF itself; without it the user supplies the brief PDF. */
export const authoritiesWordToPdf = () =>
  apiRequest<{ wordToPdf: boolean }>("/authorities/capabilities").then(({ wordToPdf }) => wordToPdf);
export const prepareAuthoritiesSources = async (id: string, revision: number, signal?: AbortSignal,
  authorityId?: string, progress?: (message: string) => void) =>
  (await followedRequest(`/authorities/${segment(id)}/sources`,
    { ...mutationInit("POST", { revision, authorityId }), signal }, progress)).json() as Promise<AuthoritiesProduct>;
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
    { kind: "book"; slot: AuthoritiesBookSlot; supplementId?: string }) =>
  post<AuthoritiesProduct>(`/authorities/${segment(id)}/library-pdfs`, {
    revision, documentId, versionId, target,
  });
export const attachAuthoritiesBookPdf = (id: string, revision: number,
  slot: AuthoritiesBookSlot, file: File, supplementId?: string) =>
  multipartRequest<AuthoritiesProduct>(
    `/authorities/${segment(id)}/book-parts/${slot}`, file,
    { fields: { revision: String(revision), ...(supplementId ? { supplement_id: supplementId } : {}) } },
  );
export const authoritiesSourceOcr = (id: string, roles: string[], cancel = false, pages?: number[]) =>
  post<Array<{ role: string; documentId?: string; done?: boolean }>>(
    `/authorities/${segment(id)}/source-ocr`, { roles, cancel, pages });
export const buildAuthorities = async (id: string, revision: number, signal?: AbortSignal,
  progress?: (message: string) => void) =>
  (await followedRequest(`/authorities/${segment(id)}/build`,
    { ...mutationInit("POST", { revision }), signal }, progress)).json() as
    Promise<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt }>;

export const prepareAuthoritiesAnnotations = (id: string, authorityId: string, bindingRole: string,
  sourceSha256: string, signal?: AbortSignal) =>
  apiRequest<import("@/app/authorities/annotationPreparation").AnnotationPreparation>(
    `/authorities/${segment(id)}/annotations`,
    { ...mutationInit("POST", { authorityId, bindingRole, sourceSha256 }), signal });
