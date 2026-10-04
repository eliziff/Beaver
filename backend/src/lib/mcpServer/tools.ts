import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { LegalSourceReference } from "mike/shared/contracts/legalSourceReference.mjs";
import { SEARCH_SOURCES_TOOL, searchSources } from "../chat/tools/sourceSearchTools";
import { RESOURCE_TOOLS } from "../chat/resourceTools";
import { objectSchema, toolText } from "../chat/toolRegistry";
import { createLegalEvidenceTurnState, LEGAL_EVIDENCE_SUBMIT_TOOL, legalEvidenceCitationPlan, registerLegalEvidence,
  renderLegalEvidenceAnswer, restorePriorLegalEvidence, storedLegalEvidenceReceipt, submitLegalEvidenceAnswer,
  type RegisteredEvidence } from "../chat/legalEvidence";
import { mikeLocalDataHome } from "../legalDataPath";
import type { LegalEvidenceReceipt } from "mike/shared/contracts/researchContract.mjs";
import { createLegalEvidenceCitations, createLegalEvidenceCitationsFromEntries, legalEvidenceDocumentLink } from "../chat/citations";
import { legalEvidenceAuthority, legalEvidenceLocatorText } from "../chat/citationPresentation";
import { renderCitedBlocks } from "mike/shared/runtime/groundedAnswer.mjs";
import { readLegalSourceResource } from "../researchReader";
import { researchSourceFromResource, researchSourceResource } from "../researchFile";
import { legalSourceOperations } from "../legalSourceApplication";
import { structureNative } from "../structureNative";
import { quoteTextComparison } from "../authoritiesDiscrepancy";

/** The Beaver API the UI and the Authorities tools share, called as the local user. */
export type BeaverApi = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
type Context = { api: BeaverApi; signal: AbortSignal;
  /** Where this connector is reached: a citation's link is <origin>/cite/<evidence_id>. */
  origin: string;
  /** A request to Beaver's API as the local user, made for the app page. */
  beaverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** A short-lived link to a file the app saves. */
  download: (name: string, type: string, bytes: Buffer) => string };
type Handler = (args: Record<string, unknown>, context: Context) => Promise<CallToolResult>;

export const UI_RESOURCE = "ui://beaver/app.html";
const ui = { ui: { resourceUri: UI_RESOURCE }, "openai/outputTemplate": UI_RESOURCE };
const status = (invoking: string, invoked: string) =>
  ({ "openai/toolInvocation/invoking": invoking, "openai/toolInvocation/invoked": invoked });
const appOnly = { ui: { visibility: ["app"] },
  "openai/widgetAccessible": true, "openai/visibility": "private" };

// Sources searched or read this process, so a read can name them by resource; and every passage
// read, so its evidence_id resolves to the exact span and its publisher link.
const knownSources = new Map<string, LegalSourceReference>();
const evidence = new Map<string, RegisteredEvidence>();
const MAX_EVIDENCE = 5_000;
// The answer's claims as last submitted: a correction replaces only the claims Beaver rejected.
let draft: unknown[] | null = null;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const json = (value: unknown, isError = false) => toolText(value, isError);
const withUi = (value: Record<string, unknown>, summary: string): CallToolResult => ({
  content: [{ type: "text", text: summary }], structuredContent: value,
});
/** What the app's sources, Authorities and Library views call; chats, keys and settings stay local. */
const APP_ROUTES = /^\/(?:config|authorities|authorities-runtime|sources|source-workspaces|single-documents|uploads|library|projects|work-products|user\/profile)(?:[/?]|$)/u;
type FormPart = { name: string; value?: string; filename?: string; type?: string; data?: string };

const readTool = RESOURCE_TOOLS.find(({ name }) => name === "Read")!;
const readProperties = readTool.inputSchema.properties as Record<string, object>;
const pick = (names: string[]) => Object.fromEntries(names.map((name) => [name, readProperties[name]]));
const sourceKind = { type: "string", enum: ["case", "legislation", "journal"],
  description: "What the citation names; defaults to case." };
const citationInput = { type: "string", maxLength: 500,
  description: "A citation such as 2014 SCC 71 or RSO 1990, c C.43, when you have no source:// resource." };

const receiptFile = path.join(path.dirname(mikeLocalDataHome()), "mcp-evidence.jsonl");
let stored: Map<string, LegalEvidenceReceipt> | undefined;
const storedReceipts = () => stored ??= new Map((existsSync(receiptFile) ? readFileSync(receiptFile, "utf8").split("\n") : [])
  .flatMap((line) => { try { const receipt = storedLegalEvidenceReceipt(JSON.parse(line));
    return receipt ? [[receipt.evidence_id, receipt] as const] : []; } catch { return []; } }));
async function restore(ids: string[], signal: AbortSignal) {
  const missing = ids.flatMap((id) => !evidence.has(id) && storedReceipts().get(id) || []);
  if (missing.length) for (const entry of await restorePriorLegalEvidence(missing, signal))
    evidence.set(entry.receipt.evidence_id, entry);
}

function remember(outcome: Awaited<ReturnType<typeof readLegalSourceResource>>) {
  for (const receipt of outcome?.evidence ?? []) {
    if (!storedReceipts().has(receipt.evidence_id)) {
      storedReceipts().set(receipt.evidence_id, receipt);
      appendFileSync(receiptFile, JSON.stringify(receipt) + "\n");
    }
    evidence.delete(receipt.evidence_id);
    evidence.set(receipt.evidence_id, { receipt, ...outcome?.evidenceSources?.get(receipt.evidence_id) });
  }
  for (const id of evidence.keys()) { if (evidence.size <= MAX_EVIDENCE) break; evidence.delete(id); }
}

/** A source:// resource from file_path, or the one source a citation resolves to. */
async function sourceResource(args: Record<string, unknown>, signal: AbortSignal) {
  const resource = text(args.file_path);
  if (resource) return { resource };
  const citation = text(args.citation);
  if (!citation) return { error: "Give file_path (a source:// resource) or citation." };
  const kind = (["case", "legislation", "journal"].includes(text(args.kind)) ? text(args.kind) : "case") as
    "case" | "legislation" | "journal";
  const resolved = await legalSourceOperations.resolve({ text: citation, kind, signal });
  if (resolved.status !== "found") return { error: resolved.status === "ambiguous"
    ? `${citation} matches more than one source; search for it and read the right resource.`
    : `${citation} did not resolve to an available source; search for it instead.` };
  const key = researchSourceResource(resolved.value);
  knownSources.set(key, resolved.value);
  return { resource: key };
}

async function read(args: Record<string, unknown>, signal: AbortSignal) {
  const outcome = await readLegalSourceResource({ id: `mcp-${randomUUID()}`, name: "Read", input: args },
    args, { userId: "", signal, knownSources });
  remember(outcome);
  return outcome;
}

/** A citation's link names only its evidence: Beaver builds the publisher link (paragraph or section
 *  anchor with a text fragment of the exact words) when it is opened. */
const citeLink = (origin: string, ids: readonly string[]) => `${origin}/cite/${ids.join("+")}`;
/** Each passage with Beaver's citation of it and its link. */
function linked<T extends { evidence_id: string }>(passage: T, origin: string) {
  const entry = evidence.get(passage.evidence_id);
  if (!entry) return passage;
  return { ...passage, cite: [legalEvidenceAuthority(entry.receipt), legalEvidenceLocatorText(entry)].filter(Boolean).join(", "),
    link: citeLink(origin, [passage.evidence_id]) };
}
function withLinks(result: CallToolResult, origin: string): CallToolResult {
  const block = result.content[0];
  if (result.isError || block?.type !== "text") return result;
  const data = JSON.parse(block.text) as { passages?: Array<{ evidence_id: string }> };
  return Array.isArray(data.passages)
    ? json({ ...data, passages: data.passages.map((passage) => linked(passage, origin)) }) : result;
}

const passagesOf = (result: CallToolResult) => {
  const block = result.content[0];
  try {
    const data = JSON.parse(block?.type === "text" ? block.text : "{}") as { passages?: unknown };
    return Array.isArray(data.passages) ? data.passages as Array<{ evidence_id: string; text: string;
      kind: string; locator: string }> : [];
  } catch { return []; }
};

async function authoritiesSummary(api: BeaverApi, id: string) {
  const product = await api(`/authorities/${encodeURIComponent(id)}`) as {
    id: string; title: string; revision: number; outputs: Record<string, { filename: string }>;
    state: { stage?: string; authorityOrder: string[]; authorities: Record<string, {
      kind: string; citation: string; name?: string | null; excluded?: boolean; source: { kind: string } }> } };
  return { id: product.id, title: product.title, revision: product.revision, stage: product.state.stage ?? "citations",
    outputs: Object.entries(product.outputs).map(([role, output]) => ({ role, filename: output.filename })),
    authorities: product.state.authorityOrder.map((authorityId) => {
      const authority = product.state.authorities[authorityId];
      return { id: authorityId, kind: authority?.kind, citation: authority?.citation, name: authority?.name ?? null,
        source: authority?.source.kind, ...(authority?.excluded ? { excluded: true } : {}) };
    }) };
}

const draftId = { type: "string", description: "Authorities draft id from authorities_list." };

/** The brief saved to the user's Beaver library and imported as a new draft, with the court defaults. */
async function importAttached(context: Context, url: string, name: string, type?: string) {
  const file = await fetch(url, { signal: context.signal });
  if (!file.ok) throw new Error("The attached file could not be read.");
  const form = new FormData();
  form.append("file", new Blob([await file.arrayBuffer()], { type: type || file.headers.get("content-type") || "" }), name);
  const saved = await context.beaverFetch("/authorities/documents", { method: "POST", body: form });
  if (!saved.ok) throw new Error(((await saved.json()) as { detail?: string }).detail ?? "Beaver could not save the brief.");
  const document = await saved.json() as { id: string };
  const product = await context.api("/authorities", { method: "POST", body: {
    source: { kind: "document", documentId: document.id, version: "latest" }, title: name.replace(/\.[^.]+$/u, "") } }) as { id: string };
  return product.id;
}

const definitions: Array<Tool & { run: Handler }> = [{
  name: "search_legal_sources",
  title: "Search legal sources",
  description: `${SEARCH_SOURCES_TOOL.description} Each result's resource (source://…) is what read_passage reads.`,
  inputSchema: SEARCH_SOURCES_TOOL.inputSchema,
  annotations: { readOnlyHint: true },
  _meta: status("Searching legal sources…", "Searched legal sources"),
  async run(args, { signal }) {
    const searched = await searchSources(args, signal);
    for (const value of Array.isArray(searched.results) ? searched.results : []) {
      const entry = value as Record<string, unknown>, resource = text(entry.resource);
      const source = resource ? researchSourceFromResource(resource) : null;
      if (source) knownSources.set(researchSourceResource(source), { ...source, title: text(entry.title) || null,
        citation: text(entry.citation) || source.citation, url: text(entry.url) || null });
    }
    return json(searched);
  },
}, {
  name: "read_passage",
  title: "Read a legal passage",
  description: "Read exact passages of a case, statute or article. Every unit returned has its evidence_id, Beaver's citation of it (cite) and its link, which opens the publisher's page at the exact words. Read a run of paragraphs in one call with locator and end_locator; find phrases with pattern or patterns. Cite what you write as [cite](link) with the link exactly as given, and finish a grounded answer with submit_grounded_answer.",
  inputSchema: objectSchema({
    file_path: { type: "string", description: "A source:// resource from search_legal_sources." },
    citation: citationInput, kind: sourceKind,
    ...pick(["locator_kind", "locator", "end_locator", "context_blocks", "pattern", "patterns", "max_results",
      "context_chars", "offset", "limit", "start_char"]),
  }),
  annotations: { readOnlyHint: true },
  _meta: status("Reading the passage…", "Read the passage"),
  async run(args, { signal, origin }) {
    const located = await sourceResource(args, signal);
    if (located.error) return json({ ok: false, error: located.error }, true);
    const { citation: _citation, kind: _kind, ...input } = args;
    const outcome = await read({ ...input, file_path: located.resource }, signal);
    return outcome ? withLinks(outcome.result, origin) : json({ ok: false, error: "That resource is not a readable legal source." }, true);
  },
}, {
  name: "verify_quote",
  title: "Verify a quotation",
  description: "Check that a quotation appears verbatim in a legal source, at a pinpoint when given. Returns verified or mismatch with the exact source text and the corrected quotation, and the passage's evidence_id, cite and direct link.",
  inputSchema: objectSchema({
    quote: { type: "string", minLength: 3, maxLength: 4_000, description: "The quotation, without surrounding quotation marks." },
    file_path: { type: "string", description: "A source:// resource from search_legal_sources." },
    citation: citationInput, kind: sourceKind,
    ...pick(["locator_kind", "locator", "end_locator"]),
  }, ["quote"]),
  annotations: { readOnlyHint: true },
  _meta: status("Checking the quotation…", "Checked the quotation"),
  async run(args, { signal, origin }) {
    const quote = text(args.quote).replace(/^["“”']+|["“”']+$/gu, "");
    const located = await sourceResource(args, signal);
    if (located.error) return json({ ok: false, error: located.error }, true);
    const words = quote.split(/\s+/u);
    // Without a pinpoint, the quotation's opening and closing words find the passages to compare.
    const locate = text(args.locator) ? { locator_kind: args.locator_kind, locator: args.locator,
      ...(args.end_locator ? { end_locator: args.end_locator } : {}) }
      : { patterns: [...new Set([words.slice(0, 6).join(" "), words.slice(-6).join(" ")])], max_results: 6 };
    const outcome = await read({ file_path: located.resource, ...locate }, signal);
    const passages = outcome ? passagesOf(outcome.result) : [];
    if (!passages.length) return json({ ok: true, status: "unlocated",
      detail: "No passage of the source contains the quotation's opening or closing words; read the source to find it." });
    const source = passages.map(({ text }) => text).join("\n\n");
    const errors = structureNative().groundedProseErrors(`“${quote}”`, ["q"], [{ evidenceId: "q", text: source, labels: [] }]);
    const comparison = quoteTextComparison(quote, source);
    // The passages the quotation (or its closest source text) falls in.
    const found = comparison.candidate ? source.indexOf(comparison.candidate) : -1;
    let offset = 0;
    const spans = passages.map((passage) => { const start = offset; offset += passage.text.length + 2;
      return { passage, start, end: start + passage.text.length }; });
    const matched = found < 0 ? passages : spans.filter(({ start, end }) =>
      start < found + comparison.candidate!.length && end > found).map(({ passage }) => passage);
    return json({ ok: true, status: errors.length ? "mismatch" : "verified",
      ...(errors.length ? { source_text: comparison.candidate, changes: comparison.changes } : {}),
      passages: matched.map(({ evidence_id, kind, locator }) => linked({ evidence_id, kind, locator }, origin)) });
  },
}, {
  // Beaver's own grounded-answer contract: it checks every claim against its passages, plans the
  // citations, and builds each one's publisher pinpoint link (paragraph or section anchor with a
  // text fragment of the exact words).
  ...LEGAL_EVIDENCE_SUBMIT_TOOL,
  title: "Submit the grounded answer",
  _meta: { ...ui, ...status("Checking the answer against its passages…", "Checked the answer") },
  async run(args, context) {
    const state = createLegalEvidenceTurnState();
    state.draft = draft;
    const cited = [...new Set(JSON.stringify([args, draft]).match(/\be_[\w-]{18}(?![\w-])/gu) ?? [])];
    await restore(cited, context.signal);
    for (const id of new Set(JSON.stringify([args, draft]).match(/\be_[\w-]{18}(?![\w-])/gu) ?? [])) {
      const entry = evidence.get(id);
      if (entry) registerLegalEvidence(state, entry.receipt, entry);
    }
    const submitted = submitLegalEvidenceAnswer(args, state);
    draft = state.draft ?? null;
    if (!submitted.ok) return json(submitted, true);
    const citations = createLegalEvidenceCitations(state), { groups, claimRefs } = legalEvidenceCitationPlan(state);
    const link = (ref: number) => {
      const citation = citations.find((candidate) => candidate.ref === ref);
      if (!citation || (citation.kind !== "a2aj" && citation.kind !== "public_legal")) return [];
      const name = groups[ref - 1]?.shortForm ? citation.short_authority ?? citation.authority : citation.authority;
      return [`[${[name ?? citation.citation, citation.pinpoint].filter(Boolean).join(", ")}](${citeLink(context.origin,
        groups[ref - 1]!.members.map(({ receipt }) => receipt.evidence_id))})`];
    };
    const linked = renderCitedBlocks(state.answer!.map((claim, index) =>
      ({ text: claim.text, citations: claimRefs[index].flatMap(link) })));
    return withUi({ view: "answer", text: renderLegalEvidenceAnswer(state), citations }, linked);
  },
}, {
  name: "authorities_list",
  title: "List Authorities drafts",
  description: "List the user's Table/Book of Authorities drafts, newest first.",
  inputSchema: objectSchema({}),
  annotations: { readOnlyHint: true },
  _meta: status("Listing drafts…", "Listed drafts"),
  async run(_args, { api }) {
    const drafts = await api("/authorities?limit=20") as Array<{ id: string; title: string; revision: number; updatedAt: string }>;
    return json(drafts.map(({ id, title, revision, updatedAt }) => ({ id, title, revision, updatedAt })));
  },
}, {
  name: "authorities_open",
  title: "Open Authorities",
  description: "Open Beaver Authorities for the user: import a factum or brief (PDF or Word), review its citations, gather and highlight sources, and build the Book of Authorities. Opens the given draft; imports the brief the user attached to the chat when given as file; otherwise opens a new import.",
  inputSchema: objectSchema({ draft_id: draftId, file: { type: "object", description: "A PDF or Word brief the user attached to the chat.",
    properties: { download_url: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" },
      file_name: { type: "string" } }, required: ["download_url", "file_id"] } }),
  _meta: { ...ui, ...status("Opening Authorities…", "Opened Authorities"), "openai/fileParams": ["file"] },
  async run(args, context) {
    const attached = args.file as { download_url?: string; file_name?: string; mime_type?: string } | undefined;
    const id = attached?.download_url ? await importAttached(context, attached.download_url,
      attached.file_name || "brief.pdf", attached.mime_type) : text(args.draft_id);
    const summary = id ? await authoritiesSummary(context.api, id) : null;
    return withUi({ view: "authorities", draftId: id || null, title: summary?.title ?? null,
      stage: summary?.stage ?? null, authorities: summary?.authorities.length ?? 0 },
      summary ? `Opened ${summary.title} (${summary.authorities.length} authorities, stage ${summary.stage}).`
        : "Opened Authorities for a new import. The user chooses the brief in the app.");
  },
}, {
  name: "authorities_review",
  title: "Review an Authorities draft",
  description: "Read an Authorities draft: its authorities with ids, citations and source status, its built outputs, and the quotation and pinpoint discrepancies found against the sources.",
  inputSchema: objectSchema({ draft_id: draftId }, ["draft_id"]),
  annotations: { readOnlyHint: true },
  _meta: status("Reviewing the draft…", "Reviewed the draft"),
  async run(args, { api }) {
    const id = text(args.draft_id);
    const [summary, discrepancies] = await Promise.all([authoritiesSummary(api, id),
      api(`/authorities/${encodeURIComponent(id)}/discrepancies`, { method: "POST" })]);
    return json({ ...summary, discrepancies });
  },
}, {
  name: "authorities_act",
  title: "Change an Authorities draft",
  description: "Apply one change to an Authorities draft at its current revision. Actions include {type:\"add-authority\",kind,citation,name?}, {type:\"remove-authority\",authorityId}, {type:\"exclude-authority\",authorityId,excluded}, {type:\"move-authority\",authorityId,toIndex}, {type:\"edit-authority\",authorityId,kind,citation,name}, {type:\"rename-authority\",authorityId,displayName}, {type:\"set-stage\",stage}. kind is case, legislation, commentary or other.",
  inputSchema: objectSchema({ draft_id: draftId, revision: { type: "integer", minimum: 0 },
    action: { type: "object", description: "The change, as listed above." } }, ["draft_id", "revision", "action"]),
  _meta: status("Changing the draft…", "Changed the draft"),
  async run(args, { api }) {
    const id = text(args.draft_id);
    await api(`/authorities/${encodeURIComponent(id)}/actions`, { method: "POST",
      body: { revision: args.revision, action: args.action } });
    return json(await authoritiesSummary(api, id));
  },
}, {
  name: "authorities_build",
  title: "Build the Book of Authorities",
  description: "Build a draft's outputs (Book of Authorities PDF and Word table) and show them to the user to download. The user can also build from the open Authorities app.",
  inputSchema: objectSchema({ draft_id: draftId }, ["draft_id"]),
  _meta: { ...ui, ...status("Building the book…", "Built the book") },
  async run(args, context) {
    const id = text(args.draft_id);
    const { revision } = await authoritiesSummary(context.api, id);
    const built = await context.api(`/authorities/${encodeURIComponent(id)}/build`, { method: "POST", body: { revision } }) as
      { product: { title: string; outputs: Record<string, { filename: string }> } };
    const files = Object.values(built.product.outputs).map(({ filename }) => filename);
    return withUi({ view: "authorities", draftId: id, title: built.product.title },
      `Built ${files.join(", ")}. The user downloads them from the Build step shown.`);
  },
}, {
  name: "beaver_api",
  title: "Beaver app request",
  description: "Used by the Beaver app to read and change what it shows.",
  inputSchema: objectSchema({ method: { type: "string" }, path: { type: "string" },
    headers: { type: "object" }, body: { type: "string" }, base64: { type: "string" },
    form: { type: "array", items: { type: "object" } } }, ["method", "path"]),
  _meta: appOnly,
  async run(args, { beaverFetch }) {
    const route = text(args.path);
    if (!APP_ROUTES.test(route)) return json({ ok: false, error: "Beaver does not offer that here." }, true);
    const headers = Object.fromEntries(Object.entries((args.headers ?? {}) as Record<string, string>)
      .filter(([name]) => /^(?:accept|content-type|if-[\w-]+)$/iu.test(name) && !(args.form && /^content-type$/iu.test(name))));
    let body: BodyInit | undefined;
    if (Array.isArray(args.form)) {
      const form = new FormData();
      for (const part of args.form as FormPart[]) form.append(part.name, part.data === undefined ? part.value ?? ""
        : new Blob([Buffer.from(part.data, "base64")], { type: part.type ?? "application/octet-stream" }), part.filename);
      body = form;
    } else if (typeof args.base64 === "string") body = Buffer.from(args.base64, "base64");
    else if (typeof args.body === "string") body = args.body;
    const response = await beaverFetch(route, { method: text(args.method) || "GET", headers, body });
    const type = response.headers.get("content-type") ?? "", bytes = Buffer.from(await response.arrayBuffer());
    const reply = { status: response.status, headers: Object.fromEntries(["content-type", "content-disposition"]
      .flatMap((name) => response.headers.get(name) ? [[name, response.headers.get(name)!]] : [])),
      ...(/json|text|x-beaver-progress/u.test(type) ? { text: bytes.toString("utf8") } : { base64: bytes.toString("base64") }) };
    return { content: [{ type: "text", text: String(response.status) }], structuredContent: reply };
  },
}, {
  name: "beaver_download",
  title: "Beaver app download",
  description: "Used by the Beaver app to save a file where the chat app has no download of its own.",
  inputSchema: objectSchema({ filename: { type: "string" }, type: { type: "string" }, data: { type: "string" } },
    ["filename", "type", "data"]),
  _meta: appOnly,
  async run(args, { download }) {
    return { content: [{ type: "text", text: "Ready." }],
      structuredContent: { url: download(text(args.filename), text(args.type), Buffer.from(text(args.data), "base64")) } };
  },
}];

export const tools: Tool[] = definitions.map(({ run: _run, ...tool }) => tool);

export async function callTool(name: string, args: Record<string, unknown>, context: Context): Promise<CallToolResult> {
  const tool = definitions.find((definition) => definition.name === name);
  if (!tool) return json({ ok: false, error: `Unknown tool ${name}` }, true);
  try { return await tool.run(args, context); }
  catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, true); }
}

/** The link Beaver builds for cited passages, as its citation chip opens it: what a chat's
 *  /cite/<evidence_id>[+<evidence_id>…] link opens. */
export async function evidenceLink(ids: string[], signal: AbortSignal) {
  await restore(ids, signal);
  const entries = ids.flatMap((id) => evidence.get(id) ?? []);
  if (entries.length !== ids.length || !entries.length) return null;
  if (entries.length === 1) {
    const link = legalEvidenceDocumentLink(entries[0]);
    return link.pinpoint?.url ?? link.mainUrl;
  }
  const [citation] = createLegalEvidenceCitationsFromEntries(entries);
  return citation && "url" in citation ? citation.url ?? null : null;
}
