export type ProjectScope = { userId: string; userEmail?: string };
export type ProjectRecord = Record<string, unknown> & { id: string };
export type ProjectPage<T, C extends unknown[]> = {
  items: T[];
  nextAfter: C | null;
};

export class ProjectStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type ProjectStore = {
  page(scope: ProjectScope, options: {
    q: string;
    scope: "all" | "mine" | "shared-with-me";
    limit: number;
    after: [string, string] | null;
  }): Promise<ProjectPage<ProjectRecord, [string, string]>>;
  create(scope: ProjectScope, input: {
    name: string;
    cmNumber: string | null;
    practice: string | null;
    sharedWith: string[];
    metadata?: Record<string, unknown>;
    notes?: string | null;
  }): Promise<ProjectRecord>;
  directory(scope: ProjectScope, projectId: string, options: {
    q: string;
    parentFolderId: string | null;
    limit: number;
    after: [number, string, string] | null;
  }): Promise<ProjectPage<Record<string, unknown>, [number, string, string]>>;
  get(scope: ProjectScope, projectId: string): Promise<ProjectRecord | null>;
  people(scope: ProjectScope, projectId: string): Promise<{
    owner: { user_id: string; email: string | null; display_name: string | null };
    members: { email: string; display_name: string | null }[];
  } | null>;
  update(scope: ProjectScope, projectId: string, input: {
    name?: string;
    cmNumber?: string | null;
    practice?: string | null;
    sharedWith?: string[];
    metadata?: Record<string, unknown>;
    notes?: string | null;
  }): Promise<ProjectRecord | null>;
  delete(scope: ProjectScope, projectId: string): Promise<boolean>;
  detachDocument(scope: ProjectScope, projectId: string,
    documentId: string): Promise<boolean>;
  attachDocument(scope: ProjectScope, projectId: string,
    documentId: string): Promise<{ document: ProjectRecord; created: boolean }>;
  renameDocument(scope: ProjectScope, projectId: string, documentId: string,
    filename: unknown): Promise<ProjectRecord>;
  uploadDocument(scope: ProjectScope, projectId: string, file: {
    originalname: string;
    buffer: Buffer;
  }, fileType: string): Promise<ProjectRecord>;
  chats(scope: ProjectScope, projectId: string): Promise<ProjectRecord[]>;
  createFolder(scope: ProjectScope, projectId: string, input: {
    name: string;
    parentFolderId: string | null;
  }): Promise<ProjectRecord>;
  updateFolder(scope: ProjectScope, projectId: string, folderId: string,
    input: { name?: string; parentFolderId?: string | null }): Promise<ProjectRecord>;
  deleteFolder(scope: ProjectScope, projectId: string,
    folderId: string): Promise<void>;
  moveDocument(scope: ProjectScope, projectId: string, documentId: string,
    folderId: string | null): Promise<ProjectRecord>;
};
