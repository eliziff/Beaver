// The legal-structure engine's operations as JavaScript calls them, over one transport that takes a
// dispatch request and returns its reply: the native addon's `call` in Node, the same crate compiled
// to WebAssembly in the browser (native/legal-structure-node/src/dispatch.rs, whose table of operations
// export-types writes to engine-types/operations.mjs). An argument named "document" is a document, sent
// as its handle; a reply's `{ $document: handle }` is its document.

import { OPERATIONS } from "./engine-types/operations.mjs";

/** A failure the engine returned (`engine::Failure`): its message, and for a PDF's parse the kind of failure and what
 *  went wrong. The engine is still usable afterwards. */
class EngineError extends Error {
  constructor({ message, kind, detail }) { super(message); if (kind) this.kind = kind; if (detail) this.detail = detail; }
}
/** An opaque engine document, released when JavaScript no longer references it; sent to the engine, wherever a
 *  request holds it, as its handle in the engine that made it. */
class NativeDocumentHandle {
  constructor(handle, generation, current) { this.handle = handle; this.generation = generation; this.current = current; }
  toJSON() {
    if (this.generation !== this.current()) throw new Error("This document was lost when the engine restarted. Reopen it and try again.");
    return this.handle;
  }
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
/** `[u32 json length][json {op, args}][bytes]`, `args` positional: with `lift`, each Uint8Array they hold is
 *  `{ $bytes: [offset, length] }` in the bytes after the JSON, lifted before the JSON is written: a replacer would see a
 *  Node Buffer only after its own toJSON had written it out as an array of every byte. */
function engineRequest(op, args, lift) {
  const chunks = []; let length = 0;
  const lifted = (value) => value instanceof Uint8Array ? (chunks.push(value), { $bytes: [(length += value.byteLength) - value.byteLength,
    value.byteLength] }) : Array.isArray(value) ? value.map(lifted) : value && typeof value === "object" && typeof value.toJSON !== "function"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, lifted(item)])) : value;
  const json = encoder.encode(JSON.stringify({ op, args: lift ? lifted(args) : args }));
  const request = new Uint8Array(4 + json.length + length);
  new DataView(request.buffer).setUint32(0, json.length, true);
  request.set(json, 4);
  let at = 4 + json.length;
  for (const chunk of chunks) { request.set(chunk, at); at += chunk.byteLength; }
  return request;
}
/** `[u8 ok][u32 json length][json][bytes]`, the json read by `revive(key, value, bytes)`. */
function engineReply(reply, revive) {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const jsonLength = view.getUint32(1, true);
  const text = decoder.decode(reply.subarray(5, 5 + jsonLength));
  if (!view.getUint8(0)) throw new EngineError(JSON.parse(text));
  const bytes = reply.subarray(5 + jsonLength);
  // A reviver is called for every value of the reply (a 21,602-entry outline: 15 ms parsed, 140 ms revived): a reply
  // is revived only where it holds a document or bytes.
  const holds = revive && (text.includes('"$document"') || text.includes('"$bytes"'));
  return JSON.parse(text, holds ? (key, value) => revive(key, value, bytes) : undefined);
}

/**
 * @param {{ call(request: Uint8Array): Uint8Array,
 *   callAsync?(request: Uint8Array, progress?: (done: number, total: number) => void): Promise<Uint8Array>,
 *   restart?(): string }} transport
 *   `call` runs an operation now; `callAsync`, where the host has one, off its thread. `restart`
 *   drops an engine that a call interrupted (a trap) and returns the reason it last gave.
 * @param {{ toBuffer?: (bytes: Uint8Array) => Uint8Array, recognizePdf?: Function,
 *   parser?: { prepare(bytes, request): Promise<object>, seed(sha256): Promise<void> } }} [host]
 *   `toBuffer` wraps result bytes as the host's Buffer; `recognizePdf` recognizes scanned pages in the
 *   host; `parser` prepares PDFs this engine has no cache of elsewhere, writing the parse cache where it reads it.
 */
/** A wait an abandoned asker leaves, without cancelling the work it shares with others. */
export const abandonable = (pending, signal) => !signal ? pending : Promise.race([pending, new Promise((_, reject) => {
  signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
})]);

export function structureEngineAddon(transport, { toBuffer = (bytes) => bytes, recognizePdf, parser } = {}) {
  // A trapped engine restarts; documents belong to the engine that made them.
  let generation = 1;
  // A released document is freed off this thread where the host can: freeing a large one holds up whatever runs here.
  const released = new FinalizationRegistry(({ handle, generation: owner }) => {
    if (owner !== generation) return;
    const request = engineRequest("releaseDocument", [handle]);
    if (transport.callAsync) void transport.callAsync(request).catch(() => { /* engine already reset */ });
    else try { engineReply(transport.call(request)); } catch { /* engine already reset */ }
  });
  function trapped(error, op) {
    if (error instanceof EngineError) return Object.assign(new Error(error.message),
      error.kind ? { kind: error.kind } : {}, error.detail ? { detail: error.detail } : {});
    // Anything else interrupted the engine mid-call: a trap, or a stack overflow, which V8
    // reports as a RangeError and which leaves the engine's stack pointer and heap behind.
    generation += 1;
    return new Error(transport.restart?.() || `The legal-structure engine failed during ${op}.`);
  }
  function request(name, positional) {
    const { args, bytes } = OPERATIONS[name];
    if (args.some((key, index) => key === "document" && !(positional[index] instanceof NativeDocumentHandle)))
      throw new Error("This document was lost when the engine restarted. Reopen it and try again.");
    return engineRequest(name, args.map((_, index) => positional[index] ?? null), bytes);
  }
  // A document a reply holds, as JavaScript holds it, and its bytes as the host's buffer.
  function revive(_key, value, bytes) {
    if (Array.isArray(value?.$bytes)) return toBuffer(bytes.slice(value.$bytes[0], value.$bytes[0] + value.$bytes[1]));
    if (typeof value?.$document !== "number") return value;
    const document = new NativeDocumentHandle(value.$document, generation, () => generation);
    released.register(document, { handle: value.$document, generation });
    return document;
  }
  function invoke(name, positional) {
    const framed = request(name, positional);
    try { return engineReply(transport.call(framed), revive); }
    catch (error) { throw trapped(error, name); }
  }
  async function invokeOff(name, positional, progress) {
    if (transport.prepare) await transport.prepare();
    if (!transport.callAsync) return invoke(name, positional);
    const framed = request(name, positional);
    let reply;
    try { reply = engineReply(await transport.callAsync(framed, progress), revive); }
    catch (error) { throw trapped(error, name); }
    return reply;
  }
  // Readings being made for this engine by its host, by cache key: a second asker waits for the first's.
  const preparing = new Map();
  // The cache key of each reading the host recognized, by the request it answered: its key holds the recognition, so
  // the engine cannot name it from the request alone.
  const recognized = new Map();
  // A PDF the host reads for this engine: parsed in its parse workers (`parser`), its scanned pages recognized by its
  // own recognizers (`recognizePdf`) in place of the engine's, and reopened here by its cache key. A reading already
  // cached is reopened without asking the host.
  async function hostPdf(bytes, source, signal, progress) {
    await parser?.seed(source.sourceSha256);
    const { ocr, layout, cacheKey: named, ...pdf } = source.pdf ?? {};
    const reopen = (cacheKey) => invokeOff("openSource", [undefined, { ...source, pdf: { ...pdf, cacheKey } }]);
    if (named) {
      // A reading no longer cached is made again from the bytes, as the engine itself does; it may have a key of its own.
      const kept = await reopen(named);
      if (kept || !bytes) return kept;
    }
    const { cacheKey: _named, ...asked } = source.pdf ?? {};
    let request = { ...asked, id: `${source.documentId}:${source.versionId}`, expectedSourceSha256: source.sourceSha256 };
    const asking = recognizePdf && request.ocr ? JSON.stringify(request) : null;
    const known = asking && recognized.get(asking), again = known && await reopen(known);
    if (again) return again;
    // Without bytes, only a reading this engine can name itself is found: one asking for no recognition or layout.
    if (!named && !bytes) return ocr || layout ? null : reopen();
    if (recognizePdf && request.ocr) {
      const { ocr: _ocr, ...plain } = asked;
      // Which pages need reading is the extraction's to say: the PDF's structure is read once, with their text.
      const plainRequest = { ...plain, id: request.id, expectedSourceSha256: source.sourceSha256 };
      // In a parse worker where the host has them, whose extraction the parse after it then reads back.
      const needing = await (parser?.pagesNeedingOcr ? parser.pagesNeedingOcr(bytes, plainRequest)
        : invokeOff("pdfPagesNeedingOcr", [bytes, plainRequest]));
      const pages = needing.filter(index => !request.pages || request.pages.includes(index + 1));
      const supplied = pages.length ? await recognizePdf(bytes, source.sourceSha256, pages, signal,
        progress && (done => progress(done, pages.length))) : undefined;
      signal?.throwIfAborted();
      const { ocr: _requested, ...rest } = request;
      request = { ...rest, ...(supplied ? { suppliedOcr: supplied } : {}) };
    }
    const cacheKey = invoke("pdfCacheKey", [bytes, request]);
    if (asking) recognized.set(asking, cacheKey);
    const kept = await reopen(cacheKey);
    if (kept) return kept;
    let pending = preparing.get(cacheKey);
    if (!pending) {
      pending = (parser ? parser.prepare(bytes, request) : invokeOff("preparePdfDocument", [bytes, request], progress))
        .finally(() => preparing.delete(cacheKey));
      preparing.set(cacheKey, pending);
    }
    return reopen((await abandonable(pending, signal)).cacheKey);
  }
  async function invokeAsync(name, positional) {
    // A host with parse workers extracts there, its extraction kept where the parse after it reads it back.
    if (name === "pdfPagesNeedingOcr" && parser?.pagesNeedingOcr) return parser.pagesNeedingOcr(positional[0], positional[1]);
    if (OPERATIONS[name].mode !== "progress") return invokeOff(name, positional);
    const [bytes, request, signal, progress] = positional;
    signal?.throwIfAborted();
    if (name === "openSource" && (parser || recognizePdf) && request?.fileType === "pdf")
      return hostPdf(bytes, request, signal, progress);
    return invokeOff(name, [bytes, request], progress);
  }
  // The page reads every pass's pages on its own pool of recognizers, so passes need not wait their turn.
  const addon = { schedulesRecognition: !!recognizePdf,
    /** Whether a document belongs to the engine now running. */
    documentLive: (document) => document?.generation === generation,
    /** The engine's memory, where its host can tell: WebAssembly's never shrinks. */
    memoryBytes: () => transport.memoryBytes?.() ?? 0,
    /** Starts the engine afresh, giving back the memory it grew to; its documents are lost. */
    recycle() { generation += 1; transport.restart?.(); },
    /** A synchronous operation run off this thread, for a call long enough to hold up the event loop. */
    offThread: (name, ...positional) => invokeOff(name, positional) };
  for (const [name, { mode }] of Object.entries(OPERATIONS)) addon[name] = mode === "now"
    ? (...positional) => invoke(name, positional)
    : (...positional) => invokeAsync(name, positional);
  return addon;
}
