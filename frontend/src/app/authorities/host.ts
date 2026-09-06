import type { Document } from "@/app/lib/api/documents";
import type { WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesBuildSettings,
  AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritiesOutputMode, AuthoritiesProduct,
  AuthoritiesProfileId, AuthoritySourceLanguage } from "./types";
import type { OutputFolderPort } from "@/app/components/shared/OutputFolderSetting";

export type AuthoritiesFile = { file: File; input?: WorkProductInput };
export type AuthoritiesFilePick = { multiple: boolean; accept: "source" | "pdf" };
export type AuthoritiesBookSlot = "cover" | "index" | "supplemental";
export type AuthoritiesLibraryPdfTarget =
  | { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage }
  | { kind: "book"; slot: AuthoritiesBookSlot; supplementId?: string };
export type AuthoritiesSourceIssue =
  | { status: "changed" }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" };
export type AuthoritiesDraftInspection = {
  sourceIssues: Record<string, AuthoritiesSourceIssue>;
  outputFreshness: "unbuilt" | "current" | "stale";
};
export type AuthoritiesCreate = {
  source: { kind: "manual" } | { kind: "document"; document: Document } |
    { kind: "file"; selected: AuthoritiesFile };
  title: string;
  projectId?: string;
  settings?: Partial<AuthoritiesBuildSettings> & { profileId?: AuthoritiesProfileId;
    outputMode?: AuthoritiesOutputMode; insertIntoDocument?: boolean };
};
export interface AuthoritiesHost {
  prepareAnnotations?: typeof import("./annotationPreparation").prepareAnnotations;
  mode?: "beaver" | "standalone";
  drafts: WorkProductStore;
  create(input: AuthoritiesCreate): Promise<AuthoritiesProduct>;
  act(id: string, revision: number, action: AuthoritiesAction): Promise<AuthoritiesProduct>;
  refresh(id: string, revision: number): Promise<AuthoritiesProduct>;
  prepareSources(product: AuthoritiesProduct, signal?: AbortSignal): Promise<AuthoritiesProduct>;
  prepareHighlights?(product: AuthoritiesProduct, progress?: (message: string) => void,
    signal?: AbortSignal): Promise<void>;
  review?(id: string, signal?: AbortSignal): Promise<AuthoritiesDiscrepancy[]>;
  resolveDiscrepancy?(id: string, input: { id: string; action: AuthoritiesDiscrepancyAction;
    revision: number }): Promise<AuthoritiesProduct>;
  attach(id: string, authorityId: string, revision: number,
    selected: AuthoritiesFile, language?: AuthoritySourceLanguage): Promise<AuthoritiesProduct>;
  build(product: AuthoritiesProduct, progress?: (message: string) => void,
    signal?: AbortSignal): Promise<{
    product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt; notice?: string;
  }>;
  download(documentId: string, versionId: string): Promise<Blob>;
  searchLibrary?(query: string, context?: { projectId?: string | null;
    formats?: Array<"pdf" | "docx"> },
    signal?: AbortSignal): Promise<Document[]>;
  pickFiles?(options: AuthoritiesFilePick): Promise<AuthoritiesFile[]>;
  inspectDraft(draft: AuthoritiesProduct): Promise<AuthoritiesDraftInspection>;
  relinkSource?(id: string, role: string, revision: number): Promise<AuthoritiesProduct>;
  replaceSource?(id: string, revision: number,
    selected: AuthoritiesFile): Promise<AuthoritiesProduct>;
  attachBookPdf?(id: string, revision: number, slot: AuthoritiesBookSlot,
    selected: AuthoritiesFile, supplementId?: string): Promise<AuthoritiesProduct>;
  attachLibraryPdf?(id: string, revision: number, document: Document,
    target: AuthoritiesLibraryPdfTarget): Promise<AuthoritiesProduct>;
  readSource?(draft: AuthoritiesProduct, role: string): Promise<Blob>;
  outputFolder?: OutputFolderPort;
}
