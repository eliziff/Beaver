import type { Document } from "@/app/components/shared/types";
import type { WorkProductInput, WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesProduct } from "./types";

export type AuthoritiesFile = { file: File; input?: WorkProductInput };
export type AuthoritiesSourceIssue =
  | { status: "changed" }
  | { status: "missing"; reason: "deleted" | "permission" | "unavailable" };
export type AuthoritiesCreate = {
  source: { kind: "manual" } | { kind: "document"; document: Document } |
    { kind: "file"; selected: AuthoritiesFile };
  title: string;
  projectId?: string;
};
export interface AuthoritiesHost {
  mode: "beaver" | "standalone";
  drafts: WorkProductStore;
  create(input: AuthoritiesCreate): Promise<AuthoritiesProduct>;
  act(id: string, revision: number, action: AuthoritiesAction): Promise<AuthoritiesProduct>;
  refresh(id: string, revision: number): Promise<AuthoritiesProduct>;
  attach(id: string, authorityId: string, revision: number,
    selected: AuthoritiesFile): Promise<AuthoritiesProduct>;
  build(product: AuthoritiesProduct, progress?: (message: string) => void): Promise<{
    product: AuthoritiesProduct; receipt: AuthoritiesBuildReceipt;
  }>;
  download(documentId: string, versionId: string): Promise<Blob>;
  searchLibrary?(query: string, signal?: AbortSignal): Promise<Document[]>;
  pickFiles?(multiple: boolean): Promise<AuthoritiesFile[]>;
  sourceIssues?(draft: AuthoritiesProduct): Promise<Record<string, AuthoritiesSourceIssue>>;
  relinkSource?(id: string, role: string, revision: number): Promise<AuthoritiesProduct>;
}
