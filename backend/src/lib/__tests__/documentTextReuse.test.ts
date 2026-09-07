import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { utils, write } from "xlsx";
import { sha256 } from "../hash";
import { spreadsheetToLLMText } from "../spreadsheet";
import { extractEmailText } from "../emailText";
import { extractPresentationText } from "../officeText";

// Only the unavailable native compiler is doubled. XLSX, PPTX, email and
// plain-text checks run the actual compilers through the production service.
const native = vi.hoisted(() => ({ docxText: vi.fn(),
  deriveDocumentStructure: vi.fn(async (input: { text: string }) => ({ text: input.text })),
  documentTextBytes: (document: { text: string }) => Buffer.byteLength(document.text),
}));
vi.mock("../structureNative", () => ({ structureNative: () => native }));
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const source = (bytes: Buffer = Buffer.from("source"), fileType = "txt") => ({
  documentId: randomUUID(), versionId: "version-1", fileType, sourceSha256: sha256(bytes),
  readBytes: vi.fn(async () => bytes), assertAvailable: vi.fn(async () => undefined),
});
const service = async () => (await import("../documentProjectionService")).documentProjectionService;

beforeEach(() => {
  vi.resetModules();
  native.docxText.mockReset().mockImplementation(async (bytes, drafting, limit) =>
    `${drafting ? "drafting" : "text"}:${limit ?? "all"}:${bytes.toString()}`);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["xlsx", "pptx", "eml", "txt"])("reuses exact %s compiler output without reading the source again", async fileType => {
  let bytes: Buffer, expected: string;
  if (fileType === "xlsx") {
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, utils.aoa_to_sheet([["Clause", "Amount"], ["Notice 😀", 250]]), "Terms");
    bytes = write(workbook, { bookType: "xlsx", type: "buffer" });
    expected = await spreadsheetToLLMText(bytes, "xlsx");
  } else if (fileType === "pptx") {
    bytes = await new JSZip().file("ppt/slides/slide1.xml", "<a:t>Notice &amp; delivery</a:t>")
      .file("ppt/slides/slide2.xml", "<a:t>Second clause</a:t>").generateAsync({ type: "nodebuffer" });
    expected = await extractPresentationText(bytes);
  } else if (fileType === "eml") {
    bytes = Buffer.from("From: sender@example.test\r\nSubject: Notice\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTerms 😀");
    expected = await extractEmailText(bytes);
  } else {
    bytes = Buffer.from("\uFEFFExact\r\ntext 😀\n"); expected = "Exact\r\ntext 😀\n";
  }
  const input = source(bytes, fileType), projection = await service();
  expect(await projection.text(input)).toBe(expected);
  expect(await projection.text({ ...input })).toBe(expected);
  expect(input.readBytes).toHaveBeenCalledOnce();
});

it("shares extraction, not reader cancellation or authorization", async () => {
  const input = source(), body = deferred<Buffer>(), projection = await service();
  input.readBytes.mockImplementation(() => body.promise);
  let allowed = true;
  const validate = vi.fn(async () => { if (!allowed) throw new Error("Access revoked"); });
  const abandoned = new AbortController();
  const first = projection.text(input, { signal: abandoned.signal });
  const second = projection.text({ ...input, assertAvailable: validate });
  const third = projection.text(input);
  await vi.waitFor(() => expect(input.readBytes).toHaveBeenCalledOnce());
  abandoned.abort(); allowed = false;
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  body.resolve(Buffer.from("source"));
  await expect(second).rejects.toThrow("Access revoked");
  expect(await third).toBe("source");
  expect(await projection.text(input)).toBe("source");
  expect(input.readBytes).toHaveBeenCalledOnce();
});

it("rechecks raw sources even on hits and rejects corrupt bytes without poisoning a verified result", async () => {
  const { assertAvailable: _validator, ...input } = source();
  const projection = await service();
  expect(await projection.text(input)).toBe("source");
  await expect(projection.text({ ...input, readBytes: async () => Buffer.from("corrupt") }))
    .rejects.toThrow("no longer match");
  expect(await projection.text(input)).toBe("source");
  expect(input.readBytes).toHaveBeenCalledTimes(2);
});

it("keeps document, version, hash, format, drafting and native limits distinct", async () => {
  const input = source(Buffer.from("original"), "docx"), projection = await service();
  expect(await projection.text(input)).toBe("text:all:original");
  expect(await projection.text(input, { drafting: true })).toBe("drafting:all:original");
  expect(await projection.text(input, { limit: 3 })).toBe("text:3:original");
  expect(await projection.text(input, { limit: 5 })).toBe("text:5:original");
  for (const changed of [{ documentId: "other" }, { versionId: "other" }])
    expect(await projection.text({ ...input, ...changed })).toBe("text:all:original");
  expect(native.docxText).toHaveBeenCalledTimes(6);
  expect(await projection.text({ ...input, fileType: "txt" })).toBe("original");
  const updated = Buffer.from("updated");
  expect(await projection.text({ ...input, sourceSha256: sha256(updated), readBytes: async () => updated }))
    .toBe("text:all:updated");
  expect(await projection.text(input, { drafting: true })).toBe("drafting:all:original");
  expect(native.docxText).toHaveBeenCalledTimes(7);
});

it("applies non-native limits after reuse without splitting a surrogate pair", async () => {
  const input = source(Buffer.from("A😀BCD")), projection = await service();
  expect(await projection.text(input, { limit: 2 })).toBe("A😀");
  expect(await projection.text(input, { limit: 0 })).toBe("");
  expect(await projection.text(input, { limit: 4 })).toBe("A😀B");
  expect(await projection.text(input)).toBe("A😀BCD");
  expect(input.readBytes).toHaveBeenCalledOnce();
  for (const limit of [-1, NaN, Infinity, 0.5])
    await expect(projection.text(input, { limit })).rejects.toThrow("nonnegative safe integer");
});

it("retries a failed drafting extraction instead of retaining its plain-text fallback", async () => {
  const input = source(Buffer.from("body"), "docx"), projection = await service();
  native.docxText.mockRejectedValueOnce(new Error("Transient native failure"));
  expect(await projection.text(input, { drafting: true })).toBe("text:all:body");
  expect(await projection.text(input, { drafting: true })).toBe("drafting:all:body");
  expect(await projection.text(input, { drafting: true })).toBe("drafting:all:body");
  expect(native.docxText).toHaveBeenCalledTimes(3);
});

it("does not retain failed extraction, and observes late failure after a reader cancels", async () => {
  const projection = await service(), input = source(Buffer.from("body"), "docx");
  const extraction = deferred<string>(); native.docxText.mockReturnValueOnce(extraction.promise);
  const abort = new AbortController(), pending = projection.text(input, { signal: abort.signal });
  await vi.waitFor(() => expect(native.docxText).toHaveBeenCalledOnce());
  abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  extraction.reject(new Error("Late failure"));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await projection.text(input)).toBe("text:all:body");
  expect(native.docxText).toHaveBeenCalledTimes(2);
});

it("retains valid empty text and rejects unavailable or invalid identities before a hit", async () => {
  const projection = await service(), input = source(Buffer.from("\uFEFF"));
  expect(await projection.text(input)).toBe(""); expect(await projection.text(input)).toBe("");
  expect(input.readBytes).toHaveBeenCalledOnce();
  input.assertAvailable.mockRejectedValueOnce(new Error("Access revoked"));
  await expect(projection.text(input)).rejects.toThrow("Access revoked");
  await expect(projection.text({ ...input, documentId: " invalid" })).rejects.toThrow("valid document");
  const abort = new AbortController(); abort.abort();
  await expect(projection.text(input, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
});

it("keeps the eight-entry LRU and does not pin oversized strings", async () => {
  const projection = await service(), inputs = Array.from({ length: 9 }, () => source());
  for (const input of inputs.slice(0, 8)) await projection.text(input);
  await projection.text(inputs[0]); // touch, so entry 1 is now oldest
  await projection.text(inputs[8]);
  await projection.text(inputs[0]); expect(inputs[0].readBytes).toHaveBeenCalledOnce();
  await projection.text(inputs[1]); expect(inputs[1].readBytes).toHaveBeenCalledTimes(2);
  const large = source(Buffer.from("large"), "docx");
  native.docxText.mockResolvedValue("x".repeat(4 * 1024 * 1024 + 1));
  expect((await projection.text(large)).length).toBe(4 * 1024 * 1024 + 1);
  await projection.text(large); expect(large.readBytes).toHaveBeenCalledTimes(2);
});

it("bounds total retained UTF-16 text as well as entry count", async () => {
  const projection = await service(), first = source(Buffer.from("one"), "docx"), second = source(Buffer.from("two"), "docx");
  native.docxText.mockResolvedValue("x".repeat(3 * 1024 * 1024));
  await projection.text(first); await projection.text(second); await projection.text(first);
  expect(first.readBytes).toHaveBeenCalledTimes(2);
});

it("preserves input/output ceilings and retries corrected raw data", async () => {
  const projection = await service(), empty = source(Buffer.alloc(0));
  await expect(projection.text(empty)).rejects.toThrow("input exceeds");
  const compressed = source(Buffer.alloc(50 * 1024 * 1024 + 1), "pptx");
  await expect(projection.text(compressed)).rejects.toThrow("Compressed document");
  const input = source(Buffer.from("body"), "docx");
  native.docxText.mockResolvedValueOnce("x".repeat(64 * 1024 * 1024 + 1));
  await expect(projection.text(input)).rejects.toThrow("output exceeds");
  expect(await projection.text(input)).toBe("text:all:body");
});

it("captures options and source identity before asynchronous work", async () => {
  const projection = await service(), input = source(Buffer.from("body"), "docx");
  const body = deferred<Buffer>(); input.readBytes.mockImplementation(() => body.promise);
  const options = { drafting: true, limit: 3 };
  const pending = projection.text(input, options);
  options.drafting = false; options.limit = 6; input.versionId = "changed";
  body.resolve(Buffer.from("body"));
  expect(await pending).toBe("drafting:3:body");
});

it("keeps structured native projections separate from text in the shared working set", async () => {
  const projection = await service(), input = source();
  const structured = await projection.read(input);
  expect(typeof structured).toBe("object");
  expect(await projection.text(input)).toBe("source");
  expect(await projection.read(input)).toBe(structured);
  expect(await projection.text(input)).toBe("source");
  expect(input.readBytes).toHaveBeenCalledTimes(2);
});
