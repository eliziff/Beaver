import type { Document } from "@/app/lib/api/documents";
import type { WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesBuildSettings,
  AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritiesOutputMode, AuthoritiesProduct,
  AuthoritiesProfileId, AuthoritySourceLanguage } from "./types";
import type { OutputFolderPort } from "@/app/components/shared/OutputFolderSetting";
import type { PdfProgress } from "@/app/lib/pdfPreparation";
import type { PdfRecognizedText } from "@/app/lib/api/documents";
import type { PdfOpening } from "@/app/lib/inspectPdf";

/** `autoFetched`: found by auto-fetch rather than chosen, so its citation is checked before it is attached. */
export type AuthoritiesFile = { file: File; input?: WorkProductInput; autoFetched?: boolean };
export type AuthoritiesFilePick = { multiple: boolean; accept: "source" | "pdf" };
export type { AuthoritiesBookSlot } from "../../../../shared/authorities-sources.mjs";
import type { AuthoritiesBookSlot } from "../../../../shared/authorities-sources.mjs";
export type AuthoritiesLibraryPdfTarget =
  | { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage }
  | { kind: "book"; slot: AuthoritiesBookSlot; supplementId?: string };
export type AuthoritiesSourceIssue =
  | { status: "changed" }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" };
/** Durable recognition of scanned source PDFs: start (cited pages first), stop, and watch. */
export type AuthoritiesOcrPort = {
  start(id: string, roles: string[], pages?: number[], scannedPages?: Record<string, number[]>): Promise<Array<{ role: string; documentId?: string; done?: boolean }>>;
  cancel(id: string, roles: string[]): Promise<unknown>;
  progress(documentIds: string[]): Promise<PdfProgress[]>;
};
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
  recognitionAvailable?: boolean;
  /** Whether a Word brief becomes PDF here; without it a final PDF needs the brief saved as PDF. */
  wordToPdf?(): Promise<boolean>;
  drafts: WorkProductStore;
  create(input: AuthoritiesCreate): Promise<AuthoritiesProduct>;
  act(id: string, revision: number, action: AuthoritiesAction): Promise<AuthoritiesProduct>;
  refresh(id: string, revision: number): Promise<AuthoritiesProduct>;
  /** `progress` hears which authority is being looked up or fetched, as it happens. */
  prepareSources(product: AuthoritiesProduct, signal?: AbortSignal,
    authorityId?: string, progress?: (message: string) => void): Promise<AuthoritiesProduct>;
  review?(id: string, signal?: AbortSignal): Promise<AuthoritiesDiscrepancy[]>;
  resolveDiscrepancy?(id: string, input: { id: string; action: AuthoritiesDiscrepancyAction;
    revision: number }): Promise<AuthoritiesProduct>;
  attach(id: string, authorityId: string, revision: number,
    selected: AuthoritiesFile, language?: AuthoritySourceLanguage): Promise<AuthoritiesProduct>;
  /** The authority still without a PDF that a PDF from the watched folder is, if exactly one. */
  pdfAuthority?(product: AuthoritiesProduct, opening: PdfOpening): Promise<string | null>;
  /** The folder Auto-fetch watches, kept for the next visit. */
  watchedFolder?: { get(): Promise<FileSystemDirectoryHandle | null>;
    set(handle: FileSystemDirectoryHandle | null): Promise<void> };
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
  /** Call from a click: the browser only asks for file access during a user gesture. */
  requestSourceAccess?(draft: AuthoritiesProduct): Promise<boolean>;
  attachBookPdf?(id: string, revision: number, slot: AuthoritiesBookSlot,
    selected: AuthoritiesFile, supplementId?: string): Promise<AuthoritiesProduct>;
  attachLibraryPdf?(id: string, revision: number, document: Document,
    target: AuthoritiesLibraryPdfTarget): Promise<AuthoritiesProduct>;
  readSource?(draft: AuthoritiesProduct, role: string, signal?: AbortSignal): Promise<Blob>;
  readSourceText?(draft: AuthoritiesProduct, role: string, signal?: AbortSignal, pages?: number[]): Promise<PdfRecognizedText>;
  readSourcePageLabels?(draft: AuthoritiesProduct, role: string, signal?: AbortSignal): Promise<Array<string | null>>;
  sourceOcr?: AuthoritiesOcrPort;
  outputFolder?: OutputFolderPort;
}
