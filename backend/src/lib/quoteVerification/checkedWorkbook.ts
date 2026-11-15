// The quote verifier's "[CHECKED] <stem>.xlsx", read and written in one engine run (native/alr-verifier). The run asks
// what only this host can answer, and is resumed with the answers: a model's reading of the notes, the sources the
// parts cite (an attached PDF, else a provider's text, as the quote check read it), a journal article's page and a
// private CanLII index's decision page.
import type { AuthoritiesDraft } from "../authoritiesDomain";
import type { QuoteContext } from "../authoritiesQuotations";
import { journalStores } from "../legalSources/journal";
import { indexedCaseUrl, hasCanliiIndex } from "../legalSources/canlii";
import { checkedSources, citedSourceReader, type checkQuotes } from "../quoteCheck";
import { legalSourceOperations } from "../legalSourceApplication";
import type { NativeDocument } from "../structureNative";
import type { ModelNotePart } from "../noteSplitModel";
import type { AlrQuestion } from "mike/shared/engine-types/AlrQuestion";
import type { AlrRow } from "mike/shared/engine-types/AlrRow";
import { structureNative } from "../structureNative";
import { ApplicationError } from "../applicationError";

type Check = Awaited<ReturnType<typeof checkQuotes>>;
export type AlrExportDetail = "display" | "display-json" | "diagnostic-hidden" | "diagnostic";
export type AlrWorkbookOptions = { exportDetail?: AlrExportDetail; footnotes?: string;
  /** The quotation's context, the Python app's proposition_mode. */
  quoteContext?: QuoteContext;
  /** The Python app's text fragments (frag_mode): "all" (the default), "pinpointless" or "off". */
  textFragments?: "all" | "pinpointless" | "off";
  /** Whether a part's passage may be read from A2AJ; off, only an attached PDF is read. */
  a2aj?: boolean;
  /** A model's analysis of quotations, by quotation id: a column of its own, apart from the mechanical findings. */
  analysis?: Record<string, string> };

/** A note as the run mode decides whether the model reads it: its text and the engine's parts. */
export type AlrModelNote = Extract<AlrQuestion, { ask: "split" }>["notes"][number];
/** An earlier part a supra may name. */
export type AlrCandidate = Extract<AlrQuestion, { ask: "choose" }>["references"][number]["earlier"][number];
/** A model run mode: the notes' parts it reads, and the earlier part each unresolved supra names. */
export type AlrModel = {
  split(notes: AlrModelNote[], signal?: AbortSignal): Promise<Map<number, ModelNotePart[]>>;
  choose(references: Array<{ text: string; earlier: AlrCandidate[]; proposition: string }>,
    signal?: AbortSignal): Promise<Array<AlrCandidate | null>>;
};

/** The host's answer to what the run asks. */
async function answer(question: AlrQuestion, check: Check, options: AlrWorkbookOptions, model: AlrModel | undefined,
  attached: ReadonlyMap<string, NativeDocument>, signal?: AbortSignal) {
  switch (question.ask) {
    case "links": return { links: question.cases.map(indexedCaseUrl) };
    case "split": return { parts: [...(await model!.split(question.notes, signal))] };
    case "choose": {
      const chosen = await model!.choose(question.references, signal);
      return { chosen: chosen.map((candidate, at) => candidate ? question.references[at].earlier.indexOf(candidate) : -1)
        .map((at) => at >= 0 ? at : null) };
    }
    case "read": {
      // An A2AJ source the quote check read is taken as it read it.
      const a2aj = citedSourceReader({ ...legalSourceOperations,
        resolve: (request) => legalSourceOperations.resolve({ ...request, providers: ["a2aj"], discoverPdf: false }),
        readPassage: (request) => legalSourceOperations.readPassage({ ...request, discoverPdf: false }) }, signal);
      return { reads: await Promise.all(question.sources.map(async (source) => {
        if (!source) return null;
        // A PDF attached for the authority (a CanLII download, a file from the watched folder) is read as its source.
        const own = source.authorityId ? attached.get(source.authorityId) : undefined;
        if (own) return { document: own };
        if (options.a2aj === false) return null;
        const kept = await checkedSources.get(check)?.kept(source);
        const found = kept && !kept.missing && kept.source.provider === "a2aj" ? kept : await a2aj(source);
        return found && !found.missing ? { document: found.document, source: found.source } : null;
      })) };
    }
  }
}

/** "[CHECKED] <stem>.xlsx", and for display-json the diagnostics file paired with it by signature; `references`, how many
 *  of its rows are an ibid or a supra and how many of those are linked to their source; and the rows. `progress` hears
 *  each step. */
export async function alrCheckedWorkbook(filename: string, draft: AuthoritiesDraft, check: Check, options: AlrWorkbookOptions = {},
  model?: AlrModel, signal?: AbortSignal, attached: ReadonlyMap<string, NativeDocument> = new Map(), progress?: (message: string) => void) {
  // An HTTP request's own error: the analysis names quotations of another check.
  if (options.analysis) for (const id of Object.keys(options.analysis)) if (!check.quotes.some((quote) => quote.id === id))
    throw new ApplicationError(400, "Explanations must refer to quotation IDs in this check.");
  progress?.("Connecting ibid and supra references");
  const native = structureNative();
  let step = await native.alrWorkbook({ filename, draft, check, options, model: !!model, canliiIndex: hasCanliiIndex(),
    journals: journalStores(), stamp: `${Date.now()}${performance.now()}` });
  while (step.step === "ask") {
    const replied = await answer(step.question, check, options, model, attached, signal);
    signal?.throwIfAborted();
    if (step.question.ask === "read") progress?.("Writing the workbook");
    step = await native.alrAnswer(step.run, replied);
  }
  const { name, workbook, rows, references, signature } = step;
  if (!signature) return { name, workbook, sidecar: null, references, rows };
  return { name, workbook, sidecar: { name: name.replace(/\.xlsx$/iu, ".diagnostics.json"), value: {
    schema: "alr_quote_verifier_diagnostics_v1", xlsx_file: name, xlsx_signature: signature,
    exported_at: new Date().toISOString().slice(0, 19), footnote_rows: rows } }, references, rows };
}

export type { AlrRow };
