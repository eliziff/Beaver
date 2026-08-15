import type { LibraryKind } from "./normalize";
import type { DocumentRecord } from "./documentStore";

export type LibraryScope = {
  userId: string;
  userEmail?: string;
  kind: LibraryKind;
};

export type LibraryDocument = DocumentRecord;

export type LibraryFolder = Record<string, unknown> & {
  id: string;
  parent_folder_id: string | null;
};

export type LibraryPageItem =
  | { kind: "folder"; folder: LibraryFolder }
  | { kind: "document"; document: LibraryDocument };

export type LibraryStore = {
  page(scope: LibraryScope, options: {
    q: string;
    parentFolderId: string | null;
    limit: number;
    after: [number, string, string] | null;
    documentsOnly?: boolean;
  }): Promise<{
    items: LibraryPageItem[];
    nextAfter: [number, string, string] | null;
  }>;
  folder(scope: LibraryScope, folderId: string): Promise<LibraryFolder | null>;
  createFolder(
    scope: LibraryScope,
    name: string,
    parentFolderId: string | null,
  ): Promise<LibraryFolder | null>;
  updateFolder(scope: LibraryScope, folderId: string, update: {
    name?: string;
    parentFolderId?: string | null;
  }): Promise<LibraryFolder | null>;
  deleteFolder(scope: LibraryScope, folderId: string): Promise<boolean>;
  document(
    scope: LibraryScope,
    documentId: string,
  ): Promise<LibraryDocument | null>;
  moveDocument(
    scope: LibraryScope,
    documentId: string,
    folderId: string | null,
  ): Promise<LibraryDocument | null>;
  updateDocument(scope: LibraryScope, documentId: string, update: {
    filename: string;
    metadata?: unknown;
    notes?: string | null;
  }): Promise<LibraryDocument | null>;
};
