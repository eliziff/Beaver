// The legal-structure engine's operations as JavaScript calls them, over one transport that takes a
// dispatch request and returns its reply: the native addon's `call` in Node, the same crate compiled
// to WebAssembly in the browser (native/legal-structure-node/src/dispatch.rs).

const ASYNC = new Set(["deriveDocumentStructure",
  "fixDocxSupraCrossReferences", "docxAuthorityTextUnits", "pdfOpening", "preparePdfDocument", "openSource", "sourceText",
  "pdfPassageGeometry", "quoteLocateDocument", "a2ajDocument", "a2ajSection", "a2ajRecord", "a2ajRecordProvision", "a2ajStoreDocuments"]);
// Positional arguments, named as the dispatch reads them. "bytes" travels as raw bytes, and a reply's bytes are its
// value's `bytes`; "document" is a document's handle, and a reply's `{ $document: handle }` its document.
export const SIGNATURES = {
  nativeBuildFeatures: [],
  deriveDocumentStructure: ["request"],
  fixDocxSupraCrossReferences: ["bytes"],
  docxAuthorityTextUnits: ["bytes"],
  preparePdfDocument: ["bytes", "request"], pdfCacheKey: ["request"],
  pdfOpening: ["bytes"],
  // Annotations appended to the PDF as an incremental update; with disarm (default), its active content taken out.
  pdfWriteAnnotations: ["bytes", "marks", "namespace", "disarm"],
  // A stored source read as its document (none where the engine keeps none and no bytes are given), or as its text.
  openSource: ["bytes", "request"], sourceText: ["bytes", "request"],
  pdfDocumentSummary: ["document"], pdfRecognizedText: ["document", "pages"],
  pdfAuthorityTextUnits: ["document"], pdfPageMap: ["document", "citations"], pdfPageTexts: ["document"],
  pdfPrintedPages: ["document", "citations", "labels"], reporterStartPages: ["citations"],
  pdfPassageGeometry: ["document", "targets", "citations"],
  briefOccurrencePages: ["pages", "units"],
  queryPdfDocument: ["document", "request"],
  docxStructureLint: ["document"],
  documentText: ["document", "limit"], documentTextBytes: ["document"], documentRevision: ["document"],
  readDocumentTextWindow: ["document", "offset", "startChar", "limit"],
  readDocumentTextRange: ["document", "start", "end", "offset", "limit", "startChar"],
  documentAnchors: ["document", "kind", "end"],
  documentOutline: ["document"],
  legalSourceViewer: ["document", "primaryKind", "limit"], documentTableCells: ["document"],
  textOutline: ["text", "kind"], statuteProvisionSpans: ["text", "labels"], collapseLabels: ["labels", "kind"], expandLabels: ["labels", "kind", "limit"],
  statuteCurrency: ["pages"], filingCover: ["opening", "title"],
  searchQuery: ["query", "columns"], renderCitedBlocks: ["blocks"],
  citationLookupKeys: ["texts"], citationKeyVersion: [], providerCitationsInText: ["text"],
  citationEngineCall: ["method", "request"],
  documentReadingOrder: ["units"], footnotePropositions: ["units", "context"],
  citationOccurrencesInText: ["text"], authorityReferencesInText: ["text"],
  hasCitationInText: ["text"],
  groundedProseErrors: ["text", "citedEvidenceIds", "visibleEvidence"],
  quoteRepairSuggestion: ["claim", "spans"], markedQuoteSpans: ["text"], documentTextUnits: ["document", "sentences"],
  quoteComparison: ["authored", "source"],
  quoteLocateDocument: ["document", "source", "quotes", "compare", "keep"], editorialQuote: ["authored", "source"],
  verbatimRepair: ["authored", "source"], quoteOccurrences: ["text", "quote"], quotationDiff: ["authored", "source"], journalTitleSearches: ["citation"], journalTitleChoice: ["hits"],
  readDocumentRange: ["document", "kind", "from", "to", "contextBlocks"],
  canliiCaseUrl: ["citations", "language", "court"], canliiLawUrl: ["text", "language", "consolidated"], canliiCourtRoute: ["court"],
  passageLink: ["document", "request"], citedPassageLink: ["document", "url", "pinpoints"],
  sourceLink: ["document", "request"],
  smallestContainingDocumentBlock: ["document", "start", "end"], documentLocator: ["document", "start", "end", "nodeId"],
  lookupStructureBlock: ["document", "locator", "contextBlocks"],
  resolveDocumentAddressSpans: ["document", "spec", "follow", "depth"],
  graphScope: ["document", "seed", "follow", "depth", "includeDescendants", "includeUnits"],
  documentHasOrigin: ["document", "origin"],
  // The local A2AJ store at `store`, read by the engine.
  a2ajDocument: ["store", "lookup"], a2ajSection: ["store", "lookup", "section", "excerpt"],
  a2ajRecord: ["record", "language", "docType"], a2ajRecordProvision: ["records", "lookup", "excerpt"],
  a2ajRecordListing: ["record", "language"], a2ajRecordMatches: ["records", "query"],
  a2ajAliasGroups: ["store", "keys"], a2ajNamedCase: ["store", "named"], a2ajNamedRecord: ["records", "named", "language"], a2ajNameKeys: ["names"],
  a2ajSearch: ["store", "search"], a2ajCourts: ["store"], a2ajFind: ["store", "lookup"], a2ajStoreDocuments: ["store", "ids", "docType", "language"], a2ajReads: ["store", "ids", "docType", "language"],
  // The citator's graph, read beside the A2AJ store at `store`, which also gives a note-up its keys.
  citatorNoteUp: ["store", "request"], citatorMetrics: ["store", "citations"],
};
// Readings of text alone, which an operation's stages repeat: a request asked before is answered with the reply it
// had, read afresh, from the latest this many.
const PURE = new Set(["providerCitationsInText", "citationOccurrencesInText", "citationLookupKeys",
  "canliiCaseUrl", "canliiLawUrl"]);
const PURE_KEPT = 4096;

/** A failure the engine returned (`engine::Failure`): its message, and for a PDF's parse the kind of failure and what
 *  went wrong. The engine is still usable afterwards. */
class EngineError extends Error {
  constructor({ message, kind, detail }) { super(message); if (kind) this.kind = kind; if (detail) this.detail = detail; }
}
/** An opaque engine document, released when JavaScript no longer references it. */
class NativeDocumentHandle { constructor(handle, generation) { this.handle = handle; this.generation = generation; } }

const encoder = new TextEncoder(), decoder = new TextDecoder();
/** `[u32 json length][json {op, args}][bytes]` */
function engineRequest(op, args, bytes) {
  const json = encoder.encode(JSON.stringify({ op, args }));
  const request = new Uint8Array(4 + json.length + bytes.length);
  new DataView(request.buffer).setUint32(0, json.length, true);
  request.set(json, 4);
  request.set(bytes, 4 + json.length);
  return request;
}
/** `[u8 ok][u32 json length][json][bytes]`, the json read by `revive`. */
function engineReply(reply, revive) {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const jsonLength = view.getUint32(1, true);
  const text = decoder.decode(reply.subarray(5, 5 + jsonLength));
  if (!view.getUint8(0)) throw new EngineError(JSON.parse(text));
  return { value: JSON.parse(text, revive), bytes: reply.subarray(5 + jsonLength) };
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
export function structureEngineAddon(transport, { toBuffer = (bytes) => bytes, recognizePdf, parser } = {}) {
  // A trapped engine restarts; documents belong to the engine that made them.
  let generation = 1;
  // A released document is freed off this thread where the host can: freeing a large one holds up whatever runs here.
  const released = new FinalizationRegistry(({ handle, generation: owner }) => {
    if (owner !== generation) return;
    const request = engineRequest("releaseDocument", { document: handle }, new Uint8Array());
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
    const args = {}; let bytes = new Uint8Array();
    SIGNATURES[name].forEach((key, index) => {
      const value = positional[index];
      if (key === "bytes") bytes = value ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : bytes;
      else if (key === "document") {
        if (value?.generation !== generation)
          throw new Error("This document was lost when the engine restarted. Reopen it and try again.");
        args.document = value.handle;
      } else args[key] = value ?? null;
    });
    return engineRequest(name, args, bytes);
  }
  // A document a reply holds, as JavaScript holds it.
  function revive(_key, value) {
    if (typeof value?.$document !== "number") return value;
    const document = new NativeDocumentHandle(value.$document, generation);
    released.register(document, { handle: value.$document, generation });
    return document;
  }
  const result = ({ value, bytes }) => bytes.length ? { ...value, bytes: toBuffer(bytes.slice()) } : value;
  const replies = new Map();
  function invoke(name, positional) {
    const key = PURE.has(name) ? `${name}${JSON.stringify(positional)}` : null;
    const kept = key && replies.get(key);
    if (kept) { replies.delete(key); replies.set(key, kept); return result(engineReply(kept, revive)); }
    const framed = request(name, positional);
    let reply, read;
    try { reply = transport.call(framed); read = engineReply(reply, revive); }
    catch (error) { throw trapped(error, name); }
    if (key) {
      replies.set(key, reply);
      if (replies.size > PURE_KEPT) replies.delete(replies.keys().next().value);
    }
    return result(read);
  }
  async function invokeOff(name, positional, progress) {
    if (transport.prepare) await transport.prepare();
    if (!transport.callAsync) return invoke(name, positional);
    const framed = request(name, positional);
    let reply;
    try { reply = engineReply(await transport.callAsync(framed, progress), revive); }
    catch (error) { throw trapped(error, name); }
    return result(reply);
  }
  // A wait an abandoned asker leaves, without cancelling the work it shares with others.
  const abandonable = (pending, signal) => !signal ? pending : Promise.race([pending, new Promise((_, reject) => {
    signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
  // Readings being made for this engine by its host, by cache key: a second asker waits for the first's.
  const preparing = new Map();
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
    // Without bytes, only a reading this engine can name itself is found: one asking for no recognition or layout.
    else if (!bytes) return ocr || layout ? null : reopen();
    const { cacheKey: _named, ...asked } = source.pdf ?? {};
    let request = { ...asked, id: `${source.documentId}:${source.versionId}`, expectedSourceSha256: source.sourceSha256 };
    if (recognizePdf && request.ocr) {
      const { ocr: _ocr, ...plain } = asked;
      const inspected = invoke("pdfDocumentSummary", [await hostPdf(bytes, { ...source, pdf: plain }, signal)]);
      const pages = inspected.pagesNeedingOcr.filter(index => !request.pages || request.pages.includes(index + 1));
      const supplied = pages.length ? await recognizePdf(bytes, inspected.sha256, pages, signal,
        progress && (done => progress(done, pages.length))) : undefined;
      signal?.throwIfAborted();
      const { ocr: _requested, ...rest } = request;
      request = { ...rest, ...(supplied ? { suppliedOcr: supplied } : {}) };
    }
    const cacheKey = invoke("pdfCacheKey", [request]);
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
    if (name !== "openSource" && name !== "preparePdfDocument") return invokeOff(name, positional);
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
  for (const name of Object.keys(SIGNATURES)) addon[name] = ASYNC.has(name)
    ? (...positional) => invokeAsync(name, positional)
    : (...positional) => invoke(name, positional);
  return addon;
}
