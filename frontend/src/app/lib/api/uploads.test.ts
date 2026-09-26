import { webcrypto, createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resumeUpload, uploadDocumentSession, type UploadSession } from "./uploads";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
it("recovers a lost completion response without creating or transferring a second document", async () => {
  const sessions = new Map<string, UploadSession>(); let published = 0, transfers = 0, lost = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/uploads") {
      const input = JSON.parse(String(init.body));
      if (!sessions.has(input.client_key)) sessions.set(input.client_key, { ...input, id: crypto.randomUUID(), status: "pending", document: null });
      return Response.json(sessions.get(input.client_key));
    }
    if (url.endsWith("/transfer")) return Response.json({ kind: "proxy" });
    if (url.endsWith("/content")) { transfers++; return Response.json({ uploaded: true }); }
    if (url.endsWith("/complete")) {
      const session = [...sessions.values()][0]; published++;
      Object.assign(session, { status: "complete", document: { id: "saved-document" } });
      if (!lost) { lost = true; throw new TypeError("Connection lost"); }
      return Response.json(session);
    }
    throw new Error(`Unexpected request ${url}`);
  }));
  const file = new File(["record"], "record.txt");
  await expect(uploadDocumentSession(file, { project_id: "matter" })).rejects.toThrow("Connection lost");
  await expect(uploadDocumentSession(file, { project_id: "matter" })).resolves.toMatchObject({ id: "saved-document" });
  expect(sessions.size).toBe(1); expect(published).toBe(1); expect(transfers).toBe(1);
  expect(localStorage.length).toBe(0);
});
it("sends direct file bytes without application credentials and tolerates an immutable retry", async () => {
  const session = { id: "upload", filename: "record.txt", size_bytes: 3, source_sha256: hash("abc"), status: "pending" } as UploadSession;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/transfer")) return Response.json({ kind: "direct", url: "https://storage.example.test/upload",
      headers: { "if-none-match": "*", "x-amz-checksum-sha256": "checksum" } });
    if (url.startsWith("https://storage")) return new Response(null, { status: 412 });
    return Response.json({ ...session, status: "complete", document: { id: "saved" } });
  }));
  const file = new File(["abc"], "record.txt");
  await expect(resumeUpload(session, file)).resolves.toMatchObject({ id: "saved" });
  expect(requests.find(({ url }) => url.startsWith("https://storage"))?.init)
    .toMatchObject({ method: "PUT", body: file, credentials: "omit", redirect: "error", headers: { "if-none-match": "*" } });
});
it("rejects a different file before transferring it into a recovered session", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(resumeUpload({ id: "upload", status: "pending", size_bytes: 3, source_sha256: hash("abc") } as UploadSession,
    new File(["abd"], "record.txt"))).rejects.toThrow("same file");
  expect(fetch).not.toHaveBeenCalled();
});
