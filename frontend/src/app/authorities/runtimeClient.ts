import { followedRequest, apiResponse, BeaverApiError } from "@/app/lib/api/client";
import { readSseData } from "@/app/lib/sse";
import type { AuthoritiesOperation, AuthoritiesOperationClient, AuthoritiesOperationInput,
  AuthoritiesOperationOptions, AuthoritiesRuntimeResult } from "mike/shared/runtime/authoritiesRuntime.mjs";

export type AuthoritiesRequest = Record<string, unknown> & { files?: Blob[] };
declare global { var AUTHORITIES_OPERATIONS: AuthoritiesOperationClient | undefined; }

/** The network adapter owns HTTP/multipart; the HTML worker receives ordinary values and bytes. */
export async function authoritiesOperation(operation: AuthoritiesOperation, input: AuthoritiesRequest = {},
  options: AuthoritiesOperationOptions = {}): Promise<AuthoritiesRuntimeResult> {
  options.signal?.throwIfAborted();
  if (globalThis.AUTHORITIES_OPERATIONS) {
    if ((input.files?.length ?? 0) > (operation === "build" ? 500 : 1))
      throw new BeaverApiError({ status: 400, message: "Too many source files." });
    if (input.files?.some(file => file.size > 100 * 1024 * 1024))
      throw new BeaverApiError({ status: 413, message: "File too large. Maximum size is 100 MB." });
    if (operation === "build" && (input.files ?? []).reduce((total, file) => total + file.size, 0) > 512 * 1024 * 1024)
      throw new BeaverApiError({ status: 413, message: "Authorities build files are too large together. Maximum total is 512 MB." });
    const files = await Promise.all((input.files ?? []).map(async file => ({
      filename: file instanceof File ? file.name : "authority.pdf",
      modified: file instanceof File ? file.lastModified : 0, bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    options.signal?.throwIfAborted();
    try { return await globalThis.AUTHORITIES_OPERATIONS(operation, { ...input, files } as AuthoritiesOperationInput, options); }
    catch (error) {
      if (error instanceof Error && "status" in error && typeof error.status === "number")
        throw new BeaverApiError({ status: error.status, message: error.message });
      throw error;
    }
  }
  let body: BodyInit | undefined, headers: Record<string, string> | undefined;
  if (input.files?.length) {
    const form = new FormData();
    for (const [name, value] of Object.entries(input)) {
      if (name !== "files" && value !== undefined)
        form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    for (const file of input.files) form.append(operation === "build" ? "files" : "file", file,
      file instanceof File ? file.name : "authority.pdf");
    body = form;
  } else if (operation !== "capabilities") {
    headers = { "Content-Type": "application/json" }; body = JSON.stringify(input);
  }
  if (operation === "quote-check" && options.quoteProgress) {
    const response = await apiResponse("/authorities-runtime/quote-check", {
      method: "POST", body, headers: { ...headers, Accept: "text/event-stream" }, signal: options.signal,
    });
    const report = { quotes: [] as unknown[], counts: {} as Record<string, number> };
    for await (const frame of readSseData(response.body!, { signal: options.signal })) {
      const event = JSON.parse(frame);
      if (event.error) throw new Error(event.error);
      if (event.quote) { report.quotes.push(event.quote); options.quoteProgress(event); }
      if (event.done) { report.counts = event.counts; return { data: report }; }
    }
    options.signal?.throwIfAborted();
    throw new Error("Authorities stopped part-way through checking quotations.");
  }
  const response = await followedRequest(`/authorities-runtime/${operation}`, {
    method: operation === "capabilities" ? "GET" : "POST", body, headers, signal: options.signal,
  }, options.progress);
  if (operation === "book-front") return { data: null, files: [{ role: "output", mimeType: "application/pdf",
    bytes: new Uint8Array(await response.arrayBuffer()) }] };
  if (!response.headers.get("content-type")?.startsWith("multipart/form-data")) return { data: await response.json() };
  const form = await response.formData();
  const data: Record<string, unknown> = {}, files: NonNullable<AuthoritiesRuntimeResult["files"]> = [];
  for (const [role, value] of form) {
    if (typeof value === "string") data[role] = JSON.parse(value);
    else files.push({ role, filename: value.name, mimeType: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
  }
  if (Array.isArray(data.attachments)) return { data: data.draft,
    attachments: data.attachments.map(item => ({ ...item, bytes: files.find(file => file.role === item.part)!.bytes })) };
  return { data, files };
}
