import {
  bindStandaloneFile, canRetainLocalFiles, pickRetainedFiles, readStandaloneOutput,
  relinkStandaloneFile, resolveStandaloneFile, saveStandaloneArtifacts,
  standaloneWorkProducts,
} from "@/app/lib/standaloneWorkProducts";
import { apiResponse } from "@/app/lib/apiTransport";
import type { WorkProductInput } from "@/app/lib/workProducts";
import type { AuthoritiesAction, AuthoritiesDraft } from "./types";
import type { AuthoritiesHost, AuthoritiesSourceIssue } from "./host";

function emptyDraft(): AuthoritiesDraft {
  return { schemaVersion: "beaver.authorities-draft.v1", import: { kind: "manual" },
    bindings: {}, outputMode: "both", insertIntoDocument: false,
    units: [], occurrences: {}, authorities: {}, authorityOrder: [] };
}

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
    const result = await resolveStandaloneFile(input);
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
  drafts: standaloneWorkProducts,
  async create({ source, title }) {
    const state = emptyDraft();
    if (source.kind === "file") {
      const binding = await bindStandaloneFile(source.selected.file, source.selected.input);
      const extension = source.selected.file.name
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
    const product = await currentProduct(id, revision);
    const state = await runtime<AuthoritiesDraft>("action",
      JSON.stringify({ draft: product.state, action }), true);
    return save(id, revision, state);
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
  async attach(id, authorityId, revision, selected) {
    if (await selected.file.slice(0, 5).text() !== "%PDF-") throw new Error("Add a valid PDF.");
    const product = await currentProduct(id, revision);
    const state = structuredClone(product.state), authority = state.authorities[authorityId];
    if (!authority) throw new Error("This authority no longer exists.");
    const role = `authority:${authorityId}`;
    const binding = await bindStandaloneFile(selected.file, selected.input);
    const sourceUrl = authority.source.kind === "pending-canlii" ? authority.source.pdfUrl : null;
    if (authority.source.kind === "attached") delete state.bindings[authority.source.bindingRole];
    state.bindings[role] = binding;
    authority.source = { kind: "attached", bindingRole: role, filename: selected.file.name,
      sourceSha256: binding.lastSeen.sha256!, sourceUrl };
    return save(id, revision, state);
  },
  async build(selected) {
    const product = await currentProduct(selected.id, selected.revision);
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
      const product = await currentProduct(id, revision);
      const binding = product.state.bindings[role];
      if (binding?.kind !== "local-file") throw new Error("This source cannot be relinked.");
      const resolved = await relinkStandaloneFile(binding, true);
      if (resolved.status === "missing") throw new Error("Choose the source file to relink it.");
      if (resolved.input.kind !== "local-file") throw new Error("This source cannot be relinked.");
      const state = structuredClone(product.state), current = resolved.input.lastSeen;
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
