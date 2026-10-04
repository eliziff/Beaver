// The legal-structure engine's operations as JavaScript calls them, over one transport that takes a
// dispatch request and returns its reply: the native addon's `call` in Node, the same crate compiled
// to WebAssembly in the browser (native/legal-structure-node/src/dispatch.rs).

const ASYNC = new Set(["deriveDocumentStructure", "deriveDocumentFingerprint",
  "fixDocxSupraCrossReferences", "hasDocxSupraReferences", "deriveDocxDocument", "docxText",
  "docxAuthorityTextUnits", "derivePdfDocument", "preparePdfDocument", "restorePdfDocument",
  "pdfPassageGeometryPages"]);
// Positional arguments, named as the dispatch reads them. "bytes" travels as raw bytes;
// "document" is a handle.
export const SIGNATURES = {
  nativeBuildFeatures: [],
  deriveDocumentStructure: ["request"], deriveDocumentFingerprint: ["request"],
  fixDocxSupraCrossReferences: ["bytes"], hasDocxSupraReferences: ["bytes"],
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
  readDocumentTextRange: ["document", "start", "end", "offset", "limit"],
  documentFingerprint: ["document"], documentAnchors: ["document", "end"],
  documentOutline: ["document", "legislation"],
  legalSourceViewer: ["document", "primaryKind", "limit"], documentTableCells: ["document"],
  statuteOutline: ["text", "articles"], caseOutline: ["text"],
  citationLookupKey: ["text"], citationLookupKeys: ["texts"], providerCitationsInText: ["text"],
  citationEngineCall: ["method", "request"],
  documentReadingOrder: ["request"],
  citationOccurrencesInText: ["text"], authorityReferencesInText: ["text"],
  caselawCitationLookupKey: ["text"], hasCitationInText: ["text"],
  classifyCitatorExcerpt: ["text"], classifyCitatorExcerpts: ["texts"],
  groundedProseErrors: ["text", "citedEvidenceIds", "visibleEvidence"],
  quoteRepairSuggestion: ["claim", "spans"], markedQuoteSpans: ["text"],
  readDocumentRange: ["document", "kind", "from", "to", "contextBlocks"],
  smallestContainingDocumentBlock: ["document", "start", "end"],
  textFragmentPlan: ["blockText", "quotes", "pdf", "publisherMayAnnotateLegalReference",
    "splitHtmlSourceBlocks", "document"],
  textFragmentPlanStandalone: ["blockText", "quotes", "pdf", "publisherMayAnnotateLegalReference",
    "splitHtmlSourceBlocks"],
  documentParagraphRangeDirective: ["document", "start", "end"],
  lookupStructureBlock: ["document", "locator", "contextBlocks"],
  resolveDocumentAddressSpans: ["document", "spec", "follow", "depth"],
  graphScope: ["document", "seedLabel", "follow", "depth", "includeDescendants", "includeUnits"],
  documentHasOrigin: ["document", "origin"],
};
const DOCUMENT_RESULTS = new Set(["deriveDocumentStructure", "deriveDocxDocument",
  "derivePdfDocument", "restorePdfDocument"]);

/** An error the engine returned; it is still usable afterwards. */
class EngineError extends Error {}
/** An opaque engine document, released when JavaScript no longer references it. */
class NativeDocumentHandle { constructor(handle, generation) { this.handle = handle; this.generation = generation; } }

/** Readies an engine before its first real call: the citation engine builds its grammars on first use. */
export const warmStructureAddon = (addon) => addon.citationEngineCall("extract",
  JSON.stringify({ text: "R v Oakes, [1986] 1 SCR 103", offsetUnit: "utf16", options: { resolve: false } }));

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
  function result(name, { value, bytes }) {
    if (DOCUMENT_RESULTS.has(name)) {
      if (!value) return null;
      const document = new NativeDocumentHandle(value.handle, generation);
      released.register(document, { handle: value.handle, generation });
      return document;
    }
    if (name === "fixDocxSupraCrossReferences") return { ...value, bytes: toBuffer(bytes.slice()) };
    return value;
  }
  function invoke(name, positional) {
    const framed = request(name, positional);
    try { return result(name, engineReply(transport.call(framed))); }
    catch (error) { throw trapped(error, name); }
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
  const addon = { schedulesRecognition: !!recognizePdf };
  for (const name of Object.keys(SIGNATURES)) addon[name] = ASYNC.has(name)
    ? (...positional) => invokeAsync(name, positional)
    : (...positional) => invoke(name, positional);
  return addon;
}
