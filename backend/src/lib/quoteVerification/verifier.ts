/** The quote verifier: one pipeline for every host that checks a brief's or article's quotations and citations — Beaver's
 *  quote check, the ALR Quote Verifier's pages and Word add-in, and Beaver's citation links. A host supplies the draft and
 *  the PDFs attached for its authorities; this checks the quotations, writes the "[CHECKED]" workbook and the results
 *  read onto the document's text, and writes those results (corrections, highlights, links) into its Word file. */
import { reject } from "../applicationError";
import { attachedAuthoritySources, type AuthoritiesDraft } from "../authoritiesDomain";
import { documentProjectionService } from "../documentProjectionService";
import { writeDocxSpans } from "../docxOperations";
import { sha256 } from "../hash";
import { legalSourceOperations } from "../legalSourceApplication";
import { FOREIGN_CASE_PROVIDERS, type LegalSourcePassageRequest, type LegalSourceReference,
  type LegalSourceResolveRequest } from "../legalSources";
import { checkQuotes, type QuoteLink } from "../quoteCheck";
import type { QuoteContext } from "../authoritiesQuotations";
import type { NativeDocument } from "../structureNative";
import { alrCheckedWorkbook, type AlrModel, type AlrWorkbookOptions } from "./checkedWorkbook";
import { documentWrites, wordResult, type WordCitation, type WordCopy, type WordResult } from "./wordResult";

export type QuoteVerification = Awaited<ReturnType<typeof checkQuotes>>;
export type AttachedSources = Map<string, { document: NativeDocument; source: LegalSourceReference }>;

/** The PDFs a host attached for the draft's authorities, by authority, read as documents: a quotation is checked against
 *  its authority's PDF, and a decision's pinpointed link takes its passage from it. `strict` rejects a PDF that no
 *  longer matches its authority's source; otherwise it is left out. */
export async function attachedSourceDocuments(draft: AuthoritiesDraft, files: ReadonlyArray<{ role: string; bytes: Uint8Array }>,
  signal?: AbortSignal, strict = false): Promise<AttachedSources> {
  const attached: AttachedSources = new Map();
  for (const file of files) {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength), digest = sha256(bytes);
    const authority = Object.values(draft.authorities).find((item) => attachedAuthoritySources(item.source)
      .some((source) => source.bindingRole === file.role && source.sourceSha256 === digest));
    if (!authority) {
      if (strict) reject(409, "An attached PDF changed. Add the current file before continuing.");
      continue;
    }
    const pdf = attachedAuthoritySources(authority.source).find((source) => source.bindingRole === file.role)!;
    attached.set(authority.id, { document: await documentProjectionService.read({ documentId: `standalone-authority:${digest}`,
      versionId: digest, sourceSha256: digest, fileType: "pdf", readBytes: () => bytes }, { signal }),
    source: { provider: "attached", id: digest, kind: authority.kind === "legislation" ? "legislation" : "case",
      citation: authority.citation, title: authority.displayName ?? authority.name, url: pdf.sourceUrl } });
  }
  return attached;
}

export type VerifyOptions = {
  links?: QuoteLink[]; attached?: AttachedSources;
  /** Providers left out of the check (a draft that leaves out foreign decisions leaves them out too). */
  excludedProviders?: readonly string[];
  /** Whether a publisher's PDF is looked for; the verifier links to the providers' pages, so by default it is not. */
  discoverPdfs?: boolean;
  /** Each quotation against every source its note cites (the default), else against its note's first or linked one. */
  allCitations?: boolean;
  /** "sentence" checks only the quotations in the sentence a note's marker ends or stands in. */
  quoteContext?: QuoteContext;
  /** "text" checks the text's quotations alone, none a note holds. */
  quotations?: "text";
  /** false locates each quotation without comparing it: where a caller reads only where the quotation is. */
  compare?: boolean;
  window?: { offset: number; limit: number };
  progress?: Parameters<typeof checkQuotes>[3];
  signal?: AbortSignal;
};

/** The draft's quotations, each checked against its cited sources. */
export function verifyQuotations(draft: AuthoritiesDraft, options: VerifyOptions = {}) {
  const excluded = new Set([...draft.settings.foreignCaseLookup === false ? FOREIGN_CASE_PROVIDERS : [],
    ...options.excludedProviders ?? []]);
  const providers = excluded.size ? legalSourceOperations.providerIds.filter((id) => !excluded.has(id)) : undefined;
  const discoverPdf = options.discoverPdfs === true ? undefined : false;
  const sources = { ...legalSourceOperations,
    resolve: (request: LegalSourceResolveRequest) => legalSourceOperations.resolve({ ...request, providers, discoverPdf }),
    readPassage: (request: LegalSourcePassageRequest) => legalSourceOperations.readPassage({ ...request, discoverPdf }) };
  return checkQuotes(draft, options.links, options.signal, options.progress, sources, options.window, options.attached,
    { firstCitationOnly: options.allCitations === false, quoteContext: options.quoteContext ?? "passage",
      textOnly: options.quotations === "text", compare: options.compare !== false });
}

/** "[CHECKED] <stem>.xlsx" for a check of the draft, and its results read onto the document's text (each note's parts
 *  and links, each quotation's corrections), for a Word copy or Word's pane. */
export async function verificationResults(filename: string, draft: AuthoritiesDraft, check: QuoteVerification, input: {
  options?: AlrWorkbookOptions; model?: AlrModel; attached?: AttachedSources; wordCitation?: WordCitation;
  signal?: AbortSignal; progress?: (message: string) => void;
} = {}) {
  const documents = input.attached && new Map([...input.attached].map(([id, { document }]) => [id, document]));
  const written = await alrCheckedWorkbook(filename, draft, check, input.options, input.model, input.signal, documents,
    input.progress);
  return { ...written, word: wordResult(draft, check, written.rows, input.wordCitation ?? "first") };
}

/** The draft's Word document with the results written into it as `copy` says: tracked or highlighted quotations, and
 *  links on the citations. Only a draft imported from a Word document has one. */
export async function writeVerifiedWordCopy(draft: AuthoritiesDraft, bytes: Uint8Array, word: WordResult, copy: WordCopy,
  author: string) {
  if (draft.import.kind !== "document" || draft.import.fileType !== "docx")
    reject(400, "Only a document added as a Word document has a Word copy.");
  const writes = documentWrites(word, copy);
  const { bytes: written, written: placed } = await writeDocxSpans(Buffer.from(bytes), draft.units, writes, author);
  return { bytes: written, writes: writes.length, written: placed.filter(Boolean).length };
}

/** A Word document's citations linked to their sources, at their pinpoints, as the verifier links them: its quotations
 *  are located, not compared, and nothing else in it changes. */
export async function linkWordCitations(draft: AuthoritiesDraft, bytes: Uint8Array, author: string, input: {
  signal?: AbortSignal; progress?: (message: string) => void } = {}) {
  const check = await verifyQuotations(draft, { compare: false, quotations: "text", signal: input.signal });
  const { word } = await verificationResults(draft.import.kind === "document" ? draft.import.filename : "document",
    draft, check, { signal: input.signal, progress: input.progress });
  return writeVerifiedWordCopy(draft, bytes, word, { quotations: null, links: true, correction: "marked" }, author);
}
