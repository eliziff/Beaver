// The legal-structure engine's operations as JavaScript calls them, over one transport that takes a
// dispatch request and returns its reply: the native addon's `call` in Node, the same crate compiled
// to WebAssembly in the browser (native/legal-structure-node/src/dispatch.rs).

const ASYNC = new Set(["deriveDocumentStructure", "deriveDocumentFingerprint",
  "fixDocxSupraCrossReferences", "deriveDocxDocument", "docxText",
  "docxAuthorityTextUnits", "derivePdfDocument", "preparePdfDocument", "restorePdfDocument",
  "pdfPassageGeometryPages", "quoteLocateDocument", "a2ajDocument", "a2ajSection",
  "citationEngineCallAsync"]);
// Positional arguments, named as the dispatch reads them. "bytes" travels as raw bytes;
// "document" is a handle.
export const SIGNATURES = {
  nativeBuildFeatures: [],
  structureCompositionBlocks: ["request"],
  applyStructureComposition: ["request"],
  resolveCompositionAnnotations: ["request"],
  deriveDocumentStructure: ["request"], deriveDocumentFingerprint: ["request"],
  fixDocxSupraCrossReferences: ["bytes"],
  deriveDocxDocument: ["bytes", "id", "drafting"], docxText: ["bytes", "drafting", "limit"],
  docxAuthorityTextUnits: ["bytes"],
  derivePdfDocument: ["bytes", "request"], preparePdfDocument: ["bytes", "request"],
  restorePdfDocument: ["request"],
  pdfDocumentSummary: ["document"], pdfRecognizedText: ["document", "pages"],
  pdfAuthorityTextUnits: ["document"], pdfPageLabels: ["document"], pdfPageTexts: ["document"],
  pdfPassageGeometryPages: ["document", "targets"],
  pdfLookupUnitSpans: ["document", "ids"],
  queryPdfDocument: ["document", "locatorKind", "locator", "endLocator", "contextBlocks", "page", "occurrence"],
  docxStructureLint: ["document"],
  documentText: ["document", "limit"], documentTextBytes: ["document"], documentRevision: ["document"],
  readDocumentTextWindow: ["document", "offset", "startChar", "limit"],
  readDocumentTextRange: ["document", "start", "end", "offset", "limit", "startChar"],
  documentFingerprint: ["document"], documentAnchors: ["document", "end"],
  documentOutline: ["document", "legislation"],
  sourceMarkup: ["document"], sourceOpinionComponents: ["document"],
  sourceParagraphMarkers: ["document"], sourceParagraphMarker: ["document", "markupStart"],
  legalSourceViewer: ["document", "primaryKind", "limit"], documentTableCells: ["document"],
  statuteOutline: ["text", "articles"], caseOutline: ["text"], documentCaseOutline: ["document"], statuteProvisionSpans: ["text", "labels"],
  statuteCurrency: ["pages"], filingCover: ["opening", "title"],
  citationLookupKey: ["text"], citationLookupKeys: ["texts"], providerCitationsInText: ["text"],
  citationEngineCall: ["method", "request"], citationEngineCallAsync: ["method", "request"],
  documentReadingOrder: ["request"],
  citationOccurrencesInText: ["text"], authorityReferencesInText: ["text"],
  caselawCitationLookupKey: ["text"], hasCitationInText: ["text"],
  classifyCitatorExcerpt: ["text"], classifyCitatorExcerpts: ["texts"],
  groundedProseErrors: ["text", "citedEvidenceIds", "visibleEvidence"],
  quoteRepairSuggestion: ["claim", "spans"], markedQuoteSpans: ["text"], textUnits: ["text", "sentences"],
  quoteComparison: ["authored", "source"],
  quoteLocateDocument: ["document", "source", "quotes", "compare"], editorialQuote: ["authored", "source"],
  verbatimRepair: ["authored", "source"], journalTitleSearches: ["citation"], journalTitleChoice: ["hits"],
  readDocumentRange: ["document", "kind", "from", "to", "contextBlocks"],
  canliiCaseUrl: ["citations", "language", "court"], canliiLawUrl: ["text"], canliiCourtRoute: ["court"],
  canliiA2ajLawUrl: ["dataset", "citation", "language"],
  passageLink: ["document", "request"], citedPassageLink: ["document", "url", "pinpoints"],
  sourceLinks: ["document", "request"],
  lawWebLink: ["document", "citation", "docType", "blockText", "quotes"],
  smallestContainingDocumentBlock: ["document", "start", "end"],
  lookupStructureBlock: ["document", "locator", "contextBlocks"],
  resolveDocumentAddressSpans: ["document", "spec", "follow", "depth"],
  graphScope: ["document", "seed", "follow", "depth", "includeDescendants", "includeUnits"],
  documentHasOrigin: ["document", "origin"],
  // The local A2AJ store at `store`, read by the engine.
  a2ajDocument: ["store", "lookup"], a2ajSection: ["store", "lookup", "section", "excerpt"],
  a2ajAliasGroups: ["store", "citations"],
};
// Readings of text alone, which an operation's stages repeat: a request asked before is answered with the reply it
// had, read afresh, from the latest this many.
const PURE = new Set(["providerCitationsInText", "citationOccurrencesInText", "citationLookupKey", "citationLookupKeys",
  "caselawCitationLookupKey", "canliiCaseUrl", "canliiLawUrl"]);
const PURE_KEPT = 4096;
const DOCUMENT_RESULTS = new Set(["deriveDocumentStructure", "deriveDocxDocument",
  "derivePdfDocument", "restorePdfDocument"]);

/** An error the engine returned; it is still usable afterwards. */
class EngineError extends Error {}
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
/** `[u8 ok][u32 json length][json][bytes]` */
function engineReply(reply) {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const jsonLength = view.getUint32(1, true);
  const text = decoder.decode(reply.subarray(5, 5 + jsonLength));
  if (!view.getUint8(0)) throw new EngineError(text);
  return { value: JSON.parse(text), bytes: reply.subarray(5 + jsonLength) };
}

/**
 * @param {{ call(request: Uint8Array): Uint8Array,
 *   callAsync?(request: Uint8Array, progress?: (done: number, total: number) => void): Promise<Uint8Array>,
 *   restart?(): string }} transport
 *   `call` runs an operation now; `callAsync`, where the host has one, off its thread. `restart`
 *   drops an engine that a call interrupted (a trap) and returns the reason it last gave.
 * @param {{ toBuffer?: (bytes: Uint8Array) => Uint8Array, recognizePdf?: Function,
 *   parser?: { prepare(bytes, request, signal): Promise<object>, seed(sha256): Promise<void> } }} [host]
 *   `toBuffer` wraps result bytes as the host's Buffer; `recognizePdf` recognizes scanned pages in the
 *   host; `parser` prepares PDFs elsewhere, writing the parse cache where this engine reads it.
 */
export function structureEngineAddon(transport, { toBuffer = (bytes) => bytes, recognizePdf, parser } = {}) {
  // A trapped engine restarts; documents belong to the engine that made them.
  let generation = 1;
  const released = new FinalizationRegistry(({ handle, generation: owner }) => {
    if (owner !== generation) return;
    try { engineReply(transport.call(engineRequest("releaseDocument", { document: handle }, new Uint8Array()))); }
    catch { /* engine already reset */ }
  });
  function trapped(error, op) {
    if (error instanceof EngineError) return new Error(error.message);
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
  function handle(value) {
    if (!value) return null;
    const document = new NativeDocumentHandle(value.handle, generation);
    released.register(document, { handle: value.handle, generation });
    return document;
  }
  function result(name, { value, bytes }) {
    if (DOCUMENT_RESULTS.has(name)) return handle(value);
    // A store's document: its full text's document is its provisions' where the engine names none.
    if (name === "a2ajDocument" && value) {
      const native = handle(value.native);
      return { ...value.metadata, native, searchNative: handle(value.searchNative) ?? native };
    }
    if (name === "a2ajSection" && value) return { native: handle(value.native) };
    if (name === "fixDocxSupraCrossReferences") return { ...value, bytes: toBuffer(bytes.slice()) };
    return value;
  }
  const replies = new Map();
  function invoke(name, positional) {
    const key = PURE.has(name) ? `${name}${JSON.stringify(positional)}` : null;
    const kept = key && replies.get(key);
    if (kept) { replies.delete(key); replies.set(key, kept); return result(name, engineReply(kept)); }
    const framed = request(name, positional);
    let reply, read;
    try { reply = transport.call(framed); read = engineReply(reply); }
    catch (error) { throw trapped(error, name); }
    if (key) {
      replies.set(key, reply);
      if (replies.size > PURE_KEPT) replies.delete(replies.keys().next().value);
    }
    return result(name, read);
  }
  async function invokeOff(name, positional, progress) {
    if (!transport.callAsync) return invoke(name, positional);
    const framed = request(name, positional);
    let reply;
    try { reply = engineReply(await transport.callAsync(framed, progress)); }
    catch (error) { throw trapped(error, name); }
    return result(name, reply);
  }
  // A host parser prepares PDFs off this engine's thread and leaves the parse cache readable here.
  const prepare = (bytes, request, signal) => parser
    ? parser.prepare(bytes, request, signal) : invokeOff("preparePdfDocument", [bytes, request]);
  async function invokeAsync(name, positional) {
    if (name === "restorePdfDocument") await parser?.seed(positional[0]?.expected_source_sha256);
    if (!["preparePdfDocument", "derivePdfDocument"].includes(name)) return invokeOff(name, positional);
    const [bytes, request, signal, progress] = positional;
    signal?.throwIfAborted();
    let final = request;
    if (recognizePdf && request?.ocr) {
      const { ocr, ...plain } = request;
      const inspected = await prepare(bytes, plain, signal);
      const pages = inspected.pagesNeedingOcr.filter(index => !request.pages || request.pages.includes(index + 1));
      const supplied = pages.length ? await recognizePdf(bytes, inspected.sha256, pages, signal,
        progress && (done => progress(done, pages.length))) : undefined;
      signal?.throwIfAborted();
      final = { ...plain, ...(supplied ? { supplied_ocr: supplied } : {}) };
    }
    if (!parser) return invokeOff(name, [bytes, final], progress);
    const summary = await parser.prepare(bytes, final, signal);
    if (name === "preparePdfDocument") return summary;
    // The parse is cached: this engine reads the document from that cache.
    const { ocr: _ocr, supplied_ocr: _supplied, ...cached } = final;
    return invoke("restorePdfDocument", [{ ...cached, cache_key: summary.cacheKey,
      expected_source_sha256: summary.sha256 }]) ?? invokeOff(name, [bytes, final]);
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
  // Where the host has threads, the citation engine builds its grammars and tables off this one as the engine starts,
  // so the first document read waits for none; without them each is built on first use.
  if (transport.callAsync) void invokeOff("citationEngineCall", ["warm", "{}"]).catch(() => {});
  return addon;
}
