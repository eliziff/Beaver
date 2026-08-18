import { appUrl } from "../appRoutes";
import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import { parseResourceReference, resourceReference } from "../resourceReferences";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  readLegalSourcePassage,
  type LegalSourcePassage,
  type LegalSourceReference,
} from "../legalSourceRegistry";
import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
import { linkDocxCitations } from "../docxCitationLinking";
import { fixDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintDocxStructure } from "../docxStructuralLint";
import {
  deleteProvisionAndRenumberSiblings,
  type DeleteAndRenumberReceipt,
} from "../legalAmendOps";
import { compileAgreementSkeleton, readSection, skeletonSubtreeLabels, type AgreementSkeleton, type CompileSkeletonOptions, type TableCellSpan } from "../legalTextSkeleton";
import {
  crossReferenceGraph,
  type CrossReferenceGraph,
} from "../legalCrossReference";
import {
  bakedCrossReferenceGraph,
  bakedSkeleton,
} from "../legalStructureSidecar";
import { pageMapFromMarkers, pageMapFromSourceDoc, graphScope, parseAddress, resolvePage, selectPages, type FollowDirection, type PageMap } from "../legalDocumentNavigator";
import { extractDocxDraftingSource } from "../docxDraftingSource";
import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";
import { resolveDraftingOptions } from "../draftingStyle";
import { getDraftingStyleSettings } from "../draftingStyleStore";
import {
  applyTrackedEdits,
  extractDocxBodyStructure,
  extractDocxBodyText,
  finalizeTrackedEdits,
  insertTrackedBlocks,
  type EditMode,
  type EditInput,
} from "../docxTrackedChanges";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";
import type {
  AssistantEdit,
  DocumentContent,
  DocumentProvenance,
  DocumentScope,
  DocumentStore,
} from "../documentStore";
import {
  documentProjectionService,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
} from "../documentProjectionService";
import {
  lookupProviderPdfReference,
  rehydrateProviderPdfReference,
  type ProviderPdfAttachment,
  type ProviderPdfAttachmentState,
} from "../providerPdfLibraryBridge";
import { registerProviderPdfEvidenceForTurn } from "./localPdfEvidenceState";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  Tool,
} from "../llm";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import {
  A2AJ_REFERENCE_NEIGHBORHOOD_ENABLED,
  a2ajLookupEvidenceBlocks,
  assistantToolActivityLabel,
  readA2AJReferenceNeighborhood,
  type A2AJReferenceDirection,
} from "./tools/a2ajTools";
import {
  createA2AJLookupEvidence,
  createBenchmarkEvidence,
  createLibraryEvidence,
  createPublicJournalPassageEvidence,
  legalEvidenceProseIntegrityErrors,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./legalEvidence";
import {
  COURTLISTENER_FIND_TOOL,
  COURTLISTENER_VERIFY_TOOL,
} from "./tools/courtlistenerTools";
import { CITATOR_TOOLS, executeCitatorTool } from "./tools/citatorTools";
import {
  COMPARE_VERSIONS_TOOLS,
  executeCompareVersionsTool,
} from "./tools/compareVersionsTool";
import {
  SEARCH_SOURCES_TOOL,
  searchSources,
} from "./tools/sourceSearchTools";
import { legalSourcePdfFallbacks } from "./legalSourcePdfFallback";
import {
  applyTextOpsToDocx,
  type TextOpRequest,
  type TextOpScope,
} from "../docxTextOps";
import { TEXT_OP_NAMES } from "../textOps";
import {
  boundedParagraphTail,
  buildPptxPresentation,
  presentationFromMarkdown,
  renderMarkdownDocx,
  renderXlsxWorkbook,
  safeGeneratedFilename,
  workbookFromMarkdown,
} from "./tools/documentOps";
import { quoteRepairSuggestion } from "./quoteRepair";
import { docxCautionNotes } from "./tools/docxPathologyNotes";
import { projectDocxRedline } from "../docx/redline";
import {
  ADVANCED_DOCX_EDIT_TOOL,
  TABULAR_TOOLS,
  WRITE_TOOL,
} from "./tools/toolSchemas";
import {
  captureCourtlistenerCase,
  courtlistenerPdfFallback,
  runLocalCourtlistenerTool,
  type CourtlistenerToolState,
} from "./courtlistenerToolRunner";
import { RESOURCE_TOOLS, globPattern as globRegExp } from "./resourceTools";
import {
  citationLinkingEvent,
  supraFixEvent,
  tableOfAuthoritiesEvent,
  type LocalAutomationEvent,
} from "./localAutomationEvent";
import {
  toolResultText,
  toolText,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { readTabularCells } from "./tabularCells";
import type { TabularCellStore, WorkflowStore } from "./types";

const tool = (
  name: string,
  description: string,
  parameters: Tool["inputSchema"],
  readOnly = false,
): Tool => ({
  name,
  description,
  inputSchema: parameters,
  annotations: { readOnlyHint: readOnly },
});

const DOCUMENT_ID_PROPERTY = {
  type: "string",
  description: "Document resource returned by Glob, or a unique filename.",
};
const OPTIONAL_VERSION_ID_PROPERTY = {
  type: "string",
  description: "Optional Library version id. Omit for the active version.",
};

export const DOCUMENT_TOOLS: Tool[] = [
tool(
    "update_library_metadata",
    "Save jurisdiction, practice-area, document-type, description, and note metadata for a Library item. Only when the user asks to classify or annotate; do not invent facts.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        kind: { type: "string", enum: ["file", "template"] },
        metadata: {
          type: "object",
          properties: {
            jurisdiction: { type: "string" },
            areas_of_law: { type: "array", items: { type: "string" } },
            document_types: { type: "array", items: { type: "string" } },
            description: { type: "string" },
          },
        },
        notes: { type: "string" },
      },
      required: ["document_id", "kind"],
    },
  ),
tool(
    "link_docx_citations",
    "Create a new Library DOCX version with verified provider links on its footnote citations. It splits and routes the footnotes itself; do not read, split, classify, or construct citation URLs before calling it.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
tool(
    "fix_docx_supras",
    "Turn unambiguous plain 'supra note N' numbers in a Library DOCX into native updating Word footnote cross-references. Creates a new version when it changes anything and reports ambiguous/restarted/split cases for review.",
    {
      type: "object",
      properties: { document_id: DOCUMENT_ID_PROPERTY },
      required: ["document_id"],
    },
  ),
tool(
    "lint_docx_structure",
    "Structural lint on a Library DOCX: broken internal cross-references, references to missing schedules/exhibits, numbering gaps and duplicates, duplicate or unused defined terms. Read-only; returns located findings plus a receipt of what was checked and abstained from.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
      },
      required: ["document_id"],
    },
    true,
  ),
tool(
    "delete_and_renumber_docx",
    "Delete one numbered provision from a Library DOCX and close that exact sibling gap as tracked changes. The server renumbers following sibling headings and every resolved internal pointer in one atomic operation. It refuses the whole mutation if the target, sequence, or any affected reference is missing, ambiguous, external, or otherwise unsafe. This is deliberately delete-and-close-gap only; it does not insert provisions or open a numbering gap.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
        target: {
          type: "string",
          description:
            "Exact provision handle from Grep, such as '8.02' or '8.02(a)'.",
        },
      },
      required: ["document_id", "target"],
    },
  ),
tool(
    "create_table_of_authorities",
    "Submit one owned Word or PDF Library version to the authorities workflow. A PDF can create a Book of Authorities; inserting a table requires Word. Detection is deterministic first, with a bounded cached Codex splitter only for unresolved citation units. Never pass or invent filesystem paths.",
    {
      type: "object",
      properties: {
        document_id: DOCUMENT_ID_PROPERTY,
        version_id: OPTIONAL_VERSION_ID_PROPERTY,
        split_fallback: {
          type: "string",
          enum: ["off", "auto"],
          description:
            "auto invokes the cached Codex splitter only when deterministic splitting is incomplete. Defaults to auto.",
        },
      },
      required: ["document_id"],
    },
  ),
];

/**
 * Structure for a source document, served from the existing pre-baked
 * sidecar with a compile-on-miss fallback.
 *
 * The sidecars exist because the in-memory memo only helps within a process:
 * the Income Tax Act costs ~13.4s to compile cold and ~658ms to read baked,
 * and those landmark statutes are exactly the documents a model must navigate
 * rather than read. A miss falls through to a real compile, so correctness
 * never depends on a bake — only speed does.
 *
 */
async function documentStructure(
  text: string,
  id = "",
  options: CompileSkeletonOptions = {},
) {
  return bakedSkeleton(text, id, options);
}

/**
 * Version-memoized section-lead offsets on the coding grep plane
 * (MIKE_GREP_SECTION_CONTEXT). Two-plane on purpose: nodes come from the
 * docx detectors, anchored into the served text — the skeleton compiler
 * finds 0 nodes on pandoc markdown (probed 2026-08-06, zenith supply
 * agreement), so a served-plane-only resolver would silently annotate
 * nothing. Non-docx documents and extraction failures degrade soft: rows
 * render without section leads.
 */
async function documentGraph(
  text: string,
  id: string,
  options: CompileSkeletonOptions = {},
) {
  return bakedCrossReferenceGraph(text, id, options);
}

function oneHopLegalScope(
  skeleton: AgreementSkeleton,
  graph: CrossReferenceGraph,
  seedLabel: string,
  direction: "inbound" | "outbound" | "both",
) {
  const lookup = readSection(skeleton, seedLabel);
  if (lookup.status !== "found" || !lookup.block) return null;
  const seed = skeleton.nodes.find(
    (node) =>
      node.label === lookup.block!.label &&
      node.start === lookup.block!.start &&
      node.end === lookup.block!.end,
  );
  if (!seed) return null;
  const subtree = skeletonSubtreeLabels(skeleton, seed.label);
  const byLabel = new Map(skeleton.nodes.map((node) => [node.label, node]));
  const reached = new Map<string, (typeof skeleton.nodes)[number]>();
  for (const edge of graph.edges) {
    if (edge.status !== "resolved" || edge.selfLoop) continue;
    if (
      (direction === "outbound" || direction === "both") &&
      edge.sourceLabel &&
      subtree.has(edge.sourceLabel) &&
      edge.targetLabel &&
      !subtree.has(edge.targetLabel)
    ) {
      const node = byLabel.get(edge.targetLabel);
      if (node) reached.set(node.label, node);
    }
    if (
      (direction === "inbound" || direction === "both") &&
      edge.targetLabel &&
      subtree.has(edge.targetLabel) &&
      edge.sourceLabel &&
      !subtree.has(edge.sourceLabel)
    ) {
      const node = byLabel.get(edge.sourceLabel);
      if (node) reached.set(node.label, node);
    }
  }
  return {
    seed,
    nodes: [
      seed,
      ...[...reached.values()].sort((left, right) => left.start - right.start),
    ],
  };
}






function findNearestSuggestion(query: string, body: string): string | null {
  const spans: string[] = [];
  for (let at = 0; at < body.length && spans.length < 40; at += 12_000) {
    spans.push(body.slice(at, at + 15_000));
  }
  return quoteRepairSuggestion(query.replace(/^["'“‘]+|["'”’]+$/gu, ""), spans);
}

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

type AssistantDocument = Record<string, unknown> & {
  id: string;
  filename: string;
  current_version_id: string;
  file_type: string;
};

const assistantDocument = (value: unknown): AssistantDocument | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.filename === "string" &&
      typeof row.current_version_id === "string" &&
      typeof row.file_type === "string"
    ? row as AssistantDocument
    : null;
};

const documentsFromPage = (items: Record<string, unknown>[]) =>
  items.flatMap((item) => {
    const row = item.kind === "document" ? assistantDocument(item.document) : null;
    return row ? [row] : [];
  });

async function scopedDocuments(
  scope: DocumentScope,
  library: LibraryStore,
  projects: ProjectStore,
  allowedDocumentIds?: ReadonlySet<string>,
  limit = 200,
  matterId?: string | null,
) : Promise<AssistantDocument[]> {
  if (matterId) {
    return documentsFromPage((await projects.directory(
      scope,
      matterId,
      { q: "", parentFolderId: null, limit, after: null },
    )).items);
  }
  if (allowedDocumentIds) {
    return (await Promise.all([...allowedDocumentIds].map((id) =>
      library.document({ ...scope, kind: "file" }, id))))
      .flatMap((row) => assistantDocument(row) ?? []);
  }
  return documentsFromPage((await library.page(
    { ...scope, kind: "file" },
    {
      q: "",
      parentFolderId: null,
      limit,
      after: null,
      documentsOnly: true,
    },
  )).items as Record<string, unknown>[]);
}

async function resolveDocumentArgument(
  scope: DocumentScope,
  input: Record<string, unknown>,
  library: LibraryStore,
  projects: ProjectStore,
  allowedDocumentIds?: ReadonlySet<string>,
  matterId?: string | null,
): Promise<{ input: Record<string, unknown>; error?: string }> {
  const reference = trimmed(input.document_id);
  if (!reference) return { input };
  const resource = parseResourceReference(reference);
  if (resource?.kind === "document") {
    return { input: { ...input, document_id: resource.documentId } };
  }
  const documents = await scopedDocuments(
    scope, library, projects, allowedDocumentIds, 200, matterId,
  );
  if (documents.some(({ id }) => id === reference)) return { input };
  const matches = documents.filter(
    ({ filename }) => filename.localeCompare(reference, undefined, {
      sensitivity: "accent",
    }) === 0,
  );
  if (matches.length > 1) {
    return {
      input,
      error: `Filename '${reference}' is ambiguous. Use Glob to obtain its document_id.`,
    };
  }
  return {
    input: matches.length === 1
      ? { ...input, document_id: matches[0].id }
      : input,
  };
}

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number"
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
const positiveInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number"
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export type AssistantEditTurnState = Map<
  string,
  { versionId: string; parentVersionId: string }
>;

/** Create or update the one assistant-edit version for this document/turn. */
export async function commitAssistantTurnVersion(params: {
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  sourceVersionId: string;
  filename: string;
  bytes: Buffer;
  trackedEdits: AssistantEdit[];
  turnEditState?: AssistantEditTurnState;
  editMode?: EditMode;
}) {
  const existing = params.turnEditState?.get(params.documentId);
  if (existing && existing.versionId !== params.sourceVersionId) return null;
  const parentVersionId = existing?.parentVersionId ?? params.sourceVersionId;
  const finalized = params.trackedEdits.length
    ? await finalizeTrackedEdits(
        params.bytes,
        params.trackedEdits.flatMap((edit) =>
          [edit.delWId, edit.insWId].filter((id): id is string => !!id),
        ),
        params.editMode ?? "manual",
      )
    : { bytes: params.bytes, status: "pending" as const };
  const committed = await params.documents.commitAssistantVersion(
    params.scope,
    params.documentId,
    {
      sourceVersionId: params.sourceVersionId,
      ...(existing ? { turnVersionId: existing.versionId } : {}),
      parentVersionId,
      filename: params.filename,
      bytes: finalized.bytes,
      edits: params.trackedEdits,
      status: finalized.status,
    },
  );
  if (committed.status === "committed") {
    params.turnEditState?.set(params.documentId, {
      versionId: committed.version.id,
      parentVersionId,
    });
  }
  return committed.status === "committed"
    ? {
        version: committed.version,
        parentVersionId,
        trackedEdits: committed.edits,
      }
      : null;
}

async function saveDocxEdits(params: {
  call: NormalizedToolCall;
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  source: DocumentContent;
  bytes: Buffer;
  edits: AssistantEdit[];
  turnEditState?: AssistantEditTurnState;
  editMode: EditMode;
  extra?: Record<string, unknown>;
}) {
  const committed = await commitAssistantTurnVersion({
    documents: params.documents,
    scope: params.scope,
    documentId: params.documentId,
    sourceVersionId: params.source.version.id,
    filename: params.source.version.filename ?? params.source.filename,
    bytes: params.bytes,
    trackedEdits: params.edits,
    turnEditState: params.turnEditState,
    editMode: params.editMode,
  });
  if (!committed) return fail(params.call, "The active document version changed.");
  const { version, parentVersionId, trackedEdits } = committed;
  const lint = await lintDocxStructure(params.bytes).catch(() => null);
  return documentResult(params.call, {
    ok: true,
    receipt: "mike-document:v1",
    action: "revised",
    edit_mode: params.editMode,
    document_id: params.documentId,
    parent_version_id: parentVersionId,
    version_id: version.id,
    version_number: version.version_number,
    filename: version.filename,
    file_type: version.file_type,
    source_sha256: version.source_sha256,
    change_count: trackedEdits.length,
    resource: resourceReference.document(params.documentId, version.id),
    download_url:
      `/single-documents/${encodeURIComponent(params.documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`,
    annotations: trackedEdits.map((edit) => ({
      kind: "edit",
      edit_id: edit.id,
      document_id: params.documentId,
      version_id: version.id,
      version_number: version.version_number,
      change_id: edit.changeId,
      del_w_id: edit.delWId,
      ins_w_id: edit.insWId,
      deleted_text: edit.deletedText,
      inserted_text: edit.insertedText,
      context_before: edit.contextBefore,
      context_after: edit.contextAfter,
      reason: edit.reason,
      diff: edit.diff,
      status: edit.status,
    })),
    structural_lint: lint
      ? {
          finding_count: lint.findings.length,
          findings: lint.findings.slice(0, 8),
          notes: lint.notes,
        }
      : undefined,
    ...params.extra,
  });
}

// ---------------------------------------------------------------------------
// Coding-shape aliases: Glob/Grep/Read over the library, file-path addressed,
// line-numbered. Output mirrors the native tools (cat -n reads, rg-style
// match lines, plain-text errors) because the trained package is the whole
// interaction grammar, not just the schema names.
// ---------------------------------------------------------------------------


const GREP_LINE_CAP = 2_000;

type CodingOutputLine = {
  rendered: string;
  span?: [number, number];
  readGrant?: { line: number; startChar: number };
  handoffCandidate?: boolean;
  source?: {
    documentId: string;
    versionId: string;
    filename?: string;
    locator?: string;
    locatorKind?: "paragraph" | "page" | "section" | "footnote";
    virtualPath?: string;
    projection?: string;
    sourceText?: string;
  };
};

/**
 * Max-min fair split of a row budget across per-file buckets
 * (GREP_PER_FILE_BUDGET_ENABLED). Water-filling: every file wanting less
 * than an equal share takes all it wants and releases the surplus to the
 * files still contending, so a corpus where only three documents match
 * still spends the whole budget on those three. Returns per-bucket counts
 * in the caller's original (corpus) order.
 */
function fairFileAllocation(sizes: number[], budget: number): number[] {
  const alloc = sizes.map(() => 0);
  if (!sizes.length || budget <= 0) return alloc;
  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((left, right) => left.size - right.size || left.index - right.index);
  let remaining = budget;
  let cursor = 0;
  while (cursor < order.length) {
    const entry = order[cursor];
    const share = Math.floor(remaining / (order.length - cursor));
    if (entry.size > share) break;
    alloc[entry.index] = entry.size;
    remaining -= entry.size;
    cursor += 1;
  }
  const contenders = order.slice(cursor);
  if (contenders.length) {
    const share = Math.floor(remaining / contenders.length);
    for (const entry of contenders) alloc[entry.index] = share;
    // Largest-remainder: the floor division leaves up to n-1 rows unspent.
    let spare = remaining - share * contenders.length;
    for (const entry of contenders) {
      if (spare <= 0) break;
      if (alloc[entry.index] >= entry.size) continue;
      alloc[entry.index] += 1;
      spare -= 1;
    }
  }
  return alloc;
}

/**
 * Trim a truncated bucket back to its last real content row. Separator
 * ("--") and section-lead rows carry no `source`; left dangling at a cut
 * they read as a match with no body, which is exactly the fake-hit hazard
 * the section-lead rows were built to avoid.
 */
function trimDanglingRows(lines: CodingOutputLine[]): CodingOutputLine[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].source) end -= 1;
  return end === lines.length ? lines : lines.slice(0, end);
}

function sourceLineStarts(text: string, lines: string[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length;
    if (text.startsWith("\r\n", cursor)) cursor += 2;
    else if (text[cursor] === "\n") cursor += 1;
  }
  return starts;
}

function takeCodingOutputLines(
  lines: CodingOutputLine[],
  maxChars = MAX_TOOL_RESULT_CHARS,
) {
  // Leave room for the continuation hint and never trigger the generic
  // head/tail truncator, whose JSON envelope would obscure cat/rg output.
  const budget = Math.max(
    1_000,
    Math.min(MAX_TOOL_RESULT_CHARS, maxChars) - 1_000,
  );
  const kept: CodingOutputLine[] = [];
  let chars = 0;
  for (const line of lines) {
    const added = line.rendered.length + (kept.length ? 1 : 0);
    if (kept.length && chars + added > budget) break;
    kept.push(line);
    chars += added;
  }
  return { kept, truncated: kept.length < lines.length };
}

type TextRange = { start: number; end: number };

function addCoveredRange(covered: TextRange[], added: TextRange) {
  const ordered = [...covered, added].sort((left, right) => left.start - right.start);
  const merged: TextRange[] = [];
  for (const range of ordered) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  covered.splice(0, covered.length, ...merged);
}

function uncoveredRanges(range: TextRange, covered: readonly TextRange[]) {
  let cursor = range.start;
  const open: TextRange[] = [];
  for (const prior of covered) {
    if (prior.end <= cursor) continue;
    if (prior.start >= range.end) break;
    if (prior.start > cursor) {
      open.push({ start: cursor, end: Math.min(prior.start, range.end) });
    }
    cursor = Math.max(cursor, prior.end);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end) open.push({ start: cursor, end: range.end });
  return open;
}

function codingRangeLines(
  text: string,
  starts: readonly number[],
  range: TextRange,
  header?: string,
  source?: CodingOutputLine["source"],
): CodingOutputLine[] {
  const rows: CodingOutputLine[] = header ? [{ rendered: header }] : [];
  let lineIndex = 0;
  while (lineIndex + 1 < starts.length && starts[lineIndex + 1] <= range.start) {
    lineIndex += 1;
  }
  for (let index = lineIndex; index < starts.length; index += 1) {
    const lineStart = starts[index];
    const nextStart = starts[index + 1] ?? text.length;
    if (lineStart >= range.end) break;
    const start = Math.max(lineStart, range.start);
    let end = Math.min(nextStart, range.end);
    while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) {
      end -= 1;
    }
    if (end <= start) continue;
    const full = text.slice(start, end);
    const shown = full.slice(0, Math.max(GREP_LINE_CAP, MAX_TOOL_RESULT_CHARS - 2_000));
    rows.push({
      rendered:
        `${String(index + 1).padStart(6, " ")}\t${start > lineStart ? "…" : ""}${shown}` +
        (shown.length < full.length || end < nextStart ? "…" : ""),
      span: [start, start + shown.length],
      ...(source ? { source } : {}),
    });
  }
  return rows;
}



/**
 * The revise operation, callable without dispatch: the Edit alias uses it
 * directly so the strict coding-shape surface can reject the public name
 * while the alias keeps the identical pinning, receipts, and lint hook.
 */
/**
 * Arm B's edit shape: `at` names the provision, and the context pair stops
 * being required because the server derives it.
 */


/** Convert a verified text plan to exact, paragraph-local tracked edits. */
function trackedEditsForRenumberPlan(
  sourceText: string,
  receipts: readonly DeleteAndRenumberReceipt[],
): EditInput[] | string {
  const edits: EditInput[] = [];
  const add = (
    start: number,
    end: number,
    replace: string,
    reason: string,
  ) => {
    const find = sourceText.slice(start, end);
    if (!find || find.includes("\n") || replace.includes("\n")) {
      return false;
    }
    edits.push({
      find,
      replace,
      context_before: "",
      context_after: "",
      reason,
      exact_start: start,
      exact_end: end,
    });
    return true;
  };

  for (const receipt of receipts) {
    if (sourceText.slice(receipt.start, receipt.end) !== receipt.removed) {
      return `Pinned text no longer matches ${receipt.kind} at ${receipt.start}-${receipt.end}`;
    }
    const reason =
      receipt.kind === "delete_provision"
        ? `Delete ${receipt.from} and close its numbering gap`
        : receipt.kind === "renumber_heading"
          ? `Renumber ${receipt.from} to ${receipt.to}`
          : `Update pointer from ${receipt.from} to ${receipt.to}`;
    if (receipt.kind !== "delete_provision") {
      if (!add(receipt.start, receipt.end, receipt.inserted, reason)) {
        return `${receipt.kind} crossed a paragraph boundary`;
      }
      continue;
    }

    let cursor = receipt.start;
    while (cursor < receipt.end) {
      const newline = sourceText.indexOf("\n", cursor);
      const end =
        newline < 0 || newline > receipt.end ? receipt.end : newline;
      if (end > cursor && !add(cursor, end, "", reason)) {
        return `Deletion of ${receipt.from} could not be split safely`;
      }
      cursor = end + 1;
    }
  }
  return edits.length ? edits : "Renumber plan contained no trackable text";
}

const comparableAcceptedText = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");

async function activeDocument(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
): Promise<DocumentContent | "stale" | null> {
  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file) return null;
  return (await documents.versions(scope, documentId))
      ?.current_version_id === file.version.id
    ? file
    : "stale";
}



async function readNonDocumentResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  workflows: WorkflowStore,
  localPdfEvidenceHandles?: Set<string>,
) {
  if (call.name !== "Read") return null;
  const requested = trimmed(args.file_path);
  const resource = parseResourceReference(requested);
  if (resource?.kind === "workflow") {
    const workflow = workflows.get(resource.id);
    return workflow
      ? result(call, {
          ok: true,
          resource: requested,
          title: workflow.title,
          instructions: workflow.skill_md,
        })
      : fail(call, "Workflow not found");
  }
  if (resource?.kind === "job") {
    try {
      const payload = {
        ok: true,
        resource: requested,
        job: await getTableOfAuthoritiesJob(resource.id),
      };
      const event = tableOfAuthoritiesEvent(payload, call.id);
      return {
        ...result(call, payload),
        ...(event ? { events: [event] } : {}),
      };
    } catch (error) {
      return fail(
        call,
        errorText(error, "Table of Authorities status lookup failed"),
      );
    }
  }
  if (resource?.kind !== "source") return null;
  if (resource.provider !== "pdf") {
    return fail(call, `Read does not support source provider '${resource.provider}'.`);
  }
  const handle = trimmed(args.handle);
  if (handle && (trimmed(args.locator_kind) || trimmed(args.locator))) {
    return fail(call, "Use either handle or locator fields, not both.");
  }
  try {
    const resolved = handle
      ? await rehydrateProviderPdfReference(resource.sourceId, handle)
      : await lookupProviderPdfReference(resource.sourceId, pdfLocatorParams(args));
    if (resolved.availability !== "ready") {
      return result(call, {
        ok: false,
        resource: requested,
        status: resolved.availability,
        ...("state" in resolved ? resolved.state : {}),
        ...("error" in resolved && resolved.error ? { error: resolved.error } : {}),
        next_required_action:
          resolved.availability === "queued"
            ? `Retry Read on ${requested} later.`
            : "Use the authoritative provider text already returned.",
      });
    }
    if (
      resolved.lookup.status === "found" &&
      resolved.linkEvidence &&
      resolved.state.source_reference &&
      localPdfEvidenceHandles
    ) {
      localPdfEvidenceHandles.add(resolved.lookup.evidence.handle);
      registerProviderPdfEvidenceForTurn(
        localPdfEvidenceHandles,
        resolved.lookup.evidence.handle,
        resolved.state.source_reference,
        resolved.params.url,
        resolved.params.title || resolved.params.filename || resolved.params.identity,
        resolved.linkEvidence,
      );
    }
    return result(call, {
      ...compactProviderPdfLookup(resolved),
      resource: requested,
    });
  } catch (error) {
    return fail(
      call,
      error instanceof Error &&
          /^(?:Provider PDF|Invalid PDF evidence|PDF evidence)/u.test(error.message)
        ? error.message
        : "Provider PDF lookup is unavailable",
    );
  }
}

const withMetadata = (
  output: BeaverOutcome,
  metadata: NonNullable<BeaverOutcome["metadata"]>,
): BeaverOutcome => ({
  ...output,
  metadata: { ...output.metadata, ...metadata },
});

function objectRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceDocumentText(passage: LegalSourcePassage) {
  if (typeof passage.documentArtifact === "string") {
    return passage.documentArtifact;
  }
  const artifact = objectRecord(passage.documentArtifact);
  return typeof artifact?.text === "string" ? artifact.text : passage.text;
}

function a2ajDocument(value: unknown): A2AJDocument | null {
  const document = objectRecord(value);
  return document &&
      typeof document.citation === "string" &&
      typeof document.dataset === "string" &&
      typeof document.text === "string" &&
      (document.language === "en" || document.language === "fr")
    ? value as A2AJDocument
    : null;
}

function a2ajChildLookup(passage: LegalSourcePassage) {
  const native = objectRecord(passage.native);
  const lookup = objectRecord(native?.lookup) as A2AJLocatorLookup | null;
  const block = objectRecord(native?.block) as A2AJLocatorLookup["block"];
  if (!lookup || !block || lookup.status !== "found") return null;
  return {
    ...lookup,
    requested: {
      kind: block.kind as A2AJLocatorLookup["requested"]["kind"],
      locator: block.label,
      label: block.label,
    },
    matches: [block.label],
    block,
    before: [],
    after: [],
  } satisfies A2AJLocatorLookup;
}

function legalSourceEvidence(passage: LegalSourcePassage): {
  receipt?: LegalEvidenceReceipt;
  document?: A2AJDocument;
  lookup?: A2AJLocatorLookup;
} {
  if (passage.source.provider === "a2aj") {
    const document = a2ajDocument(passage.native);
    if (document) {
      return {
        document,
      };
    }
    const lookup = a2ajChildLookup(passage);
    const receipt = lookup && createA2AJLookupEvidence(
      lookup,
      passage.source.kind === "legislation" ? "legislation" : "case",
    );
    if (lookup && receipt) return { lookup, receipt };
  }
  if (passage.role === "document" && passage.source.provider !== "hansard") {
    return {};
  }
  if (passage.source.provider === "journal") {
    const base = {
      citation: passage.source.citation ?? passage.source.id,
      name: passage.source.title ?? null,
      date: passage.source.date ?? null,
      url: passage.source.url ?? null,
      text: passage.text,
      articleId: passage.source.id,
      language: passage.source.language,
    };
    return {
      receipt: createPublicJournalPassageEvidence({
        ...base,
        locatorKind: passage.locator.requested?.kind ?? "paragraph",
        locatorLabel: passage.locator.label,
      }),
    };
  }
  const sourceClass = passage.source.kind === "legislation"
    ? "legislation"
    : passage.source.kind === "case"
      ? "case"
      : "commentary";
  const jurisdiction = passage.source.provider === "courtlistener" ||
      passage.source.provider === "govinfo"
    ? "US"
    : passage.source.provider === "tna" ||
        passage.source.provider === "govuk-et"
      ? "UK"
      : "CA-ON";
  return {
    receipt: createBenchmarkEvidence({
      jurisdiction,
      sourceClass,
      stableSourceId: [
        passage.source.provider,
        passage.source.id,
        passage.source.part ?? "",
      ].join(":"),
      sourceText: sourceDocumentText(passage),
      spanText: passage.text,
      citation: passage.source.citation ?? passage.source.id,
      name: passage.source.title,
      dataset: passage.source.collection ?? passage.source.provider,
      language: passage.source.language,
      version: passage.source.date,
      externalUrl: passage.source.url,
      locatorKind: passage.locator.requested?.kind ?? "document",
      locatorLabel: passage.locator.label,
    }),
  };
}

function sourceReference(
  provider: string,
  sourceId: string,
): LegalSourceReference | null {
  if (provider === "a2aj") {
    try {
      const identity = JSON.parse(sourceId) as unknown;
      if (
        !Array.isArray(identity) ||
        typeof identity[0] !== "string" ||
        (identity[1] !== "cases" && identity[1] !== "laws")
      ) return null;
      return {
        provider,
        id: identity[0],
        citation: identity[0],
        kind: identity[1] === "laws" ? "legislation" : "case",
        collection: typeof identity[2] === "string" && identity[2]
          ? identity[2]
          : null,
      };
    } catch {
      return null;
    }
  }
  if (provider === "courtlistener-opinion") {
    try {
      const identity = JSON.parse(sourceId) as unknown;
      if (
        !Array.isArray(identity) ||
        !Number.isSafeInteger(Number(identity[0])) ||
        !Number.isSafeInteger(Number(identity[1]))
      ) return null;
      return {
        provider: "courtlistener",
        id: String(identity[0]),
        part: String(identity[1]),
        kind: "case",
      };
    } catch {
      return null;
    }
  }
  if (provider === "courtlistener") {
    return Number.isSafeInteger(Number(sourceId)) && Number(sourceId) > 0
      ? { provider, id: sourceId, kind: "case" }
      : null;
  }
  if (["tna", "govuk-et", "govinfo"].includes(provider)) {
    return { provider, id: sourceId, kind: "case" };
  }
  if (provider === "journal") {
    return { provider, id: sourceId, kind: "journal" };
  }
  if (provider === "hansard") {
    return { provider, id: sourceId, kind: "hansard" };
  }
  return null;
}

async function readLegalSourceResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  options: {
    userId: string;
    courtlistener?: CourtlistenerToolState;
    signal?: AbortSignal;
  },
): Promise<BeaverOutcome | null> {
  if (call.name !== "Read") return null;
  const resource = parseResourceReference(trimmed(args.file_path));
  if (resource?.kind !== "source" || resource.provider === "pdf") return null;
  const locator = trimmed(args.locator);
  const locatorKind = trimmed(args.locator_kind);
  if (Boolean(locator) !== Boolean(locatorKind)) {
    return fail(call, "locator_kind and locator are required together.");
  }
  const allowedLocators = new Set(["paragraph", "section", "page", "footnote"]);
  if (locator && !allowedLocators.has(locatorKind)) {
    return fail(call, "Unsupported legal-source locator kind.");
  }
  const source = sourceReference(resource.provider, resource.sourceId);
  if (!source) return fail(call, `Invalid ${resource.provider} resource.`);
  const references = args.references === "inbound" ||
      args.references === "outbound" || args.references === "both"
    ? args.references
    : "none";
  if (args.references && !["none", "inbound", "outbound", "both"].includes(String(args.references))) {
    return fail(call, "references must be none, inbound, outbound, or both.");
  }
  if (references !== "none" && source.provider !== "a2aj") {
    return fail(call, "references is available only for A2AJ statutory sections.");
  }
  if (
    references !== "none" &&
    (source.kind !== "legislation" || locatorKind !== "section")
  ) {
    return fail(call, "references is available only for statutory sections.");
  }
  if (references !== "none" && !A2AJ_REFERENCE_NEIGHBORHOOD_ENABLED) {
    return fail(call, "Reference expansion is unavailable in this runtime.");
  }
  try {
    const read = await readLegalSourcePassage({
      source,
      ...(locator
        ? {
            locator: {
              kind: locatorKind as "paragraph" | "section" | "page" | "footnote",
              value: locator,
              ...(trimmed(args.end_locator)
                ? { endValue: trimmed(args.end_locator) }
                : {}),
            },
            contextBlocks: Math.min(
              2,
              Math.max(0, Math.trunc(Number(args.context_blocks) || 0)),
            ),
          }
        : {}),
      signal: options.signal,
    });
    if (read.status !== "found") {
      return fail(
        call,
        read.status === "unsupported"
          ? "Legal source provider is unavailable."
          : "The requested legal source passage was not found.",
      );
    }

    const registered = read.values.map((passage) => ({
      passage,
      ...legalSourceEvidence(passage),
    }));
    const fallbacks: unknown[] = [];
    const capturedRemoteSources = new Set<string>();
    const capturedCourt = new Set<string>();
    for (const item of registered) {
      const native = objectRecord(item.passage.native);
      const nativeDocument = objectRecord(native?.document);
      if (
        nativeDocument &&
        ["tna", "govuk-et", "govinfo"].includes(item.passage.source.provider)
      ) {
        const document = nativeDocument as RemoteLegalSourceDocument;
        const key = `${document.provider}:${document.identity}`;
        if (!capturedRemoteSources.has(key)) {
          capturedRemoteSources.add(key);
          fallbacks.push(
            ...await legalSourcePdfFallbacks(document, options.userId),
          );
        }
      }
      const courtCase = objectRecord(native?.case);
      if (courtCase && item.passage.source.provider === "courtlistener") {
        const key = item.passage.source.id;
        if (!capturedCourt.has(key)) {
          capturedCourt.add(key);
          const cached = captureCourtlistenerCase(
            options.courtlistener ?? { casesByClusterId: new Map() },
            courtCase,
          );
          const fallback = cached && await courtlistenerPdfFallback(
            cached,
            options.userId,
          );
          if (fallback) fallbacks.push(fallback);
        }
      }
    }

    let referenceNeighborhood: Record<string, unknown> | undefined;
    if (references !== "none") {
      const seed = registered.map(({ passage }) => {
        const native = objectRecord(passage.native);
        return objectRecord(native?.lookup) as A2AJLocatorLookup | null;
      }).find((value): value is A2AJLocatorLookup => Boolean(value));
      if (seed) {
        const related = await readA2AJReferenceNeighborhood(
          seed,
          references as A2AJReferenceDirection,
          options.signal,
        );
          const sections = related.lookups.map((lookup) => {
            const evidence = a2ajLookupEvidenceBlocks(lookup, "legislation");
            for (const item of evidence) {
              registered.push({
              passage: {
                source,
                locator: {
                  requested: {
                    kind: item.lookup.requested.kind,
                    value: item.lookup.requested.locator,
                  },
                  label: item.lookup.requested.label,
                },
                role: "context",
                text: item.receipt.span_text ?? "",
                textSha256:
                  item.receipt.exact_span_sha256 ?? sha256(item.receipt.span_text ?? ""),
                documentSha256: item.receipt.source_sha256,
                revision: item.receipt.source_sha256,
                native: { lookup: item.lookup, block: item.lookup.block },
              },
              receipt: item.receipt,
              lookup: item.lookup,
            });
          }
          return {
            label: lookup.block?.label,
            text: lookup.block?.text,
            evidence_ids: evidence.map(({ receipt }) => receipt.evidence_id),
          };
        });
        referenceNeighborhood = {
          direction: references,
          depth: 1,
          returned: related.lookups.length,
          truncated: related.truncated,
          limit_reason: related.limitReason,
          omitted: related.omitted,
          failures: related.failures,
          sections,
        };
      }
    }

    const evidences = [...new Map(
      registered.flatMap(({ receipt }) =>
        receipt ? [[receipt.evidence_id, receipt] as const] : [],
      ),
    ).values()];
    const passages = registered.slice(0, read.values.length).map(
      ({ passage, receipt }) => ({
        role: passage.role,
        kind: passage.locator.requested?.kind ?? "document",
        locator: passage.locator.label,
        text: passage.text,
        text_sha256: passage.textSha256,
        ...(receipt ? { evidence_id: receipt.evidence_id } : {}),
        ...(passage.source.provider === "courtlistener" && passage.source.part
          ? {
              resource: resourceReference.source(
                "courtlistener-opinion",
                JSON.stringify([passage.source.id, Number(passage.source.part)]),
              ),
            }
          : {}),
      }),
    );
    const payload = {
      ok: true,
      source: "Legal source",
      provider: source.provider,
      identifier: source.id,
      title: read.values[0].source.title,
      citation: read.values[0].source.citation,
      resource: trimmed(args.file_path),
      requested: locator
        ? {
            kind: locatorKind,
            locator,
            ...(trimmed(args.end_locator)
              ? { end_locator: trimmed(args.end_locator) }
              : {}),
          }
        : null,
      passage_count: passages.length,
      passages,
      evidence_ids: passages.flatMap(({ evidence_id }) =>
        evidence_id ? [evidence_id] : [],
      ),
      ...(passages.some(({ role, evidence_id }) =>
          role === "document" && !evidence_id
        )
        ? {
            next_required_action:
              "This document read is navigation text, not citable evidence. Re-read the needed native locator before relying on it.",
          }
        : {}),
      ...(fallbacks.length ? { pdf_fallbacks: fallbacks } : {}),
      ...(referenceNeighborhood
        ? { reference_neighborhood: referenceNeighborhood }
        : {}),
    };
    return {
      ...withMetadata(result(call, payload), {
        evidenceRefs: receiptEvidenceRefs(evidences),
      }),
      evidence: evidences,
    };
  } catch (error) {
    return fail(
      call,
      error instanceof Error
        ? error.message
        : "Legal source read failed.",
    );
  }
}

async function runCodingShapeCall(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  documents: DocumentStore,
  library: LibraryStore,
  projects: ProjectStore,
  scope: DocumentScope,
  allowedDocumentIds?: Set<string>,
  matterId?: string | null,
  turnEditState?: AssistantEditTurnState,
  servedDraftingCache?: Map<string, ServedDrafting>,
  localPdfEvidenceHandles?: Set<string>,
  workflows: WorkflowStore = new Map(),
  editMode: EditMode = "manual",
): Promise<BeaverOutcome> {
  servedDraftingCache ??= new Map();
  const direct = await readNonDocumentResource(
    call,
    args,
    workflows,
    localPdfEvidenceHandles,
  );
  if (direct) return direct;
  const documentsInScope = await scopedDocuments(
    scope, library, projects, allowedDocumentIds, 200, matterId,
  );
  const files =
    documentsInScope.filter(
          (document) =>
            !allowedDocumentIds || allowedDocumentIds.has(document.id),
        );
  const codingPath = (
    document: (typeof files)[number],
    versionId = document.current_version_id,
  ) => resourceReference.document(document.id, versionId);
  const disambiguationHint = (requested: string, field: "file_path" | "path") =>
    `File path is ambiguous: ${requested}. Use Glob(pattern="${requested}"), then pass the intended document_id as ${field}.`;
  const resolvePath = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    if (reference?.kind === "document") {
      return files.filter((document) => document.id === reference.documentId);
    }
    const wanted = raw.replace(/^\.?[\\/]/u, "").trim().toLowerCase();
    const byId = files.filter((document) => document.id.toLowerCase() === wanted);
    if (byId.length) return byId;
    return files.filter(
      (document) => document.filename.toLowerCase() === wanted,
    );
  };
  const referencedVersion = (raw: string) => {
    const reference = parseResourceReference(raw.trim());
    return reference?.kind === "document" ? reference.versionId : undefined;
  };
  // Markdown plane: when the arm serves docx as pandoc markdown
  // (MIKE_READ_DOCX_MARKDOWN), Glob/Read/Grep list, search, and read the
  // SAME text the mike read path would serve, so every file:line
  // coordinate agrees arm-wide. Non-docx files and extraction failures keep
  // the plaintext plane. Same document shape readOne builds for drafting.
  const codingDocument = async (
    documentId: string,
    versionId?: string,
    mode?: "text" | "drafting" | "redline",
  ) => {
    if (mode === "redline") {
      const file = await documents.read(
        scope, documentId, versionId ?? null, false,
      );
      if (!file || file.fileType.toLowerCase() !== "docx") return null;
      const redline = await projectDocxRedline(file.bytes);
      return {
        filename: file.filename,
        documentId,
        versionId: file.version.id,
        text: redline.text,
        cautions: redline.notes,
        pages: { pages: [], source: "unindexed" as const },
        tableCells: [],
        projection: "redline" as const,
      };
    }
    if (mode !== "text") {
      const drafting = await servedDraftingText(
        documents,
        scope,
        documentId,
        servedDraftingCache,
        versionId,
      );
      if (drafting) {
        return {
          filename: drafting.filename,
          documentId,
          versionId: drafting.versionId,
          text: drafting.served,
          cautions: [],
          pages: { pages: [], source: "unindexed" as const },
          tableCells: [],
          projection: "drafting" as const,
        };
      }
    }
    const extracted = await extractDocument(
      documents, scope, documentId, versionId,
    );
    return extracted ? { ...extracted, projection: "canonical" as const } : null;
  };
  if (call.name === "Glob") {
    const re = globRegExp(trimmed(args.pattern) || "*");
    const matchedFiles = files.filter((document) => re.test(document.filename));
    const fileRows = await Promise.all(
      matchedFiles.map(async (meta) => {
        const document = await codingDocument(meta.id);
        const identity = `${codingPath(meta)}\tfilename=${meta.filename}`;
        if (!document) {
          return { row: `${identity}\tunreadable`, chars: 0, lines: 0 };
        }
        const chars = document.text.length;
        const lines = document.text ? document.text.split(/\r?\n/u).length : 0;
        return {
          row: `${identity}\tchars=${chars}\tlines=${lines}`,
          chars,
          lines,
        };
      }),
    );
    const workflowRows = [...workflows].flatMap(([id, workflow]) => {
      const resource = resourceReference.workflow(id);
      return re.test(resource)
        ? [{
            row: `${resource}\ttitle=${workflow.title}`,
            chars: workflow.skill_md.length,
            lines: workflow.skill_md.split(/\r?\n/u).length,
          }]
        : [];
    });
    const rows = [
      ...fileRows,
      ...workflowRows,
    ];
    if (!rows.length) return result(call, "No files found");
    const totalChars = rows.reduce((total, row) => total + row.chars, 0);
    const totalLines = rows.reduce((total, row) => total + row.lines, 0);
    return result(
      call,
      [
        ...rows.map((row) => row.row),
        `TOTAL\tfiles=${rows.length}\tchars=${totalChars}\tlines=${totalLines}`,
      ].join("\n"),
    );
  }

  if (call.name === "Read") {

    const requested = trimmed(args.file_path);
    const handle = trimmed(args.handle);
    const locatorKind = trimmed(args.locator_kind);
    const locator = trimmed(args.locator);
    if (handle || locatorKind || locator) {
      if (handle && (locatorKind || locator)) {
        return fail(call, "Use either handle or locator fields, not both.");
      }
      if (!handle && (!locatorKind || !locator)) {
        return fail(call, "locator_kind and locator are required together.");
      }
      const matches = resolvePath(requested);
      if (matches.length !== 1) {
        return fail(
          call,
          matches.length
            ? disambiguationHint(requested, "file_path")
            : `File does not exist: ${requested}`,
        );
      }
      const meta = matches[0];
      const versionId = referencedVersion(requested);
      const file = await documents.read(
        scope, meta.id, versionId ?? null, false,
      );
      if (!file) return fail(call, "PDF resource/version not found.");
      if (file.fileType.toLowerCase() !== "pdf") {
        return fail(call, "Exact structural Read requires a PDF resource.");
      }
      if (!file.localPath) {
        return fail(
          call,
          "Exact structural PDF lookup is unavailable on this storage adapter.",
        );
      }
      const sourcePath = file.localPath;
      try {
        if (handle) {
          const receipt = await documentProjectionService.readPdfEvidence(handle);
          if (
            receipt.source.document_id !== meta.id ||
            receipt.source.version_id !== file.version.id
          ) {
            return fail(call, "PDF evidence does not belong to this resource.");
          }
          const lookup = await documentProjectionService.rehydratePdfEvidence(
            sourcePath,
            handle,
          );
          localPdfEvidenceHandles?.add(handle);
          const evidence = pdfLegalEvidence(
            meta.id,
            file.version.id,
            file.filename,
            lookup,
          );
          return {
            ...withMetadata(result(call, {
              ...compactPdfLookup(file.filename, lookup),
              evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
              resource: codingPath(meta, file.version.id),
            }), { evidenceRefs: pdfEvidenceRefs(file.filename, lookup) }),
            evidence,
          };
        }
        await documentProjectionService.parsePdf({
          documentId: meta.id,
          versionId: file.version.id,
          sourcePath,
          sourceSha256: file.version.source_sha256 ?? undefined,
        });
        const lookup = await documentProjectionService.lookupPdf(
          sourcePath,
          pdfLocatorParams(args),
        );
        if (lookup.status === "found") {
          localPdfEvidenceHandles?.add(lookup.evidence.handle);
        }
        const evidence = pdfLegalEvidence(
          meta.id,
          file.version.id,
          file.filename,
          lookup,
        );
        return {
          ...withMetadata(result(call, {
            ...compactPdfLookup(file.filename, lookup),
            evidence_ids: evidence.map(({ evidence_id }) => evidence_id),
            resource: codingPath(meta, file.version.id),
          }), { evidenceRefs: pdfEvidenceRefs(file.filename, lookup) }),
          evidence,
        };
      } catch (error) {
        return fail(call, pdfEvidenceError(error));
      }
    }
    const matches = resolvePath(requested);
    if (matches.length !== 1) {
      return fail(
        call,
        matches.length
          ? disambiguationHint(requested, "file_path")
          : `File does not exist: ${requested}\nAvailable files:\n${files.map((document) => document.filename).join("\n")}`,
      );
    }
    const meta = matches[0];
    const mode = args.mode === "text" || args.mode === "drafting" ||
        args.mode === "redline"
      ? args.mode
      : undefined;
    const document = await codingDocument(
      meta.id,
      referencedVersion(requested),
      mode,
    );
    if (!document) return fail(call, `File could not be read: ${requested}`);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text, lines);
    const limit = positiveInt(args.limit, 1, 2_000, 2_000);
    const startChar = clampInt(
      args.start_char,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    // Legal paragraphs are often several thousand characters on one source
    // line. Keep each Read line intact whenever it fits in the result budget;
    // Grep stays a compact, match-centred preview.
    const readLineCap = Math.max(
      GREP_LINE_CAP,
      MAX_TOOL_RESULT_CHARS - 2_000,
    );
    const sectionArg = trimmed(args.section);
    const pagesArg = trimmed(args.pages);
    const references =
      args.references === "inbound" ||
      args.references === "outbound" ||
      args.references === "both"
        ? args.references
        : "none";
    if (pagesArg) {
      const nonDefaultOffset =
        Object.prototype.hasOwnProperty.call(args, "offset") &&
        typeof args.offset === "number" &&
        args.offset > 1;
      if (sectionArg || nonDefaultOffset) {
        return fail(
          call,
          "pages cannot be combined with section or offset; choose one exact scope.",
        );
      }
      const selected = selectPages(document.pages, document.text, pagesArg);
      if (selected.status !== "ok") {
        return fail(
          call,
          selected.status === "empty"
            ? "pages is required"
            : `Page '${selected.token}' could not be resolved (${selected.lookup.status}).`,
        );
      }
      const candidates = selected.pages.flatMap((page) =>
        codingRangeLines(
          document.text,
          starts,
          { start: page.start, end: page.end },
          `=== ${meta.filename} :: pdf:${page.pdfPage ?? "?"}${
            page.printedLabel ? ` :: printed:${page.printedLabel}` : ""
          } ===`,
          {
            documentId: meta.id,
            versionId: document.versionId,
            locator:
              page.printedLabel ?? String(page.pdfPage ?? page.ordinal),
            locatorKind: "page",
            projection: document.projection,
            filename: meta.filename,
            sourceText: document.text,
          },
        ),
      );
      const { kept, truncated } = takeCodingOutputLines(candidates);
      return codingTextResult(
        call,
        kept.map((line) => line.rendered).join("\n") +
          (truncated ? "\n(Page read stopped at the tool-result limit.)" : ""),
        kept,
      );
    }
    if (references !== "none" && !sectionArg) {
      return fail(call, "references requires an exact section handle.");
    }
    if (sectionArg) {
      const skeleton = await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
      const lookup = readSection(skeleton, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return fail(
          call,
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            "). Grep for the wording, or Read without section.",
        );
      }
      const block = lookup.block;
      if (references !== "none") {
        const graph = await documentGraph(
          document.text,
          meta.id,
          { tableCells: document.tableCells },
        );
        const scope = oneHopLegalScope(
          skeleton,
          graph,
          block.label,
          references,
        );
        if (!scope) {
          return fail(call, `Section '${sectionArg}' could not seed a reference scope.`);
        }
        const covered: TextRange[] = [];
        const candidates: CodingOutputLine[] = [];
        for (const [index, node] of scope.nodes.entries()) {
          const open = uncoveredRanges(
            { start: node.start, end: node.end },
            covered,
          );
          for (const range of open) {
            candidates.push(
              ...codingRangeLines(
                document.text,
                starts,
                range,
                `=== ${meta.filename} :: Read section="${node.label}" :: ${
                  index === 0 ? "target" : "direct reference"
                } ===`,
                {
                  documentId: meta.id,
                  versionId: document.versionId,
                  locator: node.label,
                  locatorKind: "section",
                  projection: document.projection,
                  filename: meta.filename,
                  sourceText: document.text,
                },
              ),
            );
          }
          addCoveredRange(covered, { start: node.start, end: node.end });
        }
        const { kept, truncated } = takeCodingOutputLines(candidates);
        const note = graph.documentAbstained
          ? `\n(Reference graph abstained: ${graph.note ?? "unresolved document structure"}.)`
          : truncated
            ? "\n(Reference read stopped at the tool-result limit; narrow the direction or read a returned section recipe.)"
            : "";
        return codingTextResult(
          call,
          kept.map((line) => line.rendered).join("\n") + note,
          kept,
        );
      }
      const startLine =
        document.text.slice(0, block.start).split(/\r?\n/u).length;
      const blockLines = block.text.split(/\r?\n/u);
      const endLine = startLine + blockLines.length - 1;
      const offset = positiveInt(
        args.offset,
        1,
        100_000_000,
        startLine,
      );
      const sectionOffset = offset;
      const sectionLimit = limit;
      if (sectionOffset < startLine || sectionOffset > endLine) {
        return fail(
          call,
          `(offset ${sectionOffset} is outside section ${block.label}; the section spans lines ${startLine}-${endLine})`,
        );
      }
      const localStart = sectionOffset - startLine;
      const blockStarts = sourceLineStarts(block.text, blockLines);
      const candidates = blockLines
        .slice(localStart, localStart + sectionLimit)
        .map((line, i): CodingOutputLine => {
          const blockIndex = localStart + i;
          const sourceStart = block.start + blockStarts[blockIndex];
          const shown = line.slice(0, readLineCap);
          return {
            rendered:
              `${String(sectionOffset + i).padStart(6, " ")}\t${shown}` +
              (line.length > readLineCap
                ? "… [line truncated; Grep can locate text later on this line]"
                : ""),
            span: [sourceStart, sourceStart + shown.length],
            source: {
              documentId: meta.id,
              versionId: document.versionId,
              locator: block.label,
              locatorKind: "section",
              projection: document.projection,
              filename: meta.filename,
              sourceText: document.text,
            },
          };
        });
      const { kept, truncated } = takeCodingOutputLines(candidates);
      const lastShown = sectionOffset + kept.length - 1;
      const more =
        lastShown < endLine
          ? `\n\n[TRUNCATED: returned section lines ${sectionOffset}-${lastShown} of ${startLine}-${endLine}; continue with Read(file_path="${requested}", section="${block.label}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
          : "";
      return codingTextResult(
        call,
        kept.map((line) => line.rendered).join("\n") + more,
        kept,
      );
    }
    const offset = positiveInt(args.offset, 1, 100_000_000, 1);
    const effectiveLimit = limit;
    const firstLine = lines[offset - 1];
    if (firstLine !== undefined && startChar > firstLine.length) {
      return fail(
        call,
        `(start_char ${startChar} is past the end of line ${offset}; line chars: ${firstLine.length})`,
      );
    }
    const selectedLines = lines.slice(offset - 1, offset - 1 + effectiveLimit);
    // DOCX paragraphs are one served line. Preserve the ordinary cap for long
    // lines, but do not cut off a short proviso or exception at the end.
    const shownChars = (line: string, from: number) => {
      const tail = /\.docx$/iu.test(meta.filename)
        ? boundedParagraphTail(line, from + readLineCap)
        : null;
      return readLineCap + (tail?.text.length ?? 0);
    };
    const firstLineContinues =
      selectedLines.length > 0 &&
      startChar + shownChars(selectedLines[0], startChar) <
        selectedLines[0].length;
    const candidates = (firstLineContinues
      ? selectedLines.slice(0, 1)
      : selectedLines
    )
      .map((line, i): CodingOutputLine => {
        const lineIndex = offset - 1 + i;
        const sourceStart = starts[lineIndex];
        const localStart = i === 0 ? startChar : 0;
        const shown = line.slice(
          localStart,
          localStart + shownChars(line, localStart),
        );
        return {
          rendered:
            `${String(offset + i).padStart(6, " ")}\t${shown}` +
            (localStart + shown.length < line.length
              ? "… [line truncated; continue with the exact Read recipe below]"
              : ""),
          span: [
            sourceStart + localStart,
            sourceStart + localStart + shown.length,
          ],
          source: {
            documentId: meta.id,
            versionId: document.versionId,
            filename: meta.filename,
            sourceText: document.text,
          },
        };
      });
    if (!candidates.length) {
      return fail(
        call,
        offset > lines.length
          ? `(offset ${offset} is past the end of the file; total lines: ${lines.length})`
          : "(empty file)",
      );
    }
    const { kept, truncated } = takeCodingOutputLines(candidates);
    const lastShown = offset - 1 + kept.length;
    const sameLineContinuation =
      firstLineContinues && kept.length > 0
        ? startChar + readLineCap
        : null;
    const more = sameLineContinuation !== null
      ? `\n\n[TRUNCATED: returned line ${offset} through char ${sameLineContinuation} of ${selectedLines[0].length}; continue with Read(file_path=${JSON.stringify(requested)}, offset=${offset}, limit=${effectiveLimit}, start_char=${sameLineContinuation}). Tool-result limit reached.]`
      : lastShown < lines.length
        ? `\n\n[TRUNCATED: returned lines ${offset}-${lastShown} of ${lines.length}; continue with Read(file_path="${requested}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
        : "";
    return codingTextResult(
      call,
      kept.map((line) => line.rendered).join("\n") + more,
      kept,
    );
  }

  if (call.name === "Edit" || call.name === "edit_docx_advanced") {
    const requested = trimmed(args.file_path);
    const matches = resolvePath(requested);
    if (matches.length !== 1) {
      return result(
        call,
        matches.length
          ? disambiguationHint(requested, "file_path")
          : `File does not exist: ${requested}`,
      );
    }
    const meta = matches[0];
    const sourceVersionId = referencedVersion(requested);
    const turnVersion = turnEditState?.get(meta.id);
    if (
      sourceVersionId &&
      sourceVersionId !== meta.current_version_id &&
      sourceVersionId !== turnVersion?.parentVersionId &&
      sourceVersionId !== turnVersion?.versionId
    ) {
      return fail(call, "Edit requires the document's current version resource.");
    }
    if (call.name === "edit_docx_advanced") {
      return runAdvancedDocxEdit({
        call,
        args,
        documents,
        scope,
        documentId: meta.id,
        turnEditState,
        editMode,
      });
    }
    const oldString =
      typeof args.old_string === "string" ? args.old_string : "";
    const newString =
      typeof args.new_string === "string" ? args.new_string : "";
    if (!oldString) return result(call, "old_string is required");
    if (oldString === newString) {
      return result(call, "old_string and new_string must be different");
    }
    const file = await activeDocument(documents, scope, meta.id);
    if (!file) return fail(call, "DOCX Library version not found");
    if (file === "stale") return fail(call, "The active document version changed.");
    if (file.fileType.toLowerCase() !== "docx") {
      return fail(call, "Edit only supports .docx files.");
    }
    if (args.replace_all === true) {
      const applied = await applyTextOpsToDocx(file.bytes, [{
        op: "replace_text",
        find: oldString,
        replace: newString,
        match_case: true,
        scope: { kind: "whole_document" },
      }]);
      if (!applied.replacementCount) {
        return result(call, {
          ok: true,
          action: "no_changes",
          document_id: meta.id,
          version_id: file.version.id,
          change_count: 0,
        });
      }
      return saveDocxEdits({
        call,
        documents,
        scope,
        documentId: meta.id,
        source: file,
        bytes: applied.bytes,
        edits: applied.edits,
        turnEditState,
        editMode,
        extra: {
          ops: applied.reports,
          ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
        },
      });
    }
    const applied = await applyTrackedEdits(file.bytes, [{
      find: oldString,
      replace: newString,
      context_before: "",
      context_after: "",
    }], { author: "Beaver" });
    if (!applied.changes.length) {
      const sourceText = await extractDocxBodyText(file.bytes);
      return result(call, {
        ok: false,
        error: "No revision was saved",
        edit_errors: applied.errors.map(({ index, reason }) =>
          `edit ${index + 1}: ${reason}`),
        nearest_match: findNearestSuggestion(oldString, sourceText),
      });
    }
    return saveDocxEdits({
      call,
      documents,
      scope,
      documentId: meta.id,
      source: file,
      bytes: applied.bytes,
      edits: applied.changes.map((change) => ({
        changeId: change.id,
        delWId: change.delId,
        insWId: change.insId,
        deletedText: change.deletedText,
        insertedText: change.insertedText,
        contextBefore: change.contextBefore ?? "",
        contextAfter: change.contextAfter ?? "",
        reason: change.reason,
        diff: change.diff,
      })),
      turnEditState,
      editMode,
    });
  }

  // Grep
  const requestedPattern = trimmed(args.pattern);
  if (!requestedPattern) return fail(call, "pattern is required");
  const inlineCaseInsensitive = requestedPattern.startsWith("(?i)");
  const pattern = inlineCaseInsensitive
    ? requestedPattern.slice("(?i)".length)
    : requestedPattern;
  let re: RegExp;
  const regexFlags =
    inlineCaseInsensitive || args["-i"] === true ? "iu" : "u";
  try {
    re = new RegExp(pattern, regexFlags);
  } catch (error) {
    // CC parity: ripgrep accepts escapes the JS u-flag rejects (\-, \%,
    // escaped spaces, POSIX classes); retry without unicode strictness
    // before failing so trained-prior patterns don't burn a round.
    {
      try {
        re = new RegExp(pattern, regexFlags.replace("u", ""));
      } catch {
        return fail(
          call,
          `regex parse error: ${errorText(error, "invalid pattern")}`,
        );
      }
    }
  }
  const pathArg = trimmed(args.path);
  let targets = files;
  let targetVersionId: string | undefined;
  if (pathArg) {
    const matches = resolvePath(pathArg);
    if (matches.length !== 1) {
      return fail(
        call,
        matches.length
          ? disambiguationHint(pathArg, "path")
          : `File does not exist: ${pathArg}`,
      );
    }
    targets = [matches[0]];
    targetVersionId = referencedVersion(pathArg);
  } else if (trimmed(args.glob)) {
    const globRe = globRegExp(trimmed(args.glob));
    targets = files.filter((document) => globRe.test(document.filename));
  }
  const grepSection = trimmed(args.section);
  if (grepSection && !pathArg) {
    return fail(call, "Legal Grep scopes require one exact path.");
  }
  const mode =
    args.output_mode === "content" ||
    args.output_mode === "count"
      ? args.output_mode
      : "files_with_matches";
  const headLimit = positiveInt(
    args.head_limit,
    1,
    2_000,
    250,
  );
  const context = clampInt(args["-C"], 0, 10, 0);
  // CC parity: -A/-B honored per side, -C the symmetric fallback; frozen
  // arms keep -C-only semantics.
  const contextBefore = clampInt(args["-B"], 0, 10, context);
  const contextAfter = clampInt(args["-A"], 0, 10, context);
  const numberLines = args["-n"] !== false;

  const rows: CodingOutputLine[] = [];
  // Per-file content buckets; only populated when the per-file budget is on.
  // files_with_matches/count emit one row per document and are fair already.
  const fileBuckets: CodingOutputLine[][] = [];
  let truncated = false;
  for (const meta of targets) {
    const document = await codingDocument(meta.id, targetVersionId);
    if (!document) continue;
    const resource = codingPath(meta, document.versionId);
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text, lines);
    let scopeSpans: TextRange[] | null = null;
    let scopedSkeleton: AgreementSkeleton | null = null;
    if (grepSection) {
      scopedSkeleton = await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
      const lookup = readSection(scopedSkeleton, grepSection);
      if (lookup.status !== "found" || !lookup.block) {
        return fail(
          call,
          `Section '${grepSection}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            ").",
        );
      }
      scopeSpans = [{ start: lookup.block.start, end: lookup.block.end }];
    }
    const matched: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const lineStart = starts[i];
      const lineEnd = starts[i + 1] ?? document.text.length;
      if (
        (!scopeSpans ||
          scopeSpans.some(
            (scope) => lineStart < scope.end && scope.start < lineEnd,
          )) &&
        re.test(lines[i])
      ) {
        matched.push(i);
      }
    }
    if (!matched.length) continue;
    // A handle is emitted only when the paired Read resolver accepts it.
    // Ambiguous TOC/body duplicates stay line-addressed instead of teaching
    // the model an attractive handle that must fail on the next turn.
    let sectionOf:
        | ((line: number, at?: number) => {
          handle: string;
          display: string;
          firstLine: number;
          lastLine: number;
          start: number;
          end: number;
        } | null)
      | null = null;
    if (mode === "content") {
      const skeleton =
        scopedSkeleton ??
        (await documentStructure(document.text, meta.id, {
          tableCells: document.tableCells,
        }));
      if (skeleton.nodes.length) {
        const offsets: number[] = [];
        let cursor = 0;
        for (const line of lines) {
          offsets.push(cursor);
          const next = document.text.indexOf("\n", cursor + line.length);
          cursor = next === -1 ? document.text.length : next + 1;
        }
        sectionOf = (line, at) => {
          const pos = at ?? offsets[line] ?? 0;
          let best: { label: string; span: number } | null = null;
          for (const node of skeleton.nodes) {
            if (pos >= node.start && pos < node.end) {
              const span = node.end - node.start;
              if (!best || span < best.span) best = { label: node.label, span };
            }
          }
          if (!best) return null;
          // A native cell's row is the useful retrieval unit for a hit:
          // models otherwise infer this parent themselves, which was the
          // only repeatable DOCX failure in the fair coding baseline.
          const row = /^(table:\d+\/row:\d+)\/col:\d+$/u.exec(best.label)?.[1];
          const preferred =
            row && readSection(skeleton, row).status === "found"
              ? row
              : best.label;
          const lookup = readSection(skeleton, preferred);
          if (lookup.status !== "found" || !lookup.block) return null;
          const preferredNode = skeleton.nodes.find(
            (node) => node.label === preferred,
          );
          const rowAddress = /^table:(\d+)\/row:(\d+)$/u.exec(preferred);
          const addresses = rowAddress
            ? document.tableCells
                .filter(
                  (cell) =>
                    cell.table === Number(rowAddress[1]) &&
                    cell.row === Number(rowAddress[2]) &&
                    cell.address,
                )
                .map((cell) => cell.address)
            : [];
          const display =
            (preferredNode?.display ?? preferred) +
            (addresses.length ? `; cells ${addresses.join(", ")}` : "");
          const firstLine =
            document.text.slice(0, lookup.block.start).split(/\r?\n/u).length;
          const lastLine =
            firstLine + lookup.block.text.split(/\r?\n/u).length - 1;
          return {
            handle: lookup.block.label,
            display,
            firstLine,
            lastLine,
            start: lookup.block.start,
            end: lookup.block.end,
          };
        };
      }
    }
    if (mode === "files_with_matches") {
      rows.push({ rendered: resource });
      continue;
    }
    if (mode === "count") {
      rows.push({ rendered: `${resource}:${matched.length}` });
      continue;
    }
    const matchedLines = new Set(matched);
    let lastPrinted = -2;
    // Under the per-file budget every document renders into its own bucket
    // and the split happens after the sweep, once the matching-file count is
    // known. A single file still never needs more than the whole budget, so
    // headLimit doubles as the per-file collection cap. The corpus sweep is
    // never cut short here: stopping early is precisely the starvation the
    // per-file budget exists to remove.
    const sink: CodingOutputLine[] = [];
    for (const at of matched) {
      if (sink.length >= headLimit) {
        truncated = true;
        break;
      }
      const from = Math.max(0, at - contextBefore);
      const to = Math.min(lines.length - 1, at + contextAfter);
      if (
        (contextBefore || contextAfter) &&
        lastPrinted >= 0 &&
        from > lastPrinted + 1
      ) {
        sink.push({ rendered: "--" });
      }
      for (let i = Math.max(from, lastPrinted + 1); i <= to; i += 1) {
        const isMatch = matchedLines.has(i);
        const handoffCandidate =
          isMatch || matchedLines.has(i - 1) || matchedLines.has(i + 1);
        const sep = isMatch ? ":" : "-";
        const filePath = resource;
        const matchColumn = isMatch ? Math.max(0, lines[i].search(re)) : 0;
        const section = isMatch
          ? sectionOf?.(i, starts[i] + matchColumn)
          : null;

        const candidateSection = handoffCandidate
          ? section ?? sectionOf?.(i)
          : null;
        const renderedPath = filePath;
        const renderedLineNumber = i + 1;
        const renderedLine = lines[i];
        const renderedMatchColumn = matchColumn;
        const sourceLineStart = starts[i];
        const prefix = numberLines
          ? `${renderedPath}${sep}${renderedLineNumber}${sep}`
          : `${renderedPath}${sep}`;
        const sliceStart =
          renderedLine.length > GREP_LINE_CAP && isMatch
            ? Math.min(
                Math.max(
                  0,
                  renderedMatchColumn - Math.floor(GREP_LINE_CAP / 2),
                ),
                renderedLine.length - GREP_LINE_CAP,
              )
            : 0;
        const shown = renderedLine.slice(
          sliceStart,
          sliceStart + GREP_LINE_CAP,
        );
        const contact = section ? `  [${section.handle}]` : "";
        sink.push({
          rendered:
            `${prefix}${sliceStart ? "…" : ""}${shown}` +
            (sliceStart + shown.length < renderedLine.length ? "…" : "") +
            contact,
          span: [
            sourceLineStart + sliceStart,
            sourceLineStart + sliceStart + shown.length,
          ],
          handoffCandidate,
          source: {
            documentId: meta.id,
            versionId: document.versionId || meta.current_version_id,
            filename: meta.filename,
            sourceText: document.text,
            ...(candidateSection?.handle
              ? { locator: candidateSection.handle }
              : {}),
          },
        });
        lastPrinted = i;
      }
    }
    {
      if (sink.length) fileBuckets.push(sink);
      // A file that filled its collection cap had more to give; that is a
      // real truncation regardless of how the split lands below.
      continue;
    }
    if (truncated) break;
  }
  if (fileBuckets.length) {
    const alloc = fairFileAllocation(
      fileBuckets.map((bucket) => bucket.length),
      headLimit,
    );
    for (let i = 0; i < fileBuckets.length; i += 1) {
      const bucket = fileBuckets[i];
      const take = alloc[i];
      if (take >= bucket.length) {
        rows.push(...bucket);
        continue;
      }
      truncated = true;
      rows.push(...trimDanglingRows(bucket.slice(0, take)));
    }
  }
  if (!rows.length) return result(call, "No matches found");
  const limited = rows.slice(0, headLimit);
  const { kept, truncated: sizeTruncated } = takeCodingOutputLines(limited);
  const body = [
    kept.map((line) => line.rendered).join("\n"),
  ].join("\n");
  const output = codingTextResult(
    call,
    truncated || rows.length > headLimit || sizeTruncated
      ? mode === "content"
        ? `${body}\n(Results truncated: ${headLimit} lines split evenly across ${fileBuckets.length} matching file${fileBuckets.length === 1 ? "" : "s"}. Narrow the pattern, scope with path=, or raise head_limit.)`
        : `${body}\n(Results truncated, showing first ${headLimit} lines. Narrow the pattern or pass head_limit.)`
      : body,
    kept,
  );
  return output;
}

function pdfLocatorParams(args: Record<string, unknown>) {
  return {
    locatorKind: args.locator_kind as LocalPdfLocatorKind,
    locator: typeof args.locator === "string" ? args.locator : "",
    endLocator: optionalString(args.end_locator),
    contextBlocks: optionalNumber(args.context_blocks),
    page: optionalNumber(args.page),
    occurrence: optionalNumber(args.occurrence),
  };
}

export async function extractDocument(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
) {
  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file) return null;
  const fileType = file.fileType.toLowerCase();
  const projection = await documentProjectionService.read({
    documentId,
    versionId: file.version.id,
    filename: file.filename,
    fileType,
    sourceSha256: file.version.source_sha256,
    bytes: file.bytes,
    localPath: file.localPath,
  });
  const text = projection.text;
  const parsed = "sourceDoc" in projection ? projection.sourceDoc : null;
  const cautions = projection.kind === "docx-session"
    ? docxCautionNotes(projection.pathology)
    : [];

  // The page map is built HERE because this is the only place that still
  // holds the engine artifact: `parsed` carries both the PDF page number and
  // the printed label the engine's header/footer detection found, and the
  // rendered text collapses them into one marker. Every consumer downstream
  // sees text only, so a map recovered later cannot tell "printed 47" from
  // "PDF page 47" — and a table of contents cites the printed one.
  //
  // Both PDF routes end at the engine, so both can be indexed: the ingested
  // artifact carries page BLOCKS, and the un-ingested route still renders
  // `[page N]` markers into the text. Fall through from one to the other, and
  // when a PDF yields neither, say the index is UNAVAILABLE — a PDF has
  // pages whether or not we managed to read them, and reporting "no pages"
  // would state a falsehood about the document to cover a gap in the
  // pipeline.
  const fromArtifact = parsed ? pageMapFromSourceDoc(parsed) : null;
  const pages: PageMap = fromArtifact?.pages.length
    ? fromArtifact
    : (() => {
        const recovered = pageMapFromMarkers(text);
        if (recovered.pages.length || fileType !== "pdf") return recovered;
        return { pages: [], source: "unindexed" as const };
      })();
  const tableCells: TableCellSpan[] = projection.tableCells;
  return {
    filename: file.filename,
    documentId,
    versionId: file.version.id,
    text,
    cautions,
    pages,
    tableCells,
  };
}

/**
 * Opt-in redline view (3i-2): the active version's body text with tracked
 * changes, comments, and manual ink redlines projected as markers. A read
 * view only — the edit paths keep anchoring against the default text.
 */




/**
 * Transport ceiling for a single tool result. Every organ here has its own
 * cap, but nothing enforced a floor under all of them, and an oversized result
 * is not paid once — the adapters re-send the whole transcript each round, so
 * one unbounded read is re-billed for the rest of the turn.
 *
 * 64,000 sits above every deliberate read (section reads cap at 60,000, as
 * does PDF lookup), so it bites untargeted whole-document reads and nothing
 * else. Trimming takes the head AND the tail, because a clause's proviso lives
 * at its end.
 */
const MAX_TOOL_RESULT_CHARS = Number(
  process.env.MIKE_TOOL_RESULT_CAP || 64_000,
);

export type AssistantToolEvent = {
  type: "doc_created" | "doc_edited";
  filename: string;
  document_id: string;
  version_id: string;
  version_number: number | null;
  download_url: string;
  resource: string;
  edit_mode?: EditMode;
  annotations?: unknown[];
} | LocalAutomationEvent;

function result(
  _call: NormalizedToolCall,
  content: unknown,
): BeaverOutcome {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  const object = content && typeof content === "object" && !Array.isArray(content)
      ? content as Record<string, unknown>
      : null;
  const error = object?.ok === false;
  const message = String(object?.error ?? serialized);
  const status: NormalizedToolResult["status"] =
    typeof object?.status === "string"
      ? object.status as NormalizedToolResult["status"]
      : error
        ? /ambiguous/iu.test(message) ? "ambiguous"
          : /not found|does not exist|no (?:matches|files)/iu.test(message)
            ? "not_found" : "error"
        : /^No (?:matches|files)/iu.test(serialized) ? "not_found" : "ok";
  return {
    result: toolText(serialized, status === "error"),
    metadata: { status },
  };
}

function documentResult(
  call: NormalizedToolCall,
  content: Record<string, unknown>,
): BeaverOutcome {
  const base = result(call, content);
  const action = content.action;
  if (
    content.ok !== true || content.receipt !== "mike-document:v1" ||
    (action !== "created" && action !== "revised") ||
    typeof content.filename !== "string" ||
    typeof content.document_id !== "string" ||
    typeof content.version_id !== "string" ||
    typeof content.download_url !== "string"
  ) return base;
  const event: AssistantToolEvent = {
    type: action === "created" ? "doc_created" : "doc_edited",
    filename: content.filename,
    document_id: content.document_id,
    version_id: content.version_id,
    version_number: typeof content.version_number === "number"
      ? content.version_number
      : null,
    download_url: content.download_url,
    resource: typeof content.resource === "string"
      ? content.resource
      : resourceReference.document(content.document_id, content.version_id),
    ...(action === "revised" && {
      edit_mode: content.edit_mode === "auto" ? "auto" : "manual",
      annotations: Array.isArray(content.annotations) ? content.annotations : [],
    }),
  };
  return {
    ...base,
    mutated: true,
    events: [...(base.events ?? []), event],
  };
}

const mutationResult = (call: NormalizedToolCall, content: Record<string, unknown>) => ({
  ...result(call, content),
  mutated: content.ok === true,
});

function codingTextResult(
  call: NormalizedToolCall,
  content: string,
  lines: CodingOutputLine[],
): BeaverOutcome {
  const sourceLines =
    call.name === "Grep"
      ? lines.filter((line) => line.handoffCandidate === true)
      : lines;
  const segments = sourceLines.flatMap((line) => {
    if (!line.span || !line.source) return [];
    const { sourceText: _, ...source } = line.source;
    return [{
      ...source,
      start: line.span[0],
      end: line.span[1],
      kind: call.name === "Grep" ? "candidate" as const : "evidence" as const,
    }];
  });
  const evidence = call.name === "Read"
    ? [...new Map(sourceLines.flatMap((line) => {
        if (!line.span || !line.source?.sourceText) return [];
        const [start, end] = line.span;
        const receipt = createLibraryEvidence({
          documentId: line.source.documentId,
          versionId: line.source.versionId,
          filename: line.source.filename ?? line.source.documentId,
          sourceText: line.source.sourceText,
          spanText: line.source.sourceText.slice(start, end),
          start,
          end,
          locator: line.source.locator && line.source.locatorKind
            ? { kind: line.source.locatorKind, label: line.source.locator }
            : undefined,
        });
        return [[receipt.evidence_id, receipt] as const];
      })).values()]
    : [];
  const rendered = result(
    call,
    evidence.length
      ? `${content}\n\nCitation evidence_ids: ${evidence.map(({ evidence_id }) => evidence_id).join(", ")}`
      : content,
  );
  return {
    ...rendered,
    metadata: {
      ...rendered.metadata,
      evidenceSpans: sourceLines.flatMap((line) => line.span ? [line.span] : []),
      evidenceSegments: segments,
    },
    ...(evidence.length ? { evidence } : {}),
  };
}

const fail = (call: NormalizedToolCall, error: string) =>
  result(call, { ok: false, error });

const SAFE_PDF_EVIDENCE_ERRORS = new Set([
  "Invalid PDF evidence handle",
  "Invalid PDF evidence receipt",
  "PDF evidence receipt handle does not match its content",
  "PDF evidence receipt does not belong to this source",
  "PDF evidence source bytes no longer match their version",
  "PDF evidence no longer matches the authoritative source artifacts",
]);

const pdfEvidenceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return SAFE_PDF_EVIDENCE_ERRORS.has(message)
    ? message
    : "PDF evidence is unavailable";
};

type LocalPdfLookupResult =
  | Awaited<ReturnType<typeof documentProjectionService.lookupPdf>>
  | Awaited<ReturnType<typeof documentProjectionService.rehydratePdfEvidence>>;
const MAX_COMPACT_PDF_MATCHES = 20;

function compactPdfLookup(filename: string, lookup: LocalPdfLookupResult) {
  if (lookup.status !== "found") {
    const matches = lookup.matches.slice(0, MAX_COMPACT_PDF_MATCHES);
    return {
      ok: false,
      filename,
      status: lookup.status,
      exact: false,
      ...(matches.length ? { matches } : {}),
      ...(lookup.matches.length > matches.length
        ? { matches_truncated: true }
        : {}),
      ...("error" in lookup ? { error: lookup.error } : {}),
    };
  }
  const confidence = lookup.units
    .map((unit) => unit.confidence)
    .filter((value): value is number => typeof value === "number");
  const compactUnit = (unit: (typeof lookup.units)[number]) => ({
    kind: unit.kind,
    locator: unit.locator,
    text: unit.text,
    ...(unit.page_numbers.length ? { pages: unit.page_numbers } : {}),
    ...(unit.confidence !== null && unit.confidence < 1
      ? { confidence: unit.confidence }
      : {}),
    ...(unit.proposition ? { proposition: unit.proposition } : {}),
    ...(unit.note
      ? {
          note: {
            label: unit.note.label,
            ...(unit.note.warnings.length
              ? { warnings: unit.note.warnings }
              : {}),
          },
        }
      : {}),
  });
  return {
    ok: true,
    filename,
    status: lookup.status,
    exact: true,
    handle: lookup.evidence.handle,
    version_id: lookup.source.version_id,
    units: lookup.units.map(compactUnit),
    ...(lookup.before.length || lookup.after.length
      ? {
          context: {
            before: lookup.before.map(compactUnit),
            after: lookup.after.map(compactUnit),
          },
        }
      : {}),
    confidence: confidence.length ? Math.min(...confidence) : null,
    link: {
      ...(lookup.evidence.page_text_sha256 &&
      lookup.evidence.page_numbers?.length
        ? { href: lookup.link.href }
        : {}),
      page_numbers: lookup.link.page_numbers,
    },
  };
}

function pdfEvidenceRefs(
  filename: string,
  lookup: LocalPdfLookupResult,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  if (lookup.status !== "found") return [];
  return [...lookup.before, ...lookup.units, ...lookup.after]
    .filter((unit) => Boolean(unit.text))
    .map((unit) => ({
      handle: `${lookup.evidence.handle}#${unit.id}`,
      filename,
      locator: unit.locator,
      text: unit.text,
      exactSha256: sha256(unit.text),
      kind: "evidence" as const,
    }));
}

function receiptEvidenceRefs(
  receipts: Array<LegalEvidenceReceipt | undefined>,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  return receipts.flatMap((receipt) =>
    receipt?.span_text
      ? [
          {
            handle: receipt.evidence_id,
            filename: receipt.name ?? receipt.citation,
            locator: receipt.locator.label,
            text: receipt.span_text,
            exactSha256: sha256(receipt.span_text),
            kind: "evidence" as const,
          },
        ]
      : [],
  );
}

type ReadyProviderPdfLookup = {
  availability: "ready";
  state: ProviderPdfAttachmentState;
  params: ProviderPdfAttachment;
  lookup: LocalPdfLookupResult;
  linkEvidence: LocalPdfLinkEvidence | null;
};

function compactProviderPdfLookup(resolved: ReadyProviderPdfLookup) {
  const filename =
    resolved.params.title ||
    resolved.params.filename ||
    resolved.params.identity;
  const compact = compactPdfLookup(filename, resolved.lookup);
  const freshness = {
    freshness_status: resolved.state.freshness_status,
    fetched_at: resolved.state.fetched_at,
    checked_at: resolved.state.checked_at,
    ...(resolved.state.freshness_status === "stale"
      ? {
          freshness_warning:
            "The exact cached PDF is verified, but its latest refresh failed or is due.",
        }
      : {}),
  };
  if (resolved.lookup.status !== "found") {
    return {
      ...compact,
      ...freshness,
      reference_id: resolved.state.reference_id,
      request_reference: resolved.state.request_reference,
      source_reference: resolved.state.source_reference,
    };
  }
  const pageNumbers =
    resolved.linkEvidence?.pageNumbers ?? resolved.lookup.link.page_numbers;
  const sourceUrl = new URL(resolved.params.url);
  if (pageNumbers[0]) sourceUrl.hash = `page=${pageNumbers[0]}`;
  return {
    ...compact,
    ...freshness,
    reference_id: resolved.state.reference_id,
    request_reference: resolved.state.request_reference,
    source_reference: resolved.state.source_reference,
    link: { href: sourceUrl.toString(), page_numbers: pageNumbers },
  };
}

type InsertBlocksRequest = {
  blocks: string[];
  position: "before" | "after";
  anchorText?: string;
  occurrence?: number;
};

function parseAdvancedOps(raw: unknown):
  | { insert?: InsertBlocksRequest; requests: TextOpRequest[] }
  | string {
  const ops = raw as Array<Record<string, unknown>>;
  const inserted = ops.find(({ op }) => op === "insert_blocks");
  if (inserted) {
    if (ops.length !== 1) return "insert_blocks must be the only op in its call";
    const blocks = inserted.blocks as string[];
    const scope = inserted.scope as Record<string, unknown>;
    if (blocks.some((block) => !block.trim() || /[\r\n]/u.test(block))) {
      return "insert_blocks.blocks must contain non-empty single-paragraph strings";
    }
    if (scope.kind !== "whole_document" && scope.kind !== "find_text") {
      return "insert_blocks scope must be whole_document or find_text";
    }
    if (scope.kind === "find_text" && !trimmed(scope.text)) {
      return "insert_blocks find_text scope requires exact anchor text";
    }
    return {
      insert: {
        blocks,
        position: inserted.position === "before" ? "before" : "after",
        ...(scope.kind === "find_text" ? { anchorText: trimmed(scope.text) } : {}),
        ...(typeof scope.occurrence === "number"
          ? { occurrence: scope.occurrence }
          : {}),
      },
      requests: [],
    };
  }
  const requests: TextOpRequest[] = [];
  for (const [index, op] of ops.entries()) {
    const scope = op.scope as Record<string, unknown>;
    if (scope.kind === "find_text" && !trimmed(scope.text)) {
      return `ops[${index}].scope.text is required for find_text`;
    }
    if (scope.kind === "range" && (!trimmed(scope.from_text) || !trimmed(scope.to_text))) {
      return `ops[${index}].scope.from_text and to_text are required for range`;
    }
    if (scope.kind === "at" && !trimmed(scope.at)) {
      return `ops[${index}].scope.at is required for at`;
    }
    if (op.op === "replace_text" && typeof op.find !== "string") {
      return `ops[${index}].find is required for replace_text`;
    }
    requests.push({
      ...op,
      op: op.op as string,
      scope: scope as unknown as TextOpScope,
    } as TextOpRequest);
  }
  return { requests };
}

function pdfLegalEvidence(
  documentId: string,
  versionId: string,
  filename: string,
  lookup: LocalPdfLookupResult,
): LegalEvidenceReceipt[] {
  if (lookup.status !== "found") return [];
  return [...lookup.before, ...lookup.units, ...lookup.after].flatMap((unit) => {
    if (!unit.text.trim()) return [];
    const locatorKind = unit.kind === "page"
      ? "page"
      : unit.kind === "footnote"
        ? "footnote"
        : unit.kind === "paragraph"
          ? "paragraph"
          : "section";
    return [createBenchmarkEvidence({
      jurisdiction: "matter",
      sourceClass: "commentary",
      stableSourceId: `library-pdf:${documentId}:${versionId}:${unit.id}`,
      sourceText: unit.text,
      spanText: unit.text,
      citation: filename,
      name: filename,
      dataset: "library-pdf",
      version: versionId,
      locatorKind,
      locatorLabel: unit.locator,
    })];
  });
}

async function runAdvancedDocxEdit(params: {
  call: NormalizedToolCall;
  args: Record<string, unknown>;
  documents: DocumentStore;
  scope: DocumentScope;
  documentId: string;
  turnEditState?: AssistantEditTurnState;
  editMode: EditMode;
}) {
  const parsed = parseAdvancedOps(params.args.ops);
  if (typeof parsed === "string") return fail(params.call, parsed);
  const { insert: blockInsert, requests } = parsed;
  try {
    const file = await activeDocument(
      params.documents,
      params.scope,
      params.documentId,
      params.turnEditState?.get(params.documentId)?.versionId,
    );
    if (!file) return fail(params.call, "DOCX Library version not found");
    if (file === "stale") return fail(params.call, "The active document version changed.");
    if (file.fileType.toLowerCase() !== "docx") {
      return fail(params.call, "Text operations require a DOCX Library version");
    }
    let resolvedRequests = requests;
    if (requests.some(({ scope }) =>
      (scope as unknown as { kind: string }).kind === "at")) {
      const body = await extractDocxBodyStructure(file.bytes);
      if (!body.text) {
        return fail(params.call, "DOCX body text could not be extracted, so an `at` scope cannot be resolved.");
      }
      const skeleton = compileAgreementSkeleton(body.text, params.documentId, {
        tableCells: body.tableCells,
      });
      const map = pageMapFromMarkers(body.text);
      const mapped: TextOpRequest[] = [];
      for (const [index, request] of requests.entries()) {
        const scope = request.scope as unknown as {
          kind: string;
          at: string;
          follow?: FollowDirection;
          depth?: number;
        };
        if (scope.kind !== "at") {
          mapped.push(request);
          continue;
        }
        const address = parseAddress(scope.at ?? "");
        if (!address || address.kind === "offset") {
          return fail(params.call, `ops[${index}].scope.at is not a provision or page address`);
        }
        let spans: { start: number; end: number }[];
        if (address.kind === "page") {
          const lookup = resolvePage(map, body.text, address.spec);
          if (lookup.status !== "found") {
            return fail(params.call, `ops[${index}].scope.at did not resolve (${lookup.status})`);
          }
          spans = [{ start: lookup.page.start, end: lookup.page.end }];
        } else {
          const seed = readSection(skeleton, address.locator);
          if (seed.status !== "found" || !seed.block) {
            return fail(params.call, `ops[${index}].scope.at did not resolve (${seed.status})`);
          }
          const follow = scope.follow ?? "none";
          if (follow === "none") {
            spans = [{ start: seed.block.start, end: seed.block.end }];
          } else {
            const walked = graphScope(
              skeleton,
              crossReferenceGraph(body.text, params.documentId, { skeleton }),
              seed.block.label,
              { follow, depth: scope.depth ?? 1 },
            );
            if (!walked) return fail(params.call, `ops[${index}].scope.at is not a skeleton node`);
            spans = walked.nodes.map(({ start, end }) => ({ start, end }));
          }
        }
        mapped.push({ ...request, scope: { kind: "spans", spans } });
      }
      resolvedRequests = mapped;
    }
    const applied = blockInsert
      ? await insertTrackedBlocks(file.bytes, blockInsert, { author: "Beaver" }).then(
          (inserted) => ({
            bytes: inserted.bytes,
            edits: inserted.changes.map((change): AssistantEdit => ({
              changeId: change.id,
              delWId: change.delId,
              insWId: change.insId,
              deletedText: change.deletedText,
              insertedText: change.insertedText,
              contextBefore: change.contextBefore ?? "",
              contextAfter: change.contextAfter ?? "",
              diff: change.diff,
            })),
            reports: [{
              op: "insert_blocks",
              replacements: inserted.changes.length,
              notes: [] as string[],
            }],
            replacementCount: inserted.changes.length,
            editErrors: inserted.errors.map(
              ({ index, reason }) => `change ${index + 1}: ${reason}`,
            ),
          }),
        )
      : await applyTextOpsToDocx(file.bytes, resolvedRequests);
    const reports = applied.reports.map(({ op, replacements, notes }) => ({
      op,
      replacements,
      unchanged_sites: notes,
    }));
    if (!applied.replacementCount) {
      return result(params.call, {
        ok: true,
        action: "no_changes",
        document_id: params.documentId,
        version_id: file.version.id,
        change_count: 0,
        ops: reports,
      });
    }
    if (!applied.edits.length) {
      return result(params.call, {
        ok: false,
        error: "No revision was saved",
        ops: reports,
        ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
      });
    }
    return saveDocxEdits({
      call: params.call,
      documents: params.documents,
      scope: params.scope,
      documentId: params.documentId,
      source: file,
      bytes: applied.bytes,
      edits: applied.edits,
      turnEditState: params.turnEditState,
      editMode: params.editMode,
      extra: {
        ops: reports,
        ...(applied.editErrors.length ? { edit_errors: applied.editErrors } : {}),
      },
    });
  } catch (error) {
    return fail(params.call, errorText(error, "Deterministic text operations failed"));
  }
}

async function workflowDocx(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  versionId?: string,
) {
  const file = await activeDocument(documents, scope, documentId, versionId);
  if (!file) throw new Error("Document not found");
  if (file === "stale") throw new Error("Version is not active");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Operation requires a DOCX document");
  }
  return file;
}

async function saveWorkflowDocx(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  turnEditState: AssistantEditTurnState | undefined,
  input: { sourceVersionId: string; filename: string; bytes: Buffer },
) {
  const committed = await commitAssistantTurnVersion({
    documents,
    scope,
    documentId,
    ...input,
    trackedEdits: [],
    turnEditState,
  });
  if (!committed) throw new Error("The active version changed");
  return {
    id: committed.version.id,
    filename: committed.version.filename ?? input.filename,
    version_number: committed.version.version_number ?? undefined,
    file_type: committed.version.file_type ?? undefined,
    source_sha256: committed.version.source_sha256 ?? undefined,
    parentVersionId: committed.parentVersionId,
  };
}

const DOCX_WORKFLOWS: Record<
  string,
  {
    run: (
      documents: DocumentStore,
      scope: DocumentScope,
      documentId: string,
      versionId: string | undefined,
      turnEditState?: AssistantEditTurnState,
    ) => Promise<Record<string, unknown>>;
    fallback: string;
  }
> = {
  link_docx_citations: {
    run: async (documents, scope, documentId, versionId, turnEditState) => {
      const file = await workflowDocx(documents, scope, documentId, versionId);
      return linkDocxCitations({
        documentId,
        sourceVersionId: file.version.id,
        filename: file.filename,
        bytes: file.bytes,
        saveVersion: (input) => saveWorkflowDocx(
          documents, scope, documentId, turnEditState, input,
        ),
      });
    },
    fallback: "DOCX citation linking failed",
  },
  fix_docx_supras: {
    run: async (documents, scope, documentId, versionId, turnEditState) => {
      const file = await workflowDocx(documents, scope, documentId, versionId);
      const cleanup = await fixDocxSupraCrossReferences(file.bytes);
      if (!cleanup.converted) {
        return {
          ok: true,
          changed: false,
          document_id: documentId,
          version_id: file.version.id,
          filename: file.filename,
          ...cleanup,
          bytes: undefined,
        };
      }
      const filename = `${file.filename.replace(/\.docx$/iu, "")} - supras fixed.docx`;
      const saved = await saveWorkflowDocx(
        documents,
        scope,
        documentId,
        turnEditState,
        { sourceVersionId: file.version.id, filename, bytes: cleanup.bytes },
      );
      return {
        ok: true,
        receipt: "mike-document:v1",
        action: "revised",
        changed: true,
        document_id: documentId,
        parent_version_id: saved.parentVersionId,
        version_id: saved.id,
        version_number: saved.version_number,
        filename: saved.filename,
        file_type: saved.file_type ?? "docx",
        source_sha256: saved.source_sha256,
        download_url: `/single-documents/${encodeURIComponent(documentId)}/file?version_id=${encodeURIComponent(saved.id)}`,
        annotations: [],
        ...cleanup,
        bytes: undefined,
      };
    },
    fallback: "DOCX supra cleanup failed",
  },
  lint_docx_structure: {
    run: async (documents, scope, documentId, versionId) => {
      const file = await workflowDocx(documents, scope, documentId, versionId);
      return {
        ok: true,
        document_id: documentId,
        version_id: file.version.id,
        filename: file.filename,
        ...await lintDocxStructure(file.bytes),
      };
    },
    fallback: "DOCX structural lint failed",
  },
};

type ServedDrafting =
  | {
      served: string;
      versionId: string;
      filename: string;
    }
  | null;

async function servedDraftingText(
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  cache?: Map<string, ServedDrafting>,
  versionId?: string,
): Promise<ServedDrafting> {

  const file = await documents.read(
    scope, documentId, versionId ?? null, false,
  );
  if (!file || file.fileType.toLowerCase() !== "docx") return null;
  const cacheKey = `${documentId}:${file.version.id}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;
  const source = await extractDocxDraftingSource(file.bytes).catch(() => null);
  let result: ServedDrafting;
  if (!source) {
    result = null;
  } else {
    result = {
      served: source.markdown,
      versionId: file.version.id,
      filename: file.filename,
    };
  }
  cache?.set(cacheKey, result);
  return result;
}

export type AssistantToolOptions = {
  userEmail?: string;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workflows?: WorkflowStore;
  courtlistener?: CourtlistenerToolState;
  allowedDocumentIds?: Set<string>;
  pdfHandles?: Set<string>;
  matterId?: string | null;
  legalEvidence?: LegalEvidenceTurnState;
  edits?: AssistantEditTurnState;
  servedDraftingCache?: Map<string, ServedDrafting>;
  editMode?: EditMode;
  timeZone?: string;
};

export async function executeAssistantTool(
  userId: string,
  call: NormalizedToolCall,
  {
    userEmail,
    courtlistener: courtlistenerState,
    allowedDocumentIds,
    pdfHandles: localPdfEvidenceHandles,
    matterId,
    legalEvidence: legalEvidenceState,
    edits: turnEditState,
    servedDraftingCache = new Map(),
    editMode = "manual",
    timeZone,
    documents,
    library,
    projects,
    workflows,
  }: AssistantToolOptions,
  signal?: AbortSignal,
): Promise<BeaverOutcome> {
  if (signal?.aborted) throw signal.reason ?? new Error("Tool call cancelled");
  const scope: DocumentScope = { userId, userEmail };
  const availableWorkflows = workflows ?? new Map(
    SYSTEM_ASSISTANT_WORKFLOWS.map(({ id, title, skill_md }) => [
      id,
      { title, skill_md },
    ]),
  );
  // Per-turn cache for the derived SECT-INDEX (F5): .docx extraction + skeleton
  // derivation + index render repeat on every read/find call in a batch; keyed
  // by documentId:versionId so a version change naturally re-derives. Scoped to
  // this batch, so it never outlives the turn.
  const persistGenerated = async (
    filename: string,
    bytes: Buffer,
    provenance?: DocumentProvenance,
  ) => {
    const document = await documents.create(scope, {
      filename,
      fileType: filename.slice(filename.lastIndexOf(".") + 1).toLowerCase(),
      bytes,
      projectId: matterId,
      libraryKind: "file",
      provenance,
    });
    allowedDocumentIds?.add(document.id);
    return document;
  };
  const execute = async (): Promise<BeaverOutcome> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Tool call cancelled");
      let args = call.input;

      {
        const resolved = await resolveDocumentArgument(
          scope,
          args,
          library,
          projects,
          allowedDocumentIds,
          matterId,
        );
        if (resolved.error) return fail(call, resolved.error);
        args = resolved.input;
      }

      const sourceRead = await readLegalSourceResource(call, args, {
        userId,
        courtlistener: courtlistenerState,
        signal,
      });
      if (sourceRead) return sourceRead;
      if (
        (call.name === "Glob" ||
          call.name === "Grep" ||
          call.name === "Read" ||
          call.name === "Edit" ||
          call.name === "edit_docx_advanced")
      ) {
        const codingResult = await runCodingShapeCall(
          call,
          args,
          documents,
          library,
          projects,
          scope,
          allowedDocumentIds,
          matterId,
          turnEditState,
          servedDraftingCache,
          localPdfEvidenceHandles,
          availableWorkflows,
          editMode,
        );
        return codingResult;
      }
      if (call.name === SEARCH_SOURCES_TOOL.name) {
        return result(call, await searchSources(args, signal));
      }
      if (courtlistenerState) {
        const courtlistenerResult = await runLocalCourtlistenerTool(
          call,
          courtlistenerState,
          userId,
          signal,
        );
        if (courtlistenerResult) return courtlistenerResult;
      }
      const documentId = trimmed(args.document_id);
      if (
        allowedDocumentIds &&
        documentId &&
        !allowedDocumentIds.has(documentId)
      ) {
        return fail(call, "Document is not attached to this matter");
      }
      if (call.name === "Write") {
        const requestedFilename = trimmed(args.filename);
        const markdown = typeof args.content === "string" ? args.content.trim() : "";
        const extension = /\.([^.]+)$/u.exec(requestedFilename)?.[1].toLowerCase();
        if (!markdown || !["docx", "xlsx", "pptx"].includes(extension ?? "")) {
          return fail(call, "Write requires content and a .docx, .xlsx, or .pptx filename.");
        }
        const title = requestedFilename.replace(/\.[^.]+$/u, "");
        const filename = safeGeneratedFilename(title, extension!);
        try {
          if (extension !== "docx") {
            const bytes = extension === "xlsx"
              ? await renderXlsxWorkbook(title, workbookFromMarkdown(markdown))
              : await buildPptxPresentation(title, presentationFromMarkdown(markdown));
            const document = await persistGenerated(filename, bytes);
            return documentResult(call, {
              ok: true,
              receipt: "mike-document:v1",
              action: "created",
              document_id: document.id,
              version_id: document.current_version_id,
              version_number: document.active_version_number,
              filename: document.filename,
              file_type: document.file_type,
              resource: resourceReference.document(
                document.id,
                document.current_version_id,
              ),
              download_url:
                `/single-documents/${encodeURIComponent(document.id)}/file` +
                `?version_id=${encodeURIComponent(document.current_version_id)}`,
            });
          }
          const generatedAt = new Date();
          const drafting = resolveDraftingOptions(
            args,
            await getDraftingStyleSettings(userId),
          );
          const evidence = resolveDocxEvidenceCitations(
            legalEvidenceState,
            args.citations,
          );
          if (legalEvidenceState) {
            const integrityErrors = legalEvidenceProseIntegrityErrors(
              markdown,
              evidence.bindings.flatMap(({ evidenceIds }) => evidenceIds),
              legalEvidenceState,
            );
            if (integrityErrors.length) {
              return fail(call, `Draft integrity check failed: ${integrityErrors.join("; ")}`);
            }
          }
          const rendered = await renderMarkdownDocx(
            title,
            markdown,
            args.fields,
            {
              landscape: args.landscape === true,
              citations: evidence.citations,
              citationPlacement: drafting.citationPlacement,
              citationHyperlinks: drafting.citationHyperlinks,
              numberHeadings: drafting.numberHeadings,
              memoHeader: drafting.memoHeader,
              generatedAt,
              timeZone,
            },
          );
          if ("error" in rendered) return fail(call, rendered.error);
          const document = await persistGenerated(
            filename,
            rendered.bytes,
            {
              schemaVersion: 1,
              actor: "assistant",
              action: "created",
              generation: {
                rendererVersion: "beaver.docx-markdown.v2",
                markdownSha256: sha256(markdown),
                fieldValuesSha256: sha256(JSON.stringify(args.fields ?? [])),
                sourceRegistrySha256: sha256(
                  JSON.stringify(args.citations ?? []),
                ),
                evidenceBindings: evidence.bindings.map((binding) => ({
                  id: binding.id,
                  evidenceIds: binding.evidenceIds,
                  sourceSha256s: binding.sourceSha256s,
                  locators: binding.locators,
                  mainUrls: binding.mainUrls,
                  pinpointUrls: binding.pinpointUrls,
                })),
              },
            },
          );
          const downloadUrl =
            `/single-documents/${encodeURIComponent(document.id)}/file` +
            `?version_id=${encodeURIComponent(document.current_version_id)}`;
          const receipt = {
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            document_id: document.id,
            version_id: document.current_version_id,
            version_number: document.active_version_number,
            filename: document.filename,
            file_type: document.file_type,
            source_sha256: document.source_sha256,
            attached_to_matter: Boolean(matterId),
            resource: resourceReference.document(
              document.id,
              document.current_version_id,
            ),
            download_url: downloadUrl,
          };
          return documentResult(call, receipt);
        } catch (error) {
          return fail(
            call,
            error instanceof Error ? error.message : "DOCX creation failed",
          );
        }
      }

      if (call.name === "delete_and_renumber_docx") {
        let versionId = trimmed(args.version_id);
        const target = trimmed(args.target);
        if (!documentId || !target) {
          return fail(call, "document_id and target are required");
        }
        const turnVersion = turnEditState?.get(documentId);
        if (turnVersion) {
          if (
            versionId &&
            versionId !== turnVersion.versionId &&
            versionId !== turnVersion.parentVersionId
          ) {
            return fail(call, "version_id is not the active turn version");
          }
          versionId = turnVersion.versionId;
        }
        try {
          const file = await activeDocument(
            documents, scope, documentId, versionId || undefined,
          );
          if (!file) return fail(call, "DOCX Library version not found");
          if (file === "stale") {
            return fail(call, "version_id is not the active version");
          }
          if (file.fileType.toLowerCase() !== "docx") {
            return fail(call, "Renumbering requires a DOCX Library version");
          }

          const bytes = file.bytes;
          const body = await extractDocxBodyStructure(bytes);
          if (!body.text) {
            return fail(call, "DOCX body text could not be extracted");
          }
          const plan = deleteProvisionAndRenumberSiblings(body.text, target);
          if (plan.failures.length) {
            return result(call, {
              ok: false,
              error: "Delete-and-renumber refused; the document is unchanged",
              document_id: documentId,
              version_id: file.version.id,
              source_sha256: file.version.source_sha256,
              target,
              mapping: plan.mapping,
              failures: plan.failures,
            });
          }
          const edits = trackedEditsForRenumberPlan(body.text, plan.applied);
          if (typeof edits === "string") return fail(call, edits);
          const edited = await applyTrackedEdits(bytes, edits, {
            author: "Beaver",
          });
          if (edited.errors.length || !edited.changes.length) {
            return result(call, {
              ok: false,
              error: "Delete-and-renumber could not be represented as tracked changes; the document is unchanged",
              edit_errors: edited.errors,
            });
          }
          const acceptedText = await extractDocxBodyText(edited.bytes);
          const actualComparable = comparableAcceptedText(acceptedText);
          const expectedComparable = comparableAcceptedText(plan.text);
          if (actualComparable !== expectedComparable) {
            let mismatch = 0;
            while (
              mismatch < actualComparable.length &&
              actualComparable[mismatch] === expectedComparable[mismatch]
            ) {
              mismatch += 1;
            }
            return result(call, {
              ok: false,
              error:
                "Tracked-change verification disagreed with the renumber plan; the document is unchanged",
              mismatch_at: mismatch,
              expected_excerpt: expectedComparable.slice(
                Math.max(0, mismatch - 80),
                mismatch + 160,
              ),
              actual_excerpt: actualComparable.slice(
                Math.max(0, mismatch - 80),
                mismatch + 160,
              ),
              tracked_changes: edited.changes.map((change) => ({
                deleted: change.deletedText,
                inserted: change.insertedText,
              })),
            });
          }

          const trackedEdits: AssistantEdit[] = edited.changes.map(
            (change) => ({
              changeId: change.id,
              delWId: change.delId,
              insWId: change.insId,
              deletedText: change.deletedText,
              insertedText: change.insertedText,
              contextBefore: change.contextBefore,
              contextAfter: change.contextAfter,
              reason: change.reason,
              diff: change.diff,
            }),
          );
          const committed = await commitAssistantTurnVersion({
            documents,
            scope,
            documentId,
            sourceVersionId: file.version.id,
            filename: file.version.filename ?? file.filename,
            bytes: edited.bytes,
            trackedEdits,
            turnEditState,
            editMode,
          });
          if (!committed) {
            return fail(call, "version_id is no longer active");
          }
          const {
            version,
            parentVersionId,
            trackedEdits: savedEdits,
          } = committed;
          const downloadUrl =
            `/single-documents/${encodeURIComponent(documentId)}/file` +
            `?version_id=${encodeURIComponent(version.id)}`;
          return documentResult(call, {
            ok: true,
            receipt: "mike-document:v1",
            operation_receipt: "mike-delete-and-renumber:v1",
            action: "revised",
            edit_mode: editMode,
            document_id: documentId,
            parent_version_id: parentVersionId,
            input_source_sha256: file.version.source_sha256,
            version_id: version.id,
            version_number: version.version_number,
            filename: version.filename,
            file_type: version.file_type,
            source_sha256: version.source_sha256,
            target,
            mapping: plan.mapping,
            verification: plan.verification,
            plan_sha256: sha256(JSON.stringify(plan.applied)),
            splices: plan.applied.map((receipt) => ({
              kind: receipt.kind,
              start: receipt.start,
              end: receipt.end,
              from: receipt.from,
              to: receipt.to,
              removed_sha256: sha256(receipt.removed),
              inserted: receipt.inserted,
            })),
            change_count: savedEdits.length,
            resource: resourceReference.document(documentId, version.id),
            download_url: downloadUrl,
            annotations: savedEdits.map((edit) => ({
              kind: "edit",
              edit_id: edit.id,
              document_id: documentId,
              version_id: version.id,
              version_number: version.version_number,
              change_id: edit.changeId,
              del_w_id: edit.delWId,
              ins_w_id: edit.insWId,
              deleted_text:
                edit.deletedText.length > 500
                  ? `${edit.deletedText.slice(0, 500)}…`
                  : edit.deletedText,
              inserted_text: edit.insertedText,
              reason: edit.reason,
              diff: edit.diff,
              status: edit.status,
            })),
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Delete-and-renumber failed"),
          );
        }
      }

      if (call.name === "update_library_metadata") {
        const documentId = trimmed(args.document_id);
        const kind = args.kind === "template" ? "template" : "file";
        if (!documentId) return fail(call, "document_id is required");
        const libraryScope = { ...scope, kind } as const;
        const current = await library.document(libraryScope, documentId);
        const updated = current?.filename
          ? await library.updateDocument(libraryScope, documentId, {
              filename: current.filename,
              metadata: args.metadata,
              ...(typeof args.notes === "string" || args.notes === null
                ? { notes: args.notes }
                : {}),
            })
          : null;
        return updated
          ? mutationResult(call, {
              ok: true,
              document_id: updated.id,
              filename: updated.filename,
              metadata: updated.metadata,
              notes: updated.notes,
              app_url: appUrl({
                kind: "library-document",
                libraryKind: kind,
                projectId: matterId,
              }),
            })
          : fail(call, "Document not found");
      }

      const docxWorkflow = DOCX_WORKFLOWS[call.name];
      if (docxWorkflow) {
        const automationEvent = call.name === "link_docx_citations"
          ? citationLinkingEvent
          : call.name === "fix_docx_supras"
            ? supraFixEvent
            : null;
        if (!documentId) {
          const message = "document_id is required";
          const event = automationEvent?.({ ok: false, error: message }, call.id);
          return { ...fail(call, message), ...(event ? { events: [event] } : {}) };
        }
        try {
          const output = await docxWorkflow.run(
            documents,
            scope,
            documentId,
            trimmed(args.version_id) || undefined,
            turnEditState,
          );
          const rendered = documentResult(call, output);
          const event = automationEvent?.(output, call.id);
          return event
            ? { ...rendered, events: [...(rendered.events ?? []), event] }
            : rendered;
        } catch (error) {
          const message = errorText(error, docxWorkflow.fallback);
          const rendered = fail(call, message);
          const event = automationEvent?.({ ok: false, error: message }, call.id);
          return event ? { ...rendered, events: [event] } : rendered;
        }
      }

      if (call.name === "create_table_of_authorities") {
        const versionId = trimmed(args.version_id);
        if (!documentId) {
          const message = "document_id is required";
          const event = tableOfAuthoritiesEvent({ ok: false, error: message }, call.id);
          return { ...fail(call, message), ...(event ? { events: [event] } : {}) };
        }
        try {
          const file = await documents.read(
            scope,
            documentId,
            versionId || null,
            false,
          );
          if (!file) {
            const message = "Library version not found";
            const event = tableOfAuthoritiesEvent({ ok: false, error: message }, call.id);
            return { ...fail(call, message), ...(event ? { events: [event] } : {}) };
          }
          if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) {
            const message = "Table of Authorities requires a Word or PDF Library version";
            const event = tableOfAuthoritiesEvent({ ok: false, error: message }, call.id);
            return { ...fail(call, message), ...(event ? { events: [event] } : {}) };
          }
          const job = await submitTableOfAuthoritiesDocument({
            bytes: file.bytes,
            filename: file.version.filename ?? file.filename,
            splitFallback: args.split_fallback === "off" ? "off" : "auto",
            projectId: matterId,
          });
          const payload = {
            ok: true,
            document_id: documentId,
            version_id: file.version.id,
            filename: file.version.filename,
            resource: resourceReference.job(job.id),
            job,
            next_required_action:
              `Read ${resourceReference.job(job.id)} until detection is complete.`,
          };
          const event = tableOfAuthoritiesEvent(payload, call.id);
          return {
            ...mutationResult(call, payload),
            ...(event ? { events: [event] } : {}),
          };
        } catch (error) {
          const message = errorText(error, "Table of Authorities submission failed");
          const event = tableOfAuthoritiesEvent({ ok: false, error: message }, call.id);
          return { ...fail(call, message), ...(event ? { events: [event] } : {}) };
        }
      }

      const citator = executeCitatorTool(call.name, args);
      if (citator) {
        return {
          ...withMetadata(result(call, citator.payload), {
            evidenceRefs: receiptEvidenceRefs(citator.evidences ?? []),
          }),
          evidence: citator.evidences ?? [],
        };
      }

      const compared = await executeCompareVersionsTool(
        documents, scope, call.name, args, matterId,
      );
      if (compared) return documentResult(call, compared);

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
  };
  const output = await execute();
  if (signal?.aborted && !output.mutated) {
    throw signal.reason ?? new Error("Tool call cancelled");
  }
  return output;
}

export type AssistantToolRuntime = {
  userId: string;
  options: AssistantToolOptions;
  scope: "main" | "reader";
  tabular?: TabularCellStore;
  documentNames?: ReadonlyMap<string, string>;
  resolveArtifact(value: string): string | undefined;
  artifactFor(documentId: string): string;
  onMutationCommitted(): void;
};

type DocumentToolEvent = Extract<
  AssistantToolEvent,
  { type: "doc_created" | "doc_edited" }
>;

const isDocumentToolEvent = (event: unknown): event is DocumentToolEvent =>
  !!event && typeof event === "object" &&
  (event as { type?: unknown }).type === "doc_created" ||
  !!event && typeof event === "object" &&
  (event as { type?: unknown }).type === "doc_edited";

export function createAssistantTools<Context>(
  runtime: AssistantToolRuntime,
): BeaverTool<Context>[] {
  const documentName = (value: unknown) => {
    const raw = trimmed(value);
    const resolved = runtime.resolveArtifact(raw) ?? raw;
    const reference = parseResourceReference(resolved);
    const id = reference?.kind === "document" ? reference.documentId : resolved;
    return runtime.documentNames?.get(id);
  };
  const activity = (name: string, input: Record<string, unknown>) =>
    assistantToolActivityLabel(name, input) ?? null;
  const execute = async (
    call: Readonly<NormalizedToolCall>,
    input: Record<string, unknown>,
    signal: AbortSignal,
    terminalOnCreate = false,
  ): Promise<BeaverOutcome> => {
    const filePath = trimmed(input.file_path);
    const resolvedInput = filePath && runtime.resolveArtifact(filePath)
      ? { ...input, file_path: runtime.resolveArtifact(filePath)! }
      : input;
    const output = await executeAssistantTool(
      runtime.userId,
      { ...call, input: resolvedInput },
      runtime.options,
      signal,
    );
    const { events: rawEvents = [], ...rest } = output;
    if (output.mutated) runtime.onMutationCommitted();
    const documentEvent = rawEvents.find(isDocumentToolEvent);
    const artifact = documentEvent && runtime.artifactFor(documentEvent.document_id);
    return {
      ...rest,
      result: artifact
        ? toolText({ ok: true, artifact, filename: documentEvent.filename })
        : output.result,
      ...(runtime.scope === "main" && rawEvents.length ? { events: rawEvents } : {}),
      ...((output.terminal ||
          (terminalOnCreate && documentEvent?.type === "doc_created"))
        ? { terminal: true }
        : {}),
    };
  };
  const definition = (
    schema: Tool,
    policy: {
      specialist?: boolean;
      reader?: boolean;
      sequential?: boolean | ((input: Record<string, unknown>) => boolean);
      activity?: (input: Record<string, unknown>) => string | null;
      terminalOnCreate?: boolean;
    } = {},
  ): BeaverTool<Context> => ({
    ...schema,
    ...(policy.specialist ? { specialist: true } : {}),
    ...(policy.reader ? { reader: true } : {}),
    ...(policy.sequential ? { sequential: policy.sequential } : {}),
    activity: policy.activity ?? ((input) => activity(schema.name, input)),
    execute: (input, _context, signal, call) =>
      execute(call, input, signal, policy.terminalOnCreate),
  });

  const [glob, grep, read, edit] = RESOURCE_TOOLS;
  const [
    updateMetadata,
    linkCitations,
    fixSupras,
    lintStructure,
    deleteAndRenumber,
    createAuthorities,
  ] = DOCUMENT_TOOLS;
  const compareVersions = COMPARE_VERSIONS_TOOLS[0];
  const findInCase = COURTLISTENER_FIND_TOOL;
  const verifyCitations = COURTLISTENER_VERIFY_TOOL;
  const noteUp = CITATOR_TOOLS[0];

  const tools: BeaverTool<Context>[] = [
    definition(glob, { reader: true, activity: () => null }),
    definition(grep, {
      reader: true,
      activity: (input) => documentName(input.path)
        ? `Searching ${documentName(input.path)}`
        : activity("Grep", input),
    }),
    definition(read, {
      reader: true,
      activity: (input) => documentName(input.file_path)
        ? `Reading ${documentName(input.file_path)}`
        : activity("Read", input),
    }),
    definition(edit, {
      sequential: true,
      activity: (input) => documentName(input.file_path)
        ? `Editing ${documentName(input.file_path)}`
        : activity("Edit", input),
    }),
    definition(WRITE_TOOL, { sequential: true, terminalOnCreate: true }),
    definition(SEARCH_SOURCES_TOOL, { reader: true }),
    definition(noteUp, { reader: true }),
    definition(updateMetadata, { specialist: true, sequential: true }),
    definition(linkCitations, { specialist: true, sequential: true }),
    definition(fixSupras, { specialist: true, sequential: true }),
    definition(lintStructure, { specialist: true, reader: true }),
    definition(deleteAndRenumber, { specialist: true, sequential: true }),
    definition(createAuthorities, { specialist: true, sequential: true }),
    definition(ADVANCED_DOCX_EDIT_TOOL, { specialist: true, sequential: true }),
    definition(compareVersions, {
      specialist: true,
      sequential: (input) => input.save_redline === true,
    }),
    definition(findInCase, {
      specialist: true,
      reader: true,
    }),
    definition(verifyCitations, {
      specialist: true,
      reader: true,
    }),
  ];

  if (runtime.tabular && runtime.options.legalEvidence) {
    const tabular = runtime.tabular;
    const evidence = runtime.options.legalEvidence;
    const tabularSchema = TABULAR_TOOLS[0];
    tools.splice(5, 0, {
      ...tabularSchema,
      reader: true,
      activity: () => "Reading table cells",
      async execute(input) {
        const indices = (value: unknown) => Array.isArray(value)
          ? value.filter((item): item is number => Number.isSafeInteger(item))
          : undefined;
        const read = readTabularCells(
          tabular,
          evidence,
          indices(input.col_indices),
          indices(input.row_indices),
        );
        return {
          result: toolText(read.content),
          ...(runtime.scope === "main"
            ? { events: [{ type: "doc_read", filename: read.label }] }
            : {}),
        };
      },
    });
  }
  return tools;
}
