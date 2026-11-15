export type AuthoritiesOperation = "quote-check" | "source-text" | "source-pages" | "source-quotes" | "source-read" | "excerpt-pages" | "pinpoints" | "annotations" | "create" | "import" | "refresh" | "action" | "apply-actions" | "book-front" | "sources" | "discrepancies" | "discrepancies/actions" | "link-propagation" | "pdf" | "pdf-authority" | "build" | "capabilities" | "verify-workbook" | "verify-docx";
export type AuthoritiesRuntimeFile = { filename: string; bytes: Uint8Array; modified?: number };
export type AuthoritiesOperationInput = Record<string, unknown> & { files?: AuthoritiesRuntimeFile[] };
export type AuthoritiesOutputFile = { role: string; filename?: string; mimeType: string; bytes: Uint8Array };
export type AuthoritiesRuntimeResult = { data: unknown; files?: AuthoritiesOutputFile[];
  attachments?: Array<{ authorityId: string; filename: string; sourceSha256: string; language: string; bytes: Uint8Array }> };
export type AuthoritiesOperationOptions = { signal?: AbortSignal; progress?: (message: string) => void; quoteProgress?: (value: unknown) => void;
  /** Gathering's steps as it makes them ("sources"): its actions, and the PDF an attaching one keeps. */
  sourceProgress?: (value: AuthoritiesSourceStep) => void };
export type AuthoritiesSourceStep = { actions: unknown[];
  attachment?: { authorityId: string; filename: string; sourceSha256: string; language: string; bytes: Uint8Array } };
export type AuthoritiesOperationClient = (operation: AuthoritiesOperation, input: AuthoritiesOperationInput, options?: AuthoritiesOperationOptions) => Promise<AuthoritiesRuntimeResult>;
