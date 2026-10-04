import type { PdfProgress } from "@/app/lib/pdfPreparation";
import type { PdfRecognizedText } from "@/app/lib/api/documents";
import { authoritiesInputPlan } from "../../../../shared/authorities-sources.mjs";
import { oneAtATime } from "../../../../shared/one-at-a-time.mjs";
import type { AuthoritiesProduct } from "./types";
import {
  bindStandaloneFile, chooseStandaloneOutputFolder, clearStandaloneOutputFolder,
  getStandaloneFilingContact, getStandaloneOutputFolder, setStandaloneFilingContact, inspectStandaloneFile, pickRetainedFiles, readSourceAnswer, readSourcePdf,
  readStandaloneOutput, relinkStandaloneFile, rememberSourceAnswer, rememberSourcePdf, requestStandaloneFileAccess,
  resolveStandaloneFile, retainStandaloneFile,
  saveStandaloneArtifacts, standaloneWatchedFolder,
  standaloneWorkProducts, writeStandaloneArtifactsToOutputFolder,
  type StandaloneArtifact,
} from "@/app/lib/standaloneWorkProducts";
import { BeaverApiError } from "@/app/lib/api/client";
import { authoritiesOperation, type AuthoritiesRequest } from "./runtimeClient";
import type { AuthoritiesOperation } from "mike/shared/runtime/authoritiesRuntime.mjs";
import type { WorkProduct, WorkProductInput } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesDraft } from "./types";
import type { AuthoritiesFile, AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import { authoritiesProfile } from "./profiles";
import { prepareAnnotations } from "./annotationPreparation";
import { prepareSourceText, readSourceText, recognitionWaiting } from './standalonePdfText';
import { mapAuthorityBookBytes, type BuiltAuthorityBook, type PreparedAuthoritiesBook } from
  "mike/shared/runtime/authoritiesBook.mjs";
import BookWorker from "./bookWorker?worker&inline";

/** Assembles the book in a worker: its pages are copied and saved there, not on the page's thread. */
function renderBook(book: PreparedAuthoritiesBook, signal?: AbortSignal) {
  const worker = new BookWorker();
  return new Promise<BuiltAuthorityBook[]>((resolve, reject) => {
    const stop = () => { worker.terminate(); reject(new DOMException("The build was cancelled.", "AbortError")); };
    signal?.addEventListener("abort", stop, { once: true });
    const finish = () => { signal?.removeEventListener("abort", stop); worker.terminate(); };
    worker.onmessage = ({ data }: MessageEvent<{ built?: BuiltAuthorityBook[]; error?: string }>) => {
      finish(); if (data.built) resolve(data.built); else reject(new Error(data.error));
    };
    worker.onerror = (event) => { finish(); reject(new Error(event.message || "The book could not be assembled.")); };
    // The prepared PDFs are the response's own copies, so they move to the worker rather than copy.
    worker.postMessage(book, [...new Set([book.customCover, book.customIndex, ...book.sources.map(({ bytes }) => bytes)]
      .flatMap((bytes) => bytes ? [bytes.buffer as ArrayBuffer] : []))]);
  });
}

// The runtime asks the page for publisher PDFs it verified before, and for answers sources gave
// before (Authorities.html's page bridge).
Object.assign(globalThis, { AUTHORITIES_SOURCE_PDFS: { read: readSourcePdf, remember: rememberSourcePdf },
  AUTHORITIES_SOURCE_ANSWERS: { read: readSourceAnswer, remember: rememberSourceAnswer } });

const recognitionAvailable = import.meta.env.VITE_AUTHORITIES_RECOGNITION !== "unavailable";
function supportedDraft(state: AuthoritiesDraft): AuthoritiesDraft {
  return recognitionAvailable || state.settings.scannedPdfPolicy === "page-margin" ? state
    : { ...state, settings: { ...state.settings, scannedPdfPolicy: "page-margin" } };
}

async function resolveExact(input: WorkProductInput): Promise<File>;
async function resolveExact(input: WorkProductInput, allowMissing: boolean): Promise<File | null>;
async function resolveExact(input: WorkProductInput, allowMissing = false) {
  const result = await resolveStandaloneFile(input);
  if (result.status === "missing" && allowMissing) return null;
  if (result.status === "missing") throw new Error(result.reason === "permission"
    ? "Chrome needs your permission to read this file again."
    : "A connected file could not be found. Reconnect it, then try again.");
  if (result.status === "changed") throw new Error(
    `${input.kind === "local-file" ? input.lastSeen.name : "A connected file"} changed. Relink it before building.`,
  );
  return result.file;
}

async function findSourceIssues(state: AuthoritiesDraft) {
  const entries = await Promise.all(Object.entries(state.bindings).map(async ([role, input]) => {
    if (input.kind !== "local-file") return null;
    const result = await inspectStandaloneFile(input);
    const issue: AuthoritiesSourceIssue | null = result.status === "changed"
      ? { status: "changed" } : result.status === "missing" ? result : null;
    return issue ? [role, issue] as const : null;
  }));
  return Object.fromEntries(entries.filter(
    (entry): entry is readonly [string, AuthoritiesSourceIssue] => !!entry,
  ));
}

// Each draft as this page last saved or read it: a change starts from it rather than reading the
// whole draft back. A revision saved elsewhere meanwhile still fails the save, which reads afresh.
const latest = new Map<string, WorkProduct<AuthoritiesDraft>>();
const kept = (product: WorkProduct<AuthoritiesDraft>) => (latest.set(product.id, product), product);
async function save(id: string, revision: number, state: AuthoritiesDraft) {
  return kept(await standaloneWorkProducts.update<AuthoritiesDraft>(id, { revision, state: supportedDraft(state) }));
}
async function currentProduct(id: string, revision: number) {
  const known = latest.get(id);
  const product = known?.revision === revision ? known : kept(await standaloneWorkProducts.get<AuthoritiesDraft>(id));
  if (product.revision !== revision)
    throw new BeaverApiError({ status: 409, message: "This draft changed. Reopen it and try again." });
  return { ...product, state: supportedDraft(product.state) };
}

async function runtimeResponse(operation: AuthoritiesOperation, input: AuthoritiesRequest,
  signal?: AbortSignal, progress?: (message: string) => void) {
  return authoritiesOperation(operation, input, { signal, progress });
}
// A read holds an upload slot for as long as it reads (a scan's pages can take a while), so reads
// go one at a time, in tab order, and the workspace's own requests always find a slot free.
const readingAhead = oneAtATime();
/** Reads a source as a build of the draft would, so the build finds the pages it recognizes kept.
 *  A failure here is the build's to report; the scan is still recognized for the highlights. */
async function readAsBuild(product: AuthoritiesProduct, role: string, file: File, signal: AbortSignal,
  recognized: (count: number) => void) {
  const form: AuthoritiesRequest = {};
  form["draft"] = product.state; form["role"] = role;
  form.files = [file];
  await readingAhead(() => runtimeResponse("source-read", form, signal, (message) => {
    const done = Number(message.split("/")[0]);
    if (Number.isFinite(done)) recognized(done);
  }), signal).catch((error) => { if (signal.aborted) throw error; });
}
async function runtimeDraft(operation: AuthoritiesOperation, input: AuthoritiesRequest, signal?: AbortSignal,
  progress?: (message: string) => void) {
  const result = await runtimeResponse(operation, input, signal, progress);
  const state = result.data as AuthoritiesDraft;
  for (const item of result.attachments ?? []) {
    signal?.throwIfAborted();
    const decision = state.authorities[item.authorityId]?.source;
    const source = decision?.kind === "attached" ? decision.sources.find(candidate =>
      candidate.language === item.language && candidate.filename === item.filename && candidate.sourceSha256 === item.sourceSha256) : undefined;
    if (!source) throw new Error("An automatic authority source was invalid.");
    const file = new File([item.bytes.slice().buffer as ArrayBuffer], item.filename, { type: "application/pdf", lastModified: 0 });
    const binding = await retainStandaloneFile(file);
    if (binding.lastSeen.sha256 !== item.sourceSha256 || source.sourceSha256 !== item.sourceSha256)
      throw new Error(`The downloaded bytes do not match ${item.filename}.`);
    state.bindings[source.bindingRole] = binding;
  }
  return supportedDraft(state);
}

async function refreshImported(state: AuthoritiesDraft, file: File, replace = false) {
  const form: AuthoritiesRequest = {}; form["draft"] = state;
  form.files = [file]; form["modified"] = String(file.lastModified);
  if (replace) form["replace"] = "true";
  return runtimeDraft("refresh", form);
}
const validPdf = async (file: File) => await file.slice(0, 5).text() === "%PDF-";

async function buildInputs(product: AuthoritiesProduct, progress?: (message: string) => void,
  signal?: AbortSignal) {
    const plan = authoritiesInputPlan(product.state,
      authoritiesProfile(product.state.settings.profileId).requirements);
    const authorityRoles = new Set(plan.authoritySources.map(({ source }) => source.bindingRole));
    const requiredRoles = new Set([
      ...plan.bookPdfs.map(({ bindingRole }) => bindingRole),
      ...(product.state.import.kind === "document" ? [product.state.import.bindingRole] : []),
    ]);
    const roles: string[] = [];
    const form: AuthoritiesRequest = {}; form["draft"] = product.state;
    form["id"] = product.id; form["revision"] = String(product.revision);
    form["title"] = product.title;
    progress?.("Preparing sources");
    for (const role of plan.byteRoles) {
      signal?.throwIfAborted();
      const file = await resolveExact(product.state.bindings[role],
        !!product.state.settings.allowIncomplete && authorityRoles.has(role) && !requiredRoles.has(role));
      signal?.throwIfAborted();
      if (!file) continue;
      (form.files ??= []).push(file);
      roles.push(role);
    }
    form["roles"] = roles;
    return form;
}

async function attachPdf(id: string, revision: number, selected: AuthoritiesFile, fields: Record<string, string>) {
  const product = await currentProduct(id, revision), form: AuthoritiesRequest = {};
  form["draft"] = product.state; form.files = [selected.file];
  form["modified"] = String(selected.file.lastModified);
  for (const [key, value] of Object.entries(fields)) form[key] = value;
  const state = await runtimeDraft("pdf", form);
  const role = Object.keys(state.bindings).find((role) => {
    const input = state.bindings[role]; return input.kind === "local-file" && input.handleId === "standalone";
  });
  const binding = await bindStandaloneFile(selected.file, selected.input);
  if (!role || state.bindings[role].kind !== "local-file" ||
      state.bindings[role].lastSeen.sha256 !== binding.lastSeen.sha256)
    throw new Error("The selected PDF changed while it was being added.");
  state.bindings[role] = binding;
  return save(id, revision, state);
}

async function sourceText(product: AuthoritiesProduct, role: string, signal?: AbortSignal,
  pages?: number[]): Promise<PdfRecognizedText> {
  const input = product.state.bindings[role];
  signal?.throwIfAborted();
  return input?.kind === 'local-file' && input.lastSeen.sha256 ? readSourceText(input.lastSeen.sha256, pages) : {pages:[]};
}

type RecognitionJob = { controller: AbortController; progress: PdfProgress };
const recognitionJobs = new Map<string, RecognitionJob>();

export const standaloneAuthoritiesHost: AuthoritiesHost = {
  prepareAnnotations: (product, ...args) =>
    prepareAnnotations({ ...product, state: supportedDraft(product.state) }, ...args),
  mode: "standalone",
  recognitionAvailable,
  wordToPdf: () => authoritiesOperation("capabilities").then(result => (result.data as { wordToPdf: boolean }).wordToPdf),
  sourceOcr: {
    async start(id, roles, pages, scannedPages) {
      const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
      return roles.map(role => {
        const binding = product.state.bindings[role];
        if (binding?.kind !== "local-file" || !binding.lastSeen.sha256) throw new Error("This source is unavailable.");
        const documentId = `${id}:${role}:${binding.lastSeen.sha256}`;
        const previous = recognitionJobs.get(documentId);
        if (previous && !previous.controller.signal.aborted && !previous.progress.error)
          return { role, documentId, done: previous.progress.done };
        const job: RecognitionJob = { controller: new AbortController(), progress: {
          id: documentId, done: false, pages: pages ?? [], recognized: 0 } };
        recognitionJobs.set(documentId, job);
        void (async () => {
          const file = await resolveExact(binding);
          const recognized = (count: number) => { job.progress = { ...job.progress, recognized: count }; };
          // First the pages a build of this draft reads, so Build finds them ready; then the rest
          // of the scan, for the highlights.
          await readAsBuild(product, role, file, job.controller.signal, recognized);
          await prepareSourceText(product, role, file, pages, scannedPages?.[role], job.controller.signal, recognized);
          job.progress = { ...job.progress, done: true, pages: [] };
        })().catch((error: Error) => {
          if (!job.controller.signal.aborted) job.progress = { ...job.progress, error: error.message };
        });
        return { role, documentId };
      });
    },
    async cancel(id, roles) {
      for (const [key, job] of recognitionJobs) if (roles.some(role => key.startsWith(`${id}:${role}:`)))
        job.controller.abort();
    },
    async progress(ids) {
      return ids.flatMap(id => recognitionJobs.has(id) ? [{ ...recognitionJobs.get(id)!.progress,
        waiting: recognitionWaiting(id.split(":").at(-1)!) }] : []);
    },
  },
  drafts: standaloneWorkProducts,
  async create({ source, title, settings }) {
    if (source.kind === "document") {
      throw new Error("Choose a local PDF or Word document in the standalone app.");
    }
    let state: AuthoritiesDraft;
    if (source.kind === "file") {
      const binding = await bindStandaloneFile(source.selected.file, source.selected.input);
      const extension = source.selected.file.name
        .split(".").at(-1)?.toLowerCase();
      if (extension !== "pdf" && extension !== "docx") throw new Error("Add a PDF or Word document.");
      const form: AuthoritiesRequest = {}; form.files = [source.selected.file];
      form["modified"] = String(source.selected.file.lastModified);
      if (settings) form["settings"] = settings;
      state = await runtimeDraft("import", form);
      state.bindings.source = binding;
    } else state = await runtimeDraft("create", { settings });
    return standaloneWorkProducts.create<AuthoritiesDraft>({ kind: "authorities", title, state });
  },
  async act(id, revision, action: AuthoritiesAction) {
    const product = await currentProduct(id, revision);
    const state = await runtimeDraft("action",
      { draft: product.state, action });
    return save(id, revision, state);
  },
  async review(id, signal) {
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    return runtimeResponse("discrepancies", { draft: product.state }, signal)
      .then(result => result.data as Awaited<ReturnType<NonNullable<AuthoritiesHost["review"]>>>);
  },
  async resolveDiscrepancy(id, input) {
    const product = await currentProduct(id, input.revision);
    let response: Awaited<ReturnType<typeof runtimeResponse>>;
    if (input.action === "ignore") {
      response = await runtimeResponse("discrepancies/actions",
        { draft: product.state, request: input });
    } else {
      const imported = product.state.import;
      if (imported.kind !== "document" || imported.fileType !== "docx")
        throw new Error("Source corrections require an imported Word document.");
      const file = await resolveExact(product.state.bindings[imported.bindingRole]);
      const form: AuthoritiesRequest = {}; form["draft"] = product.state;
      form["request"] = input; form.files = [file];
      form["modified"] = String(file.lastModified);
      response = await runtimeResponse("discrepancies/actions", form);
    }
    if (!response.files?.length) return save(id, input.revision, response.data as AuthoritiesDraft);
    const state = (response.data as { draft: AuthoritiesDraft }).draft;
    const source = response.files.find(file => file.role === "source"), imported = state.import;
    if (!source || imported.kind !== "document" || imported.fileType !== "docx") throw new Error("The corrected Word document was invalid.");
    const file = new File([source.bytes.slice().buffer as ArrayBuffer], imported.filename, { type: source.mimeType, lastModified: 0 });
    const binding = await retainStandaloneFile(file), expected = state.bindings[imported.bindingRole];
    if (expected?.kind !== "local-file" ||
        expected.lastSeen.sha256 !== binding.lastSeen.sha256) {
      throw new Error("The corrected Word document did not match the reviewed source.");
    }
    state.bindings[imported.bindingRole] = binding;
    return save(id, input.revision, state);
  },
  async refresh(id, revision) {
    const product = await currentProduct(id, revision);
    if (product.state.import.kind !== "document") return product;
    const role = product.state.import.bindingRole;
    const resolved = await resolveStandaloneFile(product.state.bindings[role]);
    if (resolved.status === "missing") throw new Error(
      "The connected source could not be found. Relink it, then try again.",
    );
    const state = structuredClone(product.state); state.bindings[role] = resolved.input;
    return save(id, revision, await refreshImported(state, resolved.file));
  },
  async prepareSources(selected, signal, authorityId, progress) {
    signal?.throwIfAborted();
    const product = await currentProduct(selected.id, selected.revision);
    const prepared = await runtimeDraft("sources",
      { draft: product.state, authorityId }, signal, progress);
    signal?.throwIfAborted();
    return JSON.stringify(prepared) === JSON.stringify(product.state)
      ? product : save(product.id, product.revision, prepared);
  },
  bookFront: async (product, actions, signal) => (await runtimeResponse("book-front",
    { draft: product.state, actions, title: product.title }, signal)).files!.map(file => new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType }))[0],
  attach: (id, authorityId, revision, selected, language = "en") =>
    attachPdf(id, revision, selected, { authority_id: authorityId, language,
      ...(selected.autoFetched ? { auto_fetched: "true" } : {}) }),
  attachBookPdf: (id, revision, slot, selected, supplementId) =>
    attachPdf(id, revision, selected, { slot, ...(supplementId ? { supplement_id: supplementId } : {}) }),
  pdfAuthority: async (product, opening) => ((await runtimeResponse("pdf-authority",
    { draft: product.state, ...opening })).data as { authorityId: string | null }).authorityId,
  watchedFolder: standaloneWatchedFolder,
  async build(selected, progress, signal) {
    signal?.throwIfAborted();
    const product = await currentProduct(selected.id, selected.revision);
    const form = await buildInputs(product, progress, signal);
    progress?.("Building outputs");
    const response = await runtimeResponse("build", form, signal, progress);
    signal?.throwIfAborted();
    const { receipt, book } = response.data as { receipt: AuthoritiesBuildReceipt; book?: PreparedAuthoritiesBook<string> };
    const artifacts: Omit<StandaloneArtifact, "receipt">[] = await Promise.all(
      Object.entries(receipt.outputs).map(async ([role, detail]) => {
        const file = response.files?.find(file => file.role === role);
        if (!detail || !file) throw new Error(`The ${role} output is missing.`);
        return { role, ...detail, bytes: file.bytes };
      }));
    if (book) {
      const preparedBook = await mapAuthorityBookBytes(book,
        async (role) => {
          const source = response.files?.find(file => file.role === role);
          if (!source) throw new Error(`The prepared PDF ${role} is missing.`);
          return source.bytes;
        });
      progress?.("Assembling the book");
      const built = await renderBook(preparedBook, signal);
      for (const item of built) {
        const hash = await crypto.subtle.digest("SHA-256", item.bytes as Uint8Array<ArrayBuffer>);
        const sha256 = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        const detail = { filename: item.filename, mimeType: item.mimeType, sha256, pageCount: item.pageCount };
        receipt.outputs[item.role] = detail;
        artifacts.push({ ...item, sha256 });
      }
    }
    signal?.throwIfAborted();
    progress?.("Saving outputs");
    const saved = await saveStandaloneArtifacts(product, artifacts.map((artifact) =>
      ({ ...artifact, receipt })));
    let notice: string | null;
    try { notice = await writeStandaloneArtifactsToOutputFolder(artifacts.map((artifact) =>
      ({ ...artifact, receipt }))); }
    catch { notice = "Built files are ready to download; the output folder could not be used."; }
    return { product: saved, receipt, ...(notice ? { notice } : {}) };
  },
  async checkQuotes(selected, progress, signal) {
    signal?.throwIfAborted();
    const product = await currentProduct(selected.id, selected.revision);
    // The PDFs attached for authorities: their quotations are checked against them.
    const form: AuthoritiesRequest = { draft: product.state }, roles: string[] = [];
    for (const { source } of authoritiesInputPlan(product.state,
      authoritiesProfile(product.state.settings.profileId).requirements).authoritySources) {
      const file = await resolveExact(product.state.bindings[source.bindingRole], true);
      if (file) { (form.files ??= []).push(file); roles.push(source.bindingRole); }
    }
    form["roles"] = roles;
    return (await authoritiesOperation("quote-check", form, { signal, quoteProgress: (value) => {
      const { completed, total } = value as { completed: number; total: number };
      progress?.(`Checking quotations · ${completed} of ${total}`);
    } })).data;
  },
  download: async (documentId, versionId) => {
    const saved = await readStandaloneOutputByDocument(documentId, versionId);
    return new Blob([saved.bytes.slice().buffer], { type: saved.output.mimeType });
  },
  readSource: async (draft, role) => resolveExact(draft.state.bindings[role]),
  readSourceText: sourceText,
  readPinpoints: async (text, start, end) =>
    (await runtimeResponse("pinpoints", { text, start, end })).data as Awaited<ReturnType<NonNullable<AuthoritiesHost["readPinpoints"]>>>,
  async inspectDraft(draft) {
    return { sourceIssues: await findSourceIssues(draft.state) };
  },
  pickFiles: ({ multiple, accept }) => pickRetainedFiles(multiple, accept),
  requestSourceAccess: (draft) => requestStandaloneFileAccess(Object.values(draft.state.bindings)),
  async relinkSource(id, role, revision) {
    const product = await currentProduct(id, revision);
    const binding = product.state.bindings[role];
    if (binding?.kind !== "local-file") throw new Error("This source cannot be relinked.");
    const state = structuredClone(product.state);
    const imported = state.import.kind === "document" && state.import.bindingRole === role
      ? state.import : null;
    const authoritySource = Object.values(state.authorities).flatMap(({ source }) =>
      source.kind === "attached" ? source.sources : []).find(({ bindingRole }) =>
      bindingRole === role);
    const bookPdf = [state.bookParts.cover, state.bookParts.index, ...state.bookParts.supplements]
      .find((part) => part?.bindingRole === role);
    const boundPdf = authoritySource ?? bookPdf;
    const resolved = await relinkStandaloneFile(binding, true,
      authoritySource || bookPdf ? "pdf" : "source");
    if (resolved.status === "missing") throw new Error("Choose the source file to relink it.");
    if (resolved.input.kind !== "local-file") throw new Error("This source cannot be relinked.");
    const current = resolved.input.lastSeen;
    if (!imported && !boundPdf) throw new Error("This source no longer exists.");
    if (imported) {
      const extension = resolved.file.name.split(".").at(-1)?.toLowerCase();
      if (extension !== imported.fileType) throw new Error(
        `Choose a ${imported.fileType === "pdf" ? "PDF" : "Word document"}.`,
      );
      imported.filename = resolved.file.name;
    } else if (boundPdf) {
      if (!await validPdf(resolved.file)) throw new Error("Choose a valid PDF.");
      boundPdf.filename = resolved.file.name;
      boundPdf.sourceSha256 = current.sha256!;
    }
    state.bindings[role] = { ...resolved.input, lastSeen: current };
    return save(id, revision, imported
      ? await refreshImported(state, resolved.file) : state);
  },
  outputFolder: {
    get: getStandaloneOutputFolder,
    choose: chooseStandaloneOutputFolder,
    clear: clearStandaloneOutputFolder,
  },
  filingContact: { get: getStandaloneFilingContact, save: setStandaloneFilingContact },
};

async function readStandaloneOutputByDocument(documentId: string, versionId: string) {
  const products = await standaloneWorkProducts.list<AuthoritiesDraft>("authorities");
  for (const product of products) for (const [role, output] of Object.entries(product.outputs)) {
    if (output.documentId === documentId && output.versionId === versionId)
      return readStandaloneOutput(product.id, role, versionId);
  }
  throw new Error("This built file is unavailable. Build it again.");
}
