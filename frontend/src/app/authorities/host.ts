import type { Document } from "@/app/components/shared/types";
import type { WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesBuildSettings,
  AuthoritiesDiscrepancy, AuthoritiesOutputMode, AuthoritiesProduct,
  AuthoritiesProfileId } from "./types";

export type AuthoritiesFile = { file: File; input?: WorkProductInput };
export type AuthoritiesFilePick = { multiple: boolean; accept: "source" | "pdf" };
export type AuthoritiesBookSlot = "cover" | "index" | "supplemental";
export type AuthoritiesSourceIssue =
  | { status: "changed" }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" };
export type AuthoritiesCreate = {
  source: { kind: "manual" } | { kind: "document"; document: Document } |
    { kind: "file"; selected: AuthoritiesFile };
  title: string;
  projectId?: string;
  settings?: Partial<AuthoritiesBuildSettings> & { profileId?: AuthoritiesProfileId;
    outputMode?: AuthoritiesOutputMode; insertIntoDocument?: boolean };
};
export interface AuthoritiesHost {
  drafts: WorkProductStore;
  create(input: AuthoritiesCreate): Promise<AuthoritiesProduct>;
  act(id: string, revision: number, action: AuthoritiesAction): Promise<AuthoritiesProduct>;
  refresh(id: string, revision: number): Promise<AuthoritiesProduct>;
  prepareSources(product: AuthoritiesProduct, signal?: AbortSignal): Promise<AuthoritiesProduct>;
  review?(id: string, signal?: AbortSignal): Promise<AuthoritiesDiscrepancy[]>;
  attach(id: string, authorityId: string, revision: number,
    selected: AuthoritiesFile): Promise<AuthoritiesProduct>;
  build(product: AuthoritiesProduct, progress?: (message: string) => void,
    signal?: AbortSignal): Promise<{
    product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt; notice?: string;
  }>;
  download(documentId: string, versionId: string): Promise<Blob>;
  searchLibrary?(query: string, signal?: AbortSignal): Promise<Document[]>;
  pickFiles?(options: AuthoritiesFilePick): Promise<AuthoritiesFile[]>;
  sourceIssues?(draft: AuthoritiesProduct): Promise<Record<string, AuthoritiesSourceIssue>>;
  relinkSource?(id: string, role: string, revision: number): Promise<AuthoritiesProduct>;
  replaceSource?(id: string, revision: number,
    selected: AuthoritiesFile): Promise<AuthoritiesProduct>;
  attachBookPdf?(id: string, revision: number, slot: AuthoritiesBookSlot,
    selected: AuthoritiesFile): Promise<AuthoritiesProduct>;
  outputFolder?: {
    get(): Promise<string | null>;
    choose(): Promise<string | null>;
    clear(): Promise<void>;
  };
}
