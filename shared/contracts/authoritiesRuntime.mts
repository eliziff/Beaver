export type AuthoritiesOperation = "quote-check" | "source-text" | "source-read" | "excerpt" | "excerpt-pages" | "pinpoints" | "page-labels" | "annotations" | "create" | "import" | "refresh" | "action" | "book-front" | "sources" | "discrepancies" | "discrepancies/actions" | "pdf" | "pdf-authority" | "build" | "capabilities";
export type AuthoritiesRuntimeFile = { filename: string; bytes: Uint8Array; modified?: number };
export type AuthoritiesOperationInput = Record<string, unknown> & { files?: AuthoritiesRuntimeFile[] };
export type AuthoritiesOutputFile = { role: string; filename?: string; mimeType: string; bytes: Uint8Array };
export type AuthoritiesRuntimeResult = { data: unknown; files?: AuthoritiesOutputFile[];
  attachments?: Array<{ authorityId: string; filename: string; sourceSha256: string; language: string; bytes: Uint8Array }> };
export type AuthoritiesOperationOptions = { signal?: AbortSignal; progress?: (message: string) => void; quoteProgress?: (value: unknown) => void };
export type AuthoritiesOperationClient = (operation: AuthoritiesOperation, input: AuthoritiesOperationInput, options?: AuthoritiesOperationOptions) => Promise<AuthoritiesRuntimeResult>;
