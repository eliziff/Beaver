import {
  canRetainLocalFiles, pickRetainedFiles, readStandaloneOutput, resolveLocalFile,
  relinkLocalFile, saveStandaloneArtifacts, standaloneWorkProducts,
} from "@/app/lib/standaloneWorkProducts";
import { apiResponse } from "@/app/lib/apiTransport";
import type { InputResolution, WorkProductInput } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesDraft } from "./types";
import type { AuthoritiesFile, AuthoritiesHost, AuthoritiesSourceIssue } from "./host";

const sessionFiles = new Map<string, File>();
const snapshot = async (file: File) => ({ name: file.name, size: file.size,
  modified: file.lastModified, sha256: await hash(file) });
const hash = async (file: Blob) => [...new Uint8Array(await crypto.subtle.digest(
  "SHA-256", await file.arrayBuffer(),
))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function emptyDraft(): AuthoritiesDraft {
  return { schemaVersion: "beaver.authorities-draft.v1", import: { kind: "manual" },
    bindings: {}, outputMode: "both", insertIntoDocument: false,
    units: [], occurrences: {}, authorities: {}, authorityOrder: [] };
}

async function inputFor(selected: AuthoritiesFile) {
  const lastSeen = await snapshot(selected.file);
  if (selected.input?.kind === "local-file") return { ...selected.input, lastSeen };
  const handleId = `session:${crypto.randomUUID()}`;
  sessionFiles.set(handleId, selected.file);
  return { kind: "local-file" as const, handleId, lastSeen };
}

async function resolveInput(input: WorkProductInput, verifyContents = false): Promise<InputResolution> {
  if (input.kind !== "local-file") throw new Error("This standalone input is unavailable.");
  const cached = sessionFiles.get(input.handleId);
  const result = cached ? { status: "ready" as const, file: cached, input }
    : await resolveLocalFile(input);
  if (result.status === "missing") return result;
  const previous = input.lastSeen, metadata = { name: result.file.name, size: result.file.size,
    modified: result.file.lastModified };
  const metadataChanged = result.status === "changed" || metadata.name !== previous.name ||
    metadata.size !== previous.size || metadata.modified !== previous.modified;
  const current = verifyContents || metadataChanged || !previous.sha256
    ? await snapshot(result.file) : { ...metadata, sha256: previous.sha256 };
  const changed = metadataChanged || verifyContents && current.sha256 !== previous.sha256;
  return { status: changed ? "changed" : "ready", file: result.file,
    input: { ...input, lastSeen: current } };
}

async function resolveExact(input: WorkProductInput) {
  const result = await resolveInput(input, true);
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
    const result = await resolveInput(input);
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

async function runtimeResponse(path: string, body: BodyInit, json = false) {
  return apiResponse(`/authorities-runtime/${path}`, {
    method: "POST", body, ...(json ? { headers: { "Content-Type": "application/json" } } : {}),
  });
}
async function runtime<T>(path: string, body: BodyInit, json = false) {
  return await (await runtimeResponse(path, body, json)).json() as T;
}

async function refreshImported(state: AuthoritiesDraft, file: File) {
  const form = new FormData(); form.append("draft", JSON.stringify(state));
  form.append("file", file, file.name); form.append("modified", String(file.lastModified));
  return runtime<AuthoritiesDraft>("refresh", form);
}

export const standaloneAuthoritiesHost: AuthoritiesHost = {
  mode: "standalone",
  list: () => standaloneWorkProducts.list<AuthoritiesDraft>("authorities"),
  get: (id) => standaloneWorkProducts.get<AuthoritiesDraft>(id),
  async create({ source, title }) {
    const state = emptyDraft();
    if (source.kind === "file") {
      const binding = await inputFor(source.selected), extension = source.selected.file.name
        .split(".").at(-1)?.toLowerCase();
      if (extension !== "pdf" && extension !== "docx") throw new Error("Add a PDF or Word document.");
      const form = new FormData(); form.append("file", source.selected.file);
      form.append("modified", String(source.selected.file.lastModified));
      Object.assign(state, await runtime<AuthoritiesDraft>("import", form));
      state.bindings.source = binding;
    }
    return standaloneWorkProducts.create<AuthoritiesDraft>({ kind: "authorities", title, state });
  },
  async act(id, revision, action: AuthoritiesAction) {
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    if (product.revision !== revision) throw new Error("This draft changed. Reopen it and try again.");
    const state = await runtime<AuthoritiesDraft>("action",
      JSON.stringify({ draft: product.state, action }), true);
    return save(id, revision, state);
  },
  async refresh(id, revision) {
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    if (product.revision !== revision) throw new Error("This draft changed. Reopen it and try again.");
    if (product.state.import.kind !== "document") return product;
    const role = product.state.import.bindingRole;
    const resolved = await resolveInput(product.state.bindings[role]);
    if (resolved.status === "missing") throw new Error(
      "The connected source could not be found. Relink it, then try again.",
    );
    const state = structuredClone(product.state); state.bindings[role] = resolved.input;
    return save(id, revision, await refreshImported(state, resolved.file));
  },
  async attach(id, authorityId, revision, selected) {
    if (await selected.file.slice(0, 5).text() !== "%PDF-") throw new Error("Add a valid PDF.");
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    if (product.revision !== revision) throw new Error("This draft changed. Reopen it and try again.");
    const state = structuredClone(product.state), authority = state.authorities[authorityId];
    if (!authority) throw new Error("This authority no longer exists.");
    const role = `authority:${authorityId}`, binding = await inputFor(selected);
    const sourceUrl = authority.source.kind === "pending-canlii" ? authority.source.pdfUrl : null;
    if (authority.source.kind === "attached") delete state.bindings[authority.source.bindingRole];
    state.bindings[role] = binding;
    authority.source = { kind: "attached", bindingRole: role, filename: selected.file.name,
      sourceSha256: binding.lastSeen.sha256!, sourceUrl };
    return save(id, revision, state);
  },
  async build(id, revision) {
    const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
    if (product.revision !== revision) throw new Error("This draft changed. Reopen it and try again.");
    const roles = [
      ...(product.state.outputMode === "table" ? [] :
        Object.values(product.state.authorities).flatMap(({ excluded, source }) =>
          !excluded && source.kind === "attached" ? [source.bindingRole] : [])),
      ...(product.state.insertIntoDocument && product.state.import.kind === "document"
        ? [product.state.import.bindingRole] : []),
    ];
    const form = new FormData(); form.append("draft", JSON.stringify(product.state));
    form.append("id", product.id); form.append("revision", String(product.revision));
    form.append("title", product.title);
    for (const role of roles) {
      const file = await resolveExact(product.state.bindings[role]);
      form.append("files", file, file.name);
    }
    form.append("roles", JSON.stringify(roles));
    const response = await (await runtimeResponse("build", form)).formData();
    const receipt = JSON.parse(String(response.get("receipt")));
    const artifacts = await Promise.all(Object.entries(receipt.outputs).map(async ([role, output]) => {
      const file = response.get(role), detail = output as {
        filename: string; mimeType: string; sha256: string; pageCount: number | null };
      if (!(file instanceof File)) throw new Error(`The ${role} output is missing.`);
      return { role, ...detail, bytes: new Uint8Array(await file.arrayBuffer()) };
    }));
    const saved = await saveStandaloneArtifacts(product, artifacts.map((artifact) =>
      ({ ...artifact, receipt })));
    return { product: saved, receipt };
  },
  update: (id, revision, title) => standaloneWorkProducts.update<AuthoritiesDraft>(id,
    { revision, title }),
  duplicate: (id, title) => standaloneWorkProducts.duplicate<AuthoritiesDraft>(id, { title }),
  remove: (id) => standaloneWorkProducts.remove(id),
  download: async (documentId, versionId) => {
    const saved = await readStandaloneOutputByDocument(documentId, versionId);
    return new Blob([saved.bytes.slice().buffer], { type: saved.output.mimeType });
  },
  ...(canRetainLocalFiles() ? {
    async pickFiles(multiple: boolean) {
      return pickRetainedFiles(multiple);
    },
    sourceIssues: (draft) => findSourceIssues(draft.state),
    async relinkSource(id: string, role: string, revision: number) {
      const product = await standaloneWorkProducts.get<AuthoritiesDraft>(id);
      if (product.revision !== revision)
        throw new Error("This draft changed. Reopen it and try again.");
      const binding = product.state.bindings[role];
      if (binding?.kind !== "local-file") throw new Error("This source cannot be relinked.");
      let resolved = await resolveInput(binding);
      if (resolved.status === "missing") resolved = await relinkLocalFile(binding);
      if (resolved.status === "missing") throw new Error("Choose the source file to relink it.");
      if (resolved.input.kind !== "local-file") throw new Error("This source cannot be relinked.");
      const state = structuredClone(product.state), current = await snapshot(resolved.file);
      const imported = state.import.kind === "document" && state.import.bindingRole === role
        ? state.import : null;
      const authority = Object.values(state.authorities).find(({ source }) =>
        source.kind === "attached" && source.bindingRole === role);
      if (!imported && !authority) throw new Error("This source no longer exists.");
      if (imported) {
        const extension = resolved.file.name.split(".").at(-1)?.toLowerCase();
        if (extension !== imported.fileType) throw new Error(
          `Choose a ${imported.fileType === "pdf" ? "PDF" : "Word document"}.`,
        );
        imported.filename = resolved.file.name;
      } else if (authority?.source.kind === "attached") {
        if (await resolved.file.slice(0, 5).text() !== "%PDF-")
          throw new Error("Choose a valid PDF.");
        authority.source.filename = resolved.file.name;
        authority.source.sourceSha256 = current.sha256!;
      }
      const input = { ...resolved.input, lastSeen: current };
      state.bindings[role] = input;
      return save(id, revision, imported
        ? await refreshImported(state, resolved.file) : state);
    },
  } : {}),
};

async function readStandaloneOutputByDocument(documentId: string, versionId: string) {
  const products = await standaloneWorkProducts.list<AuthoritiesDraft>("authorities");
  for (const product of products) for (const [role, output] of Object.entries(product.outputs)) {
    if (output.documentId === documentId && output.versionId === versionId)
      return readStandaloneOutput(product.id, role, versionId);
  }
  throw new Error("This built file is unavailable. Build it again.");
}
