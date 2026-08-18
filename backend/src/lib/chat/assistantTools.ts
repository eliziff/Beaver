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
import {
  type PublicLegalDocument,
} from "../publicLegalSources";
import { linkDocxCitations } from "../docxCitationLinking";
import { fixDocxSupraCrossReferences } from "../docxDeterministicCleanup";
import { lintDocxStructure } from "../docxStructuralLint";
import { type ServedPassage } from "../legalFigureReconciliation";
import {
  deleteProvisionAndRenumberSiblings,
  type DeleteAndRenumberReceipt,
} from "../legalAmendOps";
import {
  assignmentClosureReceipts,
  type AssignmentClosureSource,
} from "../legalAssignmentClosure";
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
import { anchoredSectionSpine, anchoredSectionStarts, deriveSectionNodes } from "./docxSectionAnchors";
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
import { isSpreadsheetDocumentType } from "../documentTypes";
import { spreadsheetToLLMStructure } from "../spreadsheet";
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
  lookupLocalPdfStructure,
  readLocalPdfEvidenceReceipt,
  readLocalPdfSourceDoc,
  rehydrateLocalPdfEvidence,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
} from "../localPdfLookup";
import { parseLocalPdfOnDemand } from "../localPdfIngestion";
import {
  lookupProviderPdfReference,
  rehydrateProviderPdfReference,
  type ProviderPdfAttachment,
  type ProviderPdfAttachmentState,
} from "../providerPdfLibraryBridge";
import {
  localPdfArtifactSessionForTurn,
  registerProviderPdfEvidenceForTurn,
} from "./localPdfEvidenceState";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  Tool,
} from "../llm";
import { cachedParse } from "../parseCache";
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
  registerLegalEvidence,
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
import { publicLegalPdfFallbacks } from "./publicLegalPdfFallback";
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
  textParserFor,
  workbookFromMarkdown,
} from "./tools/documentOps";
import { quoteRepairSuggestion } from "./quoteRepair";
import { docxCautionNotes, docxPathologyReportFor } from "./tools/docxPathologyNotes";
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
import { hideLegalSourceUrls } from "./legalToolResultVisibility";
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
const grepSectionSpineCache = new Map<string, number[]>();
const codingTocCache = new Map<string, string>();
const STRUCTURE_CACHE_LIMIT = 32;

function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > STRUCTURE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

async function grepSectionSpine(
  documents: DocumentStore,
  scope: DocumentScope,
  meta: { id: string; current_version_id: string; file_type: string },
  servedText: string,
): Promise<number[]> {
  if (meta.file_type.toLowerCase() !== "docx") return [];
  const key = `${meta.current_version_id}:${servedText.length}`;
  const cached = grepSectionSpineCache.get(key);
  if (cached) return remember(grepSectionSpineCache, key, cached);
  let leads: number[] = [];
  try {
    const file = await documents.read(
      scope, meta.id, meta.current_version_id, false,
    );
    if (file) {
      const nodes = await deriveSectionNodes(file.bytes);
      leads = anchoredSectionStarts(nodes, servedText);
    }
  } catch {
    // Soft degradation: no annotation for this document.
  }
  return remember(grepSectionSpineCache, key, leads);
}

/**
 * Rendered .toc content for one document on the served plane, memoized
 * per version. Same two-plane resolver as grepSectionSpine (docx
 * detector nodes anchored into served markdown); non-docx and anchorless
 * documents return "" and contribute no .toc file.
 */
async function codingTocText(
  documents: DocumentStore,
  scope: DocumentScope,
  meta: { id: string; current_version_id: string; file_type: string; filename: string },
  servedText: string,
): Promise<string> {
  if (meta.file_type.toLowerCase() !== "docx") return "";
  const key = `${meta.current_version_id}:${servedText.length}`;
  const cached = codingTocCache.get(key);
  if (cached !== undefined) return remember(codingTocCache, key, cached);
  let rendered = "";
  try {
    const file = await documents.read(
      scope, meta.id, meta.current_version_id, false,
    );
    if (file) {
      const nodes = await deriveSectionNodes(file.bytes);
      const spine = anchoredSectionSpine(nodes, servedText);
      if (spine.length) {
        // grep -n convention: "LINE:verbatim line text" — the exact output
        // a coding agent gets from grepping section leads itself, verbatim
        // document text (quotable; Read offset=<line> limit=1 returns the
        // same line). No reconstructed labels.
        const bodyLines = servedText.split("\n");
        const lineOf = (offset: number) =>
          servedText.slice(0, offset).split("\n").length;
        const rows = spine.map((entry) => {
          const line = lineOf(entry.offset);
          return `${line}:${(bodyLines[line - 1] ?? "").slice(0, 150)}`;
        });
        rendered =
          `# ${meta.filename} — ${spine.length} section leads ` +
          `(${servedText.length} chars, ${bodyLines.length} lines; ` +
          `Read offset=<line> to open a section)\n` +
          rows.join("\n");
      }
    }
  } catch {
    // Soft degradation: no .toc for this document.
  }
  return remember(codingTocCache, key, rendered);
}

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

const CODING_DOCUMENT_REFERENCE_FIELDS = new Set([
  "document_id",
  "source_document_id",
  "amendment_document_id",
  "english_document_id",
  "french_document_id",
]);
const CODING_DOCUMENT_REFERENCE_ARRAY_FIELDS = new Set([
  "document_ids",
  "doc_ids",
  "source_document_ids",
  "draft_document_ids",
]);

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

async function referencedDocuments(
  scope: DocumentScope,
  references: Iterable<string>,
  library: LibraryStore,
  projects: ProjectStore,
  allowedDocumentIds?: ReadonlySet<string>,
  matterId?: string | null,
) {
  if (allowedDocumentIds) {
    return scopedDocuments(scope, library, projects, allowedDocumentIds);
  }
  const found = new Map<string, AssistantDocument>();
  for (const reference of new Set(references)) {
    const matches = matterId
      ? documentsFromPage((await projects.directory(
          scope, matterId,
          { q: reference, parentFolderId: null, limit: 3, after: null },
        )).items)
      : documentsFromPage((await library.page(
          { ...scope, kind: "file" },
          {
            q: reference,
            parentFolderId: null,
            limit: 3,
            after: null,
            documentsOnly: true,
          },
        )).items as Record<string, unknown>[]);
    const exact = assistantDocument(
      await library.document({ ...scope, kind: "file" }, reference),
    );
    if (exact && (!matterId || matches.some(({ id }) => id === exact.id))) {
      found.set(exact.id, exact);
    }
    for (const document of matches) {
      if (document.filename.toLocaleLowerCase() === reference.toLocaleLowerCase()) {
        found.set(document.id, document);
      }
    }
  }
  return [...found.values()];
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

async function resolveCodingDocumentReferences(
  scope: DocumentScope,
  input: Record<string, unknown>,
  library: LibraryStore,
  projects: ProjectStore,
  allowedDocumentIds?: ReadonlySet<string>,
  matterId?: string | null,
): Promise<{ input: Record<string, unknown>; error?: string }> {
  const fields = Object.keys(input).filter(
    (field) =>
      CODING_DOCUMENT_REFERENCE_FIELDS.has(field) ||
      CODING_DOCUMENT_REFERENCE_ARRAY_FIELDS.has(field),
  );
  if (!fields.length) return { input };

  const references = fields.flatMap((field) =>
    Array.isArray(input[field])
      ? stringArray(input[field])
      : [trimmed(input[field])].filter(Boolean));
  const documents = await referencedDocuments(
    scope, references, library, projects, allowedDocumentIds, matterId,
  );
  const byFilename = new Map<string, typeof documents>();
  for (const document of documents) {
    const key = document.filename.toLocaleLowerCase();
    byFilename.set(key, [...(byFilename.get(key) ?? []), document]);
  }
  const resolve = (reference: string): { value: string; error?: string } => {
    if (documents.some((document) => document.id === reference)) {
      return { value: reference };
    }
    const matches = byFilename.get(reference.toLocaleLowerCase()) ?? [];
    if (matches.length === 1) return { value: matches[0].id };
    if (matches.length > 1) {
      return {
        value: reference,
        error: `Filename '${reference}' is ambiguous. Use Glob to obtain its document_id.`,
      };
    }
    return { value: reference };
  };

  const resolved = { ...input };
  for (const field of fields) {
    if (CODING_DOCUMENT_REFERENCE_FIELDS.has(field)) {
      const reference = trimmed(input[field]);
      if (!reference) continue;
      const next = resolve(reference);
      if (next.error) return { input, error: next.error };
      resolved[field] = next.value;
      continue;
    }
    if (!Array.isArray(input[field])) continue;
    const values: string[] = [];
    for (const raw of input[field]) {
      if (typeof raw !== "string") continue;
      const next = resolve(raw);
      if (next.error) return { input, error: next.error };
      values.push(next.value);
    }
    resolved[field] = values;
  }
  return { input: resolved };
}

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number"
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
// Coding models commonly serialize an omitted optional number as 0. For
// one-based Read arguments, 0 means "not supplied", not line 1 or a
// one-line window. Positive values retain the ordinary clamped semantics.
const positiveInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && value > 0
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export type AssistantEditTurnState = Map<
  string,
  { versionId: string; parentVersionId: string }
>;

export type AssistantReadTurnState = Map<
  string,
  {
    documentId: string;
    docLabel?: string;
    versionId: string;
    filename: string;
    projection: "canonical" | "drafting" | "redline";
    sourceChars?: number;
    deliveredChars?: number;
    // Body start of the served plane (the SECT-INDEX length when one is
    // attached, else 0) and the union of delivered [start,end) intervals in
    // served coordinates. "Fully read" is interval coverage of the body span,
    // never a char-count sum — overlapping windows must not fake completeness.
    bodyStart?: number;
    intervals?: Array<[number, number]>;
  }
> & { servedDraftingCache?: Map<string, ServedDrafting> };

export function mergeIntervals(
  intervals: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = intervals
    .map(([start, end]): [number, number] =>
      start <= end ? [start, end] : [end, start],
    )
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function coveredLength(
  intervals: Array<[number, number]>,
  start: number,
  end: number,
): number {
  return mergeIntervals(intervals).reduce(
    (total, [s, e]) =>
      total + Math.max(0, Math.min(e, end) - Math.max(s, start)),
    0,
  );
}

export function readCoversBody(read: {
  sourceChars?: number;
  deliveredChars?: number;
  bodyStart?: number;
  intervals?: Array<[number, number]>;
}): boolean {
  const sourceChars = read.sourceChars ?? 0;
  if (sourceChars <= 0) return false;
  if (read.intervals) {
    const bodyStart = read.bodyStart ?? 0;
    return (
      coveredLength(read.intervals, bodyStart, sourceChars) >=
      sourceChars - bodyStart
    );
  }
  return (read.deliveredChars ?? 0) >= sourceChars;
}

/**
 * Chars of BODY content (past the SECT-INDEX) delivered for one read-state
 * entry. An index-only orientation read records a zero-length segment, so it
 * scores 0 here while still counting as a touch. Entries from paths that
 * never window (no intervals recorded) fall back to deliveredChars: any
 * delivery there included body content.
 */
export function bodyExposedChars(read: {
  sourceChars?: number;
  deliveredChars?: number;
  bodyStart?: number;
  intervals?: Array<[number, number]>;
}): number {
  const sourceChars = read.sourceChars ?? 0;
  if (sourceChars <= 0) return 0;
  const bodyStart = read.bodyStart ?? 0;
  if (read.intervals)
    return coveredLength(read.intervals, bodyStart, sourceChars);
  return Math.min(
    read.deliveredChars ?? 0,
    Math.max(0, sourceChars - bodyStart),
  );
}

/**
 * Exposure-accounting split of the allowed documents: `read` = some body
 * content was served this turn; `orientedOnly` = touched (SECT-INDEX or a
 * zero-body window) but no body chars served; `unread` = never touched.
 * find_in_document hits are deliberately NOT exposure — excerpts are
 * candidates for scoped reads, and counting them as coverage would recreate
 * the false assurance this split exists to remove.
 */
export function splitReadExposure(
  allowed: Array<{ id: string; filename: string }>,
  turnReadState: AssistantReadTurnState,
): { read: string[]; orientedOnly: string[]; unread: string[] } {
  const touchedIds = new Set<string>();
  const exposedIds = new Set<string>();
  for (const entry of turnReadState.values()) {
    touchedIds.add(entry.documentId);
    if (bodyExposedChars(entry) > 0) exposedIds.add(entry.documentId);
  }
  return {
    read: allowed
      .filter((document) => exposedIds.has(document.id))
      .map((document) => document.filename),
    orientedOnly: allowed
      .filter(
        (document) =>
          !exposedIds.has(document.id) && touchedIds.has(document.id),
      )
      .map((document) => document.filename),
    unread: allowed
      .filter((document) => !touchedIds.has(document.id))
      .map((document) => document.filename),
  };
}

type WorkingSetEvidenceSegment = {
  virtualStart: number;
  virtualEnd: number;
  documentId: string;
  versionId: string;
  sourceStart: number;
  sourceEnd: number;
  filename?: string;
  locator?: string;
  locatorKind?: "paragraph" | "page" | "section" | "footnote";
  virtualPath?: string;
  projection?: string;
};

type WorkingSetEvidenceRef = {
  virtualStart: number;
  virtualEnd: number;
  handle: string;
  filename: string;
  locator?: string;
  exactSha256: string;
};

export type AssistantWorkingSetTurnState = Map<
  string,
  {
    path: string;
    text: string;
    sourceChars: number;
    segments: WorkingSetEvidenceSegment[];
    refs?: WorkingSetEvidenceRef[];
  }
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
  turnReadState?: AssistantReadTurnState;
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
  const saved = await params.documents.read(
    params.scope,
    params.documentId,
    version.id,
    false,
  );
  if (!saved) return fail(params.call, "Saved DOCX version not found.");
  const sourceClosure = await sourceClosureForDraft(
    params.documents,
    params.scope,
    await extractDocxBodyText(saved.bytes),
    params.turnReadState,
  );
  const lint = await lintDocxStructure(saved.bytes).catch(() => null);
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
    ...(sourceClosure.length ? { source_closure: sourceClosure } : {}),
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

function workingSetEvidenceSegments(
  set: AssistantWorkingSetTurnState extends Map<string, infer Value>
    ? Value
    : never,
  ranges: readonly [number, number][],
) {
  const evidence: NonNullable<NormalizedToolResult["evidenceSegments"]> = [];
  for (const [start, end] of ranges) {
    for (const segment of set.segments) {
      const overlapStart = Math.max(start, segment.virtualStart);
      const overlapEnd = Math.min(end, segment.virtualEnd);
      if (overlapStart >= overlapEnd) continue;
      evidence.push({
        documentId: segment.documentId,
        versionId: segment.versionId,
        start: segment.sourceStart + overlapStart - segment.virtualStart,
        end: segment.sourceStart + overlapEnd - segment.virtualStart,
        ...(segment.filename && { filename: segment.filename }),
        ...(segment.locator && { locator: segment.locator }),
        ...(segment.locatorKind && { locatorKind: segment.locatorKind }),
        ...(segment.virtualPath && { virtualPath: segment.virtualPath }),
        ...(segment.projection && { projection: segment.projection }),
        kind: "evidence",
      });
    }
  }
  return evidence;
}

function workingSetEvidenceRefs(
  set: AssistantWorkingSetTurnState extends Map<string, infer Value>
    ? Value
    : never,
  ranges: readonly [number, number][],
) {
  const evidence: NonNullable<NormalizedToolResult["evidenceRefs"]> = [];
  for (const [start, end] of ranges) {
    for (const ref of set.refs ?? []) {
      const overlapStart = Math.max(start, ref.virtualStart);
      const overlapEnd = Math.min(end, ref.virtualEnd);
      if (overlapStart >= overlapEnd) continue;
      const text = set.text.slice(overlapStart, overlapEnd);
      const localStart = overlapStart - ref.virtualStart;
      const localEnd = overlapEnd - ref.virtualStart;
      evidence.push({
        handle: `${ref.handle}#chars=${localStart}-${localEnd}`,
        text,
        filename: ref.filename,
        locator:
          localStart === 0 && localEnd === ref.virtualEnd - ref.virtualStart
            ? ref.locator
            : `${ref.locator ?? ref.handle} chars ${localStart}-${localEnd}`,
        exactSha256: sha256(text),
        kind: "evidence",
      });
    }
  }
  return evidence;
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
    a2ajDocuments?: A2AJDocument[];
    a2ajLookups?: A2AJLocatorLookup[];
    courtlistener?: CourtlistenerToolState;
    evidence?: LegalEvidenceTurnState;
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
    const capturedPublic = new Set<string>();
    const capturedCourt = new Set<string>();
    for (const item of registered) {
      if (item.document) {
        if (!options.a2ajDocuments?.some(
          (candidate) => candidate.citation === item.document!.citation &&
            candidate.dataset === item.document!.dataset &&
            candidate.language === item.document!.language,
        )) options.a2ajDocuments?.push(item.document);
      }
      if (item.lookup) options.a2ajLookups?.push(item.lookup);
      const native = objectRecord(item.passage.native);
      const nativeDocument = objectRecord(native?.document);
      if (
        nativeDocument &&
        ["tna", "govuk-et", "govinfo"].includes(item.passage.source.provider)
      ) {
        const document = nativeDocument as PublicLegalDocument;
        const key = `${document.provider}:${document.identity}`;
        if (!capturedPublic.has(key)) {
          capturedPublic.add(key);
          fallbacks.push(...await publicLegalPdfFallbacks(document, options.userId));
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
      if (options.evidence && item.receipt) {
        registerLegalEvidence(options.evidence, item.receipt, {
          document: item.document,
          lookup: item.lookup,
        });
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
            options.a2ajLookups?.push(item.lookup);
            if (options.evidence) {
              registerLegalEvidence(options.evidence, item.receipt, {
                lookup: item.lookup,
              });
            }
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
  workingSets?: AssistantWorkingSetTurnState,
  servedDraftingCache?: Map<string, ServedDrafting>,
  turnReadState?: AssistantReadTurnState,
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
  const resolveWorkingSet = (raw: string) => {
    const wanted = raw.replace(/\\/gu, "/").trim().toLowerCase();
    return [...(workingSets?.values() ?? [])].find(
      (set) => set.path.toLowerCase() === wanted,
    );
  };
  // Markdown plane: when the arm serves docx as pandoc markdown
  // (MIKE_READ_DOCX_MARKDOWN), Glob/Read/Grep list, search, and read the
  // SAME text the mike read path would serve, so every file:line
  // coordinate agrees arm-wide. The slice starts past any attached
  // SECT-INDEX (bodyOffset is 0 when none is attached) so hits never land
  // in a prosthetic prefix. Non-docx files and extraction failures keep
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
          text: drafting.served.slice(drafting.bodyOffset),
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
  const recordCodingExposure = (
    meta: (typeof files)[number],
    versionId: string,
    projection: "canonical" | "drafting" | "redline",
    sourceChars: number,
    spans: Array<[number, number]>,
  ) => {
    if (!turnReadState) return;
    const stateKey = `${projection}:${meta.id}:${versionId}`;
    const prior = turnReadState.get(stateKey);
    const intervals = mergeIntervals([...(prior?.intervals ?? []), ...spans]);
    turnReadState.set(stateKey, {
      documentId: meta.id,
      docLabel: codingPath(meta, versionId),
      versionId,
      filename: meta.filename,
      projection,
      sourceChars,
      deliveredChars: intervals.reduce(
        (total, [start, end]) => total + (end - start),
        0,
      ),
      bodyStart: 0,
      intervals,
    });
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
    const workingSetRows = [...(workingSets?.values() ?? [])]
      .filter((set) => re.test(set.path))
      .map((set) => ({
        row: `${set.path}\tchars=${set.text.length}\tlines=${
          set.text ? set.text.split(/\r?\n/u).length : 0
        }`,
        chars: set.text.length,
        lines: set.text ? set.text.split(/\r?\n/u).length : 0,
      }));
    // Companion .toc index files (v4): one row per docx whose section
    // spine anchored; the pattern matches against "<filename>.toc" so
    // "*.toc" lists only indexes. Sizes are the rendered toc itself —
    // orientation priced in-band, like everything else Glob reports.
    const tocRows = (
          await Promise.all(
            files
              .filter((meta) => re.test(`${meta.filename}.toc`))
              .map(async (meta) => {
                const document = await codingDocument(meta.id);
                if (!document) return null;
                const toc = await codingTocText(
                  documents, scope, meta, document.text,
                );
                if (!toc) return null;
                return {
                  row: `${meta.filename}.toc\tchars=${toc.length}\tlines=${toc.split("\n").length}`,
                  chars: toc.length,
                  lines: toc.split("\n").length,
                };
              }),
          )
        ).filter((row): row is NonNullable<typeof row> => row !== null);
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
      ...tocRows,
      ...workingSetRows,
      ...workflowRows,
    ];
    if (!rows.length) return result(call, "No files found");
    const totalChars = rows.reduce((total, row) => total + row.chars, 0);
    const totalLines = rows.reduce((total, row) => total + row.lines, 0);
    return result(
      call,
      [
        ...rows.map((row) => row.row),
        `TOTAL\tfiles=${rows.length}\tchars=${totalChars}\tlines=${totalLines}` +
          (0
            ? `\twhole_read_budget_chars=${0}`
            : ""),
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
          const receipt = await readLocalPdfEvidenceReceipt(handle);
          if (
            receipt.source.document_id !== meta.id ||
            receipt.source.version_id !== file.version.id
          ) {
            return fail(call, "PDF evidence does not belong to this resource.");
          }
          const artifactSession = localPdfEvidenceHandles
            ? localPdfArtifactSessionForTurn(localPdfEvidenceHandles, sourcePath)
            : undefined;
          const lookup = await rehydrateLocalPdfEvidence(
            sourcePath,
            handle,
            artifactSession,
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
        await parseLocalPdfOnDemand({
          documentId: meta.id,
          versionId: file.version.id,
          sourcePath,
          sourceSha256: file.version.source_sha256 ?? undefined,
        });
        const artifactSession = localPdfEvidenceHandles
          ? localPdfArtifactSessionForTurn(localPdfEvidenceHandles, sourcePath)
          : undefined;
        const lookup = await lookupLocalPdfStructure(
          sourcePath,
          pdfLocatorParams(args),
          { artifactSession },
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
    // Companion .toc read (v4): serve the rendered index cat-n style.
    // Derived metadata, not document text — no evidence segments, no
    // body-exposure accounting; the body plane's line numbers stay pure.
    if (/\.toc$/iu.test(requested)) {
      const base = requested.replace(/\.toc$/iu, "");
      const candidates = resolvePath(base);
      if (candidates.length !== 1) {
        return fail(
          call,
          candidates.length
            ? disambiguationHint(requested, "file_path")
            : `No .toc for '${base}' — Glob lists the available index files.`,
        );
      }
      const meta = candidates[0];
      const document = await codingDocument(meta.id, referencedVersion(base));
      const toc = document
        ? await codingTocText(documents, scope, meta, document.text)
        : "";
      if (!toc) {
        return fail(
          call,
          `No .toc for '${base}' — this document has no anchorable section spine; read the document directly.`,
        );
      }
      {
        if (document) {
          recordCodingExposure(
            meta,
            document.versionId || meta.current_version_id,
            document.projection,
            document.text.length,
            [],
          );
        }
      }
      const rendered = toc
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(6)}\t${line}`)
        .join("\n");
      return result(call, rendered);
    }
    const workingSet = resolveWorkingSet(requested);
    if (workingSet) {
      if (
        trimmed(args.section) ||
        trimmed(args.pages) ||
        (args.references && args.references !== "none")
      ) {
        return result(
          call,
          "Structure projections accept only file_path, offset, and limit.",
        );
      }
      const lines = workingSet.text.split(/\r?\n/u);
      const starts = sourceLineStarts(workingSet.text, lines);
      const offset = positiveInt(args.offset, 1, 100_000_000, 1);
      const limit = positiveInt(args.limit, 1, 2_000, 2_000);
      const firstLine = lines[offset - 1];
      const startChar = 0;
      if (firstLine === undefined) {
        return result(
          call,
          offset > lines.length
            ? `(offset ${offset} is past the end of the working set; total lines: ${lines.length})`
            : "(empty working set)",
        );
      }
      if (startChar > firstLine.length) {
        return result(
          call,
          `(start_char ${startChar} is past the end of working-set line ${offset}; line chars: ${firstLine.length})`,
        );
      }
      const bodyBudget = Math.max(
        1_000,
        MAX_TOOL_RESULT_CHARS - 1_000,
      );
      const candidates: CodingOutputLine[] = [];
      let used = 0;
      let sameLineContinuation:
        | { line: number; nextChar: number; totalChars: number }
        | undefined;
      for (
        let index = 0;
        index < limit && offset - 1 + index < lines.length;
        index += 1
      ) {
        const lineIndex = offset - 1 + index;
        const line = lines[lineIndex];
        const localStart = index === 0 ? startChar : 0;
        const prefix = `${String(lineIndex + 1).padStart(6, " ")}\t`;
        const available =
          bodyBudget - used - prefix.length - (candidates.length ? 1 : 0);
        if (available <= 0) break;
        const shown = line.slice(localStart, localStart + available);
        candidates.push({
          rendered: `${prefix}${shown}`,
          span: [
            starts[lineIndex] + localStart,
            starts[lineIndex] + localStart + shown.length,
          ],
        });
        used += prefix.length + shown.length + (candidates.length > 1 ? 1 : 0);
        if (localStart + shown.length < line.length) {
          sameLineContinuation = {
            line: lineIndex + 1,
            nextChar: localStart + shown.length,
            totalChars: line.length,
          };
          break;
        }
      }
      const rendered = candidates.map((line) => line.rendered).join("\n");
      const lastShown = offset - 1 + candidates.length;
      const continuation = sameLineContinuation
        ? `[TRUNCATED: structure-projection line ${sameLineContinuation.line} exceeds the tool-result limit; narrow the projection with Grep.]`
        : lastShown < lines.length
          ? `[TRUNCATED: returned lines ${offset}-${lastShown} of ${lines.length}; continue with Read(file_path=${JSON.stringify(workingSet.path)}, offset=${lastShown + 1}).]`
          : "";
      const content = continuation
        ? `${rendered}\n\n${continuation}`
        : rendered;
      const exposedRanges = candidates.flatMap((line) =>
        line.span ? [line.span] : [],
      );
      return {
        ...withMetadata(result(call, content), {
          evidenceSegments: workingSetEvidenceSegments(workingSet, exposedRanges),
          evidenceRefs: workingSetEvidenceRefs(workingSet, exposedRanges),
        }),
      };
    }
    if (
      requested.replace(/\\/gu, "/").toLowerCase().startsWith(
        ".mike/structure/",
      )
    ) {
      return result(call, {
        ok: false,
        status: "not_found",
        error:
          "Structure path not found in this turn. Copy an exact .mike/structure/... path returned by Grep; never invent or alter one.",
      });
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
    // Exposure accounting (echo plane): every successful Read records its
    // served spans into turnReadState — the state splitReadExposure consults
    // at the Write coverage gate. Without this the coding family
    // served body text while the gate saw an empty map, so the echo refused
    // every first draft with an all-documents "never opened" list regardless
    // of what had actually been read. Grep hits stay non-exposure by
    // doctrine; .toc reads stay derived-metadata-only. The coding plane is
    // served body-only (no SECT-INDEX prefix), so bodyStart is 0 and spans
    // are body coordinates already.
    const recordReadExposure = (kept: CodingOutputLine[]) => {
      const spans = kept.flatMap((line) => (line.span ? [line.span] : []));
      if (!spans.length) return;
      recordCodingExposure(
        meta,
        document.versionId || meta.current_version_id,
        document.projection,
        document.text.length,
        spans,
      );
    };
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
          },
        ),
      );
      const { kept, truncated } = takeCodingOutputLines(candidates);
      recordReadExposure(kept);
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
        recordReadExposure(kept);
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
      // Some tool-call providers populate every optional numeric field with its
      // minimum. Preserve absolute line semantics for real windows, while
      // treating that synthetic `1` like an omitted section offset.
      const sectionOffset = offset === 1 && startLine > 1 ? startLine : offset;
      // The same providers also materialize both optional numeric fields at
      // their schema minima. In section mode `{ offset: 1, limit: 1 }` is the
      // provider rendering of a section-only recipe, not a request to return
      // only its heading line. A deliberate one-line section read can use the
      // section's absolute line number instead.
      const sectionLimit =
        Number(args.offset) === 1 && Number(args.limit) === 1 ? 2_000 : limit;
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
            },
          };
        });
      const { kept, truncated } = takeCodingOutputLines(candidates);
      const lastShown = sectionOffset + kept.length - 1;
      const more =
        lastShown < endLine
          ? `\n\n[TRUNCATED: returned section lines ${sectionOffset}-${lastShown} of ${startLine}-${endLine}; continue with Read(file_path="${requested}", section="${block.label}", offset=${lastShown + 1}).${truncated ? " Tool-result limit reached." : ""}]`
          : "";
      recordReadExposure(kept);
      return codingTextResult(
        call,
        kept.map((line) => line.rendered).join("\n") + more,
        kept,
      );
    }
    const offset = positiveInt(args.offset, 1, 100_000_000, 1);
    // CC parity: some tool-call providers materialize every optional
    // numeric field at its schema minimum, so {offset:1, limit:1} is the
    // provider rendering of a plain read, not a request for line 1 alone
    // (same rule as the section-mode guard above). A deliberate one-line
    // read of line 1 can pass limit:1 without offset.
    const effectiveLimit =
      Number(args.offset) === 1 &&
      Number(args.limit) === 1
        ? 2_000
        : limit;
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
    recordReadExposure(kept);
    return codingTextResult(
      call,
      kept.map((line) => line.rendered).join("\n") + more,
      kept,
    );
  }

  if (call.name === "Edit" || call.name === "edit_docx_advanced") {
    const requested = trimmed(args.file_path);
    if (resolveWorkingSet(requested)) {
      return result(
        call,
        "The evidence file is append-only. Edit the original file using the Read recipe in the source boundary.",
      );
    }
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
        turnReadState,
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
        turnReadState,
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
      turnReadState,
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
  const virtualTarget = pathArg ? resolveWorkingSet(pathArg) : undefined;
  if (virtualTarget) {
    if (
      trimmed(args.section) ||
      trimmed(args.pages) ||
      (args.references && args.references !== "none")
    ) {
      return fail(call, "Structure-projection Grep does not accept legal scopes.");
    }
    const lines = virtualTarget.text.split(/\r?\n/u);
    const starts = sourceLineStarts(virtualTarget.text, lines);
    const matched = lines.flatMap((line, index) => {
      const column = line.search(re);
      return column >= 0 ? [{ line: index, column }] : [];
    });
    if (!matched.length) return result(call, "No matches found");
    if (args.output_mode === "count") {
      return result(call, `${virtualTarget.path}:${matched.length}`);
    }
    if (args.output_mode !== "content") return result(call, virtualTarget.path);
    const headLimit = positiveInt(args.head_limit, 1, 2_000, 250);
    const lineCap = GREP_LINE_CAP;
    const context = clampInt(args["-C"], 0, 10, 0);
    // CC parity: -A (after) and -B (before) are honored per side; -C stays
    // the symmetric fallback. Frozen arms keep -C-only semantics.
    const contextBefore = clampInt(args["-B"], 0, 10, context);
    const contextAfter = clampInt(args["-A"], 0, 10, context);
    const rows: CodingOutputLine[] = [];
    const emitted = new Set<number>();
    for (const match of matched) {
      const at = match.line;
      for (
        let index = Math.max(0, at - contextBefore);
        index <= Math.min(lines.length - 1, at + contextAfter) && rows.length < headLimit;
        index += 1
      ) {
        if (emitted.has(index)) continue;
        emitted.add(index);
        const isMatch = index === at;
        const separator = isMatch ? ":" : "-";
        const sliceStart =
          isMatch && lines[index].length > lineCap
            ? Math.min(
                Math.max(0, match.column - Math.floor(lineCap / 2)),
                lines[index].length - lineCap,
              )
            : 0;
        const shown = lines[index].slice(
          sliceStart,
          sliceStart + lineCap,
        );
        rows.push({
          rendered: `${virtualTarget.path}${separator}${index + 1}${separator}${shown}`,
          span: [
            starts[index] + sliceStart,
            starts[index] + sliceStart + shown.length,
          ],
        });
      }
    }
    const { kept, truncated } = takeCodingOutputLines(rows);
    const body = kept.map((line) => line.rendered).join("\n");
    const content =
      truncated || rows.length >= headLimit
        ? `${body}\n(Results truncated; narrow the pattern.)`
        : body;
    const exposedRanges = kept.flatMap((line) =>
      line.span ? [line.span] : [],
    );
    return {
      ...withMetadata(result(call, content), {
        evidenceSegments: workingSetEvidenceSegments(
          virtualTarget,
          exposedRanges,
        ),
        evidenceRefs: workingSetEvidenceRefs(virtualTarget, exposedRanges),
      }),
    };
  }
  if (
    pathArg.replace(/\\/gu, "/").toLowerCase().startsWith(
      ".mike/structure/",
    )
  ) {
    return result(call, {
      ok: false,
      status: "not_found",
      error:
        "Structure path not found in this turn. Copy an exact .mike/structure/... path returned by Grep; never invent or alter one.",
    });
  }
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
  const grepPages = trimmed(args.pages);
  const grepReferences =
    args.references === "inbound" ||
    args.references === "outbound" ||
    args.references === "both"
      ? args.references
      : "none";
  if ((grepSection || grepPages || grepReferences !== "none") && !pathArg) {
    return fail(call, "Legal Grep scopes require one exact path.");
  }
  if (grepSection && grepPages) {
    return fail(call, "section and pages are alternative exact scopes; choose one.");
  }
  if (grepReferences !== "none" && !grepSection) {
    return fail(call, "references requires an exact section handle.");
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
  const grepSourceChars = new Map<string, number>();
  const grepSources = new Map<
    string,
    { versionId: string; projection: "canonical" | "drafting" | "redline" }
  >();
  // Per-file content buckets; only populated when the per-file budget is on.
  // files_with_matches/count emit one row per document and are fair already.
  const fileBuckets: CodingOutputLine[][] = [];
  const hardReferenceHints: Array<{
    kind: "literal_reference";
    label: string;
    path: string;
    offset: number;
    limit: number;
    rendered: string;
  }> = [];
  let truncated = false;
  for (const meta of targets) {
    const document = await codingDocument(meta.id, targetVersionId);
    if (!document) continue;
    const resource = codingPath(meta, document.versionId);
    grepSourceChars.set(meta.id, document.text.length);
    grepSources.set(meta.id, {
      versionId: document.versionId || meta.current_version_id,
      projection: document.projection,
    });
    const lines = document.text.split(/\r?\n/u);
    const starts = sourceLineStarts(document.text, lines);
    let scopeSpans: TextRange[] | null = null;
    let scopedSkeleton: AgreementSkeleton | null = null;
    let mapSkeleton: AgreementSkeleton | null = null;
    if (grepSection) {
      scopedSkeleton =
        mapSkeleton ??
        (await documentStructure(document.text, meta.id, {
          tableCells: document.tableCells,
        }));
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
      if (grepReferences === "none") {
        scopeSpans = [{ start: lookup.block.start, end: lookup.block.end }];
      } else {
        const graph = await documentGraph(
          document.text,
          meta.id,
          { tableCells: document.tableCells },
        );
        const scope = oneHopLegalScope(
          scopedSkeleton,
          graph,
          lookup.block.label,
          grepReferences,
        );
        scopeSpans =
          scope?.nodes.map((node) => ({ start: node.start, end: node.end })) ?? [];
      }
    } else if (grepPages) {
      const selected = selectPages(document.pages, document.text, grepPages);
      if (selected.status !== "ok") {
        return fail(
          call,
          selected.status === "empty"
            ? "pages is required"
            : `Page '${selected.token}' could not be resolved (${selected.lookup.status}).`,
        );
      }
      scopeSpans = selected.pages.map((page) => ({
        start: page.start,
        end: page.end,
      }));
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
        mapSkeleton ??
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
    // Section-context rows (coding_markdown_v3): anchored section leads,
    // computed once per hit-document; per hit, the enclosing lead is the
    // last start at or below the hit's offset.
    const sectionLeads = await grepSectionSpine(
      documents, scope, meta, document.text,
    );
    const emittedSectionRows = new Set<number>();
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
      if (sectionLeads.length) {
        const hitOffset = starts[at];
        let lo = 0;
        let hi = sectionLeads.length - 1;
        let lead = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (sectionLeads[mid] <= hitOffset) {
            lead = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (lead >= 0) {
          let leadLine = 0;
          lo = 0;
          hi = lines.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= sectionLeads[lead]) {
              leadLine = mid;
              lo = mid + 1;
            } else {
              hi = mid - 1;
            }
          }
          // The lead renders as an rg context row at its true line number —
          // document text, quotable, Read-able at that coordinate. Skip it
          // when this hit's own context window is about to print that line,
          // or when it was already emitted for this document.
          if (
            leadLine < Math.max(from, lastPrinted + 1) &&
            !emittedSectionRows.has(leadLine)
          ) {
            emittedSectionRows.add(leadLine);
            const leadText = (lines[leadLine] ?? "").slice(0, GREP_LINE_CAP);
            sink.push({
              rendered: numberLines
                ? `${resource}-${leadLine + 1}-${leadText}`
                : `${resource}-${leadText}`,
              span: [
                starts[leadLine],
                starts[leadLine] + leadText.length,
              ],
              source: {
                documentId: meta.id,
                versionId: document.versionId || meta.current_version_id,
                filename: meta.filename,
              },
            });
          }
        }
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
  if (mode === "content") {
    const spansByDocument = new Map<string, Array<[number, number]>>();
    for (const line of kept) {
      if (!line.source || !line.span) continue;
      const spans = spansByDocument.get(line.source.documentId) ?? [];
      spans.push(line.span);
      spansByDocument.set(line.source.documentId, spans);
    }
    for (const [documentId, spans] of spansByDocument) {
      const meta = files.find((file) => file.id === documentId);
      const source = grepSources.get(documentId);
      if (!meta || !source) continue;
      recordCodingExposure(
        meta,
        source.versionId,
        source.projection,
        grepSourceChars.get(documentId) ?? 0,
        spans,
      );
    }
  }
  const body = [
    kept.map((line) => line.rendered).join("\n"),
    ...hardReferenceHints.map((hint) => hint.rendered),
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
  const visibleHints = hardReferenceHints.filter((hint) =>
    toolResultText(output.result).includes(hint.rendered),
  );
  return visibleHints.length
    ? withMetadata(output, {
        retrievalHints: visibleHints.map(({ rendered: _, ...hint }) =>
          hint,
        ),
      })
    : output;
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

const textCache = new Map<
  string,
  {
    text: string;
    cautions: string[];
    pages: PageMap;
    tableCells: TableCellSpan[];
  }
>();

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
  const cacheKey =
    `${documentId}:${file.version.id}:` +
    (file.version.source_sha256 ?? file.version.created_at);
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) {
    return {
      filename: file.filename,
      documentId,
      versionId: file.version.id,
      ...cached,
    };
  }

  const fileType = file.fileType.toLowerCase();
  const parser = textParserFor(fileType);
  const parsed =
    fileType === "pdf" && file.localPath
      ? await readLocalPdfSourceDoc(file.localPath).catch(() => null)
      : null;
  const sourceBytes = async () => file.bytes;
  const docxStructure =
    fileType === "docx"
      ? await extractDocxBodyStructure(await sourceBytes())
      : null;
  const spreadsheetStructure = isSpreadsheetDocumentType(fileType)
    ? await spreadsheetToLLMStructure(await sourceBytes())
    : null;
  const text: string =
    parsed?.text ??
    docxStructure?.text ??
    spreadsheetStructure?.text ??
    (parser
      ? await sourceBytes().then((value) =>
          cachedParse({
            scope: `user:${scope.userId}`,
            parser: parser.parser,
            version: parser.version,
            bytes: value,
            parse: () => parser.run(value),
          }),
        )
      : "");
  // Additive metadata only: the sniffer's cautions ride alongside the text,
  // which stays byte-identical to what this function has always returned.
  const cautions =
    fileType === "docx"
      ? docxCautionNotes(
          await docxPathologyReportFor({
            fileType,
            scope: `user:${scope.userId}`,
            bytes: await sourceBytes(),
          }),
        )
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
  const tableCells: TableCellSpan[] =
    docxStructure?.tableCells ?? spreadsheetStructure?.tableCells ?? [];

  if (textCache.size >= 16) {
    textCache.delete(textCache.keys().next().value!);
  }
  textCache.set(cacheKey, { text, cautions, pages, tableCells });
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
export const MAX_TOOL_RESULT_CHARS = Number(
  process.env.MIKE_TOOL_RESULT_CAP || 64_000,
);

/**
 * A cap the model cannot act on is just a hole in the answer, so say what was
 * dropped and name the calls that fetch it back. Beaver can be more specific
 * than a byte offset: it has addressable section handles.
 */
function continuationHint(call: NormalizedToolCall): string {
  if (/^(?:a2aj|caselaw|courtlistener|hansard|legal_pdf|public_legal_source)_/u.test(call.name)) {
    return `Retry ${call.name} with a narrower query, exact source identifier, or locator; reuse identifiers visible in the preview.`;
  }
  if (call.name.startsWith("library_")) {
    return `Retry ${call.name} with a smaller input batch or a more specific identifier.`;
  }
  return `Retry ${call.name} with narrower inputs.`;
}

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
  call: NormalizedToolCall,
  content: unknown,
): BeaverOutcome {
  const visibleContent = hideLegalSourceUrls(call.name, content);
  const serialized =
    typeof visibleContent === "string"
      ? visibleContent
      : JSON.stringify(visibleContent);
  const objectContent =
    visibleContent && typeof visibleContent === "object" &&
      !Array.isArray(visibleContent)
      ? (visibleContent as Record<string, unknown>)
      : null;
  const reportedStatus =
    typeof objectContent?.status === "string" &&
    [
      "ok",
      "not_found",
      "ambiguous",
      "selection_required",
      "action_required",
      "truncated",
      "past_end",
      "already_exposed",
      "error",
    ].includes(objectContent.status)
      ? (objectContent.status as NormalizedToolResult["status"])
      : null;
  const status: NormalizedToolResult["status"] =
    reportedStatus ??
    (objectContent?.ok === false
      ? /ambiguous/iu.test(String(objectContent.error ?? ""))
        ? "ambiguous"
        : /not found|does not exist|no (?:matches|files)/iu.test(
              String(objectContent.error ?? ""),
            )
          ? "not_found"
          : "error"
      : objectContent?.truncated === true
        ? "truncated"
        : /past the end|outside section/iu.test(serialized)
          ? "past_end"
          : /ambiguous/iu.test(serialized)
            ? "ambiguous"
            : /^No (?:matches|files)/iu.test(serialized)
              ? "not_found"
              : "ok");
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return {
      result: toolText(serialized, status === "error"),
      metadata: { status },
    };
  }
  const ok =
    visibleContent && typeof visibleContent === "object" &&
        !Array.isArray(visibleContent)
      ? (visibleContent as Record<string, unknown>).ok
      : undefined;
  const envelope = (keep: number) => {
    const headLength = Math.ceil(keep * 0.7);
    const tailLength = keep - headLength;
    return JSON.stringify({
      ...(typeof ok === "boolean" ? { ok } : {}),
      truncated: true,
      original_format: typeof visibleContent === "string" ? "text" : "json",
      omitted_characters: serialized.length - keep,
      preview: {
        head: serialized.slice(0, headLength),
        tail: tailLength ? serialized.slice(-tailLength) : "",
      },
      continuation: continuationHint(call),
    });
  };
  // JSON escaping makes the payload size data-dependent. A tiny binary
  // search keeps the most preview text that fits while preserving valid JSON.
  let low = 0;
  let high = Math.min(serialized.length, MAX_TOOL_RESULT_CHARS);
  let shortened = envelope(0);
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = envelope(keep);
    if (candidate.length <= MAX_TOOL_RESULT_CHARS) {
      shortened = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return {
    result: toolText(
      shortened.length <= MAX_TOOL_RESULT_CHARS
        ? shortened
        : JSON.stringify({ truncated: true }),
    ),
    metadata: { status: "truncated" },
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
  const rendered = result(call, content);
  const sourceLines =
    call.name === "Grep"
      ? lines.filter((line) => line.handoffCandidate === true)
      : lines;
  return toolResultText(rendered.result) === content
    ? {
        ...rendered,
        metadata: {
          ...rendered.metadata,
          evidenceSpans: sourceLines.flatMap((line) =>
            line.span ? [line.span] : [],
          ),
          evidenceSegments: sourceLines.flatMap((line) =>
            line.span && line.source
              ? [
                  {
                    ...line.source,
                    start: line.span[0],
                    end: line.span[1],
                    kind: call.name === "Grep" ? "candidate" : "evidence",
                  },
                ]
              : [],
          ),
        },
      }
    : rendered;
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
  | Awaited<ReturnType<typeof lookupLocalPdfStructure>>
  | Awaited<ReturnType<typeof rehydrateLocalPdfEvidence>>;
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

const TEXT_OP_STRING_LIMIT = 5000;

type InsertBlocksRequest = {
  blocks: string[];
  position: "before" | "after";
  anchorText?: string;
  occurrence?: number;
};

function parseInsertBlocksRequest(raw: unknown): InsertBlocksRequest | null | string {
  if (!Array.isArray(raw)) return null;
  const inserts = raw.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).op === "insert_blocks",
  );
  if (!inserts.length) return null;
  if (raw.length !== 1) return "insert_blocks must be the only op in its call";
  const item = inserts[0] as Record<string, unknown>;
  const blocks = Array.isArray(item.blocks)
    ? item.blocks.filter((block): block is string => typeof block === "string")
    : [];
  if (
    !blocks.length ||
    blocks.length > 20 ||
    blocks.some(
      (block) =>
        !block.trim() || block.length > TEXT_OP_STRING_LIMIT || /[\r\n]/u.test(block),
    )
  ) {
    return "insert_blocks.blocks must contain 1 to 20 non-empty single-paragraph strings";
  }
  const scope = item.scope as Record<string, unknown> | undefined;
  if (!scope || (scope.kind !== "whole_document" && scope.kind !== "find_text")) {
    return "insert_blocks scope must be whole_document or find_text";
  }
  if (scope.kind === "find_text" && !trimmed(scope.text)) {
    return "insert_blocks find_text scope requires exact anchor text";
  }
  return {
    blocks,
    position: item.position === "before" ? "before" : "after",
    ...(scope.kind === "find_text" ? { anchorText: trimmed(scope.text) } : {}),
    ...(typeof scope.occurrence === "number"
      ? { occurrence: Math.trunc(scope.occurrence) }
      : {}),
  };
}

/** Parse and bound-check the raw ops array; returns an error string on any
 *  malformed op so the model gets a correctable message. */
function parseTextOpRequests(raw: unknown): TextOpRequest[] | string {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) {
    return "ops must be an array of 1 to 20 operations";
  }
  const boundedString = (value: unknown) =>
    typeof value === "string" && value.length <= TEXT_OP_STRING_LIMIT;
  const requests: TextOpRequest[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `ops[${index}]`;
    if (!item || typeof item !== "object") return `${at} must be an object`;
    const op = item as Record<string, unknown>;
    if (typeof op.op !== "string" || !TEXT_OP_NAMES.includes(op.op)) {
      return `${at}.op must be one of: ${TEXT_OP_NAMES.join(", ")}`;
    }
    const rawScope = op.scope as Record<string, unknown> | undefined;
    if (!rawScope || typeof rawScope !== "object") {
      return `${at}.scope is required`;
    }
    let scope: TextOpScope;
    if (rawScope.kind === "whole_document") {
      scope = { kind: "whole_document" };
    } else if (rawScope.kind === "find_text") {
      if (!boundedString(rawScope.text) || !(rawScope.text as string).trim()) {
        return `${at}.scope.text is required for find_text`;
      }
      scope = {
        kind: "find_text",
        text: rawScope.text as string,
        ...(typeof rawScope.occurrence === "number"
          ? { occurrence: Math.trunc(rawScope.occurrence) }
          : {}),
      };
    } else if (rawScope.kind === "range") {
      if (
        !boundedString(rawScope.from_text) ||
        !(rawScope.from_text as string).trim() ||
        !boundedString(rawScope.to_text) ||
        !(rawScope.to_text as string).trim()
      ) {
        return `${at}.scope.from_text and to_text are required for range`;
      }
      scope = {
        kind: "range",
        from_text: rawScope.from_text as string,
        to_text: rawScope.to_text as string,
      };
    } else if (rawScope.kind === "at") {
      if (!boundedString(rawScope.at) || !(rawScope.at as string).trim()) {
        return `${at}.scope.at is required for at`;
      }
      // Carried unresolved: resolution needs the pinned version's text, and
      // the contract is that every scope resolves against THAT version.
      scope = {
        kind: "at",
        at: (rawScope.at as string).trim(),
        ...(typeof rawScope.follow === "string" ? { follow: rawScope.follow } : {}),
        ...(typeof rawScope.depth === "number"
          ? { depth: Math.trunc(rawScope.depth) }
          : {}),
      } as unknown as TextOpScope;
    } else {
      return `${at}.scope.kind must be whole_document, at, find_text, or range`;
    }
    if (op.op === "replace_text" && !boundedString(op.find)) {
      return `${at}.find is required for replace_text`;
    }
    requests.push({
      op: op.op,
      scope,
      ...(boundedString(op.find) ? { find: op.find as string } : {}),
      ...(boundedString(op.replace) ? { replace: op.replace as string } : {}),
      ...(typeof op.match_case === "boolean" ? { match_case: op.match_case } : {}),
      ...(typeof op.whole_word === "boolean" ? { whole_word: op.whole_word } : {}),
      ...(typeof op.occurrence === "number"
        ? { occurrence: Math.trunc(op.occurrence) }
        : {}),
      ...(typeof op.style === "string" && op.style.length <= 20
        ? { style: op.style }
        : {}),
    });
  }
  return requests;
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
  turnReadState?: AssistantReadTurnState;
  editMode: EditMode;
}) {
  const blockInsert = parseInsertBlocksRequest(params.args.ops);
  if (typeof blockInsert === "string") return fail(params.call, blockInsert);
  const requests = blockInsert ? [] : parseTextOpRequests(params.args.ops);
  if (typeof requests === "string") return fail(params.call, requests);
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
      turnReadState: params.turnReadState,
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

/**
 * mike_upstream_native_v1 serves the arm's own vendored copy of the pinned
 * citationReminder (2266446b:documentOps.ts:33-47) instead of Beaver's. The two
 * are byte-identical today — proven over docx/xlsx/pdf labels by
 * .tmp-native-envelope-probe.ts — so this changes no bytes for any arm; it makes
 * the native arm's fidelity structural, so a later edit to Beaver's copy for
 * another arm cannot silently drift the pinned baseline (spec §1.4). With the
 * flag off this is the same function reference every other arm already used.
 */




/** Served markdown drafting surface for one docx version. Null when the docx
 *  has no drafting source or the surface is off (callers fall back to
 *  extractDocument). */
type ServedDrafting =
  | {
      served: string;
      bodyOffset: number;
      versionId: string;
      filename: string;
      /** Extraction warnings (accepted-view tracked changes, text-box
       * exclusions, flattened controls, …); surfaced on first read only
       * when SERVE_CONVERSION_NOTES is on. */
      warnings: string[];
    }
  | null;

/**
 * Served text for the markdown drafting surface. For a .docx with a drafting
 * source under MARKDOWN_READ_DOCX, returns the pandoc markdown — with the
 * derived SECT-INDEX prepended in the index arm — plus the char offset where
 * the markdown BODY begins (0 when no index was attached), so scoped reads and
 * find_in_document can address the body with body-relative offsets. Null when
 * the surface is off or the docx has no drafting source (callers fall back to
 * extractDocument). Best-effort: if index derivation fails on a docx the
 * drafting source accepted, serve the plain markdown rather than failing.
 *
 * Memoized per (documentId, versionId) within a turn: .docx extraction +
 * skeleton derivation + index render are the expensive part of every read/find
 * call (~0.65s/call on the covenants docx). The cache lives in the turn read
 * state, so it never outlives the turn and
 * a version change (new versionId) naturally re-derives.
 */
export async function servedDraftingText(
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
      bodyOffset: 0,
      versionId: file.version.id,
      filename: file.filename,
      warnings: source.warnings,
    };
  }
  cache?.set(cacheKey, result);
  return result;
}

async function turnServedPassages(
  documents: DocumentStore,
  scope: DocumentScope,
  readState: AssistantReadTurnState,
): Promise<Array<ServedPassage & AssignmentClosureSource>> {
  const passages: Array<ServedPassage & AssignmentClosureSource> = [];
  for (const entry of readState.values()) {
    if (!entry.intervals?.length) continue;
    const file = await documents.read(
      scope,
      entry.documentId,
      entry.versionId,
      false,
    );
    if (!file || file.version.id !== entry.versionId) continue;
    let plane = "";
    if (entry.projection === "drafting") {
      plane = (
        await extractDocxDraftingSource(file.bytes).catch(
          () => null,
        )
      )?.markdown ?? "";
    } else if (entry.projection === "redline") {
      plane = (
        await projectDocxRedline(file.bytes).catch(() => null)
      )?.text ?? "";
    } else {
      plane =
        (await extractDocument(
          documents, scope, entry.documentId, entry.versionId,
        ))
          ?.text ?? "";
    }
    if (!plane) continue;
    for (const [start, end] of mergeIntervals(entry.intervals)) {
      const from = Math.max(0, Math.min(start, plane.length));
      const to = Math.max(from, Math.min(end, plane.length));
      if (to > from) {
        passages.push({
          document: entry.docLabel || entry.filename || entry.documentId,
          documentId: entry.documentId,
          versionId: entry.versionId,
          sourceSha256: file.version.source_sha256,
          projection: entry.projection,
          text: plane.slice(from, to),
          at: from,
        });
      }
    }
  }
  return passages;
}

async function sourceClosureForDraft(
  documents: DocumentStore,
  scope: DocumentScope,
  draft: string,
  readState?: AssistantReadTurnState,
) {
  return readState && /\bassign/iu.test(draft)
    ? assignmentClosureReceipts(
        await turnServedPassages(documents, scope, readState),
        draft,
      )
    : [];
}

export type AssistantToolOptions = {
  userEmail?: string;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workflows?: WorkflowStore;
  a2ajLookups?: A2AJLocatorLookup[];
  a2ajDocuments?: A2AJDocument[];
  courtlistener?: CourtlistenerToolState;
  allowedDocumentIds?: Set<string>;
  pdfHandles?: Set<string>;
  matterId?: string | null;
  legalEvidence?: LegalEvidenceTurnState;
  edits?: AssistantEditTurnState;
  reads?: AssistantReadTurnState;
  workingSets?: AssistantWorkingSetTurnState;
  editMode?: EditMode;
  timeZone?: string;
};

export async function executeAssistantTool(
  userId: string,
  call: NormalizedToolCall,
  {
    userEmail,
    a2ajLookups,
    a2ajDocuments,
    courtlistener: courtlistenerState,
    allowedDocumentIds,
    pdfHandles: localPdfEvidenceHandles,
    matterId,
    legalEvidence: legalEvidenceState,
    edits: turnEditState,
    reads: turnReadState,
    workingSets,
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
  const servedDraftingCache = turnReadState
    ? (turnReadState.servedDraftingCache ??= new Map())
    : new Map<string, ServedDrafting>();
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
        const resolved = await resolveCodingDocumentReferences(
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
        a2ajDocuments,
        a2ajLookups,
        courtlistener: courtlistenerState,
        evidence: legalEvidenceState,
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
          workingSets,
          servedDraftingCache,
          turnReadState,
          localPdfEvidenceHandles,
          availableWorkflows,
          editMode,
        );
        if (
          legalEvidenceState &&
          call.name === "Read" &&
          codingResult.metadata?.status !== "error"
        ) {
          const bySource = new Map<
            string,
            NonNullable<NormalizedToolResult["evidenceSegments"]>
          >();
          for (const segment of codingResult.metadata?.evidenceSegments ?? []) {
            if (segment.end <= segment.start) continue;
            const key = [
              segment.documentId,
              segment.versionId,
              segment.projection ?? "canonical",
            ].join(":");
            bySource.set(key, [...(bySource.get(key) ?? []), segment]);
          }
          const evidence = [...(codingResult.evidence ?? [])];
          const evidenceIds = evidence.map(({ evidence_id }) => evidence_id);
          for (const receipt of evidence) {
            registerLegalEvidence(legalEvidenceState, receipt);
          }
          for (const segments of bySource.values()) {
            const first = segments[0];
            const drafting = first.projection === "drafting"
              ? await servedDraftingText(
                  documents,
                  scope,
                  first.documentId,
                  servedDraftingCache,
                  first.versionId,
                )
              : null;
            const redlineFile = first.projection === "redline"
              ? await documents.read(
                  scope, first.documentId, first.versionId, false,
                )
              : null;
            const redline = redlineFile
              ? await projectDocxRedline(redlineFile.bytes)
              : null;
            const canonical = drafting || redline
              ? null
              : await extractDocument(
                  documents,
                  scope,
                  first.documentId,
                  first.versionId,
                );
            const sourceText = drafting
              ? drafting.served.slice(drafting.bodyOffset)
              : redline?.text ?? canonical?.text;
            if (!sourceText) continue;
            const seen = new Set<string>();
            for (const segment of segments) {
              const key = `${segment.start}:${segment.end}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const spanText = sourceText.slice(segment.start, segment.end);
              if (!spanText.trim()) continue;
              const receipt = createLibraryEvidence({
                documentId: segment.documentId,
                versionId: segment.versionId,
                filename: segment.filename ?? canonical?.filename ?? segment.documentId,
                sourceText,
                spanText,
                start: segment.start,
                end: segment.end,
                locator: segment.locator && segment.locatorKind
                  ? { kind: segment.locatorKind, label: segment.locator }
                  : undefined,
              });
              registerLegalEvidence(legalEvidenceState, receipt);
              evidence.push(receipt);
              evidenceIds.push(receipt.evidence_id);
            }
          }
          if (evidenceIds.length) {
            codingResult.result = toolText(
              `${toolResultText(codingResult.result)}\n\nCitation evidence_ids: ${evidenceIds.join(", ")}`,
            );
          }
          codingResult.evidence = evidence;
        }
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
          const sourceClosure = await sourceClosureForDraft(
            documents,
            scope,
            markdown,
            turnReadState,
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
            ...(sourceClosure.length
              ? { source_closure: sourceClosure }
              : {}),
            ...(sourceClosure.length
              ? {
                  next_required_action:
                    "Review source_closure and apply a document edit only if material.",
                }
              : {}),
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
        if (legalEvidenceState) {
          for (const evidence of citator.evidences ?? []) {
            registerLegalEvidence(legalEvidenceState, evidence);
          }
        }
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
