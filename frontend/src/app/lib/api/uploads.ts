import { apiRequest, multipartRequest, post, remove, segment, uploadSignedObject } from "./client";
import type { Document } from "./documents";

type Destination = { project_id?: string | null; folder_id?: string | null; library_kind?: "file" | "template" };
export type UploadSession = Destination & { id: string; filename: string; size_bytes: number; source_sha256: string;
  status: "pending" | "queued" | "complete" | "failed" | "cancelled" | "expired" | "removed";
  document: Document | null; error: string | null; expires_at: string; retryable: boolean };
const path = (id: string) => `/uploads/${segment(id)}`;
export const listUploads = () => apiRequest<UploadSession[]>("/uploads");
export const cancelUpload = (id: string) => remove<void>(path(id));
export const retryUpload = (id: string) => post<UploadSession>(`${path(id)}/complete`, {});
const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  (value) => value.toString(16).padStart(2, "0")).join("");
const signalChange = () => window.dispatchEvent(new Event("beaver-uploads-changed"));

export async function resumeUpload(session: UploadSession, file?: File, sourceDigest?: string): Promise<Document> {
  if (session.status === "pending") {
    if (!file) throw new Error("Select the original file to finish transferring it.");
    if (file.size !== session.size_bytes || (sourceDigest ?? await digest(await file.arrayBuffer())) !== session.source_sha256)
      throw new Error("Select the same file used for this upload.");
    const transfer = await post<{ kind: "proxy" } | { kind: "direct"; url: string; headers: Record<string, string> }>(`${path(session.id)}/transfer`, {});
    if (transfer.kind === "direct") await uploadSignedObject(transfer.url, transfer.headers, file);
    else await multipartRequest(`${path(session.id)}/content`, file);
    session = await post<UploadSession>(`${path(session.id)}/complete`, {});
    signalChange();
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (session.status === "queued") {
    if (Date.now() > deadline) throw new Error("Upload is still processing. Check Uploads for its status.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    session = await apiRequest<UploadSession>(path(session.id));
  }
  signalChange();
  if (session.document) return session.document;
  throw new Error(session.error ?? (session.status === "removed" ? "The uploaded document was removed." : `Upload ${session.status}. Select the file again.`));
}

export async function uploadDocumentSession(file: File, destination: Destination = {}) {
  if (!file.size || file.size > 100 * 1024 * 1024) throw new Error("Choose a nonempty file no larger than 100 MB.");
  const source_sha256 = await digest(await file.arrayBuffer());
  const input = { filename: file.name, size_bytes: file.size, source_sha256, ...destination };
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify(input))), cacheKey = `beaver-upload:${fingerprint}`;
  let client_key: string = crypto.randomUUID();
  try {
    const saved = localStorage.getItem(cacheKey);
    if (saved && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(saved)) client_key = saved;
    localStorage.setItem(cacheKey, client_key);
  } catch { /* Storage may be disabled. */ }
  try {
    let session = await post<UploadSession>("/uploads", { ...input, client_key });
    signalChange();
    if (["failed", "cancelled", "expired", "removed"].includes(session.status)) {
      client_key = crypto.randomUUID();
      try { localStorage.setItem(cacheKey, client_key); } catch { /* Storage may be disabled. */ }
      session = await post<UploadSession>("/uploads", { ...input, client_key });
    }
    const document = await resumeUpload(session, file, source_sha256);
    try { localStorage.removeItem(cacheKey); } catch { /* Storage may be disabled. */ }
    return document;
  } catch (error) { signalChange(); throw error; }
}
