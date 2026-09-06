import {
  bindStandaloneFile, chooseStandaloneOutputFolder, clearStandaloneOutputFolder,
  getStandaloneOutputFolder, inspectStandaloneFile, pickRetainedFiles, readStandaloneOutput,
  relinkStandaloneFile, resolveStandaloneFile, retainStandaloneFile, saveStandaloneArtifacts,
  standaloneWorkProducts, writeStandaloneArtifactsToOutputFolder,
} from "@/app/lib/standaloneWorkProducts";
import { apiResponse } from "@/app/lib/api/client";
import type { WorkProductInput } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesDraft, AttachedAuthoritySource,
  AuthoritySourceLanguage } from "./types";
import type { AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import { authoritiesProfile } from "./profiles";

async function resolveExact(input: WorkProductInput) {
  const result = await resolveStandaloneFile(input, true);
  if (result.status === "missing") throw new Error(result.reason === "permission"
    ? "Allow access to the connected file, then try again."
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

async function save(id: string, revision: number, state: AuthoritiesDraft) {
  return standaloneWorkProducts.update<AuthoritiesDraft>(id, { revision, state });
}
async function currentProduct(id: string, revision: number) {
  const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
  if (product.revision !== revision) throw new Error("This draft changed. Reopen it and try again.");
  return product;
}

async function runtimeResponse(path: string, body: BodyInit, json = false,
  signal?: AbortSignal) {
  return apiResponse(`/authorities-runtime/${path}`, {
    method: "POST", body, signal,
    ...(json ? { headers: { "Content-Type": "application/json" } } : {}),
  });
}
async function runtimeDraft(path: string, body: BodyInit, json = false, signal?: AbortSignal) {
  const response = await runtimeResponse(path, body, json, signal);
  if (!response.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return await response.json() as AuthoritiesDraft;
  }
  const form = await response.formData();
  const state = JSON.parse(String(form.get("draft"))) as AuthoritiesDraft;
  const attachments = JSON.parse(String(form.get("attachments"))) as Array<{
    part: string; authorityId: string; filename: string; sourceSha256: string;
    language: AuthoritySourceLanguage;
  }>;
  for (const item of attachments) {
    signal?.throwIfAborted();
    const decision = state.authorities[item.authorityId]?.source;
    const source = decision?.kind === "attached" ? decision.sources.find((candidate) =>
      candidate.language === item.language && candidate.filename === item.filename &&
      candidate.sourceSha256 === item.sourceSha256) : undefined;
    const part = form.get(item.part);
    if (!source ||
        !(part instanceof File) ||
        !/^[a-f0-9]{64}$/u.test(item.sourceSha256)) {
      throw new Error("An automatic authority source was invalid.");
    }
    const file = new File([await part.arrayBuffer()], item.filename,
      { type: "application/pdf", lastModified: 0 });
    const binding = await retainStandaloneFile(file);
    if (binding.lastSeen.sha256 !== item.sourceSha256 ||
        source.sourceSha256 !== item.sourceSha256) {
      throw new Error(`The downloaded bytes do not match ${item.filename}.`);
    }
    state.bindings[source.bindingRole] = binding;
  }
  return state;
}

async function refreshImported(state: AuthoritiesDraft, file: File, replace = false) {
  const form = new FormData(); form.append("draft", JSON.stringify(state));
  form.append("file", file, file.name); form.append("modified", String(file.lastModified));
  if (replace) form.append("replace", "true");
  return runtimeDraft("refresh", form);
}
const validPdf = async (file: File) => await file.slice(0, 5).text() === "%PDF-";

export const standaloneAuthoritiesHost: AuthoritiesHost = {
  mode: "standalone",
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
      const form = new FormData(); form.append("file", source.selected.file);
      form.append("modified", String(source.selected.file.lastModified));
      if (settings) form.append("settings", JSON.stringify(settings));
      state = await runtimeDraft("import", form);
      state.bindings.source = binding;
    } else state = await runtimeDraft("create", JSON.stringify({ settings }), true);
    return standaloneWorkProducts.create<AuthoritiesDraft>({ kind: "authorities", title, state });
  },
  async act(id, revision, action: AuthoritiesAction) {
    const product = await currentProduct(id, revision);
    const state = await runtimeDraft("action",
      JSON.stringify({ draft: product.state, action }), true);
    return save(id, revision, state);
  },
  async review(id, signal) {
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    return runtimeResponse("discrepancies", JSON.stringify({ draft: product.state }), true, signal)
      .then((response) => response.json());
  },
  async resolveDiscrepancy(id, input) {
    const product = await currentProduct(id, input.revision);
    let response: Response;
    if (input.action === "ignore") {
      response = await runtimeResponse("discrepancies/actions",
        JSON.stringify({ draft: product.state, request: input }), true);
    } else {
      const imported = product.state.import;
      if (imported.kind !== "document" || imported.fileType !== "docx")
        throw new Error("Source corrections require an imported Word document.");
      const file = await resolveExact(product.state.bindings[imported.bindingRole]);
      const form = new FormData(); form.append("draft", JSON.stringify(product.state));
      form.append("request", JSON.stringify(input)); form.append("file", file, file.name);
      form.append("modified", String(file.lastModified));
      response = await runtimeResponse("discrepancies/actions", form);
    }
    if (!response.headers.get("content-type")?.startsWith("multipart/form-data")) {
      return save(id, input.revision, await response.json() as AuthoritiesDraft);
    }
    const form = await response.formData(), state = JSON.parse(String(form.get("draft"))) as AuthoritiesDraft;
    const source = form.get("source"), imported = state.import;
    if (!(source instanceof File) || imported.kind !== "document" || imported.fileType !== "docx")
      throw new Error("The corrected Word document was invalid.");
    const file = new File([await source.arrayBuffer()], imported.filename,
      { type: source.type, lastModified: 0 });
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
  async prepareSources(selected, signal) {
    signal?.throwIfAborted();
    const product = await currentProduct(selected.id, selected.revision);
    const prepared = await runtimeDraft("sources",
      JSON.stringify({ draft: product.state }), true, signal);
    signal?.throwIfAborted();
    return JSON.stringify(prepared) === JSON.stringify(product.state)
      ? product : save(product.id, product.revision, prepared);
  },
  async attach(id, authorityId, revision, selected, language = "en") {
    if (!await validPdf(selected.file)) throw new Error("Add a valid PDF.");
    const product = await currentProduct(id, revision);
    const state = structuredClone(product.state), authority = state.authorities[authorityId];
    if (!authority) throw new Error("This authority no longer exists.");
    const binding = await bindStandaloneFile(selected.file, selected.input);
    const previous = authority.source.kind === "attached" ? authority.source.sources : [];
    const replaced = previous.find((source) => source.language === language);
    const sourceUrl = authority.source.kind === "pending-canlii" ? authority.source.pdfUrl
      : replaced?.sourceUrl ?? null;
    const role = replaced?.bindingRole ?? `authority:${crypto.randomUUID()}:${language}`;
    const source: AttachedAuthoritySource = { bindingRole: role, filename: selected.file.name,
      sourceSha256: binding.lastSeen.sha256!, sourceUrl, origin: "manual", language };
    const sources = language === "bilingual" ? [source]
      : [...previous.filter((item) => item.language !== "bilingual" &&
        item.language !== language), source].sort((left) => left.language === "en" ? -1 : 1);
    const retained = new Set(sources.map(({ bindingRole }) => bindingRole));
    for (const item of previous) if (!retained.has(item.bindingRole)) {
      delete state.bindings[item.bindingRole];
    }
    state.bindings[role] = binding;
    authority.source = { kind: "attached", sources };
    return save(id, revision, state);
  },
  async attachBookPdf(id, revision, slot, selected, supplementId) {
    if (!await validPdf(selected.file)) throw new Error("Add a valid PDF.");
    const product = await currentProduct(id, revision);
    const binding = await bindStandaloneFile(selected.file, selected.input);
    const form = new FormData(); form.append("draft", JSON.stringify(product.state));
    form.append("slot", slot); form.append("file", selected.file, selected.file.name);
    if (supplementId) form.append("supplement_id", supplementId);
    form.append("modified", String(selected.file.lastModified));
    const state = await runtimeDraft("book-part", form);
    const part = slot === "supplemental" ? state.bookParts.supplements.find(({ id }) =>
      supplementId ? id === supplementId
        : !product.state.bookParts.supplements.some((current) => current.id === id))
      : state.bookParts[slot];
    if (!part || part.sourceSha256 !== binding.lastSeen.sha256)
      throw new Error("The selected PDF changed while it was being added.");
    state.bindings[part.bindingRole] = binding;
    return save(id, revision, state);
  },
  async build(selected, progress, signal) {
    signal?.throwIfAborted();
    const product = await currentProduct(selected.id, selected.revision);
    const filingPdfs = product.state.insertIntoDocument &&
      !!authoritiesProfile(product.state.settings.profileId).requirements?.unlinkedPdfTableSources &&
      product.state.import.kind === "document" && product.state.import.fileType === "pdf";
    const roles = [
      ...(product.state.outputMode === "table" && !filingPdfs ? [] :
        Object.values(product.state.authorities).flatMap(({ excluded, source }) =>
          !excluded && source.kind === "attached"
            ? source.sources.map(({ bindingRole }) => bindingRole) : [])),
      ...(product.state.insertIntoDocument && product.state.import.kind === "document"
        ? [product.state.import.bindingRole] : []),
      ...(product.state.outputMode === "table" ? [] : [product.state.bookParts.cover,
        product.state.bookParts.index, ...product.state.bookParts.supplements]
        .flatMap((part) => part ? [part.bindingRole] : [])),
    ];
    const form = new FormData(); form.append("draft", JSON.stringify(product.state));
    form.append("id", product.id); form.append("revision", String(product.revision));
    form.append("title", product.title);
    progress?.("Preparing sources");
    for (const role of roles) {
      signal?.throwIfAborted();
      const file = await resolveExact(product.state.bindings[role]);
      signal?.throwIfAborted();
      form.append("files", file, file.name);
    }
    form.append("roles", JSON.stringify(roles));
    progress?.("Building outputs");
    const response = await (await runtimeResponse("build", form, false, signal)).formData();
    signal?.throwIfAborted();
    const receipt = JSON.parse(String(response.get("receipt")));
    const artifacts = await Promise.all(Object.entries(receipt.outputs).map(async ([role, output]) => {
      const file = response.get(role), detail = output as {
        filename: string; mimeType: string; sha256: string; pageCount: number | null };
      if (!(file instanceof File)) throw new Error(`The ${role} output is missing.`);
      return { role, ...detail, bytes: new Uint8Array(await file.arrayBuffer()) };
    }));
    progress?.("Saving outputs");
    const saved = await saveStandaloneArtifacts(product, artifacts.map((artifact) =>
      ({ ...artifact, receipt })));
    let notice: string | null;
    try { notice = await writeStandaloneArtifactsToOutputFolder(artifacts.map((artifact) =>
      ({ ...artifact, receipt }))); }
    catch { notice = "Built files are ready to download; the output folder could not be used."; }
    return { product: saved, receipt, ...(notice ? { notice } : {}) };
  },
  download: async (documentId, versionId) => {
    const saved = await readStandaloneOutputByDocument(documentId, versionId);
    return new Blob([saved.bytes.slice().buffer], { type: saved.output.mimeType });
  },
  readSource: async (draft, role) => resolveExact(draft.state.bindings[role]),
  async inspectDraft(draft) {
    const role = Object.keys(draft.outputs)[0];
    let outputFreshness: "unbuilt" | "current" | "stale" = role ? "stale" : "unbuilt";
    if (role) try {
      outputFreshness = (await readStandaloneOutput(draft.id, role)).stale ? "stale" : "current";
    } catch { /* A retained output whose bytes disappeared is stale. */ }
    return { sourceIssues: await findSourceIssues(draft.state), outputFreshness };
  },
  pickFiles: ({ multiple, accept }) => pickRetainedFiles(multiple, accept),
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
  async replaceSource(id, revision, selected) {
    const product = await currentProduct(id, revision);
    if (product.state.import.kind !== "document") {
      throw new Error("Only an imported document can be replaced.");
    }
    const extension = selected.file.name.split(".").at(-1)?.toLowerCase();
    if (extension !== "pdf" && extension !== "docx") throw new Error("Add a PDF or Word document.");
    const binding = await bindStandaloneFile(selected.file, selected.input);
    const state = await refreshImported(product.state, selected.file, true);
    state.bindings[state.import.kind === "document" ? state.import.bindingRole : "source"] = binding;
    return save(id, revision, state);
  },
  outputFolder: {
    get: getStandaloneOutputFolder,
    choose: chooseStandaloneOutputFolder,
    clear: clearStandaloneOutputFolder,
  },
};

async function readStandaloneOutputByDocument(documentId: string, versionId: string) {
  const products = await standaloneWorkProducts.list<AuthoritiesDraft>("authorities");
  for (const product of products) for (const [role, output] of Object.entries(product.outputs)) {
    if (output.documentId === documentId && output.versionId === versionId)
      return readStandaloneOutput(product.id, role, versionId);
  }
  throw new Error("This built file is unavailable. Build it again.");
}
