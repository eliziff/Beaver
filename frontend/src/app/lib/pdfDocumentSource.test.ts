import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPdfDocumentSource } from "./pdfDocumentSource";
import { clearDocumentFileCache, invalidateDocumentFile } from "@/app/hooks/useDocumentFile";
const controls = vi.hoisted(() => ({ delivered: vi.fn() }));
vi.mock("./pdfJs", () => ({ getPdfJs: async () => ({ PDFDataRangeTransport: class {
  constructor(readonly length: number, readonly initialData: Uint8Array) {}
  onDataRange = controls.delivered;
} }) }));
const size = 200000, digest = `"${"a".repeat(64)}"`;
let fetcher: ReturnType<typeof vi.fn>;
function partial(start: number, end: number, etag = digest, status = 206) {
  return new Response(new Uint8Array(end - start), { status, headers: {
    "Content-Type": "application/pdf", ETag: etag, "Content-Range": `bytes ${start}-${end - 1}/${size}`,
    "Content-Length": String(end - start),
  } });
}
beforeEach(() => {
  clearDocumentFileCache(); controls.delivered.mockReset();
  fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const [start, end] = new Headers(init.headers).get("Range")!.slice(6).split("-").map(Number);
    return partial(start, Math.min(end + 1, size));
  }); vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { clearDocumentFileCache(); vi.unstubAllGlobals(); });
const open = (onError = vi.fn(), controller = new AbortController()) =>
  createPdfDocumentSource("document", "version")(controller.signal, onError);

it("boots with one chunk and binds every later range to its verified representation", async () => {
  const result = await open();
  expect("range" in result).toBe(true); if (!("range" in result)) return;
  expect(result.range.length).toBe(size); expect(result.range.initialData!.length).toBe(65536);
  expect(fetcher).toHaveBeenCalledTimes(1);
  result.range.requestDataRange(131072, size);
  await vi.waitFor(() => expect(controls.delivered).toHaveBeenCalledOnce());
  const init = fetcher.mock.calls[1][1];
  expect(new Headers(init.headers).get("If-Match")).toBe(digest);
  expect(init.credentials).toBe("include"); expect(init.cache).toBe("no-store");
  expect(controls.delivered.mock.calls[0][0]).toBe(131072);
  result.range.abort();
});

it.each(["changed", "wrong range", "truncated", "revoked"])("fails closed on %s mid-document responses", async kind => {
  const error = vi.fn(), result = await open(error); if (!("range" in result)) throw new Error("No range");
  fetcher.mockResolvedValueOnce(kind === "revoked" ? new Response(null, { status: 403 })
    : kind === "changed" ? partial(65536, 131072, `"${"b".repeat(64)}"`)
    : kind === "wrong range" ? partial(65537, 131073)
    : new Response(new Uint8Array(10), { status: 206, headers: {
      "Content-Type": "application/pdf", ETag: digest, "Content-Range": `bytes 65536-131071/${size}`,
    } }));
  result.range.requestDataRange(65536, 131072);
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(controls.delivered).not.toHaveBeenCalled();
});

it("cancels obsolete loads and does not deliver a late response from a transport ignoring abort", async () => {
  const error = vi.fn(), result = await open(error); if (!("range" in result)) throw new Error("No range");
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
  result.range.requestDataRange(65536, 131072);
  invalidateDocumentFile("document");
  expect(error).toHaveBeenCalledOnce();
  release(partial(65536, 131072));
  await Promise.resolve(); await Promise.resolve();
  expect(controls.delivered).not.toHaveBeenCalled();
});

it("keeps a complete-response fallback in the existing cache without detaching it", async () => {
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
  const first = await open(); if (!("data" in first)) throw new Error("No data");
  structuredClone(first.data.buffer, { transfer: [first.data.buffer] });
  const second = await open();
  expect(second).toEqual({ data: new Uint8Array([37, 80, 68, 70]) });
  expect(fetcher).toHaveBeenCalledOnce();
});


it.each(["complete", "cached"])("invalidates an active %s-file viewer without waiting for another range", async mode => {
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
  if (mode === "cached") {
    const previous = new AbortController();
    await open(vi.fn(), previous); previous.abort();
  }
  const error = vi.fn(), controller = new AbortController();
  const result = await open(error, controller);
  expect("data" in result).toBe(true);
  invalidateDocumentFile("document");
  expect(error).toHaveBeenCalledOnce();
  clearDocumentFileCache();
  expect(error).toHaveBeenCalledOnce();
  controller.abort();
});

it("does not report a normal viewer disposal as an access failure", async () => {
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } }));
  const error = vi.fn(), controller = new AbortController();
  await open(error, controller);
  controller.abort();
  invalidateDocumentFile("document"); clearDocumentFileCache();
  expect(error).not.toHaveBeenCalled();
});
