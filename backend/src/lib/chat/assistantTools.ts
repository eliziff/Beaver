import { appUrl } from "../appRoutes";
import { sha256 } from "../hash";
import { SYSTEM_ASSISTANT_WORKFLOWS } from "../systemWorkflows";
import { parseResourceReference, resourceReference } from "../resourceReferences";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
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
import { pageLabel, pageMapFromMarkers, pageMapFromSourceDoc, graphScope, parseAddress, resolvePage, selectPages, type FollowDirection, type PageMap } from "../legalDocumentNavigator";
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
  OpenAIToolSchema,
} from "../llm";
import { cachedParse } from "../parseCache";
import {
  getTableOfAuthoritiesJob,
  submitTableOfAuthoritiesDocument,
} from "../tableOfAuthorities";
import {
  A2AJ_TOOL_NAMES,
  executeA2AJTool,
  type A2AJToolExecution,
} from "./tools/a2ajTools";
import {
  createBenchmarkEvidence,
  LEGAL_EVIDENCE_TOOL_NAME,
  createLibraryEvidence,
  registerLegalEvidence,
  submitLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./legalEvidence";
import {
  COURTLISTENER_TOOL_NAMES,
  COURTLISTENER_TOOLS,
} from "./tools/courtlistenerTools";
import { CITATOR_TOOLS, executeCitatorTool } from "./tools/citatorTools";
import {
  COMPARE_VERSIONS_TOOLS,
  executeCompareVersionsTool,
} from "./tools/compareVersionsTool";
import { executeHansardTool } from "./tools/hansardTools";
import {
  PUBLIC_LEGAL_SOURCE_TOOL_NAMES,
} from "./tools/publicLegalSourceTools";
import {
  SEARCH_SOURCES_TOOL,
  executeSearchSourcesTool,
} from "./tools/sourceSearchTools";
import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
  type PublicLegalSourceState,
} from "./publicLegalSourceState";
import {
  applyTextOpsToDocx,
  type TextOpRequest,
  type TextOpScope,
} from "../docxTextOps";
import { TEXT_OP_NAMES } from "../textOps";
import {
  boundedParagraphTail,
  buildPptxPresentation,
  renderMarkdownDocx,
  renderXlsxWorkbook,
  runEditDocument,
  safeGeneratedFilename,
  textParserFor,
} from "./tools/documentOps";
import { quoteRepairSuggestion } from "./quoteRepair";
import { docxCautionNotes, docxPathologyReportFor } from "./tools/docxPathologyNotes";
import { projectDocxRedline } from "../docx/redline";
import {
  DETERMINISTIC_DOCX_EDIT_SCHEMA,
  TOOLS,
} from "./tools/toolSchemas";
import {
  runLocalCourtlistenerTool,
  type CourtlistenerToolState,
} from "./courtlistenerToolRunner";
import { RESOURCE_TOOLS, globPattern as globRegExp } from "./resourceTools";
import type { WorkflowStore } from "./types";

const tool = (
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): OpenAIToolSchema => ({
  type: "function",
  function: { name, description, parameters },
});

const DOCUMENT_ID_PROPERTY = {
  type: "string",
  description: "Document resource returned by Glob, or a unique filename.",
};
const DOCUMENT_IDS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Filenames from Glob, or document_ids for duplicate filenames.",
};
const OPTIONAL_VERSION_ID_PROPERTY = {
  type: "string",
  description: "Optional Library version id. Omit for the active version.",
};

const DOCUMENT_TOOLS: OpenAIToolSchema[] = [
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

const GENERATION_TOOLS = (TOOLS as OpenAIToolSchema[]).filter(
  ({ function: { name } }) => name.startsWith("generate_"),
);


const ASK_INPUTS_TOOLS = (TOOLS as OpenAIToolSchema[]).filter(
  (schema) => schema.function.name === "ask_inputs",
);

/**
 * Turn-scoped bookkeeping for the requirements echo. Created once per assistant
 * turn by the route and handed to every tool batch, exactly like turnReadState,
 * so a fetch_requirements call in round 1 is still visible to a generate_docx
 * call in round 4.
 */
export type AssistantRequirementsState = {
  /** How many times fetch_requirements has been served this turn. */
  echoCallCount: number;
  /** documents_unread.length at the first echo; null until then, and null when
   * the read state was unavailable so the lists were served as unknown. */
  documentsUnreadAtEcho: number | null;
  /** Exposure accounting only: documents_oriented_only.length at the first
   * echo (touched but zero body chars served). Null when the mechanism is
   * off or the read state was unavailable. */
  documentsOrientedOnlyAtEcho: number | null;
  /** Exposure accounting only: the authoring-boundary coverage check has
   * refused once this turn; every later authoring call proceeds. */
  exposureNudgeServed: boolean;
  /** Draft-edit lever only: the body/title/filename of the last generate_docx
   * draft, saved when the coverage check refused it (and kept in sync when the
   * model re-sends a full body). Null until a draft is captured. */
  draftTitle: string | null;
  /** Draft-edit lever only: in-memory drafts keyed by lowercased filename
   * ("draft.md" is the canonical path the refusal names). Held only here,
   * never on disk — nothing is written until the final render. Multiple
   * drafts coexist: the model may spin up named drafts and address each by
   * path exactly like a workspace file. */
  drafts: Record<string, string>;
  draftFilename: string | null;
  /** Draft-edit lever only: successful in-memory draft Edits this turn. */
  draftEditCount: number;
  /** Draft-edit lever only: successful real-file (source) Edits applied this
   * turn. Monitored distinctly from draft edits — a model editing a source
   * .docx unprompted is observable behavior, not a hidden path. */
  sourceEditCount: number;
  /** Final arm: attempted source Edits refused at the immutable boundary. */
  sourceEditRefusalCount: number;
  /** Final arm: evidence state observed at the first bodied authoring call. */
  firstDraftCount: number;
  firstDraftCoverage: {
    bodyEvidence: string[];
    tocOnly: string[];
    unseen: string[];
  } | null;
  /** Final arm: one only when a coverage gap paused the first draft. */
  signalGateCount: number;
  /** Composition-check lever only: how many times the draft-vs-served
   * reconcile ran this turn (once per authoring call, at most once per turn
   * under the exposure latch) and how many competing-base findings it served.
   * Zero count with the mechanism on means the boundary never fired — the
   * conformance gate treats that as a wiring failure. */
  compositionCheckCount: number;
  compositionCheckFindings: number;
};

export const createAssistantRequirementsState =
  (): AssistantRequirementsState => ({
    echoCallCount: 0,
    documentsUnreadAtEcho: null,
    documentsOrientedOnlyAtEcho: null,
    exposureNudgeServed: false,
    draftTitle: null,
    drafts: {},
    draftFilename: null,
    draftEditCount: 0,
    sourceEditCount: 0,
    sourceEditRefusalCount: 0,
    firstDraftCount: 0,
    firstDraftCoverage: null,
    signalGateCount: 0,
    compositionCheckCount: 0,
    compositionCheckFindings: 0,
  });

/** Canonical in-memory draft path; the refusal message names this file. */
export const CANONICAL_DRAFT_FILE = "draft.md";

/** A coverage-paused output is committed only after at least one real Edit. */
export function pendingFinalAgentDraft(
  state: AssistantRequirementsState,
): { filename: string; content: string } | null {
  if (
    state.signalGateCount !== 1 ||
    state.draftEditCount < 1 ||
    !state.draftFilename
  ) {
    return null;
  }
  const content = state.drafts[state.draftFilename.toLowerCase()];
  return content ? { filename: state.draftFilename, content } : null;
}

/** Map key for a draft named by a title/filename: lowercased slug + ".md".
 * Used to alias the canonical draft under the deliverable's own name, so a
 * model that addresses its draft by a derived filename finds it. */


/**
 * Exact-string draft edit with Claude Code's contract: old_string must be
 * found, must differ from new_string, and must be unique unless replace_all.
 * Index-based splicing, never String.replace with a string pattern — $-tokens
 * in legal text (e.g. "$1,000,000") must not be interpreted as replacement
 * patterns.
 */
export function applyDraftEdit(
  draft: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; replacements: number } | { error: string } {
  if (!oldString) return { error: "old_string must be a non-empty string." };
  if (oldString === newString)
    return { error: "old_string and new_string are identical." };
  const occurrences = draft.split(oldString).length - 1;
  if (occurrences === 0)
    return {
      error:
        "old_string not found in draft.md. It must match the draft exactly," +
        " including whitespace.",
    };
  if (occurrences > 1 && !replaceAll)
    return {
      error:
        `old_string appears ${occurrences} times in draft.md. Extend it with` +
        " surrounding text until it is unique, or set replace_all: true.",
    };
  if (replaceAll) {
    return {
      updated: draft.split(oldString).join(newString),
      replacements: occurrences,
    };
  }
  const at = draft.indexOf(oldString);
  return {
    updated:
      draft.slice(0, at) + newString + draft.slice(at + oldString.length),
    replacements: 1,
  };
}

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

const ASSISTANT_TOOL_CATALOG: OpenAIToolSchema[] = [
  ...ASK_INPUTS_TOOLS,
  ...RESOURCE_TOOLS,
  ...DOCUMENT_TOOLS,
  ...GENERATION_TOOLS,
  ...COMPARE_VERSIONS_TOOLS,
  SEARCH_SOURCES_TOOL,
  ...(COURTLISTENER_TOOLS as OpenAIToolSchema[]).filter(
    ({ function: { name } }) =>
      name === COURTLISTENER_TOOL_NAMES.findInCase ||
      name === COURTLISTENER_TOOL_NAMES.verifyCitations,
  ),
  ...CITATOR_TOOLS,
];

const exactEditTool = RESOURCE_TOOLS.find(
  (entry) => entry.function.name === "Edit",
);
if (!exactEditTool) throw new Error("Production Edit tool is missing");
const exactEditProperties = exactEditTool.function.parameters.properties as
  Record<string, unknown>;
const deterministicOpsSchema = (
  DETERMINISTIC_DOCX_EDIT_SCHEMA[0]?.function.parameters.properties as
    | Record<string, unknown>
    | undefined
)?.ops;
if (!deterministicOpsSchema) {
  throw new Error("Deterministic DOCX operation schema is missing");
}
const TRANSFORM_DOCX_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "transform_docx",
    description:
      "Apply deterministic mechanical text operations to a Library DOCX. Returns a new Manual or Auto Mode version with per-operation results.",
    parameters: {
      type: "object",
      properties: {
        file_path: exactEditProperties.file_path,
        ops: deterministicOpsSchema,
      },
      required: ["file_path", "ops"],
      additionalProperties: false,
    },
  },
};

export const ASSISTANT_TOOLS = [
  ...ASSISTANT_TOOL_CATALOG,
  TRANSFORM_DOCX_TOOL,
];

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
    /** Coordinate plane for intervals. Missing means the legacy served plane. */
    projection?: "canonical" | "drafting" | "redline";
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



async function runReviseDocx(
  call: NormalizedToolCall,
  documents: DocumentStore,
  scope: DocumentScope,
  documentId: string,
  args: Record<string, unknown>,
  turnEditState?: AssistantEditTurnState,
  turnReadState?: AssistantReadTurnState,
  servedDraftingCache = new Map<string, ServedDrafting>(),
  editMode: EditMode = "manual",
): Promise<NormalizedToolResult> {
  let versionId = trimmed(args.version_id);
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  if (!documentId || !rawEdits.length) {
    return fail(call, "document_id and edits are required");
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
  if (
    rawEdits.length > 100 ||
    rawEdits.some(invalidReviseEdit)
  ) {
    return fail(call, "edits are invalid");
  }
  try {
    const source = await activeDocument(
      documents, scope, documentId, versionId || undefined,
    );
    if (!source) return fail(call, "DOCX Library version not found");
    if (source === "stale") {
      return fail(call, "version_id is not the active version");
    }
    versionId = source.version.id;
    if (source.fileType.toLowerCase() !== "docx") {
      return fail(call, "Revision requires a DOCX Library version");
    }
    const sourceBytes = source.bytes;
    const edits: EditInput[] = [];
    for (const raw of rawEdits) {
      const edit = raw as Record<string, unknown>;
      if (edit.find !== edit.replace) {
        edits.push({
          find: edit.find as string,
          replace: edit.replace as string,
          context_before: (edit.context_before as string) ?? "",
          context_after: (edit.context_after as string) ?? "",
          reason: typeof edit.reason === "string" ? edit.reason : undefined,
        });
      }
    }
    if (!edits.length) {
      return result(call, {
        ok: false,
        error: "No revision was saved",
        edit_errors: ["Every requested edit was a no-op"],
      });
    }
    const revised = await runEditDocument({
      documents,
      scope,
      documentId,
      edits,
      editMode,
      annotate: args.annotate === true,
      ...(turnVersion
        ? {
            reuseVersion: {
              versionId: turnVersion.versionId,
              parentVersionId: turnVersion.parentVersionId,
            },
          }
        : {}),
    });
    if (!revised.ok) {
      const sourceText = await extractDocxBodyText(sourceBytes);
      return result(call, {
        ok: false,
        error: "No revision was saved",
        edit_errors: [revised.error],
        nearest_matches: edits.map((edit) => ({
          attempted_quote: edit.find,
          nearest_match: findNearestSuggestion(edit.find, sourceText),
        })),
      });
    }
    const parentVersionId = turnVersion?.parentVersionId ?? versionId;
    turnEditState?.set(documentId, {
      versionId: revised.version_id,
      parentVersionId,
    });
    const saved = await documents.read(
      scope,
      documentId,
      revised.version_id,
      false,
    );
    if (!saved) return fail(call, "Saved DOCX version not found");
    const version = saved.version;
    const sourceClosure = await sourceClosureForDraft(
      documents,
      scope,
      await extractDocxBodyText(saved.bytes),
      turnReadState,
      servedDraftingCache,
    );
    // Every revision gets deterministic same-turn feedback: the
    // structural lint runs on the freshly produced version (the
    // determinism plan's receipt hook — not gated on annotate).
    const lint = await lintDocxStructure(saved.bytes).catch(() => null);
    const downloadUrl =
      `/single-documents/${encodeURIComponent(documentId)}/file` +
      `?version_id=${encodeURIComponent(version.id)}`;
    return result(call, {
      ok: true,
      receipt: "mike-document:v1",
      action: "revised",
      edit_mode: editMode,
      document_id: documentId,
      parent_version_id: parentVersionId,
      version_id: version.id,
      version_number: version.version_number,
      filename: version.filename,
      file_type: version.file_type,
      source_sha256: version.source_sha256,
      change_count: revised.annotations.length,
      comment_count: revised.comment_count,
      // Counted on every revision so rationale coverage is a
      // measurable variable (annotate mode forces it to zero by
      // rejecting reason-free edits).
      edits_without_reason: edits.filter((edit) => !edit.reason?.trim()).length,
      structural_lint: lint
        ? {
            finding_count: lint.findings.length,
            findings: lint.findings
              .slice(0, 8)
              .map(({ code, severity, subject, message }) => ({
                code,
                severity,
                subject,
                message,
              })),
            notes: lint.notes,
          }
        : undefined,
      ...(sourceClosure.length ? { source_closure: sourceClosure } : {}),
      resource: resourceReference.document(documentId, version.id),
      download_url: downloadUrl,
      annotations: revised.annotations,
      ...(sourceClosure.length
        ? {
            next_required_action:
              "Review source_closure and apply another document edit only if material.",
          }
        : {}),
    });
  } catch (error) {
    return fail(call, errorText(error, "DOCX revision failed"));
  }
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
      return result(call, {
        ok: true,
        resource: requested,
        job: await getTableOfAuthoritiesJob(resource.id),
      });
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

function withResource(
  output: NormalizedToolResult,
  resource: string,
  transform: (payload: Record<string, unknown>) => Record<string, unknown> =
    (payload) => payload,
) {
  try {
    const payload = JSON.parse(output.content);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? {
          ...output,
          content: JSON.stringify({
            ...transform(payload as Record<string, unknown>),
            resource,
          }),
        }
      : output;
  } catch {
    return output;
  }
}

function captureA2AJ(
  call: NormalizedToolCall,
  execution: A2AJToolExecution,
  options: {
    documents?: A2AJDocument[];
    lookups?: A2AJLocatorLookup[];
    evidence?: LegalEvidenceTurnState;
    resource?: string;
  },
) {
  if (execution.document?.url) options.documents?.push(execution.document);
  if (execution.lookup?.status === "found" && execution.lookup.block) {
    options.lookups?.push(execution.lookup);
  }
  for (const lookup of execution.lookups ?? []) {
    if (lookup.status === "found" && lookup.block) options.lookups?.push(lookup);
  }
  if (options.evidence) {
    registerLegalEvidence(options.evidence, execution.evidence, {
      document: execution.document,
      lookup: execution.lookup,
    });
    for (let index = 0; index < (execution.evidences?.length ?? 0); index += 1) {
      registerLegalEvidence(options.evidence, execution.evidences?.[index], {
        lookup: execution.lookups?.[index],
      });
    }
  }
  const output = {
    ...result(call, execution.payload),
    evidenceRefs: receiptEvidenceRefs([
      execution.evidence,
      ...(execution.evidences ?? []),
    ]),
  };
  return options.resource ? withResource(output, options.resource) : output;
}

async function readLegalSourceResource(
  call: NormalizedToolCall,
  args: Record<string, unknown>,
  options: {
    userId: string;
    a2ajDocuments?: A2AJDocument[];
    a2ajLookups?: A2AJLocatorLookup[];
    courtlistener?: CourtlistenerToolState;
    publicLegal: PublicLegalSourceState;
    evidence?: LegalEvidenceTurnState;
  },
): Promise<NormalizedToolResult | null> {
  if (call.name !== "Read") return null;
  const resource = parseResourceReference(trimmed(args.file_path));
  if (resource?.kind !== "source" || resource.provider === "pdf") return null;
  const locator = trimmed(args.locator);
  const locatorKind = trimmed(args.locator_kind);
  if (Boolean(locator) !== Boolean(locatorKind)) {
    return fail(call, "locator_kind and locator are required together.");
  }
  if (resource.provider === "a2aj") {
    let identity: unknown;
    try {
      identity = JSON.parse(resource.sourceId);
    } catch {
      return fail(call, "Invalid A2AJ resource.");
    }
    if (
      !Array.isArray(identity) ||
      typeof identity[0] !== "string" ||
      !["cases", "laws"].includes(String(identity[1]))
    ) {
      return fail(call, "Invalid A2AJ resource.");
    }
    const execution = await executeA2AJTool(
      locator ? A2AJ_TOOL_NAMES.lookup : A2AJ_TOOL_NAMES.fetch,
      {
        citation: identity[0],
        doc_type: identity[1],
        ...(locator
          ? {
              locator_type: locatorKind,
              locator,
              end_locator: args.end_locator,
              context_blocks: args.context_blocks,
              references: args.references,
            }
          : {}),
      },
    );
    return execution
      ? captureA2AJ(call, execution, {
          documents: options.a2ajDocuments,
          lookups: options.a2ajLookups,
          evidence: options.evidence,
          resource: trimmed(args.file_path),
        })
      : fail(call, "A2AJ resource is unavailable.");
  }
  if (resource.provider === "journal") {
    const execution = await executePublicLegalSourceTool(
      locator
        ? PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup
        : PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      {
        provider: "journal",
        identifier: resource.sourceId,
        ...(locator
          ? {
              locator_type: locatorKind,
              locator,
              context_blocks: args.context_blocks,
            }
          : {}),
      },
      options.publicLegal,
      options.userId,
    );
    if (!execution) return fail(call, "Journal resource is unavailable.");
    for (const evidence of execution.evidences ?? []) {
      if (options.evidence) registerLegalEvidence(options.evidence, evidence);
    }
    return withResource({
      ...result(call, execution.payload),
      evidenceRefs: publicLegalEvidenceRefs(execution.payload),
    }, trimmed(args.file_path));
  }
  if (resource.provider === "hansard") {
    const payload = executeHansardTool("hansard_fetch", { id: resource.sourceId });
    if (!payload) return fail(call, "Hansard resource is unavailable.");
    const intervention =
      payload.intervention && typeof payload.intervention === "object"
        ? payload.intervention as Record<string, unknown>
        : null;
    const body = trimmed(intervention?.text);
    let evidence: LegalEvidenceReceipt | undefined;
    if (intervention && body) {
      evidence = createBenchmarkEvidence({
        jurisdiction: trimmed(intervention.jurisdiction) || "CA-ON",
        sourceClass: "commentary",
        stableSourceId: `hansard:${resource.sourceId}`,
        sourceText: body,
        spanText: body,
        citation: [
          "Ontario Hansard",
          trimmed(intervention.date),
          trimmed(intervention.speaker),
        ].filter(Boolean).join(", "),
        name: trimmed(intervention.speaker) || "Ontario Hansard",
        dataset: "a2aj-hansard",
        version: trimmed(intervention.date) || null,
        externalUrl: trimmed(intervention.sourceUrl) || null,
        locatorKind: "document",
        locatorLabel: resource.sourceId,
      });
      if (options.evidence) registerLegalEvidence(options.evidence, evidence);
    }
    return withResource({
      ...result(call, {
        ...payload,
        ...(evidence ? { evidence_id: evidence.evidence_id } : {}),
      }),
      evidenceRefs: receiptEvidenceRefs([evidence]),
    }, trimmed(args.file_path));
  }
  if (
    resource.provider === "courtlistener" ||
    resource.provider === "courtlistener-opinion"
  ) {
    let clusterId = Number(resource.sourceId);
    let opinionId: number | undefined;
    if (resource.provider === "courtlistener-opinion") {
      try {
        const identity = JSON.parse(resource.sourceId);
        clusterId = Number(identity[0]);
        opinionId = Number(identity[1]);
      } catch {
        return fail(call, "Invalid CourtListener opinion resource.");
      }
    }
    if (!Number.isSafeInteger(clusterId) || clusterId <= 0) {
      return fail(call, "Invalid CourtListener resource.");
    }
    const state = options.courtlistener ?? { casesByClusterId: new Map() };
    const fetched = await runLocalCourtlistenerTool({
      id: `${call.id}:fetch`,
      name: COURTLISTENER_TOOL_NAMES.getCases,
      input: { clusterIds: [clusterId] },
    }, state, options.userId, options.evidence);
    if (!fetched || !state.casesByClusterId.has(clusterId)) {
      return fetched
        ? withResource({ ...fetched, tool_use_id: call.id }, trimmed(args.file_path))
        : fail(call, "CourtListener resource is unavailable.");
    }
    const output = await runLocalCourtlistenerTool({
      id: call.id,
      name: locator
        ? COURTLISTENER_TOOL_NAMES.lookupCaseLocator
        : COURTLISTENER_TOOL_NAMES.readCase,
      input: {
        clusterId,
        ...(opinionId ? { opinionId } : {}),
        ...(locator
          ? {
              locator_type: locatorKind,
              locator,
              context_blocks: args.context_blocks,
            }
          : {}),
      },
    }, state, options.userId, options.evidence);
    if (!output) return fail(call, "CourtListener resource is unavailable.");
    return withResource(output, trimmed(args.file_path), (payload) => ({
      ...payload,
      ...(Array.isArray(payload.opinions)
        ? {
            opinions: payload.opinions.map((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                return value;
              }
              const row = value as Record<string, unknown>;
              const id = Number(row.opinion_id);
              return Number.isSafeInteger(id)
                ? {
                    ...row,
                    resource: resourceReference.source(
                      "courtlistener-opinion",
                      JSON.stringify([clusterId, id]),
                    ),
                  }
                : row;
            }),
          }
        : {}),
    }));
  }
  return fail(call, `Unknown source provider: ${resource.provider}`);
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
  requirementsState?: AssistantRequirementsState,
  localPdfEvidenceHandles?: Set<string>,
  workflows: WorkflowStore = new Map(),
  editMode: EditMode = "manual",
): Promise<NormalizedToolResult> {
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
    const draftRows = Object.entries(requirementsState?.drafts ?? {})
          .filter(([name]) => re.test(name))
          .map(([name, body]) => ({
            row: `${name}\tchars=${body.length}\tlines=${
              body ? body.split(/\r?\n/u).length : 0
            }`,
            chars: body.length,
            lines: body ? body.split(/\r?\n/u).length : 0,
          }));
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
      ...draftRows,
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
          return {
            ...result(call, {
              ...compactPdfLookup(file.filename, lookup),
              resource: codingPath(meta, file.version.id),
            }),
            evidenceRefs: pdfEvidenceRefs(file.filename, lookup),
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
        return {
          ...result(call, {
            ...compactPdfLookup(file.filename, lookup),
            resource: codingPath(meta, file.version.id),
          }),
          evidenceRefs: pdfEvidenceRefs(file.filename, lookup),
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
        ...result(call, content),
        evidenceSegments: workingSetEvidenceSegments(workingSet, exposedRanges),
        evidenceRefs: workingSetEvidenceRefs(workingSet, exposedRanges),
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
    // at the generate_docx coverage gate. Without this the coding family
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

  if (call.name === "Edit" || call.name === "transform_docx") {
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
    if (Array.isArray(args.ops)) {
      if (
        Object.prototype.hasOwnProperty.call(args, "old_string") ||
        Object.prototype.hasOwnProperty.call(args, "new_string")
      ) {
        return result(
          call,
          "Pass either ops or old_string/new_string, not both.",
        );
      }
      const [applied] = await runAssistantTools(
        scope.userId,
        [
          {
            id: `${call.id}-deterministic`,
            name: INTERNAL_DETERMINISTIC_EDIT,
            input: { document_id: meta.id, ops: args.ops },
          },
        ],
        {
          userEmail: scope.userEmail,
          documents,
          library,
          projects,
          allowedDocumentIds,
          matterId,
          edits: turnEditState,
          reads: turnReadState,
          editMode,
        },
      );
      if (requirementsState && applied.status !== "error") {
        requirementsState.sourceEditCount += 1;
      }
      return {
        ...result(call, applied.content),
        status: applied.status,
        terminal: applied.terminal,
        mutationReceipt: applied.mutationReceipt ?? applied.content,
      };
    }
    const oldString =
      typeof args.old_string === "string" ? args.old_string : "";
    const newString =
      typeof args.new_string === "string" ? args.new_string : "";
    if (!oldString) return result(call, "old_string is required");
    if (oldString === newString) {
      return result(call, "old_string and new_string must be different");
    }
    const sectionArg = trimmed(args.section);
    if (args.replace_all === true) {
      if (sectionArg) {
        return result(
          call,
          "replace_all with section is not supported yet; run Edit once per occurrence, or replace_all across the whole file.",
        );
      }
      // Global find/replace belongs to the deterministic text-ops engine.
      const [applied] = await runAssistantTools(
        scope.userId,
        [
          {
            id: `${call.id}-textops`,
            name: INTERNAL_DETERMINISTIC_EDIT,
            input: {
              document_id: meta.id,
              ops: [
                {
                  op: "replace_text",
                  find: oldString,
                  replace: newString,
                  match_case: true,
                  scope: { kind: "whole_document" },
                },
              ],
            },
          },
        ],
        {
          userEmail: scope.userEmail,
          documents,
          library,
          projects,
          allowedDocumentIds,
          matterId,
          edits: turnEditState,
          reads: turnReadState,
          editMode,
        },
      );
      const receiptText = applied.mutationReceipt ?? applied.content;
      try {
        const payload = JSON.parse(receiptText) as {
          ok?: boolean;
          action?: string;
          error?: string;
          change_count?: number;
          edit_mode?: EditMode;
          ops?: Array<{ replacements?: number }>;
          source_closure?: unknown[];
        };
        if (payload.ok && payload.action === "no_changes") {
          return result(
            call,
            `No exact matches for old_string were found in ${meta.filename}; no change was made.`,
          );
        }
        if (payload.ok) {
          const count =
            payload.ops?.[0]?.replacements ?? payload.change_count ?? 0;
          if (requirementsState) requirementsState.sourceEditCount += 1;
          return {
            ...result(
              call,
              `Updated ${meta.filename}: ${count} replacement(s) ${
                payload.edit_mode === "auto"
                  ? "applied in Auto Mode."
                  : "saved for review in Manual Mode."
              }` +
                (payload.source_closure?.length
                  ? `\nSource closure: ${JSON.stringify(payload.source_closure)}`
                  : ""),
            ),
            mutationReceipt: receiptText,
          };
        }
        return result(
          call,
          `replace_all made no change: ${payload.error ?? applied.content}`,
        );
      } catch {
        return result(call, applied.content);
      }
    }
    // Section scope: uniqueness is required only within the named section;
    // the surrounding document text becomes the disambiguating context the
    // revise engine anchors on.
    let edit: {
      find: string;
      replace: string;
      context_before?: string;
      context_after?: string;
    } = {
      find: oldString,
      replace: newString,
      context_before: "",
      context_after: "",
    };
    if (sectionArg) {
      const document = await extractDocument(documents, scope, meta.id);
      if (!document) {
        return result(call, `File could not be read: ${requested}`);
      }
      const skeleton = await documentStructure(document.text, meta.id, {
        tableCells: document.tableCells,
      });
      const lookup = readSection(skeleton, sectionArg);
      if (lookup.status !== "found" || !lookup.block) {
        return result(
          call,
          `Section '${sectionArg}' not found (${lookup.status}` +
            (lookup.matches.length
              ? `; candidates: ${lookup.matches.join(", ")}`
              : "") +
            ").",
        );
      }
      const occurrences: number[] = [];
      for (
        let at = lookup.block.text.indexOf(oldString);
        at !== -1 && occurrences.length < 4;
        at = lookup.block.text.indexOf(oldString, at + 1)
      ) {
        occurrences.push(at);
      }
      if (!occurrences.length) {
        return result(
          call,
          `old_string was not found within section ${lookup.block.label}. Read the section and match its text exactly.`,
        );
      }
      if (occurrences.length > 1) {
        return result(
          call,
          `old_string appears ${occurrences.length} times within section ${lookup.block.label}; enlarge it with surrounding context.`,
        );
      }
      const absolute = lookup.block.start + occurrences[0];
      edit = {
        find: oldString,
        replace: newString,
        context_before: document.text.slice(
          Math.max(0, absolute - 60),
          absolute,
        ),
        context_after: document.text.slice(
          absolute + oldString.length,
          absolute + oldString.length + 60,
        ),
      };
    }
    // Same pinning, receipts, and lint hook as the public revise tool; the
    // active version is resolved inside — Edit's contract has no version id.
    const revised = await runReviseDocx(
      { id: `${call.id}-revise`, name: "Edit", input: {} },
      documents,
      scope,
      meta.id,
      { edits: [edit] },
      turnEditState,
      turnReadState,
      servedDraftingCache,
      editMode,
    );
    const receiptText = revised.mutationReceipt ?? revised.content;
    try {
      const payload = JSON.parse(receiptText) as {
        ok?: boolean;
        error?: string;
        edit_errors?: string[];
        source_closure?: unknown[];
        edit_mode?: EditMode;
      };
      if (payload.ok) {
        if (requirementsState) requirementsState.sourceEditCount += 1;
        return {
          ...result(
            call,
            `Updated ${meta.filename}: 1 change ${
              payload.edit_mode === "auto"
                ? "applied in Auto Mode."
                : "saved for review in Manual Mode."
            }` +
              (payload.source_closure?.length
                ? `\nSource closure: ${JSON.stringify(payload.source_closure)}`
                : ""),
          ),
          mutationReceipt: receiptText,
        };
      }
      const reasons = payload.edit_errors?.length
        ? payload.edit_errors
        : [payload.error ?? "unknown error"];
      return result(
        call,
        `The edit could not be applied — no change was made.\n${reasons.join("\n")}\nProvide a larger old_string with more surrounding context.`,
      );
    } catch {
      return result(call, revised.content);
    }
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
      ...result(call, content),
      evidenceSegments: workingSetEvidenceSegments(
        virtualTarget,
        exposedRanges,
      ),
      evidenceRefs: workingSetEvidenceRefs(virtualTarget, exposedRanges),
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
    output.content.includes(hint.rendered),
  );
  return visibleHints.length
    ? {
        ...output,
        retrievalHints: visibleHints.map(({ rendered: _, ...hint }) =>
          hint,
        ),
      }
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

function result(
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult {
  const serialized =
    typeof content === "string" ? content : JSON.stringify(content);
  const objectContent =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
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
    return { tool_use_id: call.id, content: serialized, status };
  }
  const ok =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>).ok
      : undefined;
  const mutationReceipt =
    content &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>).receipt === "mike-document:v1"
      ? serialized
      : undefined;
  const envelope = (keep: number) => {
    const headLength = Math.ceil(keep * 0.7);
    const tailLength = keep - headLength;
    return JSON.stringify({
      ...(typeof ok === "boolean" ? { ok } : {}),
      truncated: true,
      original_format: typeof content === "string" ? "text" : "json",
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
    tool_use_id: call.id,
    content:
      shortened.length <= MAX_TOOL_RESULT_CHARS
        ? shortened
        : JSON.stringify({ truncated: true }),
    status: "truncated",
    ...(mutationReceipt ? { mutationReceipt } : {}),
  };
}

function codingTextResult(
  call: NormalizedToolCall,
  content: string,
  lines: CodingOutputLine[],
): NormalizedToolResult {
  const rendered = result(call, content);
  const sourceLines =
    call.name === "Grep"
      ? lines.filter((line) => line.handoffCandidate === true)
      : lines;
  return rendered.content === content
    ? {
        ...rendered,
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

function publicLegalEvidenceRefs(
  payload: Record<string, unknown>,
): NonNullable<NormalizedToolResult["evidenceRefs"]> {
  const evidence =
    payload.evidence &&
    typeof payload.evidence === "object" &&
    !Array.isArray(payload.evidence)
      ? (payload.evidence as Record<string, unknown>)
      : null;
  const baseHandle =
    typeof evidence?.handle === "string"
      ? evidence.handle
      : `public:${String(payload.provider ?? "source")}:${String(payload.identifier ?? "document")}`;
  const filename = String(
    payload.title ?? payload.identifier ?? "Public legal source",
  );
  const blocks = [
    payload.block,
    ...(Array.isArray(payload.before) ? payload.before : []),
    ...(Array.isArray(payload.after) ? payload.after : []),
  ];
  const refs = blocks.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const block = raw as Record<string, unknown>;
    const text = typeof block.text === "string" ? block.text : "";
    if (!text) return [];
    const locator = String(block.label ?? `context ${index + 1}`);
    return [
      {
        handle: `${baseHandle}#${locator}:${sha256(text)}`,
        filename,
        locator,
        text,
        exactSha256: sha256(text),
        kind: "evidence" as const,
      },
    ];
  });
  if (refs.length) return refs;
  const documentText = typeof payload.text === "string" ? payload.text : "";
  return documentText
    ? [
        {
          handle: `${baseHandle}#document:${sha256(documentText)}`,
          filename,
          locator: "document",
          text: documentText,
          exactSha256: sha256(documentText),
          kind: "evidence" as const,
        },
      ]
    : [];
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

const REVISE_EDIT_KEYS = [
  "find",
  "replace",
  "context_before",
  "context_after",
] as const;

function invalidReviseEdit(raw: unknown) {
  if (!raw || typeof raw !== "object") return true;
  const edit = raw as Record<string, unknown>;
  return REVISE_EDIT_KEYS.some(
    (key) =>
      typeof edit[key] !== "string" || (edit[key] as string).length > 100_000,
  );
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
    ) => Promise<unknown>;
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

export const TURN_EDIT_TOOL_NAMES = new Set([
  "delete_and_renumber_docx",
  "link_docx_citations",
  "fix_docx_supras",
  "Edit",
  "transform_docx",
]);

const INTERNAL_DETERMINISTIC_EDIT = "__deterministic_docx_edit";

const upstreamMikeResult = (
  call: NormalizedToolCall,
  content: unknown,
): NormalizedToolResult => ({
  tool_use_id: call.id,
  content: typeof content === "string" ? content : JSON.stringify(content),
});



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
 * call (~0.65s/call on the covenants docx). The cache lives in
 * runAssistantTools and is passed down, so it never outlives the turn and
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
  cache: Map<string, ServedDrafting>,
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
    } else if (entry.projection === "canonical") {
      plane =
        (await extractDocument(
          documents, scope, entry.documentId, entry.versionId,
        ))
          ?.text ?? "";
    } else {
      // Preserve legacy benchmark read-state coordinates.
      const drafting = await servedDraftingText(
        documents, scope, entry.documentId, cache,
      );
      plane =
        drafting?.versionId === entry.versionId
          ? drafting.served
          : (
              await extractDocument(
                documents,
                scope,
                entry.documentId,
                entry.versionId,
              )
            )?.text ?? "";
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
  cache = new Map<string, ServedDrafting>(),
) {
  return readState && /\bassign/iu.test(draft)
    ? assignmentClosureReceipts(
        await turnServedPassages(documents, scope, readState, cache),
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
  publicLegal?: PublicLegalSourceState;
  allowedDocumentIds?: Set<string>;
  pdfHandles?: Set<string>;
  matterId?: string | null;
  legalEvidence?: LegalEvidenceTurnState;
  edits?: AssistantEditTurnState;
  reads?: AssistantReadTurnState;
  workingSets?: AssistantWorkingSetTurnState;
  requirements?: AssistantRequirementsState;
  editMode?: EditMode;
  timeZone?: string;
};

function sharedEvidenceLocator(
  segments: NonNullable<NormalizedToolResult["evidenceSegments"]>,
): Parameters<typeof createLibraryEvidence>[0]["locator"] {
  const first = segments[0];
  return first?.locator && first.locatorKind &&
      segments.every(({ locator, locatorKind }) =>
        locator === first.locator && locatorKind === first.locatorKind)
    ? { kind: first.locatorKind, label: first.locator }
    : undefined;
}

export async function runAssistantTools(
  userId: string,
  calls: NormalizedToolCall[],
  {
    userEmail,
    a2ajLookups,
    a2ajDocuments,
    courtlistener: courtlistenerState,
    publicLegal: publicLegalState,
    allowedDocumentIds,
    pdfHandles: localPdfEvidenceHandles,
    matterId,
    legalEvidence: legalEvidenceState,
    edits: turnEditState,
    reads: turnReadState,
    workingSets,
    requirements: requirementsState,
    editMode = "manual",
    timeZone,
    documents,
    library,
    projects,
    workflows,
  }: AssistantToolOptions,
): Promise<NormalizedToolResult[]> {
  const scope: DocumentScope = { userId, userEmail };
  const publicState = publicLegalState ?? createPublicLegalSourceState();
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
  let editTail: Promise<unknown> = Promise.resolve();
  return Promise.all(
    calls.map((call) => {
      const execute = async () => {
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

      // Claim the one final-agent authoring boundary before any later await.
      // Sibling writes in the same tool batch remain independent; only the
      // first valid bodied write can become the pending Edit target.
      const claimsFinalAgentGate = Boolean(
        requirementsState &&
          turnReadState &&
          call.name === "generate_docx" &&
          !requirementsState.exposureNudgeServed &&
          trimmed(args.filename) &&
          trimmed(args.content),
      );
      if (claimsFinalAgentGate && requirementsState) {
        requirementsState.exposureNudgeServed = true;
      }

      // Edit and Read are the two tools that can target an in-memory draft.
      // A real library path resolves through the coding surface (the FS
      // text-ops editor / read path below); a draft path — "draft.md" or any
      // other name the model spun up, held only in requirementsState.drafts
      // and never on disk — is served by the DRAFT_EDIT handler further down
      // this chain. Route by target: draft calls must fall through here, or
      // the FS resolver answers them with "File does not exist: <name>" while
      // the in-memory handler sits shadowed (the gen-7 bug — every Edit
      // failed on every run, and rendered docs used the un-edited draft).
      // Computed at the top so the lean-batch Read handler below cannot
      // intercept a draft path before the dispatch.
      const draftTarget =
        requirementsState &&
        (call.name === "Edit" || call.name === "Read") &&
        typeof args.file_path === "string" &&
        Object.prototype.hasOwnProperty.call(
          requirementsState.drafts,
          trimmed(args.file_path).toLowerCase(),
        );
      if (call.name === LEGAL_EVIDENCE_TOOL_NAME) {
        const submitted = legalEvidenceState
          ? submitLegalEvidenceAnswer(args, legalEvidenceState)
          : { ok: false, errors: ["Legal evidence state is unavailable"] };
        return {
          ...result(call, submitted),
          terminal: submitted.terminal === true,
        };
      }
      const sourceRead = await readLegalSourceResource(call, args, {
        userId,
        a2ajDocuments,
        a2ajLookups,
        courtlistener: courtlistenerState,
        publicLegal: publicState,
        evidence: legalEvidenceState,
      });
      if (sourceRead) return sourceRead;
      // draftTarget (computed at the top of this chain) routes Read/Edit on
      // draft paths to the in-memory DRAFT_EDIT handler; every other Read/Edit
      // goes to the coding surface below.
      if (
        (call.name === "Glob" ||
          call.name === "Grep" ||
          (call.name === "Read" && !draftTarget) ||
          (call.name === "Edit" && !draftTarget) ||
          call.name === "transform_docx")
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
          requirementsState,
          localPdfEvidenceHandles,
          availableWorkflows,
          editMode,
        );
        if (
          legalEvidenceState &&
          call.name === "Read" &&
          codingResult.status !== "error"
        ) {
          const bySource = new Map<
            string,
            NonNullable<NormalizedToolResult["evidenceSegments"]>
          >();
          for (const segment of codingResult.evidenceSegments ?? []) {
            if (segment.end <= segment.start) continue;
            const key = [
              segment.documentId,
              segment.versionId,
              segment.projection ?? "canonical",
            ].join(":");
            bySource.set(key, [...(bySource.get(key) ?? []), segment]);
          }
          const evidenceIds: string[] = [];
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
            const start = Math.min(...segments.map((segment) => segment.start));
            const end = Math.max(...segments.map((segment) => segment.end));
            const spanText = sourceText.slice(start, end);
            if (!spanText.trim()) continue;
            const receipt = createLibraryEvidence({
              documentId: first.documentId,
              versionId: first.versionId,
              filename: first.filename ?? canonical?.filename ?? first.documentId,
              sourceText,
              spanText,
              start,
              end,
              locator: sharedEvidenceLocator(segments),
            });
            registerLegalEvidence(legalEvidenceState, receipt);
            evidenceIds.push(receipt.evidence_id);
          }
          if (evidenceIds.length) {
            codingResult.content +=
              `\n\nCitation evidence_ids: ${evidenceIds.join(", ")}`;
          }
        }
        return codingResult;
      }
      const publicLegalResult = await executePublicLegalSourceTool(
        call.name,
        args,
        publicState,
        userId,
      );
      if (publicLegalResult) {
        // A pulled journal article registers as citeable evidence (the
        // article receipt's span is the text the model just read), so
        // submit_grounded_answer can cite it — same path as citator/a2aj.
        if (legalEvidenceState) {
          for (const evidence of publicLegalResult.evidences ?? []) {
            registerLegalEvidence(legalEvidenceState, evidence);
          }
        }
        return {
          ...result(call, publicLegalResult.payload),
          evidenceRefs: publicLegalEvidenceRefs(publicLegalResult.payload),
        };
      }
      const sourceSearchResult = await executeSearchSourcesTool(call.name, args);
      if (sourceSearchResult) return result(call, sourceSearchResult);
      if (courtlistenerState) {
        const courtlistenerResult = await runLocalCourtlistenerTool(
          call,
          courtlistenerState,
          userId,
          legalEvidenceState,
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
      // In-memory drafts are ordinary files to the model: Read returns the
      // buffer, Edit mutates it. Only draft paths reach here — the dispatch
      // above routes any file_path present in requirementsState.drafts away
      // from the FS surface — so both branches assume the key exists.
      if (
        requirementsState &&
        (call.name === "Edit" || call.name === "Read")
      ) {
        const filePath = trimmed(args.file_path);
        const key = filePath.toLowerCase();
        if (
          Object.prototype.hasOwnProperty.call(requirementsState.drafts, key)
        ) {
          if (call.name === "Read") {
            return upstreamMikeResult(call, requirementsState.drafts[key]);
          }
          const oldString =
            typeof args.old_string === "string" ? args.old_string : "";
          const newString =
            typeof args.new_string === "string" ? args.new_string : "";
          const edited = applyDraftEdit(
            requirementsState.drafts[key],
            oldString,
            newString,
            args.replace_all === true,
          );
          if ("error" in edited) {
            return upstreamMikeResult(call, { error: edited.error });
          }
          requirementsState.drafts[key] = edited.updated;
          requirementsState.draftEditCount += 1;
          return upstreamMikeResult(call, {
            ok: true,
            replacements: edited.replacements,
            draft_chars: edited.updated.length,
          });
        }
      }
      if (call.name === "generate_excel" || call.name === "generate_ppt") {
        const title = trimmed(args.title) ||
          (call.name === "generate_excel" ? "Workbook" : "Presentation");
        try {
          const extension = call.name === "generate_excel" ? "xlsx" : "pptx";
          const bytes = call.name === "generate_excel"
            ? await renderXlsxWorkbook(
                title,
                Array.isArray(args.sheets) ? args.sheets : [],
              )
            : await buildPptxPresentation(
                title,
                Array.isArray(args.slides) ? args.slides : [],
              );
          const document = await persistGenerated(
            safeGeneratedFilename(title, extension),
            bytes,
          );
          const resource = resourceReference.document(
            document.id,
            document.current_version_id,
          );
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            action: "created",
            document_id: document.id,
            version_id: document.current_version_id,
            version_number: document.active_version_number,
            filename: document.filename,
            file_type: document.file_type,
            resource,
            download_url:
              `/single-documents/${encodeURIComponent(document.id)}/file` +
              `?version_id=${encodeURIComponent(document.current_version_id)}`,
          });
        } catch (error) {
          return fail(call, errorText(error, `${call.name} failed`));
        }
      }
      if (call.name === "generate_docx") {
        const title = trimmed(args.title);
        const markdown = trimmed(args.markdown);
        if (!title || !markdown || typeof args.document_type !== "string") {
          const received = Object.keys(call.input ?? {}).join(", ");
          return fail(
            call,
            "generate_docx invalid input: expected {title, document_type," +
              " markdown} with the complete document body" +
              ` document}; received keys [${received}].`,
          );
        }
        const filename = safeGeneratedFilename(title, "docx");
        if (
          requirementsState &&
          (claimsFinalAgentGate || !requirementsState.exposureNudgeServed) &&
          turnReadState
        ) {
          const split = splitReadExposure(
            await scopedDocuments(
              scope,
              library,
              projects,
              allowedDocumentIds,
            ),
            turnReadState,
          );
          const unexposed = [...split.orientedOnly, ...split.unread];
          if (unexposed.length) {
            requirementsState.drafts[filename.toLowerCase()] = markdown;
            requirementsState.draftFilename = filename;
            requirementsState.signalGateCount += 1;
            requirementsState.exposureNudgeServed = true;
            const tocOnly = split.orientedOnly.length
              ? ` TOC-only: ${split.orientedOnly.join(", ")}.`
              : "";
            const unseen = split.unread.length
              ? ` Unseen: ${split.unread.join(", ")}.`
              : "";
            const sourceCount = unexposed.length === 1
              ? "1 source has"
              : `${unexposed.length} sources have`;
            return upstreamMikeResult(call, {
              error:
                `${sourceCount} no source text retrieved.` +
                `${tocOnly}${unseen} The pending output is ${filename}.` +
                " Review each named source for relevance; retrieve relevant" +
                " text with Grep output_mode=content or Read, then use Edit" +
                ` on ${filename} to incorporate the concrete findings.` +
                " When the output is complete, finish the task normally.",
            });
          }
          requirementsState.exposureNudgeServed = true;
        }
        try {
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
            servedDraftingCache,
          );
          const evidence = resolveDocxEvidenceCitations(
            legalEvidenceState,
            args.citations,
          );
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
          if (requirementsState?.draftFilename) {
            if (
              requirementsState?.draftFilename?.toLowerCase() ===
              document.filename.toLowerCase()
            ) {
              requirementsState.drafts = {};
              requirementsState.draftTitle = null;
              requirementsState.draftFilename = null;
            }
            return {
              ...result(call, {
                ok: true,
                filename: document.filename,
                message:
                  `Written ${document.filename} successfully.` +
                  (sourceClosure.length
                    ? " Review source_closure before ending the turn."
                    : ""),
                ...(sourceClosure.length
                  ? { source_closure: sourceClosure }
                  : {}),
              }),
              mutationReceipt: JSON.stringify(receipt),
            };
          }

          return result(call, receipt);
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
          return result(call, {
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

      if (call.name === INTERNAL_DETERMINISTIC_EDIT) {
        let versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
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
        const blockInsert = parseInsertBlocksRequest(args.ops);
        if (typeof blockInsert === "string") return fail(call, blockInsert);
        const requests = blockInsert ? [] : parseTextOpRequests(args.ops);
        if (typeof requests === "string") return fail(call, requests);
        try {
          const file = await activeDocument(
            documents, scope, documentId, versionId || undefined,
          );
          if (!file) return fail(call, "DOCX Library version not found");
          if (file === "stale") {
            return fail(call, "version_id is not the active version");
          }
          if (file.fileType.toLowerCase() !== "docx") {
            return fail(call, "Text operations require a DOCX Library version");
          }
          const bytes = file.bytes;
          // Addresses resolve against the PINNED version's own text, on the
          // same plane the writer uses (extractDocxBodyStructure, no fallback),
          // so an offset that named a clause for reading names it for
          // editing. Resolution happens here rather than inside the op
          // engine, which needs offsets and not a skeleton.
          const addressed = requests.some(
            (request) => (request.scope as { kind: string }).kind === "at",
          );
          let resolvedRequests = requests;
          if (addressed) {
            const body = await extractDocxBodyStructure(bytes);
            const docText = body.text;
            if (!docText) {
              return fail(
                call,
                "DOCX body text could not be extracted, so an `at` scope cannot be resolved. Report the file rather than editing from partial text.",
              );
            }
            const skeleton = compileAgreementSkeleton(docText, documentId, {
              tableCells: body.tableCells,
            });
            const map = pageMapFromMarkers(docText);
            const spansFor = (
              scope: { at: string; follow?: string; depth?: number },
            ): { start: number; end: number }[] | string => {
              const address = parseAddress(scope.at);
              if (!address) return `scope.at '${scope.at}' is not an address`;
              if (address.kind === "offset") {
                return `scope.at '${scope.at}' is a raw offset; edits scope to a provision or a page, never a bare offset`;
              }
              if (address.kind === "page") {
                const lookup = resolvePage(map, docText, address.spec);
                if (lookup.status !== "found") {
                  return `scope.at '${scope.at}' did not resolve to a page (${lookup.status})`;
                }
                return [{ start: lookup.page.start, end: lookup.page.end }];
              }
              const seed = readSection(skeleton, address.locator);
              if (seed.status !== "found" || !seed.block) {
                return `scope.at '${scope.at}' did not resolve to a provision (${seed.status})`;
              }
              const follow = (scope.follow ?? "none") as FollowDirection;
              if (follow === "none") {
                return [{ start: seed.block.start, end: seed.block.end }];
              }
              const walked = graphScope(
                skeleton,
                crossReferenceGraph(docText, documentId, { skeleton }),
                seed.block.label,
                { follow, depth: scope.depth ?? 1 },
              );
              if (!walked) return `scope.at '${scope.at}' is not a skeleton node`;
              return walked.nodes.map((node) => ({
                start: node.start,
                end: node.end,
              }));
            };
            const mapped: typeof requests = [];
            for (const [index, request] of requests.entries()) {
              const scope = request.scope as unknown as {
                kind: string;
                at: string;
                follow?: string;
                depth?: number;
              };
              if (scope.kind !== "at") {
                mapped.push(request);
                continue;
              }
              const spans = spansFor(scope);
              if (typeof spans === "string") {
                return fail(call, `ops[${index}].${spans}`);
              }
              mapped.push({ ...request, scope: { kind: "spans", spans } });
            }
            resolvedRequests = mapped;
          }
          const applied = blockInsert
            ? await insertTrackedBlocks(bytes, blockInsert, { author: "Beaver" }).then(
                (inserted) => ({
                  bytes: inserted.bytes,
                  edits: inserted.changes.map((change) => ({
                    changeId: change.id,
                    delWId: change.delId,
                    insWId: change.insId,
                    deletedText: change.deletedText,
                    insertedText: change.insertedText,
                    contextBefore: change.contextBefore,
                    contextAfter: change.contextAfter,
                    diff: change.diff,
                  })),
                  reports: [
                    {
                      op: "insert_blocks",
                      replacements: inserted.changes.length,
                      notes: [],
                    },
                  ],
                  replacementCount: inserted.changes.length,
                  editErrors: inserted.errors.map(
                    (error) => `change ${error.index + 1}: ${error.reason}`,
                  ),
                }),
              )
            : await applyTextOpsToDocx(bytes, resolvedRequests);
          const opReports = applied.reports.map((report) => ({
            op: report.op,
            replacements: report.replacements,
            unchanged_sites: report.notes,
          }));
          if (!applied.replacementCount) {
            // Valid outcome, not an error: report-only ops (check_spelling)
            // and transforms that found nothing to change land here.
            return result(call, {
              ok: true,
              action: "no_changes",
              document_id: documentId,
              version_id: file.version.id,
              change_count: 0,
              ops: opReports,
              next_required_action:
                "No tracked changes and no new version. Report the per-op notes to the user.",
            });
          }
          if (!applied.edits.length) {
            return result(call, {
              ok: false,
              error: "No revision was saved",
              ops: opReports,
              ...(applied.editErrors.length
                ? { edit_errors: applied.editErrors }
                : {}),
            });
          }
          const trackedEdits: AssistantEdit[] = applied.edits.map(
            (edit) => ({
              changeId: edit.changeId,
              delWId: edit.delWId,
              insWId: edit.insWId,
              deletedText: edit.deletedText,
              insertedText: edit.insertedText,
              contextBefore: edit.contextBefore,
              contextAfter: edit.contextAfter,
              diff: edit.diff,
            }),
          );
          const committed = await commitAssistantTurnVersion({
            documents,
            scope,
            documentId,
            filename: file.version.filename ?? file.filename,
            bytes: applied.bytes,
            sourceVersionId: file.version.id,
            trackedEdits,
            turnEditState,
            editMode,
          });
          if (!committed) return fail(call, "version_id is no longer active");
          const {
            version,
            parentVersionId,
            trackedEdits: savedEdits,
          } = committed;
          const sourceClosure = await sourceClosureForDraft(
            documents,
            scope,
            await extractDocxBodyText(applied.bytes),
            turnReadState,
            servedDraftingCache,
          );
          const downloadUrl =
            `/single-documents/${encodeURIComponent(documentId)}/file` +
            `?version_id=${encodeURIComponent(version.id)}`;
          return result(call, {
            ok: true,
            receipt: "mike-document:v1",
            action: "revised",
            edit_mode: editMode,
            document_id: documentId,
            parent_version_id: parentVersionId,
            version_id: version.id,
            version_number: version.version_number,
            filename: version.filename,
            file_type: version.file_type,
            source_sha256: version.source_sha256,
            change_count: savedEdits.length,
            resource: resourceReference.document(documentId, version.id),
            download_url: downloadUrl,
            ops: opReports,
            ...(applied.editErrors.length
              ? { edit_errors: applied.editErrors }
              : {}),
            ...(sourceClosure.length ? { source_closure: sourceClosure } : {}),
            annotations: savedEdits.map((edit) => ({
              kind: "edit",
              edit_id: edit.id,
              document_id: documentId,
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
            next_required_action: sourceClosure.length
              ? "Review source_closure and apply another document edit only if material."
              : "Mention any unchanged_sites when you confirm.",
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Deterministic text operations failed"),
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
          ? result(call, {
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
        if (!documentId) return fail(call, "document_id is required");
        try {
          return result(
            call,
            await docxWorkflow.run(
              documents,
              scope,
              documentId,
              trimmed(args.version_id) || undefined,
              turnEditState,
            ),
          );
        } catch (error) {
          return fail(call, errorText(error, docxWorkflow.fallback));
        }
      }

      if (call.name === "create_table_of_authorities") {
        const versionId = trimmed(args.version_id);
        if (!documentId) return fail(call, "document_id is required");
        try {
          const file = await documents.read(
            scope,
            documentId,
            versionId || null,
            false,
          );
          if (!file) return fail(call, "Library version not found");
          if (!["docx", "pdf"].includes(file.fileType.toLowerCase())) {
            return fail(
              call,
              "Table of Authorities requires a Word or PDF Library version",
            );
          }
          const job = await submitTableOfAuthoritiesDocument({
            bytes: file.bytes,
            filename: file.version.filename ?? file.filename,
            splitFallback: args.split_fallback === "off" ? "off" : "auto",
            projectId: matterId,
          });
          return result(call, {
            ok: true,
            document_id: documentId,
            version_id: file.version.id,
            filename: file.version.filename,
            resource: resourceReference.job(job.id),
            job,
            next_required_action:
              `Read ${resourceReference.job(job.id)} until detection is complete.`,
          });
        } catch (error) {
          return fail(
            call,
            errorText(error, "Table of Authorities submission failed"),
          );
        }
      }

      const hansard = executeHansardTool(call.name, args);
      if (hansard) {
        const intervention =
          call.name === "hansard_fetch" &&
          hansard.intervention &&
          typeof hansard.intervention === "object"
            ? (hansard.intervention as Record<string, unknown>)
            : null;
        const text =
          typeof intervention?.text === "string" ? intervention.text : "";
        if (legalEvidenceState && intervention && text.trim()) {
          const id = trimmed(intervention.id) || trimmed(args.id);
          const date = trimmed(intervention.date);
          const speaker = trimmed(intervention.speaker);
          const receipt = createBenchmarkEvidence({
            jurisdiction: trimmed(intervention.jurisdiction) || "CA-ON",
            sourceClass: "commentary",
            stableSourceId: `hansard:${id}`,
            sourceText: text,
            spanText: text,
            citation: ["Ontario Hansard", date, speaker].filter(Boolean).join(", "),
            name: speaker || "Ontario Hansard",
            dataset: "a2aj-hansard",
            version: date || null,
            externalUrl: trimmed(intervention.sourceUrl) || null,
            locatorKind: "document",
            locatorLabel: id || "intervention",
          });
          registerLegalEvidence(legalEvidenceState, receipt);
          return result(call, { ...hansard, evidence_id: receipt.evidence_id });
        }
        return result(call, hansard);
      }

      const citator = executeCitatorTool(call.name, args);
      if (citator) {
        if (legalEvidenceState) {
          for (const evidence of citator.evidences ?? []) {
            registerLegalEvidence(legalEvidenceState, evidence);
          }
        }
        return {
          ...result(call, citator.payload),
          evidenceRefs: receiptEvidenceRefs(citator.evidences ?? []),
        };
      }

      const compared = await executeCompareVersionsTool(
        documents, scope, call.name, args, matterId,
      );
      if (compared) return result(call, compared);

      const a2aj = await executeA2AJTool(call.name, args);
      if (a2aj) {
        return captureA2AJ(call, a2aj, {
          documents: a2ajDocuments,
          lookups: a2ajLookups,
          evidence: legalEvidenceState,
        });
      }

      return result(call, { ok: false, error: `Unknown tool: ${call.name}` });
      };
      const executeAndRecord = async () => {
        const output = await execute();
        return output;
      };
      if (!TURN_EDIT_TOOL_NAMES.has(call.name)) return executeAndRecord();
      const queued = editTail.then(executeAndRecord);
      editTail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    }),
  );
}
